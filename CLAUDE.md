@AGENTS.md

# ChitChatBusiness — Architecture

The app has migrated off Firebase for data. Firebase is retained **only** as the
phone-OTP identity provider (`@react-native-firebase/auth` on native,
`firebase/auth` on web). Everything else runs on the app's own backend.

## Backend (`server/`)

Node.js + TypeScript: Fastify REST API + Socket.IO gateway (Redis adapter),
PostgreSQL (via `pg` + `node-pg-migrate`, raw-SQL repositories), Redis
(presence, rate limits, socket adapter), BullMQ (push dispatch + scheduled
cleanup jobs that replaced the old Cloud Functions), and S3-compatible object
storage (MinIO in dev) for media via presigned URLs. The backend verifies
Firebase ID tokens with `firebase-admin` and owns all other data. See
[`server/README.md`](./server/README.md).

## Dev stack

From the repo root: `docker compose up -d` starts Postgres (5432), Redis (6379)
and MinIO (9000/9001). Then `cd server && npm run migrate && npm run dev` runs
the backend on `http://localhost:4000`.

## App ↔ backend

- REST: `src/api/client.ts` (attaches the Firebase ID token as a bearer) and the
  typed surface in `src/api/endpoints.ts`.
- Realtime: `src/realtime/socket.ts` (token handshake, auto room re-join).
- Media: `src/services/mediaService.ts` uploads bytes directly to object storage
  via presigned URLs; messages/statuses/avatars store object keys, resolved to
  signed URLs at render time.
- Config: the repo-root `.env` sets `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_SOCKET_URL`
  and `EXPO_PUBLIC_BACKEND_*` feature flags (`src/config/featureFlags.ts`).

## What is NOT used anymore

No Firestore, Firebase Storage, Realtime Database, or Cloud Functions. There are
no `firestore.rules` / `storage.rules` to maintain.
