// ─── useChatPrefs ─────────────────────────────────────────────────────────────
// Local, device-side chat preferences: pinned chats (max 3), favourites, and
// muted chats. Stored in AsyncStorage keyed per owner so they survive restarts.
//
// These are intentionally local (not synced to Firestore) — they mirror how
// mute is already stored on-device via the `chat_mute_` keys.

import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

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

  // Load the muted state for a set of chats (so the list can show mute badges)
  const loadMutedFor = useCallback(async (chatIds: string[]) => {
    try {
      const entries = await AsyncStorage.multiGet(chatIds.map(MUTE_KEY));
      const set = new Set<string>();
      entries.forEach(([key, val]) => {
        if (val === 'true') set.add(key.replace('chat_mute_', ''));
      });
      setMutedChats(set);
    } catch { /* ignore */ }
  }, []);

  const toggleMute = useCallback(async (chatId: string) => {
    const key = MUTE_KEY(chatId);
    const raw = await AsyncStorage.getItem(key);
    const nextMuted = raw !== 'true';
    await AsyncStorage.setItem(key, String(nextMuted));
    setMutedChats((prev) => {
      const copy = new Set(prev);
      if (nextMuted) copy.add(chatId); else copy.delete(chatId);
      return copy;
    });
    // Persist to Firestore so the push Cloud Function can skip muted recipients
    if (ownerUid) {
      try {
        await (db as ReturnType<typeof firestore>)
          .collection('chats').doc(chatId)
          .set({ mutedBy: { [ownerUid]: nextMuted } }, { merge: true });
      } catch (err) {
        console.warn('[useChatPrefs] Failed to sync mute to Firestore:', err);
      }
    }
    return nextMuted;
  }, [ownerUid]);

  return {
    pinned, favourites, mutedChats,
    togglePin, toggleFavourite, toggleMute, loadMutedFor, reload,
  };
}
