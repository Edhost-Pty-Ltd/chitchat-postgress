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

The **app** reads two public variables (set in the repo-root `.env`):

| Variable | Purpose |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | Base URL of the REST API (e.g. `http://localhost:4000`) |
| `EXPO_PUBLIC_SOCKET_URL` | Socket.IO gateway URL (defaults to `EXPO_PUBLIC_API_URL`) |

Per-feature backend flags (default off during migration) can be overridden with
`EXPO_PUBLIC_BACKEND_<FEATURE>=true` for `USERS`, `MESSAGING`, `PRESENCE`,
`CALLS`, `STATUS`, `MEDIA`.

## Deployment note

The REST API and Socket.IO gateway expect **TLS termination in front of the
backend** for any non-local deployment. Do not expose the plain HTTP port to the
internet.

## Architecture

See the spec under
`.kiro/specs/firebase-to-sockets-redis-postgres-migration/` (requirements,
design, tasks).
