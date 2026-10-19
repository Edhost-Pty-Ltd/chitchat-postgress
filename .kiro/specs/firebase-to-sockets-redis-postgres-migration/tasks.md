# Implementation Plan

This plan migrates ChitChatBusiness off Firebase for everything except phone-OTP authentication, in nine incremental slices (Slice 0–8). Each slice ends with a Check_In task that reports what changed, the tests run and their results, manual verification steps and open issues, then pauses for user feedback before the next slice begins (Req 13.2). Features not yet migrated keep their existing Firebase path behind a Feature_Flag (Req 3.9, 13.3), and the build plus automated tests pass at the end of every slice (Req 13.4).

> Before writing or changing any app-side (`src/`) code, read the Expo v56.0.0 versioned docs per `AGENTS.md` and confirm each API against the installed SDK. The `package.json` declares SDK `~57` while `AGENTS.md` points at v56; verify the actual installed `expo-file-system`, `expo-notifications` and related APIs at implementation time (Design: "Expo SDK version note").

## Slice 0 — Backend scaffold, Dev_Stack and app-side client layer

- [x] 0.1 Scaffold the `server/` Node.js + TypeScript project
  - Create `server/package.json`, `server/tsconfig.json` (ESM), and `server/vitest.config.ts`
  - Add dependencies: Fastify, `socket.io`, `@socket.io/redis-adapter`, `ioredis`, `pg`, `node-pg-migrate`, `zod`, `bullmq`, `firebase-admin`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `pino`; dev: `vitest`, `supertest`, `socket.io-client`, `fast-check`
  - Create the directory layout from the design (`src/config`, `db`, `redis`, `auth`, `http`, `realtime`, `media`, `push`, `jobs`, `domain`, `test`)
  - _Requirements: 1.1_

- [x] 0.2 Add the Dev_Stack Docker Compose
  - Write repo-root `docker-compose.yml` with Postgres, Redis and MinIO, startable with one command, with a MinIO bucket the backend uses without app code changes
  - _Requirements: 1.2, 10.12_

- [x] 0.3 Env loading and validation
  - Implement `server/src/config/env.ts` with a zod schema for DB URL, Redis URL, Object_Store endpoint + credentials, Firebase service-account reference and listen port
  - On a missing variable, exit non-zero with a message that names the missing variable
  - Add `server/.env.example` listing every required variable with placeholders
  - Write a unit test for the "missing variable names it, non-zero exit" behavior (Property 26)
  - _Requirements: 1.3, 1.4, 1.5 — Property 26_

- [x] 0.4 Postgres pool and migration runner
  - Implement `db/pool.ts` (pg Pool) and `db/migrate.ts` using `node-pg-migrate`
  - Add a single migrate command; create the initial migration establishing the `migrations` bookkeeping and an empty baseline
  - Add an integration test proving running migrations twice applies each migration once
  - _Requirements: 1.6, 1.7_

- [x] 0.5 Logger and request IDs
  - Implement `config/logger.ts` with pino JSON output and a per-request request ID, with redaction configured for Firebase ID tokens, push tokens and presigned URLs
  - _Requirements: 1.10, 12.6_

- [x] 0.6 Fastify server, CORS, and `/health`
  - Implement `http/server.ts`: register CORS/Socket.IO origin allow-lists from config, request-id, error handler
  - Implement `GET /health` returning 200 when Postgres and Redis both respond, and 503 naming the failing dependency otherwise
  - Add integration tests for 200 and 503-naming-dependency cases
  - _Requirements: 1.8, 1.9, 12.5_

- [x] 0.7 Auth_Verifier (Firebase Admin) for REST
  - Implement `auth/firebaseAdmin.ts` and `auth/verifier.ts` verifying `Authorization: Bearer <idToken>`, resolving `{ userId, firebaseUid, phoneNumber }`, upserting the user row on first contact
  - Return 401 with a machine-readable code for missing/malformed/expired/revoked tokens
  - Add REST auth middleware that authorizes against the resolved uid and ignores any body-supplied user id
  - Write tests for valid-token resolution, 401 cases, first-contact upsert, and body-id-is-ignored (Property 6)
  - _Requirements: 2.4, 2.5, 2.6, 2.11 — Property 6_

- [x] 0.8 Socket.IO gateway with Redis adapter and handshake auth
  - Implement `realtime/gateway.ts` with the Socket.IO server, `@socket.io/redis-adapter`, and handshake auth reading `socket.handshake.auth.token`
  - Reject connections with a missing/invalid token; auto-join `user:{userId}`
  - Add an integration test for accepted vs rejected handshakes
  - _Requirements: 2.7, 2.8, 5.16_

- [x] 0.9 Graceful shutdown
  - On SIGTERM, stop accepting new connections, drain in-flight work, close Postgres/Redis/sockets within 15 seconds
  - _Requirements: 12.7_

- [x] 0.10 App-side API_Client
  - Implement `src/api/client.ts`, `src/api/endpoints.ts`, `src/api/errors.ts`
  - Read base URL from `EXPO_PUBLIC_API_URL`; attach a fresh Firebase ID token, refreshing when expired or within 5 minutes of expiry; return typed `ApiResult` with `ApiError` (status + code) vs `NetworkError`
  - Write tests for the refresh threshold (Property 25) and error typing including no-connectivity (Property 27)
  - _Requirements: 2.2, 2.3, 3.1, 3.4, 3.5 — Properties 25, 27_

- [x] 0.11 App-side Socket_Client
  - Implement `src/realtime/socket.ts`: handshake with fresh token, exponential-backoff reconnect, re-join active chat/call/meeting rooms on reconnect, reconnect with refreshed token on expiry, `subscribe(event, handler): () => void`, disconnect + clear cached state on sign-out
  - _Requirements: 2.9, 2.10, 3.6, 3.7, 3.8_

- [x] 0.12 App-side env and feature flags
  - Implement `src/config/env.ts` (reads `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_SOCKET_URL`, logs an error naming a missing variable) and `src/config/featureFlags.ts` (per-feature Backend-vs-Firebase selection)
  - Document both env variables in the project's environment docs
  - _Requirements: 3.2, 3.3, 3.9_

- [x] 0.13 Verify Slice 0 and Check_In
  - Run backend tests against Dev_Stack Postgres + Redis; confirm the app builds on iOS, Android and web with the new modules wired but no feature cut over
  - Report files changed, tests run with results, manual verification steps and open issues; pause for user feedback
  - _Requirements: 13.2, 13.4_

## Slice 1 — Users, profile, privacy, blocks, contacts, push tokens

- [x] 1.1 Migration for user-domain tables
  - Add migration for `users`, `privacy_settings`, `blocked_users`, `push_tokens` with indexes per the design
  - _Requirements: 4.1, 4.9, 4.11, 4.7_

- [x] 1.2 Profile endpoints
  - Implement `GET /me`, `PATCH /me`, `PUT /me/phone` (409 if the number is already assigned to another user); add repositories
  - Tests for read/update and the 409 conflict
  - _Requirements: 4.1, 4.2, 4.3, 4.6_

- [x] 1.3 Privacy settings endpoints
  - Implement `GET /me/privacy`, `PUT /me/privacy`; store per-user settings
  - _Requirements: 4.9, 4.10_

- [x] 1.4 Blocks endpoints and server-side enforcement helper
  - Implement `GET /blocks`, `POST /blocks`, `DELETE /blocks/:userId`
  - Implement `domain/visibility.ts` block-evaluation used by later slices
  - _Requirements: 4.11, 4.12, 4.13_

- [x] 1.5 Contact matching
  - Implement `POST /contacts/match`: return registered users whose numbers match, limited to fields permitted by each matched user's Privacy_Settings; 413 if more than 500 numbers
  - Property tests: returned users are all in the submitted list and expose only privacy-permitted fields (Property 13); 413 boundary
  - _Requirements: 4.4, 4.5 — Property 13_

- [x] 1.6 Push token registration endpoints
  - Implement `POST /push-tokens` and `DELETE /push-tokens/:token`
  - _Requirements: 4.7, 4.8_

- [x] 1.7 Flip app hooks behind flags
  - Route `usePrivacySettings`, `useBlockedContacts`/`BlockedContext`, `useContacts`/`usePhoneBook`, `useRegistration`, `usePushNotifications` through `API_Client` when their Feature_Flag selects the Backend; keep Firebase paths as fallback
  - _Requirements: 3.9, 13.3, 13.5_

- [x] 1.8 Verify Slice 1 and Check_In
  - Run backend + app tests; manually verify profile, privacy, block/unblock, contact matching and push-token registration against the Backend
  - Report and pause for user feedback
  - _Requirements: 13.2, 13.4_

## Slice 2 — Chats, messages and the Push_Dispatcher

- [x] 2.1 Migration for chat-domain tables
  - Add migration for `chats` (with `direct_key` unique dedupe), `chat_members`, `messages` (with `expires_at`, partial unique on `(chat_id, sender_id, client_id)`), `message_receipts`, plus the design indexes
  - _Requirements: 5.1, 5.2, 5.3, 5.17_

- [x] 2.2 Chat creation and listing
  - Implement `POST /chats` (direct dedupe via `direct_key`; group creator = admin), `PATCH /chats/:id` (admin-only metadata/members, emit `chat:updated`), `GET /chats` (last message, per-chat unread, total unread)
  - Property test: unread counts equal outstanding non-blocked unread receipts and total equals the sum (Property 11)
  - _Requirements: 5.1, 5.11, 5.12, 5.13 — Property 11_

- [x] 2.3 Message read endpoint with pagination and TTL enforcement
  - Implement `GET /chats/:id/messages?cursor=&limit=50` (descending, cursor paginated), the `?after=<messageId>` reconnect variant, excluding rows past `expires_at`
  - Property tests: TTL = created_at + 72h (Property 1), expired rows never returned (Property 2), pagination complete/ordered/size-bounded (Property 3)
  - _Requirements: 5.3, 5.9, 5.18, 11.7 — Properties 1, 2, 3_

- [x] 2.4 Message send endpoint with idempotency and membership gate
  - Implement `POST /chats/:id/messages`: set `expires_at = now + 72h`, idempotent on `client_id`, reject non-members; support all message types; mark `blocked_message` for recipients who blocked the sender
  - Property tests: idempotent send returns the original (Property 4); membership gates access (Property 5)
  - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.10, 5.17_

- [x] 2.5 Realtime message delivery and receipts
  - Emit `message:new` to connected chat members except senders blocked by the recipient
  - Handle `message:delivered` and `message:read` acks (record `delivered_at`/`read_at`); emit read updates to the sender only when the reader has read receipts enabled
  - Property tests: receipts recorded on ack (Property 9); read-event emission iff read receipts enabled (Property 10); block isolation for new-message events (Property 7); blocked messages excluded from unread counts (Property 8)
  - _Requirements: 5.4, 5.6, 5.7, 5.8, 5.10 — Properties 7, 8, 9, 10_

- [x] 2.6 Message delete and forward
  - Implement `POST /chats/:id/messages/:mid/delete` (for me / everyone, emit `message:deleted`) and `POST /messages/forward` (one message per target chat)
  - _Requirements: 5.14, 5.15_

- [x] 2.7 Push_Dispatcher (replaces `onMessageCreated`)
  - Implement `push/dispatcher.ts` as a BullMQ worker enqueued on send, off the request path: notify chat members minus sender, minus blockers, minus `blocked_message`, minus recipients with an open socket joined to the chat room; category `chat_message`, data `{ chatId, senderId, type: "message" }`; delete `DeviceNotRegistered` tokens; retry retryable failures up to 3× with backoff
  - Property test: push recipient set equals the computed set (Property 12); test with a mocked `exp.host`
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7 — Property 12_

- [x] 2.8 Rate limits and input validation for messaging
  - Apply per-user Redis rate limits to message sending (429 + `Retry-After`); validate all message bodies/socket payloads with zod
  - Property tests: invalid input rejected with no state change (Property 23); over-limit returns 429 with `Retry-After` (Property 24)
  - _Requirements: 12.1, 12.3, 12.4 — Properties 23, 24_

- [x] 2.9 Flip chat/message hooks behind flags
  - Route `useChats`, `useMessages`/`useLocalMessages`, `useChatActions`, `useUnreadCount` through `API_Client`/`Socket_Client` when flagged; fetch messages newer than the last received on reconnect
  - _Requirements: 3.9, 5.18, 13.3, 13.5_

- [x] 2.10 Verify Slice 2 and Check_In
  - Run backend + app tests; manually verify send/receive, receipts, unread counts, delete/forward and push delivery across two devices
  - Report and pause for user feedback
  - _Requirements: 13.2, 13.4_

## Slice 3 — Presence, last seen and typing

- [x] 3.1 Redis presence tracking
  - On first socket connect set `presence:{userId}` (TTL 60s) and add to the socket set; refresh at least every 30s; on last disconnect remove the key and store `last_seen` in Postgres
  - Property/edge test: presence keys expire within 60s on abnormal termination
  - _Requirements: 7.1, 7.2, 7.3, 7.10_

- [x] 3.2 Presence emission with privacy and block filtering
  - Emit presence changes only to users who share a chat and are permitted by Privacy_Settings; omit online/last-seen from responses and events for users who hide them
  - Property tests: presence/last-seen honor privacy (Property 14); block isolation for presence events (Property 7)
  - _Requirements: 7.4, 7.5, 7.9 — Properties 7, 14_

- [x] 3.3 Typing indicators
  - Handle `typing:start`/`typing:stop`: set/clear `typing:{chatId}:{userId}` (TTL 5s), relay to the chat room block-filtered; client clears after 5s of silence
  - _Requirements: 7.6, 7.7, 7.8, 7.9_

- [x] 3.4 Flip presence/typing hooks behind flags
  - Route `usePresence`, `useLastSeen`, `useTypingIndicator` through `Socket_Client` when flagged
  - _Requirements: 3.9, 13.3, 13.5_

- [x] 3.5 Verify Slice 3 and Check_In
  - Run tests; manually verify online/offline, last seen with privacy toggles, and typing across devices
  - Report and pause for user feedback
  - _Requirements: 13.2, 13.4_

## Slice 4 — Calls, call history, missed calls and meetings

- [x] 4.1 Migration for call and meeting tables
  - Add migration for `calls`, `call_history`, `meetings`, `meeting_participants`, `meeting_messages` with indexes
  - _Requirements: 8.4, 8.9, 8.14_

- [x] 4.2 Call creation and history endpoints
  - Implement `POST /calls`, `GET /calls/history?cursor=` (descending, paginated, includes missed), `DELETE /calls/history`
  - Reject calls where the caller is blocked by the callee without notifying the callee
  - Property tests: history pagination (Property 3); blocked-caller rejection (Property 7)
  - _Requirements: 8.4, 8.6, 8.11, 8.12 — Properties 3, 7_

- [x] 4.3 Call signaling over Socket.IO
  - Handle `call:signal` (offer/answer/ice/accept/reject/end/state), `call:join`, `call:leave`: relay to the other participant, reject non-participants, buffer offer + ICE in `callbuf:{callId}` (TTL 60s) when the callee has not joined and flush on join; emit `call:incoming` and enqueue a push on initiation
  - Record missed when unanswered within 60s or rejected; emit `call:missed` badge update; write `call_history` per participant with final state and duration on end
  - Property tests: each ICE relayed as its own event (Property 17); only participants may signal (Property 18); buffered signals delivered on join (Property 19)
  - _Requirements: 8.1, 8.5, 8.7, 8.8, 8.9, 8.10, 8.13 — Properties 17, 18, 19_

- [x] 4.4 Swap signalingService transport
  - Rewrite `src/services/signalingService.ts` so each method emits/subscribes `call:signal` events (one event per ICE candidate) and routes `createCall`/`saveToCallHistory` through REST, preserving the existing method surface so `CallContext`, `AudioCallScreen`, `VideoCallScreen`, `FloatingCallManager` and `useWebRTC` are unchanged
  - _Requirements: 8.1, 8.2, 8.3_

- [x] 4.5 Meetings endpoints and realtime
  - Implement `POST /meetings`, `GET /meetings/:id`; handle `meeting:join`/`meeting:leave` (emit participant change), `meeting:message` (persist + deliver to the room), `meeting:signal` (relay)
  - _Requirements: 8.14, 8.15, 8.16, 8.17_

- [x] 4.6 Flip call/meeting hooks behind flags
  - Route `useIncomingCalls`, `useOutgoingCall`, `useCallHistory`, `useMissedCalls`, `useMeetingRoom` through the Backend when flagged
  - _Requirements: 3.9, 13.3, 13.5_

- [x] 4.7 Verify Slice 4 and Check_In
  - Run tests; manually verify audio and video call setup/teardown, missed-call badges, call history, and a multi-party meeting with chat
  - Report and pause for user feedback
  - _Requirements: 13.2, 13.4_

## Slice 5 — Status and broadcasts

- [x] 5.1 Migration for status and broadcast tables
  - Add migration for `statuses` (with `expires_at`), `status_visibility_users`, `status_views`, `broadcast_lists`, `broadcast_recipients` with indexes
  - _Requirements: 9.1, 9.6_

- [x] 5.2 Status endpoints
  - Implement `POST /statuses` (`expires_at = now + 24h`, visibility + selected/excluded users), `GET /statuses` (unexpired, visibility- and privacy-filtered, with unviewed indicators), `POST /statuses/:id/view` (record + emit `status:viewed`), `DELETE /statuses/:id` (remove + request media deletion); emit `status:update` to permitted users
  - Property tests: status TTL (Property 1); expired excluded (Property 2); visibility enforced (Property 15)
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.9 — Properties 1, 2, 15_

- [x] 5.3 Broadcast endpoints
  - Implement broadcast list CRUD (owner-scoped) and `POST /broadcasts/:id/send` creating one direct-chat message per non-blocking recipient, skipping blockers without failing others
  - Property test: one message per non-blocking recipient, blockers skipped (Property 16)
  - _Requirements: 9.6, 9.7, 9.8 — Property 16_

- [x] 5.4 Flip status/broadcast hooks behind flags
  - Route `useStatus`, `useUnviewedStatus`, `useBroadcastLists` through the Backend when flagged
  - _Requirements: 3.9, 13.3, 13.5_

- [x] 5.5 Verify Slice 5 and Check_In
  - Run tests; manually verify posting/viewing statuses with each visibility mode, unviewed indicators, expiry, and broadcast sending with a blocked recipient
  - Report and pause for user feedback
  - _Requirements: 13.2, 13.4_

## Slice 6 — Media storage via presigned URLs

- [x] 6.1 Migration for media_objects
  - Add migration for `media_objects` (object_key PK, owner, category, content_type, size, referenced_by)
  - _Requirements: 10.7_

- [x] 6.2 Presigned URL endpoints
  - Implement `POST /media/upload-url` (prefix-authorized key under the defined prefixes, size/type checked, 400 on violation, URL expiry ≤ 15 min) and `POST /media/download-url` (authorized keys only)
  - Apply a per-user Redis rate limit to upload-url requests
  - Property tests: authorized prefixes enforced (Property 20); upload URLs ≤ 15 min (Property 21); stored references are object keys not URLs (Property 22)
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 12.3 — Properties 20, 21, 22_

- [x] 6.3 App-side mediaService
  - Implement `src/services/mediaService.ts` (`getUploadUrl`, `getDownloadUrl`) that uploads bytes directly to the Object_Store (no bytes through the backend), verifying the installed `expo-file-system` upload API against the versioned docs first
  - _Requirements: 10.1, 10.6, 10.8_

- [x] 6.4 Replace storage usages
  - Replace `src/config/storage.ts` usages and the `VideoCallScreen.tsx` recording upload with `mediaService`; store object keys on messages/statuses/avatars/recordings and resolve download URLs at render time
  - _Requirements: 10.7, 10.9_

- [x] 6.5 Object deletion on delete/expire
  - When a message/status/avatar/recording is deleted or expires, delete the referenced object; retry failed deletions via a `deleteObject` BullMQ job and log the key
  - _Requirements: 10.10, 10.11_

- [x] 6.6 Verify Slice 6 and Check_In
  - Run tests; manually verify upload/download of each media category against MinIO and the call-recording upload
  - Report and pause for user feedback
  - _Requirements: 13.2, 13.4_

## Slice 7 — Scheduled cleanup jobs

- [x] 7.1 Job scheduler with single-run locks
  - Implement `jobs/scheduler.ts` with BullMQ repeatable jobs and Redis-backed single-run locks so each scheduled run executes on exactly one instance; retry failed runs up to 3× with backoff; log deleted row and object counts
  - _Requirements: 11.4, 11.5, 11.6_

- [x] 7.2 Cleanup jobs replacing Cloud Functions
  - Implement hourly expired-status cleanup, daily expired-message cleanup, and 30-minute stale-call cleanup (Stale_Call_Threshold = 3h); each enqueues `deleteObject` jobs for referenced keys
  - Replace `src/services/statusCleanupService.ts` with reliance on the server job
  - _Requirements: 11.1, 11.2, 11.3_

- [x] 7.3 Verify Slice 7 and Check_In
  - Run tests including cleanup-job integration tests against Dev_Stack; verify expired data removal and single-run behavior
  - Report and pause for user feedback
  - _Requirements: 11.4, 12.8, 13.2, 13.4_

## Slice 8 — Remove Legacy Firebase code

- [x] 8.1 Confirm cutover
  - Confirm every Feature_Flag points at the Backend path and no remaining feature depends on Legacy_Firebase_Code
  - All `EXPO_PUBLIC_BACKEND_*` flags are `true` in the repo-root `.env`. Found and removed two remaining live Firestore calls in `VideoCallScreen.tsx` (meeting-minutes chat post → `endpoints.sendMeetingMessage`; report-timing read → `endpoints.getMeeting`). No Firestore/Storage/Functions SDK imports or calls remain in `src/`.
  - _Requirements: 14.1_

- [x] 8.2 Remove Firestore/Storage/Functions app code
  - No Firestore/Storage/Functions SDK imports remained; `src/config/storage.ts` was already deleted. Reduced `src/config/firebaseNative.ts` to a lean Auth-only init. Removed the unreferenced `@react-native-firebase/app` web shim and its `metro.config.js` mapping (web imports `firebase/app` directly in `src/config/firebase.ts`); kept the Auth shim. The functions web shim did not exist.
  - _Requirements: 14.2, 14.6, 14.7_

- [x] 8.3 Remove repository Firebase artifacts and dependencies
  - `functions/`, `firestore.rules`, `storage.rules` were already absent and `firebase.json` was already trimmed to emulator config. `package.json` already contained no Firestore/Storage/Functions deps. Retained `@react-native-firebase/app`, `@react-native-firebase/auth`, the web auth shim, `GoogleService-Info.plist`, `google-services.json` and `.firebaserc` for Auth.
  - _Requirements: 14.3, 14.4, 14.5_

- [x] 8.4 Rewrite affected tests
  - `useChatActions.test.ts` and `useRegistration.test.ts` already mocked the backend API/mediaService; fixed a stale `signInWithPhoneNumber` assertion (RN Firebase v24 two-arg modular API). Rewrote `voiceNoteStorage.test.ts` to mock the backend `mediaService` (MinIO/S3) instead of the old Firebase Storage XHR path. Fixed `AppNavigator.test.tsx`: corrected the `../../components` mock (`IncomingCallManager`) and the no-profile case to the backend 404 contract. All four suites pass.
  - _Requirements: 14.8_

- [x] 8.5 Update documentation
  - Rewrote `CLAUDE.md` to describe the backend architecture + Dev_Stack and that Firebase is Auth-only. Updated `FIREBASE_PHONE_AUTH_SETUP.md` to drop the obsolete Firestore/Storage rule instructions and point at the backend. (Historical implementation notes in `VOICE_CALL_*`/`VIDEO_CALLING_*`/`MEDIA_SHARING_*` left as-is as a record.)
  - _Requirements: 14.9_

- [x] 8.6 Final verification and Check_In
  - `tsc --noEmit` clean on all edited files (only a pre-existing tsconfig `baseUrl` deprecation warning). Full app test suite run in-band: the three Slice-8 target suites plus others pass. Remaining failures are pre-existing and unrelated to Firebase: `dateUtils` (hardcoded 2026 dates now in the past) and native-module Jest resolution for `expo-audio`/`react-native-webrtc` (`useVoicePlayer`, `useVoiceRecorder`, `parentHooks.preservation`, `webrtcSharedContext.bugExploration`). iOS/Android/web device builds not run in this environment (no simulator/emulator access).
  - _Requirements: 14.10, 13.2, 13.4_
