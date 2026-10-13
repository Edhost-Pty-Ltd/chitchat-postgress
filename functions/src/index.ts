// ─── Cloud Functions (2nd gen) ───────────────────────────────────────────────
// Server-side maintenance, cleanup, and companion-device linking.

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp as AdminTimestamp, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import * as logger from 'firebase-functions/logger';

if (getApps().length === 0) {
  initializeApp();
}

// Global defaults for every function in this codebase.
setGlobalOptions({
  region: 'us-central1',
  maxInstances: 10,
  // cpu / concurrency are valid on gen 2 — leave defaults unless you need more.
});

const FIRESTORE_BATCH_LIMIT = 500;

async function deleteRefsInBatches(
  refs: FirebaseFirestore.DocumentReference[],
): Promise<number> {
  const dbAdmin = getFirestore();
  let deleted = 0;
  for (let i = 0; i < refs.length; i += FIRESTORE_BATCH_LIMIT) {
    const slice = refs.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = dbAdmin.batch();
    slice.forEach((ref) => batch.delete(ref));
    await batch.commit();
    deleted += slice.length;
  }
  return deleted;
}

function storagePathFromUrl(url?: string | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/o\/([^?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function deleteStorageByUrls(urls: Array<string | null | undefined>): Promise<void> {
  const bucket = getStorage().bucket();
  await Promise.all(
    urls.map(async (url) => {
      const path = storagePathFromUrl(url);
      if (!path) return;
      try {
        await bucket.file(path).delete();
      } catch (err: any) {
        if (err?.code !== 404) {
          logger.warn('[cleanup] Failed to delete storage object:', path, err?.message);
        }
      }
    }),
  );
}

// ─── 1. Expired statuses ────────────────────────────────────────────────────
export const cleanupExpiredStatuses = onSchedule('every 60 minutes', async () => {
  const dbAdmin = getFirestore();
  const now = AdminTimestamp.now();

  const snap = await dbAdmin
    .collection('statuses')
    .where('expiresAt', '<=', now)
    .limit(1000)
    .get();

  if (snap.empty) {
    logger.info('[cleanupExpiredStatuses] Nothing to clean.');
    return;
  }

  await deleteStorageByUrls(snap.docs.map((d) => d.data().mediaUrl));
  const deleted = await deleteRefsInBatches(snap.docs.map((d) => d.ref));
  logger.info(`[cleanupExpiredStatuses] Deleted ${deleted} expired status(es).`);
});

// ─── 2. Expired messages ────────────────────────────────────────────────────
export const cleanupExpiredMessages = onSchedule('every 24 hours', async () => {
  const dbAdmin = getFirestore();
  const now = AdminTimestamp.now();

  const snap = await dbAdmin
    .collectionGroup('messages')
    .where('expiresAt', '<=', now)
    .limit(2000)
    .get();

  if (snap.empty) {
    logger.info('[cleanupExpiredMessages] Nothing to clean.');
    return;
  }

  const mediaUrls: Array<string | null | undefined> = [];
  snap.docs.forEach((d) => {
    const m = d.data();
    mediaUrls.push(m.imageUrl, m.voiceUrl, m.videoUrl, m.fileUrl, m.thumbnailUrl);
  });
  await deleteStorageByUrls(mediaUrls);

  const deleted = await deleteRefsInBatches(snap.docs.map((d) => d.ref));
  logger.info(`[cleanupExpiredMessages] Deleted ${deleted} expired message(s).`);
});

// ─── 3. Stale calls ─────────────────────────────────────────────────────────
export const cleanupStaleCalls = onSchedule('every 30 minutes', async () => {
  const dbAdmin = getFirestore();
  const cutoff3h = AdminTimestamp.fromMillis(Date.now() - 3 * 60 * 60 * 1000);

  const toDelete: FirebaseFirestore.DocumentReference[] = [];
  const staleCalls = await dbAdmin
    .collection('calls')
    .where('updatedAt', '<=', cutoff3h)
    .limit(1000)
    .get();
  staleCalls.forEach((d) => toDelete.push(d.ref));

  if (toDelete.length === 0) {
    logger.info('[cleanupStaleCalls] Nothing to clean.');
    return;
  }

  const deleted = await deleteRefsInBatches(toDelete);
  logger.info(`[cleanupStaleCalls] Deleted ${deleted} stale call doc(s).`);
});

// ─── 4. Expired device link tokens ─────────────────────────────────────────
export const cleanupExpiredLinkTokens = onSchedule('every 60 minutes', async () => {
  const dbAdmin = getFirestore();
  const cutoff = AdminTimestamp.fromMillis(Date.now() - 60 * 60 * 1000);

  const snap = await dbAdmin
    .collection('deviceLinkTokens')
    .where('expiresAt', '<=', cutoff)
    .limit(500)
    .get();

  if (snap.empty) {
    logger.info('[cleanupExpiredLinkTokens] Nothing to clean.');
    return;
  }

  const deleted = await deleteRefsInBatches(snap.docs.map((d) => d.ref));
  logger.info(`[cleanupExpiredLinkTokens] Deleted ${deleted} expired link token(s).`);
});

// ─── Companion-device linking ──────────────────────────────────────────────
const MAX_LINK_AGE_MS = 15 * 60 * 1000;

export const mintCompanionToken = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to link a device.');
  }
  const ownerUid = request.auth.uid;

  if (request.auth.token?.companion === true) {
    throw new HttpsError('permission-denied', 'Companion devices cannot link other devices.');
  }

  const requestId = (request.data?.requestId ?? '') as string;
  if (typeof requestId !== 'string' || requestId.length !== 64 || !/^[0-9a-f]+$/i.test(requestId)) {
    throw new HttpsError('invalid-argument', 'Invalid requestId.');
  }

  const dbAdmin = getFirestore();
  const tokenRef = dbAdmin.collection('deviceLinkTokens').doc(requestId);
  const tokenSnap = await tokenRef.get();
  if (!tokenSnap.exists) {
    throw new HttpsError('not-found', 'Link request not found.');
  }
  const t = tokenSnap.data()!;

  if (t.requesterUid === ownerUid) {
    throw new HttpsError('invalid-argument', 'You cannot link a device to itself.');
  }

  const expiresAt = t.expiresAt?.toDate ? t.expiresAt.toDate() : new Date(t.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || Date.now() > expiresAt.getTime() + MAX_LINK_AGE_MS) {
    throw new HttpsError('failed-precondition', 'This link request has expired.');
  }

  if (t.companionCustomToken) {
    throw new HttpsError('already-exists', 'A companion token has already been minted for this request.');
  }

  if (t.ownerUid && t.ownerUid !== ownerUid) {
    throw new HttpsError('permission-denied', 'This request has already been claimed by another account.');
  }

  const customToken = await getAuth().createCustomToken(ownerUid, { companion: true });

  logger.info('mintCompanionToken', { ownerUid, requestId, deviceName: t.deviceName ?? null });

  return { customToken };
});

// ─── Push Notifications for new messages ───────────────────────────────────
// Triggers whenever a chat document is written (i.e. lastMessage is updated).
// Fans out an Expo push notification to every member except the sender.
//
// Token storage:   users/{memberId}/pushTokens/{deviceId} → { token, platform }
// Push delivery:   Expo Push API  (https://exp.host/--/api/v2/push/send)
//                  Works for both iOS and Android Expo-managed apps.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as https from 'https';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  badge?: number;
  channelId?: string;
}

interface ExpoTicket { status: string; message?: string; details?: { error?: string } }

/** POST a batch of Expo push messages (max 100 per call). Returns per-message tickets. */
async function sendExpoPushBatch(messages: ExpoPushMessage[]): Promise<ExpoTicket[]> {
  if (messages.length === 0) return [];

  const payload = JSON.stringify(messages);

  return new Promise<ExpoTicket[]>((resolve, reject) => {
    const url = new URL(EXPO_PUSH_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            logger.warn('[sendExpoPushBatch] HTTP error:', res.statusCode, body);
            resolve([]);
            return;
          }
          try {
            const parsed = JSON.parse(body) as { data?: ExpoTicket[] };
            const tickets = parsed.data ?? [];
            const errors = tickets.filter(r => r.status !== 'ok');
            if (errors.length > 0) {
              logger.warn('[sendExpoPushBatch] Per-token errors:', JSON.stringify(errors));
            } else {
              logger.info(`[sendExpoPushBatch] All ${messages.length} push(es) delivered OK.`);
            }
            resolve(tickets);
          } catch {
            resolve([]);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export const sendMessageNotification = onDocumentWritten(
  'chats/{chatId}',
  async (event) => {
    const after  = event.data?.after;
    const before = event.data?.before;

    if (!after?.exists) return; // chat deleted — nothing to do

    const chatData   = after.data()!;
    const lastMsg    = chatData.lastMessage as {
      text?: string;
      senderId?: string;
      timestamp?: FirebaseFirestore.Timestamp;
      type?: string;
    } | undefined;

    if (!lastMsg?.senderId || !lastMsg?.timestamp) return;

    // Only fire when lastMessage.timestamp actually changed (a new message was sent)
    const prevLastMsg = before?.exists ? (before.data()!.lastMessage as typeof lastMsg) : undefined;
    const prevTs = prevLastMsg?.timestamp?.toMillis?.() ?? 0;
    const newTs  = lastMsg.timestamp.toMillis?.() ?? 0;
    if (newTs <= prevTs) return;  // timestamp didn't advance — skip

    const senderId   = lastMsg.senderId;
    const members    = (chatData.members ?? []) as string[];
    const isGroup    = chatData.type === 'group';
    const groupName  = (chatData.groupName ?? 'Group') as string;
    const msgText    = lastMsg.text || (lastMsg.type === 'image' ? '📷 Photo' : lastMsg.type === 'voice' ? '🎤 Voice message' : '📎 File');
    // Users who muted this chat — skip their push notifications
    const mutedBy    = (chatData.mutedBy ?? {}) as Record<string, boolean>;

    const dbAdmin = getFirestore();

    // Resolve sender display name for group chats
    let senderName = 'Someone';
    if (isGroup) {
      try {
        const senderDoc = await dbAdmin.collection('users').doc(senderId).get();
        if (senderDoc.exists) {
          const d = senderDoc.data()!;
          const dn = (d.displayName ?? '').trim();
          const ph = (d.phone ?? '').trim();
          const PHONE_LIKE = /^\+?[\d\s\-()]{5,}$/;
          senderName = (dn && !PHONE_LIKE.test(dn) && dn !== ph) ? dn : (ph || dn || 'Someone');
        }
      } catch (err) {
        logger.warn('[sendMessageNotification] Could not resolve sender name:', err);
      }
    }

    // Collect all push tokens for non-sender members
    const pushMessages: ExpoPushMessage[] = [];
    const tokenRefs: FirebaseFirestore.DocumentReference[] = [];

    const seenTokens = new Set<string>();
    await Promise.all(
      members
        .filter((uid) => uid !== senderId)
        .filter((uid) => mutedBy[uid] !== true)  // skip recipients who muted this chat
        .map(async (uid) => {
          try {
            const tokensSnap = await dbAdmin
              .collection('users').doc(uid)
              .collection('pushTokens')
              .get();

            for (const tokenDoc of tokensSnap.docs) {
              const token = tokenDoc.data().token as string | undefined;
              if (!token || !token.startsWith('ExponentPushToken[')) continue;
              // Skip duplicate token values (same device registered more than once)
              if (seenTokens.has(token)) continue;
              seenTokens.add(token);

              pushMessages.push({
                to:        token,
                sound:     'default',
                title:     isGroup ? groupName : senderName,
                body:      isGroup ? `${senderName}: ${msgText}` : msgText,
                channelId: 'default',
                data: {
                  chatId:     event.params.chatId,
                  senderId,
                  type:       'message',
                },
              });
              tokenRefs.push(tokenDoc.ref);
            }
          } catch (err) {
            logger.warn(`[sendMessageNotification] Failed to get tokens for uid ${uid}:`, err);
          }
        }),
    );

    if (pushMessages.length === 0) return;

    // Expo limits 100 messages per batch
    const BATCH_SIZE = 100;
    for (let i = 0; i < pushMessages.length; i += BATCH_SIZE) {
      const tickets = await sendExpoPushBatch(pushMessages.slice(i, i + BATCH_SIZE));
      tickets.forEach((t, j) => {
        const err = t.details?.error;
        if (t.status === 'error' && (err === 'DeviceNotRegistered' || err === 'InvalidCredentials')) {
          const ref = tokenRefs[i + j];
          if (ref) ref.delete().catch(() => {});
        }
      });
    }

    logger.info(`[sendMessageNotification] Sent ${pushMessages.length} push(es) for chat ${event.params.chatId}`);
  },
);

// ─── Revoke companion device token ─────────────────────────────────────────
// Called by the primary device immediately after deleting a linkedDevices doc.
// Calls admin.auth().revokeRefreshTokens(ownerUid) so that any companion
// holding a custom-token session for that ownerUid is forced to re-authenticate
// on their next ID-token refresh (within 1 hour). This closes the gap where a
// non-cooperative companion could ignore the client-side watchCompanionLink
// listener and keep a live owner session indefinitely.
//
// Security:
//  - Caller must be signed in as the primary (non-companion) owner.
//  - The companion claim on a revoked session causes ID-token refresh to fail,
//    signing the companion out on their next Firestore call.
export const revokeDeviceToken = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const ownerUid = request.auth.uid;

  // Companions cannot revoke tokens — only the primary owner can.
  if (request.auth.token?.companion === true) {
    throw new HttpsError('permission-denied', 'Companion devices cannot revoke tokens.');
  }

  // Revoke all refresh tokens issued for this UID. Any session (including
  // companions) will be forced to re-authenticate within the ID-token TTL
  // (~1 hour). Since companions sign in with a custom token whose uid equals
  // the owner uid, this covers them.
  try {
    await getAuth().revokeRefreshTokens(ownerUid);
    logger.info('[revokeDeviceToken] Revoked refresh tokens for uid:', ownerUid);
  } catch (err: any) {
    logger.error('[revokeDeviceToken] Failed to revoke tokens:', err?.message);
    throw new HttpsError('internal', 'Failed to revoke tokens. Please try again.');
  }

  return { ok: true };
});

// ─── Profile View Tracker ────────────────────────────────────────────────────
// Callable that atomically increments profileViews / profileViewsToday on
// users/{viewedUid} using the Admin SDK, which bypasses client-side rules
// entirely. Running server-side closes two gaps:
//   1. A client could call increment() repeatedly — the server enforces one
//      call per invocation and the caller can't forge the result.
//   2. The client-side rule "profileViews == resource + 1" silently fails on
//      the very first view because the field doesn't exist yet; the Admin SDK
//      FieldValue.increment() initialises a missing field to 0 then adds 1.
export const recordProfileView = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in to record a profile view.');
  }

  const viewerUid = request.auth.uid;
  const viewedUid = (request.data?.viewedUid ?? '') as string;

  if (!viewedUid || typeof viewedUid !== 'string') {
    throw new HttpsError('invalid-argument', 'viewedUid is required.');
  }
  // Silently ignore self-views — don't inflate the owner's own counter.
  if (viewerUid === viewedUid) return { ok: true };

  const dbAdmin = getFirestore();
  const userRef = dbAdmin.collection('users').doc(viewedUid);

  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const snap = await userRef.get();
  const storedDayKey: string = snap.exists ? (snap.data()?.profileViewsDayKey ?? '') : '';

  // Reset today's counter when the day rolls over; otherwise increment.
  // FieldValue.increment(1) initialises to 1 if the field is absent.
  const todayIncrement = storedDayKey === todayKey
    ? FieldValue.increment(1)
    : 1;

  await userRef.set(
    {
      profileViews:          FieldValue.increment(1),
      profileViewsToday:     todayIncrement,
      profileViewsDayKey:    todayKey,
      profileViewsUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  logger.info('[recordProfileView]', { viewerUid, viewedUid });
  return { ok: true };
});

// ─── Meeting Recording Summarizer ───────────────────────────────────────────
// Callable that fetches the audio from a Firebase Storage download URL,
// uploads it to the Gemini Files API, transcribes + summarises it, then
// deletes the temporary Gemini file.  Running server-side sidesteps the
// React Native JS-bridge size limit that blocks large binary transfers from
// the client.
//
// Expected request.data:
//   { url: string, recordingId: string }
//
// Returns:
//   { minutes: string }

const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
const GEMINI_MODEL   = 'gemini-3.8-flash';

export const summarizeMeetingRecording = onCall(
  { timeoutSeconds: 300, memory: '512MiB', secrets: ['GEMINI_API_KEY'] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in.');
    }

    const url         = (request.data?.url         ?? '') as string;
    const recordingId = (request.data?.recordingId ?? '') as string;

    if (!url || typeof url !== 'string') {
      throw new HttpsError('invalid-argument', 'url is required.');
    }
    if (!GEMINI_API_KEY) {
      throw new HttpsError('failed-precondition', 'GEMINI_API_KEY is not set on the server.');
    }

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

    // 1. Download audio from Firebase Storage into memory
    const audioRes = await fetch(url);
    if (!audioRes.ok) throw new HttpsError('unavailable', `Failed to fetch audio (HTTP ${audioRes.status}).`);
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer());
    const audioSize   = audioBuffer.byteLength;
    logger.info(`[summarizeMeetingRecording] Fetched audio: ${audioSize} bytes, id=${recordingId}`);

    // 2. Start a resumable upload to the Gemini Files API
    const startRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol':              'resumable',
          'X-Goog-Upload-Command':               'start',
          'X-Goog-Upload-Header-Content-Length': String(audioSize),
          'X-Goog-Upload-Header-Content-Type':   'audio/mp4',
          'Content-Type':                        'application/json',
        },
        body: JSON.stringify({ file: { display_name: `rec_${recordingId}.m4a` } }),
      },
    );
    if (!startRes.ok) throw new HttpsError('unavailable', `Gemini upload start failed: ${await startRes.text()}`);

    const uploadUrl = startRes.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new HttpsError('internal', 'Gemini did not return an upload URL.');

    // 3. Upload the binary content
    const uploadRes = await fetch(uploadUrl, {
      method:  'POST',
      headers: {
        'Content-Length':        String(audioSize),
        'X-Goog-Upload-Offset':  '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: audioBuffer,
    });
    if (!uploadRes.ok) throw new HttpsError('unavailable', `Gemini upload failed: ${await uploadRes.text()}`);

    const uploadData     = await uploadRes.json() as any;
    const geminiFileName = uploadData.file?.name as string | undefined;
    const fileUri        = uploadData.file?.uri  as string | undefined;
    if (!fileUri || !geminiFileName) throw new HttpsError('internal', 'Gemini did not return a file URI.');
    logger.info(`[summarizeMeetingRecording] Uploaded to Gemini: ${geminiFileName}`);

    // 4. Poll until the file is ACTIVE (Gemini processes audio asynchronously)
    for (let i = 0; i < 20; i++) {
      const stateData = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${geminiFileName}?key=${GEMINI_API_KEY}`,
      ).then(r => r.json()) as any;
      const state = stateData.state as string | undefined;
      logger.info(`[summarizeMeetingRecording] File state (attempt ${i + 1}): ${state}`);
      if (state === 'ACTIVE') break;
      if (state === 'FAILED') throw new HttpsError('internal', 'Gemini file processing failed.');
      if (i === 19) throw new HttpsError('deadline-exceeded', 'Timed out waiting for Gemini file to become ACTIVE.');
      await sleep(3000);
    }

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    // Helper: POST to Gemini with up to 4 retries on capacity/rate-limit errors
    async function geminiPost(body: object): Promise<any> {
      let lastError = '';
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt > 0) await sleep(5000 * attempt); // 5s, 10s, 15s backoff
        const res  = await fetch(endpoint, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        const data = await res.json() as any;
        if (res.ok) return data;
        const msg: string = data?.error?.message ?? `Gemini error ${res.status}`;
        lastError = msg;
        if (res.status === 429 || res.status === 503 || msg.toLowerCase().includes('high demand') || msg.toLowerCase().includes('quota')) {
          logger.warn(`[summarizeMeetingRecording] Capacity error (attempt ${attempt + 1}), retrying...`);
          continue;
        }
        throw new HttpsError('internal', msg);
      }
      throw new HttpsError('resource-exhausted', `Gemini overloaded after retries: ${lastError}`);
    }

    // 5. Transcribe
    logger.info('[summarizeMeetingRecording] Starting transcription...');
    const transcriptData = await geminiPost({
      contents: [{
        parts: [
          { text: 'Transcribe this meeting recording verbatim. Include every spoken word accurately. Do not summarize — produce a full, clean transcript only. Label each speaker as "Speaker 1:", "Speaker 2:", etc. when voices change.' },
          { fileData: { mimeType: 'audio/mp4', fileUri } },
        ],
      }],
    });

    const tCand      = transcriptData.candidates?.[0];
    const transcript = ((tCand?.content?.parts ?? []) as any[]).map((p: any) => p.text ?? '').join('').trim();
    logger.info(`[summarizeMeetingRecording] Transcript: ${transcript.length} chars, finishReason: ${tCand?.finishReason}`);
    if (!transcript) throw new HttpsError('internal', `Empty transcript (finishReason: ${tCand?.finishReason ?? 'unknown'}).`);

    // 6. Summarize
    logger.info('[summarizeMeetingRecording] Starting summarization...');
    const promptText = [
      'You are a professional executive meeting secretary. Using the transcript below, produce formal, structured meeting minutes.',
      '',
      'Format your output EXACTLY as follows:',
      '',
      'MEETING MINUTES',
      '---',
      '',
      'EXECUTIVE SUMMARY',
      '[2-4 sentence overview of the meeting\'s purpose and main outcomes]',
      '',
      'KEY TOPICS DISCUSSED',
      '- [Topic 1]',
      '- [Topic 2]',
      '',
      'DECISIONS MADE',
      '- [Decision 1]',
      '',
      'ACTION ITEMS',
      '- [Person/Role] - [Task] - [Deadline if mentioned]',
      '',
      'FULL TRANSCRIPT',
      transcript,
      '',
      'Write in formal business English. Be concise, accurate, and professional.',
    ].join('\n');

    const summaryData = await geminiPost({
      contents: [{ parts: [{ text: promptText }] }],
    });

    const minutes = summaryData.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No summary returned.';
    logger.info(`[summarizeMeetingRecording] Done. Minutes: ${minutes.length} chars`);

    // 7. Clean up the Gemini file
    try {
      await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${geminiFileName}?key=${GEMINI_API_KEY}`,
        { method: 'DELETE' },
      );
    } catch (e) {
      logger.warn('[summarizeMeetingRecording] Failed to delete Gemini file:', e);
    }

    return { minutes };
  },
);

// ─── Auto Responder ──────────────────────────────────────────────────────────
// Triggers on every new message in any chat.
// If the recipient is a business with autoResponderEnabled + a work schedule,
// and the current time is outside their working hours, and we haven't already
// sent an auto-reply this "visit" (last message from recipient is not already
// the auto-reply), write the canned response as the business user.
//
// Runs server-side so it bypasses the Firestore senderId == auth.uid rule.

import { onDocumentCreated } from 'firebase-functions/v2/firestore';

export const autoResponder = onDocumentCreated(
  {
    document: 'chats/{chatId}/messages/{messageId}',
    database: '(default)',
    region: 'us-central1',
  },
  async (event) => {
    const msgData = event.data?.data();
    if (!msgData) return;

    const chatId   = event.params.chatId;
    const senderId = msgData.senderId as string | undefined;
    if (!senderId) return;

    // Don't auto-reply to blocked messages or non-text types
    if (msgData.blockedMessage) return;

    const dbAdmin = getFirestore();

    // Load the parent chat to find the other member and confirm it's 1-on-1
    const chatSnap = await dbAdmin.collection('chats').doc(chatId).get();
    if (!chatSnap.exists) return;

    const chatData = chatSnap.data()!;
    const members  = (chatData.members ?? []) as string[];
    if (chatData.type === 'group' || members.length !== 2) return;

    // The recipient is whoever didn't send this message
    const recipientUid = members.find(uid => uid !== senderId);
    if (!recipientUid) return;

    // Load recipient's profile to check auto-responder settings
    const recipientSnap = await dbAdmin.collection('users').doc(recipientUid).get();
    if (!recipientSnap.exists) return;

    const recipient = recipientSnap.data()!;
    if (!recipient.autoResponderEnabled || !recipient.auto_responder_message) return;

    // Check if current time is outside recipient's working hours.
    // If NO schedule is configured, treat it as "always respond" (return true).
    const isOutsideWorkingHours = (schedule: Record<string, { open: string; close: string }> | undefined): boolean => {
      if (!schedule || Object.keys(schedule).length === 0) return true; // no schedule = always auto-reply
      // If every day in the schedule is 'Closed', treat as no schedule — always auto-reply
      const hasAnyOpenDay = Object.values(schedule).some(d => d.open !== 'Closed');
      if (!hasAnyOpenDay) return true;
      const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const now        = new Date();
      const currentDay = DAYS[now.getDay()];
      const today      = schedule[currentDay];
      if (!today || today.open === 'Closed') return true;

      const toMinutes = (t: string): number => {
        const m = t.match(/(\d+):(\d+)\s+(AM|PM)/i);
        if (!m) return 0;
        let h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        if (m[3].toUpperCase() === 'PM' && h < 12) h += 12;
        if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
        return h * 60 + min;
      };

      const now_min   = now.getHours() * 60 + now.getMinutes();
      const open_min  = toMinutes(today.open);
      const close_min = toMinutes(today.close);
      return now_min < open_min || now_min >= close_min;
    };

    if (!isOutsideWorkingHours(recipient.workSchedule)) return;

    // Check if the last message from the recipient is already the auto-reply
    // (prevents spamming on every message in a session)
    const recentSnap = await dbAdmin
      .collection('chats').doc(chatId).collection('messages')
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    const lastFromRecipient = recentSnap.docs
      .map(d => d.data())
      .find(d => d.senderId === recipientUid);

    if (lastFromRecipient?.text === recipient.auto_responder_message) {
      logger.info(`[autoResponder] Already replied in chat ${chatId}, skipping.`);
      return;
    }

    // Write the auto-reply as the recipient (business) — Admin SDK bypasses security rules
    const autoReplyText = recipient.auto_responder_message as string;

    await dbAdmin.collection('chats').doc(chatId).collection('messages').add({
      senderId:       recipientUid,
      text:           autoReplyText,
      type:           'text',
      timestamp:      AdminTimestamp.now(),
      readBy:         [recipientUid],
      deliveredTo:    [],
      blockedMessage: false,
      isAutoReply:    true,
    });

    await dbAdmin.collection('chats').doc(chatId).update({
      'lastMessage.text':      autoReplyText,
      'lastMessage.senderId':  recipientUid,
      'lastMessage.timestamp': AdminTimestamp.now(),
    });

    logger.info(`[autoResponder] Sent auto-reply in chat ${chatId} from ${recipientUid}`);
  },
);

// Meeting invites are delivered via a normal chat message from the organizer
// to each participant (see CalenderScreen handleCreate → sendBroadcastMessage),
// which triggers sendMessageNotification — the same proven push path as chat.
