// ─── useContacts Hook ─────────────────────────────────────────────────────────
// Fetches ALL phone contacts and optionally checks which ones are registered in Firestore.

import { useState, useEffect, useCallback } from 'react';
import { getContactsAsync, requestPermissionsAsync, Fields } from 'expo-contacts/legacy';
import firestore from '@react-native-firebase/firestore';
import { normalizePhone, chunkArray } from '../utils/phoneUtils';

export interface AppContact {
  userId:            string;        // Normalized phone number (used as unique key)
  phone:             string;
  displayName:       string;
  isSaved:           boolean;       // true if registered in Firestore
  photoUri?:         string;
  firebasePhotoURL?: string;
}

type PermState = 'granted' | 'denied' | 'undetermined';

export function useContacts() {
  const [contacts,      setContacts]      = useState<AppContact[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [permission,    setPermission]    = useState<PermState>('undetermined');
  const [canAskAgain,   setCanAskAgain]   = useState(true);

  const loadContacts = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // ── 1. Permission ──────────────────────────────────────────────────
      const perm = await requestPermissionsAsync();
      const status = perm.status as PermState;
      setPermission(status);
      setCanAskAgain(perm.canAskAgain ?? true);
      console.log('[useContacts] permission:', status, 'canAskAgain:', perm.canAskAgain);

      if (status !== 'granted') {
        setError(
          status === 'denied'
            ? 'Contacts permission denied. Enable it in Settings to invite friends.'
            : 'Contacts permission required.'
        );
        setContacts([]);
        return;
      }

      // ── 2. Device contacts ─────────────────────────────────────────────
      const { data } = await getContactsAsync({
        fields: [Fields.Name, Fields.PhoneNumbers, Fields.Image],
      });
      console.log('[useContacts] raw device contacts:', data.length);

      // Build a map of all contacts from the phone (one entry per unique phone number)
      const contactsByPhone = new Map<string, {
        name: string;
        photoUri?: string;
        contactId: string;
        rawPhone: string;  // Original phone number for uniqueness
      }>();

      for (const contact of data) {
        if (!contact.phoneNumbers) continue;
        for (const pn of contact.phoneNumbers) {
          if (!pn.number) continue;
          const normalized = normalizePhone(pn.number);
          if (!normalized) continue;
          
          // Use normalized phone as key to avoid duplicates
          // If same normalized number appears twice, first one wins
          if (!contactsByPhone.has(normalized)) {
            contactsByPhone.set(normalized, {
              name: contact.name || pn.number,
              photoUri: contact.imageAvailable && contact.image?.uri ? contact.image.uri : undefined,
              contactId: contact.id || normalized,
              rawPhone: pn.number,
            });
          }
        }
      }
      console.log('[useContacts] unique normalized phones:', contactsByPhone.size);

      if (contactsByPhone.size === 0) {
        setError('No contacts found on this device.');
        setContacts([]);
        return;
      }

      // ── 3. Check Firestore to see which contacts are registered ────────
      const phones = Array.from(contactsByPhone.keys());
      const chunks = chunkArray(phones, 30);
      const registeredUsers = new Map<string, { userId: string; photoURL?: string }>();

      for (const chunk of chunks) {
        const snap = await firestore()
          .collection('users')
          .where('phone', 'in', chunk)
          .get();

        for (const doc of snap.docs) {
          const data          = doc.data();
          const phone         = data.phone as string;
          const photoPrivacy  = data.privacyProfilePhoto ?? 'Contacts';
          const firebasePhotoURL = photoPrivacy === 'Nobody' ? null : (data.photoURL || null);

          registeredUsers.set(phone, {
            userId: doc.id,
            photoURL: firebasePhotoURL ?? undefined,
          });
        }
      }

      console.log('[useContacts] registered users found:', registeredUsers.size);

      // ── 4. Build final contacts list (ALL contacts, marking registered ones) ──
      const appContacts: AppContact[] = [];

      for (const [phone, contactInfo] of contactsByPhone.entries()) {
        const registeredUser = registeredUsers.get(phone);

        appContacts.push({
          // Use the Firebase UID for registered users so that Firestore
          // `participants` array contains UIDs, matching the
          // `where('participants', 'array-contains', user.uid)` query.
          // Fall back to phone number for unregistered contacts.
          userId:           registeredUser?.userId ?? phone,
          phone,
          displayName:      contactInfo.name,
          isSaved:          !!registeredUser,
          photoUri:         contactInfo.photoUri,
          firebasePhotoURL: registeredUser?.photoURL,
        });
      }

      // Sort by display name
      appContacts.sort((a, b) => a.displayName.localeCompare(b.displayName));
      
      console.log('[useContacts] total contacts returned:', appContacts.length);
      console.log('[useContacts] registered users:', appContacts.filter(c => c.isSaved).length);
      
      setContacts(appContacts);
    } catch (err: any) {
      console.error('[useContacts] load failed:', err);
      setError(err?.message ?? 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  return {
    contacts,
    loading,
    error,
    permission,
    canAskAgain,
    hasPermission: permission === 'granted',
    reload: loadContacts,
  };
}