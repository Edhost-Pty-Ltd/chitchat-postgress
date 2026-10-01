// ─── useContacts Hook ─────────────────────────────────────────────────────────
// Fetches ALL phone contacts for primary devices and syncs them to Firestore.
// For companion devices, it fetches the synced contacts directly from Firestore.

import { useState, useEffect, useCallback } from 'react';
import { getContactsAsync, requestPermissionsAsync, Fields } from 'expo-contacts/legacy';
import firestore from '@react-native-firebase/firestore';
import { normalizePhone, chunkArray } from '../utils/phoneUtils';
import { useAuth } from '../context/AuthContext';

export interface AppContact {
  userId:            string;        // Normalized phone number or Firebase UID
  phone:             string;
  displayName:       string;
  isSaved:           boolean;       // true if registered in Firestore
  photoUri?:         string;
  firebasePhotoURL?: string;
}

type PermState = 'granted' | 'denied' | 'undetermined';

export function useContacts() {
  const { ownerUid, isCompanion } = useAuth();
  
  const [contacts,      setContacts]      = useState<AppContact[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [permission,    setPermission]    = useState<PermState>('undetermined');
  const [canAskAgain,   setCanAskAgain]   = useState(true);

  const loadContacts = useCallback(async () => {
    // If auth is not ready, wait.
    if (!ownerUid) {
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      // ── COMPANION DEVICE FLOW ──────────────────────────────────────────
      if (isCompanion) {
        setPermission('granted'); // Companions don't need local device permissions
        
        console.log('[useContacts] Companion device detected. Fetching synced contacts from Firestore...');
        const snap = await firestore()
          .collection('users')
          .doc(ownerUid)
          .collection('syncedContacts')
          .get();

        const appContacts: AppContact[] = snap.docs.map(doc => doc.data() as AppContact);
        appContacts.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));

        console.log(`[useContacts] Companion loaded ${appContacts.length} synced contacts.`);
        setContacts(appContacts);
        setLoading(false);
        return;
      }

      // ── PRIMARY DEVICE FLOW ────────────────────────────────────────────
      // 1. Permission
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

      // 2. Device contacts
      const { data } = await getContactsAsync({
        fields: [Fields.Name, Fields.PhoneNumbers, Fields.Image],
      });
      console.log('[useContacts] raw device contacts:', data.length);

      const contactsByPhone = new Map<string, {
        name: string;
        photoUri?: string | null;
        contactId: string;
        rawPhone: string;
      }>();

      for (const contact of data) {
        if (!contact.phoneNumbers) continue;
        for (const pn of contact.phoneNumbers) {
          if (!pn.number) continue;
          const normalized = normalizePhone(pn.number);
          if (!normalized) continue;
          
          if (!contactsByPhone.has(normalized)) {
            contactsByPhone.set(normalized, {
              name: contact.name || pn.number,
              photoUri: contact.imageAvailable && contact.image?.uri ? contact.image.uri : null,
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

      // 3. Check Firestore to see which contacts are registered
      const phones = Array.from(contactsByPhone.keys());
      const registeredUsers = new Map<string, { userId: string; photoURL?: string | null }>();

      const chunks = chunkArray(phones, 30);
      for (const chunk of chunks) {
        const snap = await firestore()
          .collection('users')
          .where('phone', 'in', chunk)
          .get();

        for (const doc of snap.docs) {
          const docData       = doc.data();
          const phone         = docData.phone as string;
          const photoPrivacy  = docData.privacyProfilePhoto ?? 'Contacts';
          const firebasePhotoURL = photoPrivacy === 'Nobody' ? null : (docData.photoURL || null);

          registeredUsers.set(phone, {
            userId: doc.id,
            photoURL: firebasePhotoURL ?? undefined,
          });
        }
      }

      console.log('[useContacts] registered users found:', registeredUsers.size);

      // 4. Build final contacts list
      const appContacts: AppContact[] = [];

      for (const [phone, contactInfo] of contactsByPhone.entries()) {
        const registeredUser = registeredUsers.get(phone);

        appContacts.push({
          userId:           registeredUser?.userId ?? phone,
          phone,
          displayName:      contactInfo.name,
          isSaved:          !!registeredUser,
          photoUri:         contactInfo.photoUri || undefined,
          firebasePhotoURL: registeredUser?.photoURL || undefined,
        });
      }

      appContacts.sort((a, b) => a.displayName.localeCompare(b.displayName));
      setContacts(appContacts);

      // 5. Background Sync: Upload contacts to Firestore for Companion Devices
      const syncContactsToFirestore = async (contactsToSync: AppContact[]) => {
        try {
          const fsDb = firestore();
          const syncedRef = fsDb.collection('users').doc(ownerUid).collection('syncedContacts');
          
          // Use chunk size of 450 to stay safely under Firestore's 500 batch limit
          const syncChunks = chunkArray(contactsToSync, 450);
          
          for (const chunk of syncChunks) {
            const batch = fsDb.batch();
            for (const c of chunk) {
              // Create a safe document ID from the phone number
              const docId = c.phone.replace(/[^0-9+]/g, '');
              const docRef = syncedRef.doc(docId);
              
              // Firestore rejects undefined values, ensure strict null mapping
              const safeContactData = {
                userId: c.userId,
                phone: c.phone,
                displayName: c.displayName,
                isSaved: c.isSaved,
                photoUri: c.photoUri ?? null,
                firebasePhotoURL: c.firebasePhotoURL ?? null,
              };
              
              batch.set(docRef, safeContactData, { merge: true });
            }
            await batch.commit();
          }
          console.log('[useContacts] Successfully synced contacts to Firestore for companion devices.');
        } catch (err) {
          console.error('[useContacts] Failed to sync contacts to Firestore:', err);
        }
      };

      // Fire and forget the sync so it doesn't block UI loading
      syncContactsToFirestore(appContacts);

    } catch (err: any) {
      console.error('[useContacts] load failed:', err);
      setError(err?.message ?? 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, [ownerUid, isCompanion]);

  useEffect(() => { 
    loadContacts(); 
  }, [loadContacts]);

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