// ─── useContacts Hook ─────────────────────────────────────────────────────────
// Fetches all phone contacts and checks which are registered via the backend.

import { useState, useEffect, useCallback } from 'react';
import { getContactsAsync, requestPermissionsAsync, Fields } from 'expo-contacts/legacy';
import { normalizePhone, chunkArray } from '../utils/phoneUtils';
import { endpoints } from '../api/endpoints';

export interface AppContact {
  userId:            string;
  phone:             string;
  displayName:       string;
  isSaved:           boolean;
  photoUri?:         string;
  firebasePhotoURL?: string;
}

type PermState = 'granted' | 'denied' | 'undetermined';

export function useContacts() {
  const [contacts,    setContacts]    = useState<AppContact[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [permission,  setPermission]  = useState<PermState>('undetermined');
  const [canAskAgain, setCanAskAgain] = useState(true);

  const loadContacts = useCallback(async () => {
    try {
      setLoading(true); setError(null);

      const perm   = await requestPermissionsAsync();
      const status = perm.status as PermState;
      console.log('[useContacts] permission status:', status, 'canAskAgain:', perm.canAskAgain, 'accessPrivileges:', (perm as any).accessPrivileges);
      setPermission(status);
      setCanAskAgain(perm.canAskAgain ?? true);

      if (status !== 'granted') {
        setError(status === 'denied'
          ? 'Contacts permission denied. Enable it in Settings to invite friends.'
          : 'Contacts permission required.');
        setContacts([]);
        return;
      }

      const { data } = await getContactsAsync({
        fields: [Fields.Name, Fields.PhoneNumbers, Fields.Image],
      });

      const contactsByPhone = new Map<string, { name: string; photoUri?: string }>();
      for (const contact of data) {
        if (!contact.phoneNumbers) continue;
        for (const pn of contact.phoneNumbers) {
          if (!pn.number) continue;
          const normalized = normalizePhone(pn.number);
          if (!normalized || contactsByPhone.has(normalized)) continue;
          contactsByPhone.set(normalized, {
            name: contact.name || pn.number,
            photoUri: contact.imageAvailable && contact.image?.uri ? contact.image.uri : undefined,
          });
        }
      }

      if (contactsByPhone.size === 0) {
        setError('No contacts found on this device.');
        setContacts([]);
        return;
      }

      const phones = Array.from(contactsByPhone.keys());
      const registeredUsers = new Map<string, { userId: string; photoURL?: string }>();

      const chunks = chunkArray(phones, 500);
      for (const chunk of chunks) {
        const res = await endpoints.matchContacts(chunk);
        if (!res.ok) { console.error('[useContacts] backend match failed:', res.error); continue; }
        for (const m of res.data.matches) {
          if (m.phoneNumber) {
            registeredUsers.set(m.phoneNumber, {
              userId: m.userId,
              photoURL: m.avatarObjectKey ?? undefined,
            });
          }
        }
      }

      const appContacts: AppContact[] = Array.from(contactsByPhone.entries()).map(([phone, info]) => {
        const reg = registeredUsers.get(phone);
        return {
          userId:           reg?.userId ?? phone,
          phone,
          displayName:      info.name,
          isSaved:          !!reg,
          photoUri:         info.photoUri,
          firebasePhotoURL: reg?.photoURL,
        };
      });

      appContacts.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setContacts(appContacts);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  return {
    contacts, loading, error, permission, canAskAgain,
    hasPermission: permission === 'granted',
    reload: loadContacts,
  };
}
