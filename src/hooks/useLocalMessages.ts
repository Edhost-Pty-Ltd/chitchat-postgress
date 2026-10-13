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
 * Merge an incoming batch of Firestore messages into the local cache.
 * New messages are added; existing ones are updated in place.
 * The merged list is sorted by timestamp ascending before saving.
 */
export async function mergeLocalMessages(
  chatId: string,
  incoming: FireMessage[],
): Promise<void> {
  try {
    const existing = await loadLocalMessages(chatId);

    // Build a map keyed by messageId so duplicates are overwritten.
    const map = new Map<string, FireMessage>();
    for (const m of existing)  map.set(m.messageId, m);
    for (const m of incoming)  map.set(m.messageId, m);

    // Sort ascending by timestamp. A null timestamp means the message was just
    // sent and its server timestamp hasn't resolved yet — it's the newest, so
    // sort it to the BOTTOM (treat as +Infinity), not the top.
    const merged = Array.from(map.values()).sort((a, b) => {
      const ta = a.timestamp?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const tb = b.timestamp?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });

    await AsyncStorage.setItem(KEY(chatId), JSON.stringify(merged.map(serialise)));
  } catch (err) {
    console.warn('[useLocalMessages] merge error:', err);
  }
}

/** Wipe the local cache for a single chat (called by "Clear Chat"). */
export async function clearLocalMessages(chatId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY(chatId));
  } catch (err) {
    console.warn('[useLocalMessages] clear error:', err);
  }
}

/** Remove a single message from the local cache (called when a user deletes it). */
export async function removeLocalMessage(chatId: string, messageId: string): Promise<void> {
  try {
    const existing = await loadLocalMessages(chatId);
    const next = existing.filter((m) => m.messageId !== messageId);
    await AsyncStorage.setItem(KEY(chatId), JSON.stringify(next.map(serialise)));
  } catch (err) {
    console.warn('[useLocalMessages] removeLocalMessage error:', err);
  }
}
