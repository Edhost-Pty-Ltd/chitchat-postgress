// ─── usePrivacySettings Hook ──────────────────────────────────────────────────
// Reads and persists the current user's privacy preferences.
//
// COMPANION NOTE
//   Reads work anywhere. Writes go to users/{userId} and are owner-only per
//   the rules; on a companion the auth uid is anon, not the owner uid, so
//   writes are refused locally before Firestore sees them — the hook returns
//   silently and the caller's UI guard is responsible for showing the notice.
//
import { useState, useEffect, useCallback } from 'react';
import firestore from '@react-native-firebase/firestore';
import { getAuth } from '@react-native-firebase/auth';
import { db } from '../config/firebase';

export type Visibility = 'Everyone' | 'Contacts' | 'Nobody';

export interface PrivacySettings {
  lastSeen:             Visibility;
  profilePhoto:         Visibility;
  statusVisibility:     Visibility;
  groups:               Visibility;
  calls:                Visibility;
  readReceipts:         boolean;
  disappearingMessages: boolean;
}

export const DEFAULT_PRIVACY: PrivacySettings = {
  lastSeen:             'Contacts',
  profilePhoto:         'Contacts',
  statusVisibility:     'Everyone',
  groups:               'Contacts',
  calls:                'Contacts',
  readReceipts:         true,
  disappearingMessages: true,
};

const FIELD_MAP: Record<keyof PrivacySettings, string> = {
  lastSeen:             'privacyLastSeen',
  profilePhoto:         'privacyProfilePhoto',
  statusVisibility:     'privacyStatus',
  groups:               'privacyGroups',
  calls:                'privacyCalls',
  readReceipts:         'readReceipts',
  disappearingMessages: 'disappearingMessages',
};

function parseSettings(d: Record<string, any>): PrivacySettings {
  return {
    lastSeen:             (d.privacyLastSeen     as Visibility) ?? DEFAULT_PRIVACY.lastSeen,
    profilePhoto:         (d.privacyProfilePhoto as Visibility) ?? DEFAULT_PRIVACY.profilePhoto,
    statusVisibility:     (d.privacyStatus       as Visibility) ?? DEFAULT_PRIVACY.statusVisibility,
    groups:               (d.privacyGroups       as Visibility) ?? DEFAULT_PRIVACY.groups,
    calls:                (d.privacyCalls        as Visibility) ?? DEFAULT_PRIVACY.calls,
    readReceipts:         d.readReceipts         != null ? !!d.readReceipts         : DEFAULT_PRIVACY.readReceipts,
    disappearingMessages: d.disappearingMessages != null ? !!d.disappearingMessages : DEFAULT_PRIVACY.disappearingMessages,
  };
}

// True when the caller's Firebase Auth uid matches `userId` — i.e. this is
// the primary and writes to users/{userId} are permitted.
function canWriteFor(uid: string | null): boolean {
  if (!uid) return false;
  const authUid = getAuth().currentUser?.uid;
  return !!authUid && authUid === uid;
}

export function usePrivacySettings(userId: string | null) {
  const [settings, setSettings] = useState<PrivacySettings>(DEFAULT_PRIVACY);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);

  useEffect(() => {
    if (!userId) { setLoading(false); return; }

    const fsDb = db as ReturnType<typeof firestore>;
    const unsub = fsDb.collection('users').doc(userId).onSnapshot(
      (snap) => {
        if (!snap.exists) { setLoading(false); return; }
        setSettings(parseSettings(snap.data()!));
        setLoading(false);
      },
      () => setLoading(false),
    );

    return () => unsub();
  }, [userId]);

  const updateSetting = useCallback(
    async <K extends keyof PrivacySettings>(key: K, value: PrivacySettings[K]): Promise<void> => {
      if (!userId) return;

      // Companion device: refuse silently. The screen layer already shows the
      // user a "managed on primary" alert; we do not want the optimistic UI
      // update either, otherwise the settings would flash the new value and
      // then revert on the next snapshot.
      if (!canWriteFor(userId)) {
        console.warn('[usePrivacySettings] Update rejected — not the primary device for', userId);
        return;
      }

      setSettings((prev) => ({ ...prev, [key]: value }));
      setSaving(true);
      try {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(userId).set(
          { [FIELD_MAP[key]]: value },
          { merge: true },
        );
      } catch (err) {
        console.error('[usePrivacySettings] Failed to save:', key, err);
      } finally {
        setSaving(false);
      }
    },
    [userId],
  );

  const saveAll = useCallback(
    async (s: PrivacySettings): Promise<void> => {
      if (!userId) return;

      if (!canWriteFor(userId)) {
        console.warn('[usePrivacySettings] saveAll rejected — not the primary device for', userId);
        return;
      }

      setSettings(s);
      setSaving(true);
      try {
        const patch: Record<string, unknown> = {};
        (Object.keys(FIELD_MAP) as (keyof PrivacySettings)[]).forEach((k) => {
          patch[FIELD_MAP[k]] = s[k];
        });
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(userId).set(patch, { merge: true });
      } catch (err) {
        console.error('[usePrivacySettings] Failed to save all:', err);
      } finally {
        setSaving(false);
      }
    },
    [userId],
  );

  return { settings, loading, saving, updateSetting, saveAll };
}

// Reading another user's privacy is read-only and works on both primary
// and companion devices. No guard required.
export async function fetchUserPrivacySettings(userId: string): Promise<PrivacySettings> {
  try {
    const fsDb = db as ReturnType<typeof firestore>;
    const snap = await fsDb.collection('users').doc(userId).get();
    if (!snap.exists) return DEFAULT_PRIVACY;
    return parseSettings(snap.data()!);
  } catch {
    return DEFAULT_PRIVACY;
  }
}

export function isVisibleTo(setting: Visibility, viewerIsContact: boolean): boolean {
  if (setting === 'Everyone') return true;
  if (setting === 'Nobody')   return false;
  return viewerIsContact;
}