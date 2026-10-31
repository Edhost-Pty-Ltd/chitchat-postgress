// ─── useLocalMessages ─────────────────────────────────────────────────────────
// Persists chat messages to AsyncStorage so they remain visible after Firestore
// deletes them (72-hour TTL).  Only the viewer's own device keeps the cache —
// it is never synced back to Firestore.
//
// Storage key:  local_msgs_<chatId>
// Format:       JSON array of FireMessage (timestamps as ISO strings)

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { FireMessage } from './useMessages';

const KEY = (chatId: string) => `local_msgs_${chatId}`;

// AsyncStorage has no atomic read-modify-write operation. Serialize the media
// optimistic/reconciliation writes per chat so a multi-select batch cannot
// overwrite an earlier item while both are merging concurrently.
const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite(chatId: string, work: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(chatId) ?? Promise.resolve();
  const queued = previous.catch(() => {}).then(work);
  writeQueues.set(chatId, queued);
  return queued.finally(() => {
    if (writeQueues.get(chatId) === queued) writeQueues.delete(chatId);
  });
}

// ── Serialisation helpers ────────────────────────────────────────────────────

/** Convert Date fields to ISO strings for JSON storage. */
function serialise(msg: FireMessage): object {
  return {
    ...msg,
    timestamp:           msg.timestamp?.toISOString()           ?? null,
    expiresAt:           msg.expiresAt?.toISOString()           ?? null,
    liveLocationExpiry:  msg.liveLocationExpiry?.toISOString()  ?? null,
  };
}

/** Restore Date fields from ISO strings after JSON.parse. */
function deserialise(raw: any): FireMessage {
  return {
    ...raw,
    timestamp:           raw.timestamp          ? new Date(raw.timestamp)          : null,
    expiresAt:           raw.expiresAt          ? new Date(raw.expiresAt)          : null,
    liveLocationExpiry:  raw.liveLocationExpiry ? new Date(raw.liveLocationExpiry) : null,
  } as FireMessage;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Load all locally-cached messages for a chat. Returns [] on any error. */
export async function loadLocalMessages(chatId: string): Promise<FireMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY(chatId));
    if (!raw) return [];
    const parsed: any[] = JSON.parse(raw);
    return parsed.map(deserialise);
  } catch (err) {
    console.warn('[useLocalMessages] load error:', err);
    return [];
  }
}

/**
 * Merge a message batch into the local cache. Besides the server id, media
 * sends are deduplicated by (senderId, clientId): the optimistic record uses
 * clientId as its temporary id, while the server returns a different id but
 * preserves clientId. This replacement prevents duplicate bubbles.
 */
export async function mergeLocalMessages(
  chatId: string,
  incoming: FireMessage[],
): Promise<void> {
  return enqueueWrite(chatId, async () => {
    try {
      const existing = await loadLocalMessages(chatId);
      const map = new Map<string, FireMessage>();
      for (const m of existing) map.set(m.messageId, m);

      for (const message of incoming) {
        if (message.clientId) {
          for (const [id, cached] of map) {
            if (
              id !== message.messageId &&
              cached.senderId === message.senderId &&
              cached.clientId === message.clientId
            ) {
              map.delete(id);
            }
          }
        }
        map.set(message.messageId, message);
      }

      const merged = Array.from(map.values()).sort((a, b) => {
        const ta = a.timestamp?.getTime() ?? Number.POSITIVE_INFINITY;
        const tb = b.timestamp?.getTime() ?? Number.POSITIVE_INFINITY;
        return ta - tb;
      });

      await AsyncStorage.setItem(KEY(chatId), JSON.stringify(merged.map(serialise)));
    } catch (err) {
      console.warn('[useLocalMessages] merge error:', err);
    }
  });
}

/** Persist a patch to one optimistic message (used for stage/failure changes). */
export async function updateLocalMessage(
  chatId: string,
  messageId: string,
  patch: Partial<FireMessage>,
): Promise<void> {
  return enqueueWrite(chatId, async () => {
    try {
      const existing = await loadLocalMessages(chatId);
      const updated = existing.map((m) =>
        m.messageId === messageId ? { ...m, ...patch } : m,
      );
      await AsyncStorage.setItem(KEY(chatId), JSON.stringify(updated.map(serialise)));
    } catch (err) {
      console.warn('[useLocalMessages] updateLocalMessage error:', err);
    }
  });
}

/** Wipe the local cache for a single chat (called by "Clear Chat"). */
export async function clearLocalMessages(chatId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY(chatId));
  } catch (err) {
    console.warn('[useLocalMessages] clear error:', err);
  }
}

/** Remove a single message from the local cache (used by "delete for me"). */
export async function removeLocalMessage(chatId: string, messageId: string): Promise<void> {
  try {
    const existing = await loadLocalMessages(chatId);
    const filtered = existing.filter((m) => m.messageId !== messageId);
    await AsyncStorage.setItem(KEY(chatId), JSON.stringify(filtered.map(serialise)));
  } catch (err) {
    console.warn('[useLocalMessages] removeLocalMessage error:', err);
  }
}

// ── Per-user "deleted for me" id set ─────────────────────────────────────────
// These ids are hidden locally even if the backend re-delivers the message
// (e.g. on reconnect). Stored separately from the message cache so clearing the
// cache doesn't lose them.

const DELETED_KEY = (chatId: string) => `deleted_ids_${chatId}`;

/** Load the set of message ids this user deleted "for me" in a chat. */
export async function loadDeletedIds(chatId: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(DELETED_KEY(chatId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('[useLocalMessages] loadDeletedIds error:', err);
    return [];
  }
}

/** Add message ids to the per-user deleted-for-me set. */
export async function addDeletedIds(chatId: string, ids: string[]): Promise<void> {
  try {
    const existing = await loadDeletedIds(chatId);
    const merged = Array.from(new Set([...existing, ...ids]));
    await AsyncStorage.setItem(DELETED_KEY(chatId), JSON.stringify(merged));
  } catch (err) {
    console.warn('[useLocalMessages] addDeletedIds error:', err);
  }
}

/** Clear the per-user deleted-for-me set (called by "Clear Chat"). */
export async function clearDeletedIds(chatId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(DELETED_KEY(chatId));
  } catch (err) {
    console.warn('[useLocalMessages] clearDeletedIds error:', err);
  }
}
