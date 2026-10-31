/**
 * One-time Firebase → Postgres data migration.
 *
 * Reads every Firestore collection/subcollection, every Firebase Auth user,
 * and every Firebase Storage file from the project configured in this
 * server's Firebase Admin credentials, and writes equivalent rows into the
 * current Postgres backend (same DATABASE_URL the server itself uses).
 *
 * Firebase Storage media is downloaded and re-uploaded into this backend's
 * S3-compatible store (MinIO in dev) under the same object-key convention
 * `buildObjectKey()` uses elsewhere, so migrated messages/avatars/recordings
 * work with the existing presign/download code with no special-casing.
 *
 * SAFETY: this is a one-time production-data operation. It defaults to a
 * dry run (reads Firebase, computes everything, prints what it WOULD do,
 * writes nothing). Pass --apply to actually write to Postgres/MinIO.
 *
 *   npx tsx --env-file=.env scripts/migrate-firebase-data.ts            # dry run
 *   npx tsx --env-file=.env scripts/migrate-firebase-data.ts --apply    # writes data
 *
 * Idempotent: every migrated row that has a Firestore source document uses a
 * deterministic uuid (v5, derived from the source doc path) as its Postgres
 * id, and every insert is an upsert (ON CONFLICT ...). Re-running --apply is
 * safe and converges rather than duplicating rows.
 *
 * What this migrates:
 *   - Firebase Auth users (all, even those with no Firestore profile doc)
 *   - Firestore `users/{id}` profile fields, privacy settings, business/
 *     catalog fields
 *   - `users/{id}/callHistory`, `linkedDevices`, `pushTokens`, `chatLabels`,
 *     `blockedUsers`, `syncedContacts`
 *   - `chats/{id}` + `messages/{id}` (every message type, receipts, poll
 *     votes, media re-hosted to the new object store)
 *   - `meetings/{id}` + `messages/{id}` + `recordings/{id}`
 *   - `broadcasts/{id}`
 *   - `companionLinks/{id}` (merged into linked_devices)
 *
 * What this intentionally skips (confirmed empty or ephemeral-by-design —
 * see inline notes at each skip site):
 *   - `statuses`, `calls` (0 live docs; both are TTL/ephemeral, nothing to
 *     carry forward)
 *   - `businesses`, `businessTeams`, `chats/*\/assignmentHistory`,
 *     `users/*\/stats` (dead/unused schema, or now computed instead of
 *     stored — see messages.ts analytics.ts computeMessageStats)
 */
import { createHash } from 'node:crypto';
import { getFirebaseAdmin } from '../src/auth/firebaseAdmin.js';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth, type UserRecord } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { query, withTransaction, closePool } from '../src/db/pool.js';
import { buildObjectKey, putObjectBuffer, type MediaCategory } from '../src/media/presign.js';
import { savePrivacySettings } from '../src/db/repositories/privacy.js';
import { replaceSyncedContacts } from '../src/db/repositories/syncedContacts.js';
import { addPushToken } from '../src/db/repositories/pushTokens.js';
import { registerDevice } from '../src/db/repositories/linkedDevices.js';
import { blockUser } from '../src/db/repositories/blocks.js';
import { logger } from '../src/config/logger.js';

const APPLY = process.argv.includes('--apply');
const STORAGE_BUCKET = 'chitchatbusiness-880ce.firebasestorage.app';

// ─── Deterministic ids (UUID v5) ───────────────────────────────────────────
// Project-specific fixed namespace. Only needs to be stable across runs of
// THIS script, not globally unique in the RFC sense.
const NAMESPACE = '9b1e4f2a-7c3d-4e51-8a6f-2d7c4b9e1a00';

function uuidv5(name: string): string {
  const nsBytes = Buffer.from(NAMESPACE.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1').update(Buffer.concat([nsBytes, nameBytes])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
const chatUuid = (chatDocId: string) => uuidv5(`chat:${chatDocId}`);
const messageUuid = (chatDocId: string, msgDocId: string) => uuidv5(`message:${chatDocId}/${msgDocId}`);
const meetingUuid = (meetingDocId: string) => uuidv5(`meeting:${meetingDocId}`);
const meetingMsgUuid = (meetingDocId: string, msgDocId: string) =>
  uuidv5(`meeting-message:${meetingDocId}/${msgDocId}`);
const recordingUuid = (meetingDocId: string, recDocId: string) =>
  uuidv5(`recording:${meetingDocId}/${recDocId}`);
const broadcastUuid = (broadcastDocId: string) => uuidv5(`broadcast:${broadcastDocId}`);
const chatLabelUuid = (ownerDocId: string, labelDocId: string) =>
  uuidv5(`chat-label:${ownerDocId}/${labelDocId}`);

// ─── Small helpers ──────────────────────────────────────────────────────────
function looksLikePhone(s: string): boolean {
  return /^\+?\d{6,15}$/.test(s);
}

/** Firestore Timestamp | epoch-ms number | JS Date | null/undefined -> Date|null. */
function toDate(v: unknown): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'object' && typeof (v as { toDate?: () => Date }).toDate === 'function') {
    return (v as { toDate: () => Date }).toDate();
  }
  return null;
}

function extOf(pathOrUrl: string): string | undefined {
  const clean = pathOrUrl.split('?')[0];
  const m = /\.([a-zA-Z0-9]{1,5})$/.exec(clean);
  return m ? m[1] : undefined;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', m4a: 'audio/m4a', mp3: 'audio/mpeg', aac: 'audio/aac',
  pdf: 'application/pdf',
};

interface Counters {
  [key: string]: { migrated: number; skipped: number; failed: number };
}
const counters: Counters = {};
function bump(key: string, field: 'migrated' | 'skipped' | 'failed') {
  counters[key] ??= { migrated: 0, skipped: 0, failed: 0 };
  counters[key][field]++;
}
const errors: string[] = [];
function fail(context: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  errors.push(`${context}: ${msg}`);
  logger.error({ context, err: msg }, 'migration step failed');
}

async function main() {
  logger.info({ apply: APPLY }, APPLY ? 'Running migration in APPLY mode (will write data)' : 'Running migration in DRY-RUN mode (no writes)');

  getFirebaseAdmin();
  const db = getFirestore();

  // ─── Load Firebase Auth users (small: ~44) ───────────────────────────────
  const authByUid = new Map<string, UserRecord>();
  const authByPhone = new Map<string, string>();
  {
    let pageToken: string | undefined;
    do {
      const page = await getAuth().listUsers(1000, pageToken);
      for (const u of page.users) {
        authByUid.set(u.uid, u);
        if (u.phoneNumber) authByPhone.set(u.phoneNumber, u.uid);
      }
      pageToken = page.pageToken;
    } while (pageToken);
  }
  logger.info({ count: authByUid.size }, 'Loaded Firebase Auth users');

  // ─── Identity resolution: map any raw Firestore id (uid or phone) to a
  // canonical Postgres users.id, creating ghost rows for ids with no real
  // account (e.g. a phone number that was never registered) so FK-dependent
  // data (chats, messages...) isn't dropped. ───────────────────────────────
  const resolvedCache = new Map<string, string>();
  function resolveUserId(raw: string): string {
    if (resolvedCache.has(raw)) return resolvedCache.get(raw)!;
    let canonical: string;
    if (authByUid.has(raw)) {
      canonical = raw;
    } else if (looksLikePhone(raw)) {
      canonical = authByPhone.get(raw) ?? raw; // ghost, keyed by phone if unregistered
    } else {
      canonical = raw; // already a uid shape with no Auth record, or unknown — pass through
    }
    resolvedCache.set(raw, canonical);
    return canonical;
  }

  // Track which canonical ids already have a Postgres users row so we don't
  // re-query on every reference.
  const knownUserIds = new Set<string>();
  if (APPLY) {
    const res = await query<{ id: string }>('SELECT id FROM users');
    res.rows.forEach((r) => knownUserIds.add(r.id));
  }
  async function ensureUserExists(
    canonicalId: string,
    hints: { phoneNumber?: string | null; displayName?: string | null } = {},
  ): Promise<void> {
    if (knownUserIds.has(canonicalId)) return;
    knownUserIds.add(canonicalId); // optimistic; avoids re-entrant duplicate inserts in this run
    if (!APPLY) return;
    await query(
      `INSERT INTO users (id, phone_number, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [canonicalId, hints.phoneNumber ?? (looksLikePhone(canonicalId) ? canonicalId : null), hints.displayName ?? null],
    );
  }
  // Shared ghost user for meeting system-posts (senderId literal 'system').
  await ensureUserExists('system', { displayName: 'System' });

  // ─── Media re-hosting (Firebase Storage -> this backend's object store),
  // cached by source URL/path so the same file referenced from multiple
  // documents (e.g. a catalog image forwarded into several chats) is only
  // downloaded/re-uploaded once. ─────────────────────────────────────────
  const mediaCache = new Map<string, string | null>();
  function storagePathFromUrl(urlOrPath: string): string | null {
    const m = /\/o\/([^?]+)/.exec(urlOrPath);
    if (m) return decodeURIComponent(m[1]);
    if (!/^https?:\/\//i.test(urlOrPath)) return urlOrPath; // already a bare path
    return null;
  }
  async function rehostMedia(
    sourceUrlOrPath: string | null | undefined,
    category: MediaCategory,
    ownerId: string,
    ids: { chatId?: string; meetingId?: string },
  ): Promise<string | null> {
    if (!sourceUrlOrPath) return null;
    if (mediaCache.has(sourceUrlOrPath)) return mediaCache.get(sourceUrlOrPath)!;
    const path = storagePathFromUrl(sourceUrlOrPath);
    if (!path) {
      mediaCache.set(sourceUrlOrPath, null);
      return null; // external URL we don't own — nothing to re-host
    }
    try {
      const file = getStorage().bucket(STORAGE_BUCKET).file(path);
      const [exists] = await file.exists();
      if (!exists) {
        logger.warn({ path }, 'Storage object referenced by a document no longer exists, skipping');
        mediaCache.set(sourceUrlOrPath, null);
        return null;
      }
      const [buf] = await file.download();
      const [meta] = await file.getMetadata();
      const contentType = meta.contentType ?? CONTENT_TYPE_BY_EXT[extOf(path) ?? ''] ?? 'application/octet-stream';
      const newKey = buildObjectKey(ownerId, category, { ...ids, ext: extOf(path) });
      if (APPLY) await putObjectBuffer(newKey, buf, contentType);
      mediaCache.set(sourceUrlOrPath, newKey);
      return newKey;
    } catch (err) {
      fail(`rehostMedia(${path})`, err);
      mediaCache.set(sourceUrlOrPath, null);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 1 — Users (Firestore profiles + Auth-only accounts + privacy)
  // ════════════════════════════════════════════════════════════════════════
  logger.info('--- Phase 1: users ---');
  const usersSnap = await db.collection('users').get();
  for (const doc of usersSnap.docs) {
    const raw = doc.id;
    const canonical = resolveUserId(raw);
    const d = doc.data();
    try {
      await ensureUserExists(canonical, { phoneNumber: d.phone ?? null, displayName: d.displayName ?? null });
      if (!APPLY) { bump('users', 'migrated'); continue; }

      const avatarKey = await rehostMedia(d.photoURL ?? null, 'avatar', canonical, {});

      let catalogString: string | null = null;
      let catalogItems: unknown[] = [];
      if (Array.isArray(d.catalog)) {
        catalogItems = await Promise.all(
          d.catalog.map(async (item: Record<string, unknown>) => ({
            id: item.id,
            name: item.name,
            price: item.price,
            description: item.description ?? null,
            collectionId: item.collectionId ?? null,
            imageUri: await rehostMedia(item.imageUri as string | null, 'avatar', canonical, {}),
          })),
        );
      } else if (typeof d.catalog === 'string') {
        catalogString = d.catalog;
      }

      await query(
        `UPDATE users SET
           phone_number = COALESCE(users.phone_number, $2),
           display_name = COALESCE($3, users.display_name),
           about = COALESCE($4, users.about),
           avatar_object_key = COALESCE($5, users.avatar_object_key),
           email = COALESCE($6, users.email),
           website = COALESCE($7, users.website),
           catalog = COALESCE($8, users.catalog),
           operational_hours = COALESCE($9, users.operational_hours),
           account_type = COALESCE($10, users.account_type),
           industry = COALESCE($11, users.industry),
           address = COALESCE($12::jsonb, users.address),
           work_schedule = COALESCE($13::jsonb, users.work_schedule),
           auto_responder_enabled = COALESCE($14, users.auto_responder_enabled),
           auto_responder_message = COALESCE($15, users.auto_responder_message),
           catalog_items = CASE WHEN $16::jsonb IS NOT NULL AND jsonb_array_length($16::jsonb) > 0
                                 THEN $16::jsonb ELSE users.catalog_items END,
           catalog_collections = CASE WHEN $17::jsonb IS NOT NULL AND jsonb_array_length($17::jsonb) > 0
                                 THEN $17::jsonb ELSE users.catalog_collections END,
           last_seen = COALESCE($18, users.last_seen),
           created_at = LEAST(users.created_at, COALESCE($19, users.created_at)),
           role = COALESCE($20, users.role),
           agent_status = COALESCE($21, users.agent_status),
           profile_views = GREATEST(users.profile_views, COALESCE($22, 0)),
           profile_views_today = GREATEST(users.profile_views_today, COALESCE($23, 0)),
           profile_views_day_key = COALESCE($24, users.profile_views_day_key),
           profile_views_updated_at = COALESCE($25, users.profile_views_updated_at)
         WHERE id = $1`,
        [
          canonical,
          d.phone ?? null,
          d.displayName ?? null,
          d.description ?? null,
          avatarKey,
          d.email ?? null,
          d.website ?? null,
          catalogString,
          d.operationalHours ?? null,
          d.accountType ?? null,
          d.industry ?? null,
          d.address ? JSON.stringify(d.address) : null,
          d.workSchedule ? JSON.stringify(d.workSchedule) : null,
          typeof d.autoResponderEnabled === 'boolean' ? d.autoResponderEnabled : null,
          d.auto_responder_message ?? null,
          JSON.stringify(catalogItems),
          d.collections ? JSON.stringify(d.collections) : JSON.stringify([]),
          toDate(d.lastSeen),
          toDate(d.createdAt),
          d.role ?? null,
          d.agentStatus ?? null,
          typeof d.profileViews === 'number' ? d.profileViews : null,
          typeof d.profileViewsToday === 'number' ? d.profileViewsToday : null,
          d.profileViewsDayKey ?? null,
          toDate(d.profileViewsUpdatedAt),
        ],
      );

      // Privacy settings (fields live directly on the user doc in Firestore).
      if (d.privacyLastSeen || d.privacyProfilePhoto || d.privacyStatus || d.privacyGroups || d.privacyCalls) {
        await savePrivacySettings(canonical, {
          lastSeen: d.privacyLastSeen ?? 'Contacts',
          profilePhoto: d.privacyProfilePhoto ?? 'Contacts',
          statusVisibility: d.privacyStatus ?? 'Everyone',
          groups: d.privacyGroups ?? 'Contacts',
          calls: d.privacyCalls ?? 'Contacts',
          readReceipts: d.readReceipts ?? true,
          disappearingMessages: d.disappearingMessages ?? true,
        });
      }
      bump('users', 'migrated');
    } catch (err) {
      fail(`user ${raw}`, err);
      bump('users', 'failed');
    }
  }

  // Auth users with no Firestore profile doc at all — still create a bare row
  // so the account (and anything that might reference its uid) survives.
  for (const [uid, rec] of authByUid) {
    if (knownUserIds.has(uid)) continue;
    try {
      await ensureUserExists(uid, { phoneNumber: rec.phoneNumber ?? null, displayName: rec.displayName ?? null });
      bump('users (auth-only)', 'migrated');
    } catch (err) {
      fail(`auth-only user ${uid}`, err);
      bump('users (auth-only)', 'failed');
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 2 — Chats + messages + receipts + poll votes + mutes
  // ════════════════════════════════════════════════════════════════════════
  logger.info('--- Phase 2: chats + messages ---');
  const chatsSnap = await db.collection('chats').get();
  for (const chatDoc of chatsSnap.docs) {
    const c = chatDoc.data();
    try {
      const rawMembers: string[] = Array.isArray(c.members) ? c.members : [];
      const memberPairs = rawMembers.map((raw) => ({ raw, canonical: resolveUserId(raw) }));
      const canonicalMembers = Array.from(new Set(memberPairs.map((m) => m.canonical)));
      const createdBy = c.createdBy ? resolveUserId(c.createdBy) : null;

      for (const m of canonicalMembers) await ensureUserExists(m);
      if (createdBy) await ensureUserExists(createdBy);

      const isDirect = c.type === 'direct';
      const directKey =
        isDirect && canonicalMembers.length === 2 ? [...canonicalMembers].sort().join(':') : null;

      // direct_key is UNIQUE on chats. A chat for this member pair may
      // already exist under a DIFFERENT id (e.g. created live by the app
      // after cutover, before this migration ran) — merge into that row
      // rather than colliding with it under our own deterministic id.
      let pgChatId = chatUuid(chatDoc.id);
      if (APPLY && directKey) {
        const existing = await query<{ id: string }>('SELECT id FROM chats WHERE direct_key = $1', [directKey]);
        if (existing.rows[0]) pgChatId = existing.rows[0].id;
      }

      const lastMessage = c.lastMessage as { text?: string; senderId?: string; timestamp?: unknown } | null;
      const lastMessageAt = toDate(lastMessage?.timestamp);

      if (APPLY) {
        await query(
          `INSERT INTO chats (id, type, group_name, group_photo_object_key, created_by, direct_key,
                               created_at, last_message_text, last_message_sender_id, last_message_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET
             group_name = COALESCE(EXCLUDED.group_name, chats.group_name),
             -- Don't clobber a newer live last-message with older migrated history.
             last_message_text = CASE WHEN EXCLUDED.last_message_at IS NOT NULL
                 AND (chats.last_message_at IS NULL OR EXCLUDED.last_message_at > chats.last_message_at)
               THEN EXCLUDED.last_message_text ELSE chats.last_message_text END,
             last_message_sender_id = CASE WHEN EXCLUDED.last_message_at IS NOT NULL
                 AND (chats.last_message_at IS NULL OR EXCLUDED.last_message_at > chats.last_message_at)
               THEN EXCLUDED.last_message_sender_id ELSE chats.last_message_sender_id END,
             last_message_at = CASE WHEN EXCLUDED.last_message_at IS NOT NULL
                 AND (chats.last_message_at IS NULL OR EXCLUDED.last_message_at > chats.last_message_at)
               THEN EXCLUDED.last_message_at ELSE chats.last_message_at END`,
          [
            pgChatId,
            c.type ?? 'direct',
            c.groupName ?? null,
            await rehostMedia(c.groupPhoto ?? null, 'group', createdBy ?? canonicalMembers[0] ?? 'system', { chatId: pgChatId }),
            createdBy,
            directKey,
            toDate(c.createdAt) ?? new Date(),
            lastMessage?.text ?? null,
            lastMessage?.senderId ? resolveUserId(lastMessage.senderId) : null,
            lastMessageAt,
          ],
        );

        for (const m of canonicalMembers) {
          // unreadCounts/clearedAt are keyed by the RAW id as Firestore wrote
          // them; look up via whichever raw member(s) map to this canonical id.
          const rawsForThisMember = memberPairs.filter((p) => p.canonical === m).map((p) => p.raw);
          const unread = Math.max(
            0,
            ...rawsForThisMember.map((r) => Number((c.unreadCounts ?? {})[r] ?? 0)),
          );
          const clearedAtRaw = rawsForThisMember
            .map((r) => (c.clearedAt ?? {})[r])
            .find((v) => v != null);
          await query(
            `INSERT INTO chat_members (chat_id, user_id, role, unread_count, joined_at, cleared_at)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (chat_id, user_id) DO UPDATE SET
               -- Merge, don't regress: keep whichever unread count is higher.
               unread_count = GREATEST(chat_members.unread_count, EXCLUDED.unread_count),
               cleared_at = COALESCE(EXCLUDED.cleared_at, chat_members.cleared_at)`,
            [
              pgChatId,
              m,
              !isDirect && m === createdBy ? 'admin' : 'member',
              unread,
              toDate(c.createdAt) ?? new Date(),
              toDate(clearedAtRaw),
            ],
          );
        }

        const mutedBy = (c.mutedBy ?? {}) as Record<string, boolean>;
        for (const [rawUid, muted] of Object.entries(mutedBy)) {
          if (!muted) continue;
          const m = resolveUserId(rawUid);
          await ensureUserExists(m);
          await query(
            `INSERT INTO chat_mutes (chat_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [pgChatId, m],
          );
        }
      }
      bump('chats', 'migrated');

      // ── Messages ──
      const msgsSnap = await chatDoc.ref.collection('messages').get();
      for (const msgDoc of msgsSnap.docs) {
        const m = msgDoc.data();
        const pgMsgId = messageUuid(chatDoc.id, msgDoc.id);
        try {
          const senderId = resolveUserId(m.senderId ?? 'system');
          await ensureUserExists(senderId);

          let mediaKey: string | null = null;
          let thumbKey: string | null = null;
          let fileName: string | null = m.fileName ?? null;
          let fileSize: number | null = typeof m.fileSize === 'number' ? m.fileSize : null;
          let mimeType: string | null = m.mimeType ?? null;

          if (m.type === 'image' && m.imageUrl) {
            mediaKey = await rehostMedia(m.imageUrl, 'chat-media', senderId, { chatId: pgChatId });
          } else if (m.type === 'video' && m.videoUrl) {
            mediaKey = await rehostMedia(m.videoUrl, 'chat-media', senderId, { chatId: pgChatId });
            thumbKey = await rehostMedia(m.thumbnailUrl ?? null, 'chat-media', senderId, { chatId: pgChatId });
          } else if (m.type === 'voice' && m.voiceUrl) {
            mediaKey = await rehostMedia(m.voiceUrl, 'chat-voice', senderId, { chatId: pgChatId });
          } else if (m.type === 'file' && m.fileUrl) {
            mediaKey = await rehostMedia(m.fileUrl, 'chat-media', senderId, { chatId: pgChatId });
          }

          let catalogItem: Record<string, unknown> | null = null;
          if (m.catalogItem) {
            catalogItem = {
              ...m.catalogItem,
              imageUri: await rehostMedia(m.catalogItem.imageUri ?? null, 'avatar', senderId, {}),
            };
          }

          let orderData: Record<string, unknown> | null = null;
          if (m.order) {
            orderData = {
              ...m.order,
              items: await Promise.all(
                (m.order.items ?? []).map(async (it: Record<string, unknown>) => ({
                  ...it,
                  imageUri: await rehostMedia(it.imageUri as string | null, 'avatar', senderId, {}),
                })),
              ),
            };
          }

          let contactData: Record<string, unknown> | null = null;
          if (m.contact) {
            const mapContact = (ct: Record<string, unknown>) => ({
              ...ct,
              userId: ct.userId ? resolveUserId(ct.userId as string) : null,
            });
            contactData = {
              ...mapContact(m.contact),
              ...(Array.isArray(m.contact.contacts)
                ? { contacts: m.contact.contacts.map(mapContact) }
                : {}),
            };
          }

          let pollData: Record<string, unknown> | null = null;
          let voteRows: { optionId: string; voterId: string }[] = [];
          if (m.poll) {
            pollData = { question: m.poll.question, options: m.poll.options, multiple: !!m.poll.multiple };
            const votes = (m.poll.votes ?? {}) as Record<string, string[]>;
            for (const [optionId, voters] of Object.entries(votes)) {
              for (const voterRaw of voters) voteRows.push({ optionId, voterId: resolveUserId(voterRaw) });
            }
          }

          let text: string | null = m.text ?? null;
          if (m.subtype === 'number-change' && !text) {
            text = `Changed their number from ${m.oldNumber ?? '?'} to ${m.newNumber ?? '?'}`;
          }

          if (APPLY) {
            await withTransaction(async (client) => {
              await client.query(
                `INSERT INTO messages
                   (id, chat_id, sender_id, type, text, media_object_key, thumbnail_object_key,
                    file_name, file_size, mime_type, duration_ms, location, catalog_item, reply_to,
                    subtype, poll, order_data, contact_data, created_at, expires_at,
                    deleted_for_everyone, edited, edited_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
                 ON CONFLICT (id) DO NOTHING`,
                [
                  pgMsgId,
                  pgChatId,
                  senderId,
                  m.type ?? 'text',
                  text,
                  mediaKey,
                  thumbKey,
                  fileName,
                  fileSize,
                  mimeType,
                  typeof m.duration === 'number' ? m.duration : null,
                  m.location ? JSON.stringify(m.location) : null,
                  catalogItem ? JSON.stringify(catalogItem) : null,
                  m.replyTo ? JSON.stringify(m.replyTo) : null,
                  m.subtype ?? null,
                  pollData ? JSON.stringify(pollData) : null,
                  orderData ? JSON.stringify(orderData) : null,
                  contactData ? JSON.stringify(contactData) : null,
                  toDate(m.timestamp) ?? new Date(),
                  // Reset the 72h TTL from migration time so historical
                  // messages aren't immediately swept by the cleanup job.
                  new Date(Date.now() + 72 * 60 * 60 * 1000),
                  false,
                  !!m.edited,
                  toDate(m.editedAt),
                ],
              );

              const deliveredTo: string[] = Array.isArray(m.deliveredTo) ? m.deliveredTo : [];
              const readBy: string[] = Array.isArray(m.readBy) ? m.readBy : [];
              const receiptUsers = new Set([...deliveredTo, ...readBy].map(resolveUserId));
              for (const uid of receiptUsers) {
                await ensureUserExists(uid);
                await client.query(
                  `INSERT INTO message_receipts (message_id, user_id, delivered_at, read_at, blocked_message)
                   VALUES ($1,$2,$3,$4,$5) ON CONFLICT (message_id, user_id) DO NOTHING`,
                  [
                    pgMsgId,
                    uid,
                    deliveredTo.map(resolveUserId).includes(uid) ? toDate(m.timestamp) ?? new Date() : null,
                    readBy.map(resolveUserId).includes(uid) ? toDate(m.timestamp) ?? new Date() : null,
                    !!m.blockedMessage,
                  ],
                );
              }

              for (const v of voteRows) {
                await ensureUserExists(v.voterId);
                await client.query(
                  `INSERT INTO poll_votes (message_id, option_id, voter_id) VALUES ($1,$2,$3)
                   ON CONFLICT DO NOTHING`,
                  [pgMsgId, v.optionId, v.voterId],
                );
              }
            });
          }
          bump('messages', 'migrated');
        } catch (err) {
          fail(`message ${chatDoc.id}/${msgDoc.id}`, err);
          bump('messages', 'failed');
        }
      }
    } catch (err) {
      fail(`chat ${chatDoc.id}`, err);
      bump('chats', 'failed');
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 3 — Meetings + messages + recordings
  // ════════════════════════════════════════════════════════════════════════
  logger.info('--- Phase 3: meetings ---');
  const meetingsSnap = await db.collection('meetings').get();
  for (const meetingDoc of meetingsSnap.docs) {
    const mt = meetingDoc.data();
    const pgMeetingId = meetingUuid(meetingDoc.id);
    try {
      const organizerId = resolveUserId(mt.organizerId);
      await ensureUserExists(organizerId);
      const participants: string[] = Array.isArray(mt.participants) ? mt.participants : [];
      const joined: string[] = Array.isArray(mt.joinedMembers) ? mt.joinedMembers : [];
      const muted: string[] = Array.isArray(mt.mutedUsers) ? mt.mutedUsers : [];
      const kicked: string[] = Array.isArray(mt.kickedUsers) ? mt.kickedUsers : [];
      const allCanonical = new Set(
        [organizerId, ...participants.map(resolveUserId), ...joined.map(resolveUserId)],
      );

      if (APPLY) {
        await query(
          `INSERT INTO meetings (id, title, organizer_id, is_active, ended_at, minutes,
                                  minutes_generated_at, created_at, starts_at, ends_at, type,
                                  reminders, is_recording)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (id) DO UPDATE SET
             is_active = EXCLUDED.is_active, ended_at = EXCLUDED.ended_at,
             minutes = COALESCE(EXCLUDED.minutes, meetings.minutes),
             minutes_generated_at = COALESCE(EXCLUDED.minutes_generated_at, meetings.minutes_generated_at)`,
          [
            pgMeetingId,
            mt.title ?? 'Meeting',
            organizerId,
            mt.isActive ?? true,
            toDate(mt.endedAt),
            mt.minutes ?? null,
            toDate(mt.minutesGeneratedAt),
            toDate(mt.createdAt) ?? new Date(),
            toDate(mt.date) ?? toDate(mt.createdAt) ?? new Date(),
            toDate(mt.endDate),
            mt.type ?? 'online',
            Array.isArray(mt.reminders) ? mt.reminders : [60, 30, 15, 10],
            !!mt.isRecording,
          ],
        );

        for (const m of allCanonical) {
          await ensureUserExists(m);
          await query(
            `INSERT INTO meeting_participants (meeting_id, user_id, role, is_muted, is_kicked, joined)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (meeting_id, user_id) DO UPDATE SET
               is_muted = EXCLUDED.is_muted, is_kicked = EXCLUDED.is_kicked, joined = EXCLUDED.joined`,
            [
              pgMeetingId,
              m,
              m === organizerId ? 'organizer' : 'participant',
              muted.map(resolveUserId).includes(m),
              kicked.map(resolveUserId).includes(m),
              joined.map(resolveUserId).includes(m),
            ],
          );
        }
      }
      bump('meetings', 'migrated');

      const msgsSnap = await meetingDoc.ref.collection('messages').get();
      for (const msgDoc of msgsSnap.docs) {
        const mm = msgDoc.data();
        try {
          const senderId = resolveUserId(mm.senderId ?? 'system');
          await ensureUserExists(senderId, { displayName: mm.senderName ?? null });
          if (APPLY) {
            await query(
              `INSERT INTO meeting_messages (id, meeting_id, sender_id, text, created_at, sender_name, is_system)
               VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
              [
                meetingMsgUuid(meetingDoc.id, msgDoc.id),
                pgMeetingId,
                senderId,
                mm.text ?? null,
                toDate(mm.timestamp) ?? new Date(),
                mm.senderName ?? null,
                !!mm.isSystem,
              ],
            );
          }
          bump('meeting_messages', 'migrated');
        } catch (err) {
          fail(`meeting message ${meetingDoc.id}/${msgDoc.id}`, err);
          bump('meeting_messages', 'failed');
        }
      }

      const recsSnap = await meetingDoc.ref.collection('recordings').get();
      for (const recDoc of recsSnap.docs) {
        const r = recDoc.data();
        try {
          const objectKey = await rehostMedia(r.url, 'meeting', organizerId, { meetingId: pgMeetingId });
          if (objectKey && APPLY) {
            await query(
              `INSERT INTO meeting_recordings (id, meeting_id, object_key, duration_ms, created_by, status, created_at)
               VALUES ($1,$2,$3,$4,$5,'uploaded',$6) ON CONFLICT (id) DO NOTHING`,
              [
                recordingUuid(meetingDoc.id, recDoc.id),
                pgMeetingId,
                objectKey,
                typeof r.durationMs === 'number' ? r.durationMs : 0,
                organizerId,
                toDate(r.createdAt) ?? new Date(),
              ],
            );
          }
          bump('meeting_recordings', objectKey ? 'migrated' : 'skipped');
        } catch (err) {
          fail(`recording ${meetingDoc.id}/${recDoc.id}`, err);
          bump('meeting_recordings', 'failed');
        }
      }
    } catch (err) {
      fail(`meeting ${meetingDoc.id}`, err);
      bump('meetings', 'failed');
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 4 — Broadcasts
  // ════════════════════════════════════════════════════════════════════════
  logger.info('--- Phase 4: broadcasts ---');
  const broadcastsSnap = await db.collection('broadcasts').get();
  for (const bDoc of broadcastsSnap.docs) {
    const b = bDoc.data();
    try {
      const owner = resolveUserId(b.createdBy);
      await ensureUserExists(owner);
      const recipients: string[] = Array.isArray(b.recipients) ? b.recipients.map(resolveUserId) : [];
      if (APPLY) {
        await query(
          `INSERT INTO broadcast_lists (id, owner_id, name, created_at, last_sent_at, last_message)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at, last_message = EXCLUDED.last_message`,
          [broadcastUuid(bDoc.id), owner, b.name ?? 'Broadcast', toDate(b.createdAt) ?? new Date(), toDate(b.lastSentAt), b.lastMessage ?? null],
        );
        for (const r of recipients) {
          await ensureUserExists(r);
          await query(
            `INSERT INTO broadcast_recipients (list_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [broadcastUuid(bDoc.id), r],
          );
        }
      }
      bump('broadcasts', 'migrated');
    } catch (err) {
      fail(`broadcast ${bDoc.id}`, err);
      bump('broadcasts', 'failed');
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 5 — Per-user subcollections
  // ════════════════════════════════════════════════════════════════════════
  logger.info('--- Phase 5: per-user subcollections ---');
  for (const userDoc of usersSnap.docs) {
    const ownerRaw = userDoc.id;
    const owner = resolveUserId(ownerRaw);

    // callHistory
    try {
      const snap = await userDoc.ref.collection('callHistory').get();
      for (const d of snap.docs) {
        const ch = d.data();
        const otherParty = ch.otherParty
          ? { ...ch.otherParty, userId: ch.otherParty.userId ? resolveUserId(ch.otherParty.userId) : null }
          : null;
        if (APPLY) {
          await ensureUserExists(owner);
          await query(
            `INSERT INTO call_history (user_id, call_id, other_party, type, direction, status, duration_sec, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (user_id, call_id) DO NOTHING`,
            [
              owner,
              ch.callId ?? d.id,
              JSON.stringify(otherParty ?? {}),
              ch.type ?? 'audio',
              ch.direction ?? 'incoming',
              ch.status ?? 'completed',
              typeof ch.duration === 'number' ? ch.duration : null,
              toDate(ch.timestamp) ?? new Date(),
            ],
          );
        }
        bump('call_history', 'migrated');
      }
    } catch (err) {
      fail(`callHistory for ${ownerRaw}`, err);
      bump('call_history', 'failed');
    }

    // linkedDevices
    try {
      const snap = await userDoc.ref.collection('linkedDevices').get();
      for (const d of snap.docs) {
        const ld = d.data();
        if (APPLY) {
          await ensureUserExists(owner);
          await registerDevice(owner, {
            deviceId: d.id,
            name: ld.name ?? 'Companion Device',
            type: ld.type ?? 'phone',
            os: ld.os ?? '',
            platform: ld.platform ?? 'android',
          });
        }
        bump('linked_devices', 'migrated');
      }
    } catch (err) {
      fail(`linkedDevices for ${ownerRaw}`, err);
      bump('linked_devices', 'failed');
    }

    // pushTokens
    try {
      const snap = await userDoc.ref.collection('pushTokens').get();
      for (const d of snap.docs) {
        const pt = d.data();
        if (APPLY && pt.token) {
          await ensureUserExists(owner);
          await addPushToken(owner, pt.token, pt.platform ?? null, d.id);
        }
        bump('push_tokens', 'migrated');
      }
    } catch (err) {
      fail(`pushTokens for ${ownerRaw}`, err);
      bump('push_tokens', 'failed');
    }

    // chatLabels (raw SQL: need to preserve original ids/timestamps, which
    // the live createChatLabel() repo function doesn't support).
    try {
      const snap = await userDoc.ref.collection('chatLabels').get();
      for (const d of snap.docs) {
        const cl = d.data();
        const memberIds = (cl.memberIds ?? []).map((m: string) => resolveUserId(m));
        const groupIds = (cl.groupIds ?? []).map((g: string) => chatUuid(g));
        if (APPLY) {
          await ensureUserExists(owner);
          for (const m of memberIds) await ensureUserExists(m);
          await query(
            `INSERT INTO chat_labels (id, owner_id, title, member_ids, group_ids, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, member_ids = EXCLUDED.member_ids,
               group_ids = EXCLUDED.group_ids, updated_at = EXCLUDED.updated_at`,
            [
              chatLabelUuid(ownerRaw, d.id),
              owner,
              cl.title ?? 'Label',
              memberIds,
              groupIds,
              toDate(cl.createdAt) ?? new Date(),
              toDate(cl.updatedAt) ?? new Date(),
            ],
          );
        }
        bump('chat_labels', 'migrated');
      }
    } catch (err) {
      fail(`chatLabels for ${ownerRaw}`, err);
      bump('chat_labels', 'failed');
    }

    // blockedUsers
    try {
      const snap = await userDoc.ref.collection('blockedUsers').get();
      for (const d of snap.docs) {
        const bu = d.data();
        const blockedId = resolveUserId(d.id);
        if (APPLY) {
          await ensureUserExists(owner);
          await ensureUserExists(blockedId);
          const photoKey = await rehostMedia(bu.photoURL ?? null, 'avatar', blockedId, {});
          await blockUser(owner, blockedId, {
            displayName: bu.displayName ?? null,
            photoObjectKey: photoKey,
            phone: bu.phone ?? null,
          });
        }
        bump('blocked_users', 'migrated');
      }
    } catch (err) {
      fail(`blockedUsers for ${ownerRaw}`, err);
      bump('blocked_users', 'failed');
    }

    // syncedContacts (collect all, then one replaceSyncedContacts call)
    try {
      const snap = await userDoc.ref.collection('syncedContacts').get();
      if (snap.size > 0) {
        const contacts = await Promise.all(
          snap.docs.map(async (d) => {
            const sc = d.data();
            const avatarKey = await rehostMedia(sc.firebasePhotoURL ?? null, 'avatar', owner, {});
            return {
              phone: sc.phone ?? d.id,
              displayName: sc.displayName ?? sc.phone ?? d.id,
              userId: sc.userId ? resolveUserId(sc.userId) : null,
              isSaved: !!sc.isSaved,
              avatarObjectKey: avatarKey,
            };
          }),
        );
        if (APPLY) {
          await ensureUserExists(owner);
          for (const c of contacts) if (c.userId) await ensureUserExists(c.userId);
          await replaceSyncedContacts(owner, contacts);
        }
        for (let i = 0; i < contacts.length; i++) bump('synced_contacts', 'migrated');
      }
    } catch (err) {
      fail(`syncedContacts for ${ownerRaw}`, err);
      bump('synced_contacts', 'failed');
    }

    // users/{uid}/stats (messageStats) is intentionally skipped: the new
    // backend computes these live from the messages table (see
    // src/db/repositories/analytics.ts computeMessageStats) rather than
    // storing a running counter, so migrating a stale snapshot would just
    // be immediately wrong.
  }

  // ════════════════════════════════════════════════════════════════════════
  // PHASE 6 — companionLinks (root collection) -> linked_devices
  // ════════════════════════════════════════════════════════════════════════
  logger.info('--- Phase 6: companionLinks ---');
  const companionSnap = await db.collection('companionLinks').get();
  for (const d of companionSnap.docs) {
    const cl = d.data();
    try {
      const owner = resolveUserId(cl.ownerUid ?? d.id);
      await ensureUserExists(owner);
      const platform = /iphone|ipad|ios/i.test(cl.deviceName ?? '') ? 'ios' : 'android';
      if (APPLY) {
        await registerDevice(owner, {
          deviceId: cl.deviceId ?? d.id,
          name: cl.deviceName ?? 'Companion Device',
          type: 'phone',
          os: '',
          platform,
        });
      }
      bump('companion_links', 'migrated');
    } catch (err) {
      fail(`companionLink ${d.id}`, err);
      bump('companion_links', 'failed');
    }
  }

  // ════════════════════════════════════════════════════════════════════════
  // Collections confirmed empty/ephemeral/dead — explicitly skipped, logged
  // for visibility rather than silently doing nothing.
  // ════════════════════════════════════════════════════════════════════════
  for (const name of ['statuses', 'calls', 'businesses', 'businessTeams']) {
    const snap = await db.collection(name).get();
    logger.info({ collection: name, liveDocCount: snap.size }, 'Skipped (ephemeral/dead schema, see script header)');
  }

  // ─── Summary ────────────────────────────────────────────────────────────
  logger.info('=== MIGRATION SUMMARY ===');
  for (const [key, c] of Object.entries(counters)) {
    logger.info(`${key}: migrated=${c.migrated} skipped=${c.skipped} failed=${c.failed}`);
  }
  if (errors.length > 0) {
    logger.warn({ count: errors.length }, 'Errors encountered (non-fatal, other records still processed):');
    errors.forEach((e) => logger.warn(`  - ${e}`));
  }

  if (APPLY) {
    const [users, chats, messages, meetings] = await Promise.all([
      query('SELECT count(*) FROM users'),
      query('SELECT count(*) FROM chats'),
      query('SELECT count(*) FROM messages'),
      query('SELECT count(*) FROM meetings'),
    ]);
    logger.info(
      {
        users: users.rows[0].count,
        chats: chats.rows[0].count,
        messages: messages.rows[0].count,
        meetings: meetings.rows[0].count,
      },
      'Postgres row counts after migration',
    );
  } else {
    logger.info('Dry run complete. Re-run with --apply to write this data to Postgres/MinIO.');
  }
}

main()
  .then(async () => {
    await closePool();
    process.exit(errors.length > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    logger.error({ err }, 'Migration crashed');
    await closePool();
    process.exit(1);
  });
