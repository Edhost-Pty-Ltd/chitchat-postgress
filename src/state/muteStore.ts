// ─── muteStore ────────────────────────────────────────────────────────────────
// Tiny in-memory store of which chats are muted, shared across the app so the
// in-app notification path (useNotificationSync) and the chat UIs agree — and
// so a muted chat produces *no* notification at all (no push AND no in-app
// banner).
//
// Each entry carries its expiry: an epoch-ms instant, or `null` for an
// indefinite ("Always") mute. `isMuted` is expiry-aware and self-cleans lapsed
// entries. The store is:
//   • updated immediately on local mute/unmute, so notifications stop the
//     instant you mute (no round trip), and
//   • hydrated from the server's authoritative active-mute list on connect and
//     when the chat list refreshes.

type Listener = () => void;

const expiry = new Map<string, number | null>();
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((l) => l());
}

export const muteStore = {
  /** Mute a chat until `mutedUntil` (ISO instant) or forever when null. */
  mute(chatId: string, mutedUntil: string | null): void {
    expiry.set(chatId, mutedUntil ? Date.parse(mutedUntil) : null);
    notify();
  },

  unmute(chatId: string): void {
    if (expiry.delete(chatId)) notify();
  },

  /**
   * Replace the known mute set from the server's active-mute list (which
   * already excludes expired mutes). Precise local expiries are preserved for
   * chats still present so they can lapse client-side without a re-fetch.
   */
  hydrate(chatIds: string[]): void {
    const incoming = new Set(chatIds);
    const next = new Map<string, number | null>();
    for (const id of chatIds) next.set(id, expiry.has(id) ? expiry.get(id)! : null);
    // Drop anything the server no longer reports as muted.
    let changed = next.size !== expiry.size;
    for (const id of expiry.keys()) if (!incoming.has(id)) changed = true;
    expiry.clear();
    for (const [k, v] of next) expiry.set(k, v);
    if (changed) notify();
  },

  /** Whether this chat is currently muted. Self-cleans lapsed entries. */
  isMuted(chatId: string): boolean {
    if (!expiry.has(chatId)) return false;
    const until = expiry.get(chatId)!;
    if (until === null) return true; // Always
    if (Date.now() < until) return true;
    expiry.delete(chatId); // lapsed
    return false;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
