// ─── usePrivacySettings Hook ──────────────────────────────────────────────────
// Reads and persists privacy preferences via the backend REST API.

import { useState, useEffect, useCallback } from 'react';
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

export function usePrivacySettings(userId: string | null) {
  const [settings, setSettings] = useState<PrivacySettings>(DEFAULT_PRIVACY);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);

  useEffect(() => {
    if (!userId) { setLoading(false); return; }
    let active = true;
    endpoints.getPrivacy().then((res) => {
      if (!active) return;
      if (res.ok) setSettings(res.data);
      setLoading(false);
    }).catch(() => active && setLoading(false));
    return () => { active = false; };
  }, [userId]);

  const updateSetting = useCallback(
    async <K extends keyof PrivacySettings>(key: K, value: PrivacySettings[K]): Promise<void> => {
      if (!userId) return;
      const next = { ...settings, [key]: value } as PrivacySettings;
      setSettings(next);
      setSaving(true);
      try {
        const res = await endpoints.updatePrivacy(next);
        if (res.ok) setSettings(res.data);
      } catch (err) {
        console.error('[usePrivacySettings] Failed to save:', key, err);
      } finally { setSaving(false); }
    },
    [userId, settings],
  );

  const saveAll = useCallback(
    async (s: PrivacySettings): Promise<void> => {
      if (!userId) return;
      setSettings(s); setSaving(true);
      try {
        const res = await endpoints.updatePrivacy(s);
        if (res.ok) setSettings(res.data);
      } catch (err) {
        console.error('[usePrivacySettings] Failed to save all:', err);
      } finally { setSaving(false); }
    },
    [userId],
  );

  return { settings, loading, saving, updateSetting, saveAll };
}

/** Returns DEFAULT_PRIVACY — privacy is not queryable for other users without a dedicated endpoint. */
export async function fetchUserPrivacySettings(_userId: string): Promise<PrivacySettings> {
  return DEFAULT_PRIVACY;
}

export function isVisibleTo(setting: Visibility, viewerIsContact: boolean): boolean {
  if (setting === 'Everyone') return true;
  if (setting === 'Nobody')   return false;
  return viewerIsContact;
}
