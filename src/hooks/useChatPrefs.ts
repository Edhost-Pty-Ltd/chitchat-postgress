// ─── useChatPrefs ─────────────────────────────────────────────────────────────
// Device-side chat preferences: pinned chats (max 3) and favourites are local
// (AsyncStorage, per owner). Muted chats are backend-backed (listMutedChats /
// setChatMuted) with a local cache mirror for offline display.

import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { endpoints } from '../api/endpoints';
import { muteStore } from '../state/muteStore';

export const MAX_PINNED = 3;

const PIN_KEY  = (uid: string) => `chat_pinned_${uid}`;
const FAV_KEY  = (uid: string) => `chat_favourites_${uid}`;
const MUTE_KEY = (chatId: string) => `chat_mute_${chatId}`;

async function readList(key: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function useChatPrefs(ownerUid: string | null) {
  const [pinned, setPinned]         = useState<string[]>([]);
  const [favourites, setFavourites] = useState<string[]>([]);
  const [mutedChats, setMutedChats] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    if (!ownerUid) { setPinned([]); setFavourites([]); setMutedChats(new Set()); return; }
    const [p, f] = await Promise.all([
      readList(PIN_KEY(ownerUid)),
      readList(FAV_KEY(ownerUid)),
    ]);
    setPinned(p.slice(0, MAX_PINNED));
    setFavourites(f);
  }, [ownerUid]);

  useEffect(() => { reload(); }, [reload]);

  const togglePin = useCallback(async (chatId: string): Promise<{ ok: boolean; reason?: string }> => {
    if (!ownerUid) return { ok: false };
    const current = await readList(PIN_KEY(ownerUid));
    let next: string[];
    if (current.includes(chatId)) {
      next = current.filter((id) => id !== chatId);
    } else {
      if (current.length >= MAX_PINNED) {
        return { ok: false, reason: `You can pin up to ${MAX_PINNED} chats.` };
      }
      next = [...current, chatId];
    }
    await AsyncStorage.setItem(PIN_KEY(ownerUid), JSON.stringify(next));
    setPinned(next);
    return { ok: true };
  }, [ownerUid]);

  const toggleFavourite = useCallback(async (chatId: string) => {
    if (!ownerUid) return;
    const current = await readList(FAV_KEY(ownerUid));
    const next = current.includes(chatId)
      ? current.filter((id) => id !== chatId)
      : [...current, chatId];
    await AsyncStorage.setItem(FAV_KEY(ownerUid), JSON.stringify(next));
    setFavourites(next);
  }, [ownerUid]);

  // Load the muted state for a set of chats (so the list can show mute badges).
  // Mute is backend-backed now: hydrate from the server's muted-chats list and
  // mirror it into the local cache (used as an offline fallback).
  const loadMutedFor = useCallback(async (chatIds: string[]) => {
    try {
      const res = await endpoints.listMutedChats();
      if (res.ok) {
        const set = new Set(res.data.chatIds);
        setMutedChats(set);
        // Share with the in-app notification path so muted chats stay silent.
        muteStore.hydrate(res.data.chatIds);
        // Keep the local cache in sync for offline display.
        await AsyncStorage.multiSet(
          chatIds.map((id) => [MUTE_KEY(id), String(set.has(id))]),
        );
        return;
      }
    } catch { /* fall through to local cache */ }

    // Offline fallback: read the local cache.
    try {
      const entries = await AsyncStorage.multiGet(chatIds.map(MUTE_KEY));
      const set = new Set<string>();
      entries.forEach(([key, val]) => {
        if (val === 'true') set.add(key.replace('chat_mute_', ''));
      });
      setMutedChats(set);
    } catch { /* ignore */ }
  }, []);

  // Mute a chat until `mutedUntil` (ISO instant) or forever when null ("Always").
  const muteChat = useCallback(async (chatId: string, mutedUntil: string | null = null) => {
    await AsyncStorage.setItem(MUTE_KEY(chatId), 'true');
    setMutedChats((prev) => {
      const copy = new Set(prev);
      copy.add(chatId);
      return copy;
    });
    // Silence the in-app notification path immediately (no round trip).
    muteStore.mute(chatId, mutedUntil);
    // Persist to the backend so push notifications skip this chat until it lapses.
    try {
      await endpoints.setChatMuted(chatId, true, mutedUntil);
    } catch (err) {
      console.warn('[useChatPrefs] Failed to sync mute to backend:', err);
    }
  }, []);

  const unmuteChat = useCallback(async (chatId: string) => {
    await AsyncStorage.setItem(MUTE_KEY(chatId), 'false');
    setMutedChats((prev) => {
      const copy = new Set(prev);
      copy.delete(chatId);
      return copy;
    });
    muteStore.unmute(chatId);
    try {
      await endpoints.setChatMuted(chatId, false);
    } catch (err) {
      console.warn('[useChatPrefs] Failed to sync unmute to backend:', err);
    }
  }, []);

  return {
    pinned, favourites, mutedChats,
    togglePin, toggleFavourite, muteChat, unmuteChat, loadMutedFor, reload,
  };
}
