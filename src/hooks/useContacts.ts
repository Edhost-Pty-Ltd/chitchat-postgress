// ─── useContacts Hook ─────────────────────────────────────────────────────────
// Fetches phone contacts, normalizes numbers, then cross-references with Firestore.

import { useState, useEffect } from 'react';
import { getContactsAsync, requestPermissionsAsync, Fields } from 'expo-contacts/legacy';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { normalizePhone, chunkArray } from '../utils/phoneUtils';

export interface AppContact {
  userId:             string;
  phone:              string;
  displayName:        string;
  isSaved:            boolean;
  photoUri?:          string;
  firebasePhotoURL?:  string;
}

export function useContacts() {
  const [contacts,      setContacts]      = useState<AppContact[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [hasPermission, setHasPermission] = useState(false);

  useEffect(() => { loadContacts(); }, []);

  async function loadContacts() {
    try {
      setLoading(true);
      setError(null);

      const { status } = await requestPermissionsAsync();
      if (status !== 'granted') {
        setError('Contacts permission denied');
        setLoading(false);
        return;
      }
      setHasPermission(true);

      const { data } = await getContactsAsync({
        fields: [Fields.Name, Fields.PhoneNumbers, Fields.Image],
      });

      const phoneToName  = new Map<string, string>();
      const phoneToPhoto = new Map<string, string>();

      for (const contact of data) {
        if (!contact.phoneNumbers) continue;
        for (const pn of contact.phoneNumbers) {
          if (!pn.number) continue;
          const normalized = normalizePhone(pn.number);
          phoneToName.set(normalized, contact.name || pn.number);
          if (contact.imageAvailable && contact.image?.uri) {
            phoneToPhoto.set(normalized, contact.image.uri);
          }
        }
      }

      if (phoneToName.size === 0) { setContacts([]); setLoading(false); return; }

      const fsDb = db as ReturnType<typeof firestore>;
      const phones = Array.from(phoneToName.keys());
      const chunks = chunkArray(phones, 30);
      const appContacts: AppContact[] = [];

      for (const chunk of chunks) {
        const snap = await fsDb
          .collection('users')
          .where('phone', 'in', chunk)
          .get();

        for (const doc of snap.docs) {
          const data     = doc.data();
          const phone    = data.phone as string;
          const photoPrivacy = data.privacyProfilePhoto ?? 'Contacts';
          const firebasePhotoURL = photoPrivacy === 'Nobody' ? null : (data.photoURL || null);

          appContacts.push({
            userId:           doc.id,
            phone,
            displayName:      phoneToName.get(phone) ?? phone,
            isSaved:          true,
            photoUri:         phoneToPhoto.get(phone),
            firebasePhotoURL: firebasePhotoURL ?? undefined,
          });
        }
      }

      appContacts.sort((a, b) => {
        if (a.isSaved && !b.isSaved) return -1;
        if (!a.isSaved && b.isSaved) return 1;
        return a.displayName.localeCompare(b.displayName);
      });

      setContacts(appContacts);
    } catch (err: any) {
      setError(err.message ?? 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }

  return { contacts, loading, error, hasPermission, reload: loadContacts };
}
