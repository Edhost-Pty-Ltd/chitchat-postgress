// ─── usePrivacySettings Hook ──────────────────────────────────────────────────
// Reads and persists the current user's privacy preferences.

import { useState, useEffect, useCallback } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { useBackend } from '../config/featureFlags';
import { endpoints } from '../api/endpoints';

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

export function usePrivacySettings(userId: string | null) {
  const [settings, setSettings] = useState<PrivacySettings>(DEFAULT_PRIVACY);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);

  const backend = useBackend('users');

  useEffect(() => {
    if (!userId) { setLoading(false); return; }

    if (backend) {
      let active = true;
      endpoints
        .getPrivacy()
        .then((res) => {
          if (!active) return;
          if (res.ok) setSettings(res.data);
          setLoading(false);
        })
        .catch(() => active && setLoading(false));
      return () => { active = false; };
    }

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
  }, [userId, backend]);

  const updateSetting = useCallback(
    async <K extends keyof PrivacySettings>(key: K, value: PrivacySettings[K]): Promise<void> => {
      if (!userId) return;
      // Optimistic update, then persist the full settings object.
      const next = { ...settings, [key]: value } as PrivacySettings;
      setSettings(next);
      setSaving(true);
      try {
        if (backend) {
          const res = await endpoints.updatePrivacy(next);
          if (res.ok) setSettings(res.data);
        } else {
          const fsDb = db as ReturnType<typeof firestore>;
          await fsDb.collection('users').doc(userId).set(
            { [FIELD_MAP[key]]: value },
            { merge: true },
          );
        }
      } catch (err) {
        console.error('[usePrivacySettings] Failed to save:', key, err);
      } finally {
        setSaving(false);
      }
    },
    [userId, backend, settings],
  );

  const saveAll = useCallback(
    async (s: PrivacySettings): Promise<void> => {
      if (!userId) return;
      setSettings(s);
      setSaving(true);
      try {
        if (backend) {
          const res = await endpoints.updatePrivacy(s);
          if (res.ok) setSettings(res.data);
        } else {
          const patch: Record<string, unknown> = {};
          (Object.keys(FIELD_MAP) as (keyof PrivacySettings)[]).forEach((k) => {
            patch[FIELD_MAP[k]] = s[k];
          });
          const fsDb = db as ReturnType<typeof firestore>;
          await fsDb.collection('users').doc(userId).set(patch, { merge: true });
        }
      } catch (err) {
        console.error('[usePrivacySettings] Failed to save all:', err);
      } finally {
        setSaving(false);
      }
    },
    [userId, backend],
  );

  return { settings, loading, saving, updateSetting, saveAll };
}

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
