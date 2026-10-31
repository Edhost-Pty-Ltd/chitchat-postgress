# ChitChatBusiness Backend

Node.js + TypeScript backend that replaces Firestore, Firebase Storage and
Cloud Functions. Firebase Auth (phone OTP) stays as the identity provider; this
server verifies Firebase ID tokens and owns all other data via PostgreSQL,
Redis, Socket.IO (with the Redis adapter) and an S3-compatible object store.

This is **Slice 0** of the migration: scaffold + health + auth + the realtime
gateway. Feature endpoints land in later slices.

## Dev_Stack

Local Postgres, Redis and MinIO run via Docker Compose from the repo root:

```bash
docker compose up -d          # start Postgres (5432), Redis (6379), MinIO (9000/9001)
docker compose down           # stop
```

MinIO console: http://localhost:9001 (user `chitchat`, pass `chitchat-secret`).
The `minio-init` service creates the `chitchat-media` bucket automatically.

## Running the backend

```bash
cd server
cp .env.example .env          # then fill in a Firebase service account
npm install
npm run migrate               # apply Postgres migrations (idempotent)
npm run dev                   # start on http://localhost:4000
```

Firebase Admin needs a service account to verify ID tokens. Set either
`FIREBASE_SERVICE_ACCOUNT_PATH` (path to the JSON) or
`FIREBASE_SERVICE_ACCOUNT_JSON` (the raw JSON). The server exits on startup if a
required variable is missing, naming it.

Health check: `GET /health` → 200 when Postgres and Redis respond, 503 naming
the failing dependency otherwise.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start with hot reload (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` and run |
| `npm run migrate` | Apply pending migrations |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest. Integration tests skip when the Dev_Stack is unreachable. |

## Environment variables

Backend variables are documented in [`.env.example`](./.env.example).

## Face-gated self registration

A phone OTP creates only a Firebase authentication session. It does **not**
create a Postgres account. Production token verification never inserts a user
row; it only backfills the phone number of an existing row.

New-account flow:

1. `CreateAccountScreen` collects the business profile and verifies the Firebase
   phone OTP.
2. `FaceEnrollmentScreen` calls FaceAISDK camera enrollment, then immediately
   calls its 1:1 verification with motion + silent liveness.
3. Django stores the encrypted 1024-character reference and returns a
   short-lived HMAC receipt with purpose `self_registration_face_enrollment`.
4. `POST /me/register` verifies the receipt, binds it to the Firebase UID and
   takes the phone number from the verified Firebase token. Only then does it
   insert the `users` row.
5. The optional business logo uploads after that transaction, because media
   routes are unavailable to unregistered sessions.

An OTP-authenticated UID with no `users` row may call only `GET /me` (which
returns 404) and `POST /me/register`; other REST calls return `403
REGISTRATION_REQUIRED`, and Socket.IO rejects its handshake. Existing user rows
are unaffected and are not forced through enrollment again.

The screen's 468-point mesh is a fixed, animated presentation guide. It is not
tracked landmarks and has no security authority; the SDK result code controls
registration.

## Reported-account verification

`FACE_VERIFICATION_RECEIPT_SECRET` is shared only with the standalone Django
face service. Django signs a short-lived receipt once the on-device FaceAISDK
confirms a live match against the user's stored encrypted reference; Node
verifies the receipt before changing a reported account from
`verification_required` back to `verified`. Never expose this secret through
an `EXPO_PUBLIC_*` variable. The server rejects the development fallback when
`NODE_ENV=production`.

Reported identity status is enforced server-side, not only by the mobile
overlay. Normal authenticated REST routes return `423
IDENTITY_VERIFICATION_REQUIRED`; only `GET /me` and `POST /me/verify` remain
available for recovery. Socket.IO reconnects the account in a personal-room-only
mode with chat, presence, call, and meeting handlers withheld. Once the signed
proof is accepted, sockets reconnect with normal authorization.

The **app** reads two public variables (set in the repo-root `.env`):

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | Base URL of the REST API (e.g. `http://localhost:4000`) |
| `EXPO_PUBLIC_SOCKET_URL` | Socket.IO gateway URL (defaults to `EXPO_PUBLIC_API_URL`) |

Per-feature backend flags (default off during migration) can be overridden with
`EXPO_PUBLIC_BACKEND_<FEATURE>=true` for `USERS`, `MESSAGING`, `PRESENCE`,
`CALLS`, `STATUS`, `MEDIA`.

## Multi-agent businesses

`GET /businesses/dashboard` is the mobile dashboard read model. It
idempotently bootstraps a default business for an existing standalone owner,
while an agent receives the business they were provisioned into. Company details
are always read from the owner profile; they are not copied onto agents.

- **Owners/admins** see roster counts, every active/provisioned member, phone
  numbers needed for management, enrollment state, an agent detail dashboard,
  and **Add agent**.
- **Agents** see only their own agent record, own availability, and inherited
  company details. They receive no peer names, UIDs, enrollment state, phone
  numbers, team counts, or management controls—even through the raw API.
- `POST /businesses/:id/agents` requires a primary device plus an active
  business owner/admin membership. It provisions a separate Firebase phone user
  (or resolves an existing phone identity), records consent, and returns the
  one-time Django face-enrollment grant.
- The agent signs in later on their own device using the ordinary Firebase SMS
  OTP for their assigned number. A membership becomes `active` only after Node
  accepts Django’s enrollment completion receipt.

An individual may have only one active/provisioned business context, whether
owner, admin, or agent. Both a Postgres partial unique index and a per-user
transaction lock enforce that invariant; a manager cannot attach a reported or
unverified account to the no-liveness enrollment flow.

`AGENT_FACE_ENROLLMENT_SECRET` is a separate server-only secret shared with the
Django face service. Node issues the manager/business/agent-bound grant; Django
returns the completion receipt. Never place either value in `EXPO_PUBLIC_*`.

## Deployment note

The REST API and Socket.IO gateway expect **TLS termination in front of the
backend** for any non-local deployment. Do not expose the plain HTTP port to the
internet.

## Architecture

See the spec under
`.kiro/specs/firebase-to-sockets-redis-postgres-migration/` (requirements,
design, tasks).
