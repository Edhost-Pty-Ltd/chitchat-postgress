# ChitChat facial-recognition service

Standalone Django service that owns the encrypted face reference and signs the
short-lived receipts Node uses to clear a reported account. Everything else —
camera capture, anti-spoofing, motion/silent liveness, and the 1:1 match — now
runs on-device inside
[`@faceaisdk/react-native-face-sdk`](https://www.npmjs.com/package/@faceaisdk/react-native-face-sdk).

The old server-side pipeline (InsightFace + OpenCV + server-issued motion
challenges + FacePing attestation) has been removed. This service no longer
loads a neural network, decodes images, or implements liveness geometry.

## What this service does

1. **Encrypted storage.** The mobile app uploads the SDK's 1024-char reference
   feature. Django encrypts it with Fernet and stores only the ciphertext in
   private S3/MinIO under a UUID key.
2. **Cross-device restore.** On a fresh device the app fetches the encrypted
   reference, decrypts via TLS, and calls the SDK's `insertFaceFeature` so the
   SDK can match locally.
3. **Reported-account recovery.** When the app forwards the SDK's `faceVerify`
   result (code + liveness score + the fresh live feature) with the current
   `report_generation`, Django validates the format, checks the SDK verdict,
   and mints a short-lived HMAC receipt bound to that generation. Node
   verifies the receipt before clearing the identity flag.
4. **Admin-assisted agent enrollment.** The owner/admin captures a photo on
   their own device, the SDK extracts a reference feature from it with
   `addFaceByImage`, and only that feature is forwarded under a signed Node
   grant.

## Code map

```
accounts/
├── authentication.py   Firebase ID token verification
├── permissions.py      IsFirebaseAuthenticated (safer than DRF default)
├── face_engine.py      Fernet encryption + feature-format validation
├── face_service.py     Enroll / fetch / verify-live / status / delete
├── agent_enrollment.py Signed one-time grant verification
├── agent_service.py    Admin-assisted feature storage (no liveness)
├── agent_views.py      POST /api/face/admin-register/
├── views.py            POST /api/face/{enroll,verify-live}, GET /{feature,status}
├── urls.py             URL routes
├── storage.py          Encrypted embedding S3/MinIO helpers
├── receipts.py         HMAC receipt minting
├── models.py           FaceProfile + AdminAgentEnrollmentGrant
├── tests.py            47 service + view tests (SQLite + moto S3)
└── migrations/
```

## API contract

All endpoints require `Authorization: Bearer <firebase-id-token>`.

| Method | Path | Body | Success | Notes |
|---|---|---|---|---|
| POST | `/api/face/enroll/` | JSON `face_feature`, `liveness_score`, `liveness_code` | `201 {"ok":true,"enrolled":true}` | Existing-account enrollment only. Rejects an existing immutable reference. |
| POST | `/api/face/register/` | JSON `face_feature`, `liveness_score`, `liveness_code` | `201 {"ok":true,"receipt":"..."}` | New-account face gate. Requires SDK code 1 and returns the signed receipt Node's `/me/register` requires. |
| GET  | `/api/face/feature/` | — | `200 {"enrolled":true,"face_feature":"..."}` or `{"enrolled":false}` | Lets another device restore the SDK local reference. |
| POST | `/api/face/verify-live/` | JSON `report_generation`, `face_feature`, `liveness_score`, `liveness_code` | `200 {"ok":true,"matched":true,"receipt":"..."}` | Reported-account recovery. Returns `matched:false` when the SDK itself reports code=2 (live but no match). |
| POST | `/api/face/admin-register/` | JSON `grant`, `face_feature` | `201 {"ok":true,"receipt":"..."}` | Admin-assisted; no liveness required. |
| GET  | `/api/face/status/` | — | `200 {"enrolled":bool,"locked":bool,...}` | No biometric data exposed. |

Error bodies: `{"error":"<code>"}`. Common codes: `empty_feature` (400),
`bad_feature` (422), `liveness_rejected` / `liveness_failed` (403/422),
`already_enrolled` (409), `not_enrolled` (404), `locked` (423),
`reference_unreadable` (409), `reference_not_recovery_eligible` (409),
`report_generation_invalid` (400), `agent_grant_invalid` (403),
`agent_grant_expired` (403), `agent_grant_used` (409),
`receipt_not_configured` / `service_unavailable` (503).

## Development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # fill FERNET_KEYS, Firebase, S3, receipt secrets
python manage.py migrate
python manage.py runserver 0.0.0.0:8000
```

## Tests

The test suite needs neither Postgres nor the SDK itself: it uses in-memory
SQLite, a real in-memory S3 (`moto`), real Fernet encryption, and mocks only
Firebase token verification.

```bash
FACE_TEST_SQLITE=1 \
FERNET_KEYS="$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')" \
python manage.py test accounts
```

## Mobile integration

- `src/sdk/faceAI.ts` — thin wrapper around
  `@faceaisdk/react-native-face-sdk` with named success-code constants and
  promise-based helpers.
- `src/screens/FaceEnrollmentScreen.tsx` — after OTP, runs SDK camera
  enrollment, then SDK live 1:1 verification; sends the feature/verdict to
  Django, carries Django's signed receipt to Node `/me/register`, then marks the
  AuthContext signed in. It also hosts a cosmetic 468-point mesh visual.
- `src/components/FaceMeshScan.tsx` + `src/data/faceMeshTemplate.ts` — one-path
  SVG mesh generated by `scripts/generate-face-mesh.mjs`. It is explicitly a
  presentation guide, not tracked landmarks and not part of the security
  verdict.
- `src/screens/CreateAccountScreen.tsx` — collects profile fields and verifies
  OTP only; it performs no backend profile write.
- `src/api/faceApi.ts` — talks to this service (`registerFaceForAccount`,
  `uploadEnrollment`, `fetchEnrollmentFeature`, `verifyReportedAccount`,
  `faceStatus`).
- `src/components/ReportedFaceVerification.tsx` — restores the local reference
  if needed, calls `faceVerify`, and forwards the SDK's verdict to Django.
- `src/components/AgentRegistrationSheet.tsx` — captures a photo, extracts the
  feature with `addFaceByImage` locally, forwards it under the signed grant.
- Env: `EXPO_PUBLIC_FACE_API_URL` (base URL of this service; defaults to the
  Node host on port 8000). No FacePing variables are used anywhere any more.

## Deployment checklist

1. Apply migrations through `0006_sdk_native_liveness` (drops the old
   InsightFace/liveness/attestation columns and the `LivenessChallenge`
   table).
2. Set strong persistent `FERNET_KEYS` and keep them backed up (losing them
   makes enrolled embeddings undecryptable). Set the same random
   `FACE_VERIFICATION_RECEIPT_SECRET` in both server environments, and a
   separate same random `AGENT_FACE_ENROLLMENT_SECRET` in Node + Django.
3. Scope Django's S3 credentials to the `face-embeddings/*` prefix.
4. On the mobile side, run `npx expo prebuild --clean` so the native
   projects pick up the new `@faceaisdk/react-native-face-sdk` autolinking and
   the `withFaceAISDK` config plugin's TensorFlowLiteSwift ABI workaround.
   iOS: `cd ios && pod install`.
