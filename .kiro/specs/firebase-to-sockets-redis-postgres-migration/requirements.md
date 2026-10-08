# Requirements Document

## Introduction

ChitChatBusiness is an Expo React Native app (TypeScript) that currently uses Firebase for authentication, data (Firestore), file storage (Firebase Storage) and server logic (Cloud Functions v1). This feature migrates everything except phone-OTP authentication off Firebase. Firebase Auth remains the identity provider. All other functionality moves to a new Node.js + TypeScript backend backed by PostgreSQL (persistent data), Redis (ephemeral state, pub/sub, job queues), Socket.IO with the Redis adapter (realtime delivery) and an S3-compatible bucket (media files, accessed via presigned URLs).

The migration is incremental. The app talks to a small API and realtime client layer, and each feature slice is cut over one at a time. After each slice the work stops for a check-in with the user. Firestore, Storage and Functions code is deleted only in the final slice. No existing Firestore data is migrated; the new Postgres database starts empty.

Notes on the codebase:
- `package.json` declares Expo SDK `~57` (`expo ^57.0.23`, React Native 0.86.3), while `AGENTS.md` instructs reading the Expo v56.0.0 versioned docs. This mismatch is flagged here. Implementers follow `AGENTS.md` and read the versioned Expo docs before writing app code, and confirm API behavior against the installed SDK version.
- The existing WebRTC call flow (CallContext, AudioCallScreen, VideoCallScreen, FloatingCallManager) stays intact. Only the signaling transport changes.

## Glossary

- **App**: The ChitChatBusiness Expo React Native client, including its web build.
- **Backend**: The new Node.js + TypeScript server in the `server/` directory exposing the REST_API and Realtime_Gateway.
- **REST_API**: The HTTP JSON interface of the Backend.
- **Realtime_Gateway**: The Socket.IO server component of the Backend.
- **API_Client**: The App-side module that wraps REST_API calls, attaches the Firebase_ID_Token and exposes typed methods to hooks and screens.
- **Socket_Client**: The App-side module that manages the Socket.IO connection, authentication handshake, reconnection and event subscription.
- **Firebase_Auth**: Firebase Authentication (phone OTP) via `@react-native-firebase/auth` and its web shim. The only Firebase service retained.
- **Firebase_ID_Token**: The JWT issued by Firebase_Auth that identifies the signed-in user.
- **Auth_Verifier**: The Backend component that validates a Firebase_ID_Token using the Firebase Admin SDK and resolves the caller's user ID.
- **Postgres**: The PostgreSQL database that stores all persistent application data.
- **Redis**: The Redis instance used for presence, typing state, Socket.IO adapter fan-out, rate limiting and job queues.
- **Object_Store**: The S3-compatible bucket (AWS S3, Cloudflare R2 or MinIO) that stores media files.
- **Object_Key**: The string key identifying a file in the Object_Store, stored in Postgres in place of a download URL.
- **Presigned_URL**: A time-limited URL issued by the Backend that lets the App upload or download one Object_Key directly with the Object_Store.
- **Message_TTL**: The 72-hour lifetime of a message, expressed as `expires_at = created_at + 72 hours`.
- **Status_TTL**: The 24-hour lifetime of a status, expressed as `expires_at = created_at + 24 hours`.
- **Stale_Call_Threshold**: 3 hours without update, after which a call record is considered stale.
- **Push_Dispatcher**: The Backend component that sends Expo push notifications through the `exp.host` API.
- **Job_Scheduler**: The Backend component that runs recurring jobs (BullMQ on Redis).
- **Privacy_Settings**: Per-user settings that control visibility of last seen, online presence, profile photo, status and read receipts.
- **Signaling_Event**: A Socket.IO event carrying a WebRTC offer, answer, ICE candidate, call state change or hang-up.
- **Slice**: One incremental migration step (Slice 0 through Slice 8) that ends with a Check_In.
- **Check_In**: A report to the user after a Slice that states what changed, what was verified and what comes next, followed by a pause for user feedback.
- **Feature_Flag**: An App configuration value that selects the Backend path or the legacy Firebase path for one feature during migration.
- **Legacy_Firebase_Code**: App and repository code that depends on Firestore, Firebase Storage or Firebase Functions, including `firestore.rules`, `storage.rules`, the `functions/` directory and the `firebase.json` entries for those services.
- **Dev_Stack**: The local Docker Compose environment that runs Postgres, Redis and MinIO.

## Requirements

### Requirement 1: Backend scaffold and local development stack

**User Story:** As a developer, I want a runnable backend with its data services, so that each feature slice has a foundation to build on.

#### Acceptance Criteria

1. THE Backend SHALL reside in the `server/` directory as a Node.js + TypeScript project with its own `package.json`, `tsconfig.json` and test runner configuration.
2. THE Dev_Stack SHALL define Postgres, Redis and MinIO services in a Docker Compose file at the repository root, with a single command that starts all three.
3. THE Backend SHALL read all configuration (database URL, Redis URL, Object_Store endpoint and credentials, Firebase service account reference, listen port) from environment variables.
4. THE Backend SHALL ship a `.env.example` file in `server/` that lists every required environment variable with placeholder values.
5. WHEN a required environment variable is missing at startup, THE Backend SHALL exit with a non-zero status and an error message that names the missing variable.
6. THE Backend SHALL manage the Postgres schema through versioned, ordered migration files that can be applied to an empty database with a single command.
7. WHEN the migration command is run twice against the same database, THE Backend SHALL apply each migration only once.
8. THE Backend SHALL expose a `GET /health` endpoint that returns HTTP 200 when both the Postgres connection and the Redis connection respond.
9. IF the Postgres connection or the Redis connection fails a health check, THEN THE Backend SHALL return HTTP 503 from `GET /health` with a body that names the failing dependency.
10. THE Backend SHALL write structured JSON logs that include a request ID for every REST_API request.

### Requirement 2: Authentication with Firebase ID tokens

**User Story:** As a user, I want to keep signing in with my phone number and OTP, so that login stays unchanged while the rest of the app moves to the new backend.

#### Acceptance Criteria

1. THE App SHALL continue to authenticate users through Firebase_Auth phone OTP on native platforms and through the existing auth shim on web.
2. THE API_Client SHALL attach the current Firebase_ID_Token to every REST_API request in an `Authorization: Bearer` header.
3. WHEN the Firebase_ID_Token is within 5 minutes of expiry or already expired, THE API_Client SHALL obtain a refreshed token from Firebase_Auth before sending the request.
4. WHEN a REST_API request carries a valid Firebase_ID_Token, THE Auth_Verifier SHALL resolve the Firebase user ID and phone number and make them available to the request handler.
5. IF a REST_API request carries a missing, malformed, expired or revoked Firebase_ID_Token, THEN THE Auth_Verifier SHALL return HTTP 401 with a machine-readable error code.
6. WHEN a verified user calls the Backend for the first time, THE Backend SHALL create a user row in Postgres keyed by the Firebase user ID.
7. WHEN the Socket_Client opens a connection, THE Socket_Client SHALL send the current Firebase_ID_Token in the Socket.IO handshake auth payload.
8. IF the handshake token is missing or invalid, THEN THE Realtime_Gateway SHALL reject the connection with an authentication error.
9. WHEN the Firebase_ID_Token used by an open socket expires, THE Socket_Client SHALL reconnect with a refreshed token.
10. WHEN a user signs out, THE Socket_Client SHALL disconnect and THE App SHALL clear cached Backend state for that user.
11. THE Backend SHALL authorize every REST_API route and Socket.IO event against the verified user ID and not against any user ID supplied in the request body.

### Requirement 3: App-side API and realtime client layer

**User Story:** As a developer, I want a thin API and socket layer in the app, so that features can switch from Firestore to the Backend one at a time without rewriting screens.

#### Acceptance Criteria

1. THE App SHALL provide an API_Client module and a Socket_Client module under `src/` that hooks and screens import in place of direct Firestore calls.
2. THE App SHALL read the Backend base URL from `EXPO_PUBLIC_API_URL` and the socket URL from `EXPO_PUBLIC_SOCKET_URL`, and THE App SHALL list both variables in the project's environment documentation.
3. IF `EXPO_PUBLIC_API_URL` is not set when the App starts, THEN THE App SHALL log an error that names the missing variable.
4. THE API_Client SHALL return typed results and typed errors that include the HTTP status and the Backend error code.
5. WHEN the device has no network connectivity, THE API_Client SHALL reject the request with a network error type distinguishable from an HTTP error.
6. THE Socket_Client SHALL reconnect automatically with exponential backoff after a connection loss.
7. WHEN the Socket_Client reconnects, THE Socket_Client SHALL re-join the rooms for the user's active chats, active call and open meeting.
8. THE Socket_Client SHALL expose a subscribe function that returns an unsubscribe function, so that hooks can detach listeners on unmount.
9. WHERE a Feature_Flag exists for a feature, THE App SHALL select the Backend path or the legacy Firebase path for that feature according to the flag value.
10. THE App SHALL run on iOS, Android and web with the API_Client and Socket_Client.

### Requirement 4: Users, profiles, contacts and push token registration

**User Story:** As a user, I want my profile, contacts and notification registration stored on the new backend, so that other features can rely on them.

#### Acceptance Criteria

1. THE Backend SHALL store user profile fields (display name, about text, avatar Object_Key, phone number, created time) in Postgres.
2. WHEN the App requests the current user's profile, THE REST_API SHALL return the profile of the authenticated user.
3. WHEN the user updates the profile, THE REST_API SHALL persist the change and return the updated profile.
4. WHEN the App submits a list of phone numbers for contact matching, THE REST_API SHALL return the registered users whose phone numbers match, limited to the fields permitted by the matched user's Privacy_Settings.
5. IF a contact-matching request contains more than 500 phone numbers, THEN THE REST_API SHALL return HTTP 413.
6. WHEN the user changes their phone number through Firebase_Auth, THE App SHALL call the REST_API to update the stored phone number, and THE REST_API SHALL reject a number already assigned to another user with HTTP 409.
7. WHEN the App obtains an Expo push token, THE REST_API SHALL store the token for the authenticated user in Postgres.
8. WHEN the user signs out, THE App SHALL call the REST_API to remove that device's push token.
9. THE Backend SHALL store Privacy_Settings per user in Postgres and return them to the owner on request.
10. WHEN the user updates Privacy_Settings, THE REST_API SHALL persist the new values and THE Realtime_Gateway SHALL apply them to subsequent presence, last-seen and read-receipt behavior.
11. WHEN the user blocks or unblocks another user, THE REST_API SHALL add or remove a row in the blocked users table for the authenticated user.
12. THE REST_API SHALL return the authenticated user's blocked user list on request.
13. THE Backend SHALL enforce blocked-user rules on the server for messaging, calling and presence visibility.

### Requirement 5: Chats and messages over REST and Socket.IO

**User Story:** As a user, I want to send and receive messages in real time, so that conversations work as they do today.

#### Acceptance Criteria

1. THE Backend SHALL store chats (direct and group), chat members, and messages in Postgres.
2. THE Backend SHALL support message types text, image, voice, video, file, location, system and catalog.
3. WHEN a user sends a message, THE REST_API SHALL persist the message in Postgres, set `expires_at` to the creation time plus Message_TTL, and return the stored message.
4. WHEN a message is persisted, THE Realtime_Gateway SHALL emit a new-message event to every connected member of the chat except senders blocked by the recipient.
5. IF the authenticated user is not a member of a chat, THEN THE REST_API and THE Realtime_Gateway SHALL reject message read and write operations for that chat with an authorization error.
6. WHEN a recipient's client receives a message, THE Socket_Client SHALL send a delivered acknowledgment, and THE Backend SHALL record the recipient in the message's delivered set and emit the update to the sender.
7. WHEN a recipient opens a chat and views messages, THE App SHALL send a read acknowledgment, and THE Backend SHALL record the recipient in the message's read set and emit the update to the sender.
8. WHERE the recipient's Privacy_Settings disable read receipts, THE Backend SHALL record the read state without emitting the read update to the sender.
9. WHEN the App opens a chat, THE REST_API SHALL return messages in descending creation order using cursor-based pagination with a page size of 50.
10. WHEN a message is sent from a blocked sender, THE Backend SHALL mark the message `blockedMessage` for the blocking recipient and exclude the message from that recipient's unread count and push notifications.
11. THE REST_API SHALL return the chat list for the authenticated user with the last message, per-chat unread count and total unread count.
12. WHEN a user creates a group chat, THE REST_API SHALL create the chat with the creator as admin and the listed members.
13. WHEN a user edits group members or group metadata, THE REST_API SHALL restrict the operation to chat admins and emit the change to the chat room.
14. WHEN a user deletes a message for themselves or for everyone, THE REST_API SHALL apply the deletion and THE Realtime_Gateway SHALL emit the deletion to the chat room.
15. WHEN a user forwards a message, THE REST_API SHALL create a new message in each selected target chat.
16. THE Realtime_Gateway SHALL use the Redis adapter, so that an event emitted on one Backend instance reaches sockets connected to any other Backend instance.
17. IF a client sends the same client-generated message ID twice, THEN THE REST_API SHALL return the originally stored message and persist no duplicate.
18. WHEN the Socket_Client reconnects after a disconnection, THE App SHALL fetch messages newer than the last received message for each active chat.

### Requirement 6: Push notification dispatch

**User Story:** As a user, I want notifications for new messages, so that I notice messages while the app is in the background.

#### Acceptance Criteria

1. WHEN a message is persisted, THE Push_Dispatcher SHALL send an Expo push notification to each chat member other than the sender who has a registered push token.
2. THE Push_Dispatcher SHALL set the notification category to `chat_message` and the data payload to `{ chatId, senderId, type: "message" }`.
3. IF the sender is blocked by a recipient or the message is marked `blockedMessage` for that recipient, THEN THE Push_Dispatcher SHALL send no notification to that recipient.
4. IF the `exp.host` API reports a token as `DeviceNotRegistered`, THEN THE Push_Dispatcher SHALL delete that token from Postgres.
5. IF a push request to `exp.host` fails with a retryable error, THEN THE Push_Dispatcher SHALL retry up to 3 times with exponential backoff.
6. THE Push_Dispatcher SHALL run outside the REST_API request path, so that message sending latency does not depend on `exp.host` response time.
7. WHILE a recipient has an open authenticated socket joined to the chat room, THE Push_Dispatcher SHALL omit the push notification for that recipient.

### Requirement 7: Presence, last seen and typing indicators

**User Story:** As a user, I want to see who is online and typing, so that conversations feel live, while keeping control over what I reveal.

#### Acceptance Criteria

1. WHEN a user's first socket connects, THE Realtime_Gateway SHALL set a presence key for that user in Redis with a time-to-live of 60 seconds.
2. WHILE a user has at least one open socket, THE Realtime_Gateway SHALL refresh the presence key at least once every 30 seconds.
3. WHEN a user's last socket disconnects, THE Realtime_Gateway SHALL remove the presence key and store the disconnect time as the user's last-seen time in Postgres.
4. WHEN a presence change occurs, THE Realtime_Gateway SHALL emit the change to users who share a chat with that user and are permitted by Privacy_Settings to see it.
5. WHERE a user's Privacy_Settings hide online presence or last seen, THE REST_API and THE Realtime_Gateway SHALL omit that information from responses and events sent to other users.
6. WHEN a user starts typing in a chat, THE Socket_Client SHALL emit a typing event, and THE Realtime_Gateway SHALL relay it to the other members of the chat room.
7. WHEN a typing event is received, THE Realtime_Gateway SHALL store a typing key in Redis with a time-to-live of 5 seconds.
8. WHEN no typing event has been received for 5 seconds, THE App SHALL clear the typing indicator for that user.
9. IF a blocked user's typing or presence event targets the blocking user, THEN THE Realtime_Gateway SHALL withhold the event from the blocking user.
10. WHEN the Backend process terminates abnormally, THE Redis presence keys SHALL expire within 60 seconds and mark affected users offline.

### Requirement 8: Call signaling over Socket.IO, call history and missed calls

**User Story:** As a user, I want audio and video calls to keep working, so that the transport change is invisible to me.

#### Acceptance Criteria

1. THE Realtime_Gateway SHALL relay Signaling_Events (offer, answer, ICE candidate, accept, reject, end, state change) between the participants of a call.
2. THE App SHALL send each ICE candidate as its own Signaling_Event, replacing the Firestore `arrayUnion` write.
3. THE App SHALL keep the existing WebRTC peer connection, CallContext, AudioCallScreen, VideoCallScreen and FloatingCallManager behavior and replace only the signaling transport in `src/services/signalingService.ts`.
4. WHEN a user initiates a call, THE Backend SHALL create a call record in Postgres with caller, callee or participants, call type (audio or video), state and timestamps.
5. WHEN a call is initiated, THE Realtime_Gateway SHALL emit an incoming-call event to the callee's connected sockets and THE Push_Dispatcher SHALL send a push notification to the callee.
6. IF the caller is blocked by the callee, THEN THE Backend SHALL reject the call without notifying the callee.
7. IF a Signaling_Event is sent by a user who is not a participant of the call, THEN THE Realtime_Gateway SHALL discard the event and return an authorization error to the sender.
8. WHEN an offer is sent before the callee's socket has joined the call room, THE Backend SHALL retain the offer and ICE candidates in Redis for up to 60 seconds and deliver them when the callee joins.
9. WHEN a call ends, THE Backend SHALL set the final call state and duration and write a call history entry for each participant.
10. WHEN a call is not answered within 60 seconds or is rejected, THE Backend SHALL record the call as missed for the callee.
11. THE REST_API SHALL return call history and missed calls for the authenticated user in descending time order with cursor-based pagination.
12. THE REST_API SHALL support clearing the authenticated user's call history.
13. WHEN a missed call is recorded, THE Realtime_Gateway SHALL emit an event that updates the missed-call badge on the callee's connected clients.
14. THE Backend SHALL store meetings, meeting participants and meeting chat messages in Postgres.
15. WHEN a user joins or leaves a meeting, THE Realtime_Gateway SHALL emit the participant change to everyone in the meeting room.
16. WHEN a meeting chat message is sent, THE Realtime_Gateway SHALL deliver the message to everyone in the meeting room.
17. THE Realtime_Gateway SHALL relay meeting signaling events between meeting participants.

### Requirement 9: Status updates and broadcast lists

**User Story:** As a user, I want to post statuses and send broadcasts, so that I can share with chosen audiences.

#### Acceptance Criteria

1. WHEN a user posts a status, THE REST_API SHALL persist it in Postgres with `expires_at` set to the creation time plus Status_TTL, a visibility setting and an optional list of selected users.
2. WHEN the App requests statuses, THE REST_API SHALL return only unexpired statuses whose visibility rules and Privacy_Settings permit the requesting user to see them.
3. WHEN a user views another user's status, THE REST_API SHALL add the viewer to the status's viewed set, and THE Realtime_Gateway SHALL emit the update to the status owner.
4. THE REST_API SHALL return the unviewed status indicator state for each contact to the authenticated user.
5. WHEN a user deletes their status, THE REST_API SHALL remove the status and its Object_Key reference and request deletion of the media object.
6. THE Backend SHALL store broadcast lists and their recipients in Postgres, scoped to the owner.
7. WHEN a user sends a broadcast message, THE REST_API SHALL create an individual message in the direct chat with each recipient.
8. IF a broadcast recipient has blocked the sender, THEN THE REST_API SHALL skip that recipient without returning an error for the other recipients.
9. WHEN a status is posted, THE Realtime_Gateway SHALL emit a status-update event to connected users who are permitted to view it.

### Requirement 10: Media storage with presigned URLs

**User Story:** As a user, I want to upload and view photos, voice notes, videos, files and recordings, so that media sharing continues to work without Firebase Storage.

#### Acceptance Criteria

1. WHEN the App requests an upload for a media file, THE REST_API SHALL return a Presigned_URL for upload, the Object_Key and the expiry time.
2. THE REST_API SHALL generate Object_Keys under the prefixes `avatars/{userId}/`, `chats/{chatId}/media/`, `chats/{chatId}/voice/`, `groups/{chatId}/`, `status/{userId}/` and `meetings/{meetingId}/`.
3. IF the authenticated user is not permitted to write under the requested prefix, THEN THE REST_API SHALL refuse to issue a Presigned_URL and return an authorization error.
4. THE REST_API SHALL issue upload Presigned_URLs that expire within 15 minutes.
5. IF the requested content type or declared size exceeds the configured limit for the media category, THEN THE REST_API SHALL reject the upload request with HTTP 400.
6. WHEN the App needs to display or play a stored file, THE REST_API SHALL return a Presigned_URL for download for each Object_Key the authenticated user is authorized to read.
7. THE Backend SHALL store the Object_Key and not a download URL in Postgres for every stored file.
8. THE App SHALL upload files directly to the Object_Store with the Presigned_URL and not stream file bytes through the Backend.
9. THE App SHALL replace `src/config/storage.ts` and the recording upload in `VideoCallScreen.tsx` with calls to the media service backed by the Backend.
10. WHEN a message, status, avatar or recording is deleted or expires, THE Backend SHALL delete the referenced object from the Object_Store.
11. IF an object deletion fails, THEN THE Backend SHALL retry the deletion through the Job_Scheduler and log the Object_Key.
12. THE Dev_Stack SHALL provide a MinIO bucket that the Backend uses for local development without changes to application code.

### Requirement 11: Scheduled cleanup jobs

**User Story:** As an operator, I want expired data removed automatically, so that the migrated system keeps behaving like the Cloud Functions it replaces.

#### Acceptance Criteria

1. THE Job_Scheduler SHALL run an expired-status cleanup job every hour that deletes statuses past `expires_at` and their media objects.
2. THE Job_Scheduler SHALL run an expired-message cleanup job every day that deletes messages past `expires_at` and their media objects.
3. THE Job_Scheduler SHALL run a stale-call cleanup job every 30 minutes that deletes call records not updated within the Stale_Call_Threshold.
4. WHEN a cleanup job is scheduled on multiple Backend instances, THE Job_Scheduler SHALL execute each scheduled run on exactly one instance.
5. IF a cleanup job run fails, THEN THE Job_Scheduler SHALL log the error and retry the run up to 3 times with exponential backoff.
6. WHEN a cleanup job completes, THE Backend SHALL log the number of deleted rows and deleted objects.
7. WHERE the REST_API or Realtime_Gateway returns messages or statuses, THE Backend SHALL exclude rows past `expires_at` even when the cleanup job has not yet run.

### Requirement 12: Backend security and reliability

**User Story:** As an operator, I want the backend to be safe by default, so that exposing it to the internet does not weaken the app's privacy.

#### Acceptance Criteria

1. THE Backend SHALL validate every REST_API request body, query string and Socket.IO event payload against a schema and reject invalid input with HTTP 400 or an error acknowledgment.
2. THE Backend SHALL use parameterized queries for all Postgres access.
3. THE Backend SHALL apply per-user rate limits stored in Redis to message sending, media upload requests and contact matching.
4. IF a user exceeds a rate limit, THEN THE Backend SHALL return HTTP 429 with a `Retry-After` header.
5. THE Backend SHALL restrict allowed CORS origins and Socket.IO origins to a configured list.
6. THE Backend SHALL redact Firebase_ID_Tokens, push tokens and Presigned_URLs from logs.
7. WHEN the Backend receives SIGTERM, THE Backend SHALL stop accepting new connections, finish in-flight requests and close the Postgres, Redis and socket connections within 15 seconds.
8. THE Backend SHALL ship automated tests that run against a Postgres and Redis instance from the Dev_Stack for authentication, authorization, message delivery and cleanup jobs.
9. THE Backend documentation SHALL state that the REST_API and Realtime_Gateway require TLS termination in front of the Backend for any non-local deployment.

### Requirement 13: Incremental cutover and check-ins

**User Story:** As the project owner, I want the migration delivered slice by slice with updates, so that I can review progress and the app stays working throughout.

#### Acceptance Criteria

1. THE migration SHALL be delivered in the following Slices: Slice 0 backend scaffold and client layer; Slice 1 users, profile, privacy, blocked users, contacts and push token registration; Slice 2 chats, messages and the Push_Dispatcher; Slice 3 presence, last seen and typing; Slice 4 calls, call history, missed calls and meetings; Slice 5 status and broadcasts; Slice 6 media storage; Slice 7 scheduled cleanup jobs; Slice 8 removal of Legacy_Firebase_Code.
2. WHEN a Slice is complete, THE implementer SHALL deliver a Check_In that lists the files changed, the tests run with their results, the manual verification steps and any open issues, and SHALL wait for user feedback before starting the next Slice.
3. WHILE a Slice is in progress, THE App SHALL keep every feature from other Slices working on its existing path.
4. WHEN a Slice is complete, THE App SHALL build and its automated tests SHALL pass.
5. THE implementer SHALL leave the existing Firestore implementation of a feature in place until that feature's Backend path is verified, except for the final removal in Slice 8.
6. IF a Slice depends on an unfinished earlier Slice, THEN THE implementer SHALL report the dependency in the Check_In and not start the dependent work.
7. THE migration SHALL start with an empty Postgres database and include no Firestore export or import tooling.

### Requirement 14: Removal of Legacy Firebase code

**User Story:** As a maintainer, I want all unused Firebase code removed at the end, so that the codebase has a single data path and no dead dependencies.

#### Acceptance Criteria

1. WHEN Slice 8 starts, THE implementer SHALL confirm that every Feature_Flag points at the Backend path and that no remaining feature depends on Legacy_Firebase_Code.
2. THE App SHALL contain no imports of `@react-native-firebase/firestore`, `@react-native-firebase/storage`, `@react-native-firebase/functions`, or of the Firestore, Storage and Functions modules of the `firebase` web SDK after Slice 8.
3. WHEN Slice 8 completes, THE repository SHALL not contain the `functions/` directory, `firestore.rules`, `storage.rules`, or the Firestore, Storage and Functions entries in `firebase.json`.
4. WHEN Slice 8 completes, THE `package.json` SHALL not list `@react-native-firebase/firestore`, `@react-native-firebase/storage` or `@react-native-firebase/functions`.
5. THE App SHALL retain `@react-native-firebase/app`, `@react-native-firebase/auth`, the web auth shim, `GoogleService-Info.plist` and `google-services.json`.
6. WHEN Slice 8 completes, THE App SHALL remove the web shims for `@react-native-firebase/functions` and, if no longer referenced, for `@react-native-firebase/app` from `src/shims/` and `metro.config.js`, and SHALL keep the shim required by Firebase_Auth on web.
7. WHEN Slice 8 completes, THE App SHALL remove `src/config/firebaseNative.ts` Firestore and Storage exports and `src/config/storage.ts`, and retain only the Auth exports.
8. THE implementer SHALL rewrite the tests `src/hooks/__tests__/useChatActions.test.ts`, `src/hooks/__tests__/useRegistration.test.ts`, `src/navigation/__tests__/AppNavigator.test.tsx` and `src/utils/__tests__/voiceNoteStorage.test.ts` to mock the API_Client and Socket_Client instead of Firebase services.
9. WHEN Slice 8 completes, THE implementer SHALL update the repository documentation (including `CLAUDE.md` and the setup guides that mention Firestore or Storage) to describe the Backend architecture and the Dev_Stack.
10. WHEN Slice 8 completes, THE App SHALL build for iOS, Android and web, and the full automated test suite SHALL pass.
