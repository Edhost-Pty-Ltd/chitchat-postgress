// ─── useContacts Hook ─────────────────────────────────────────────────────────
// Fetches all phone contacts and checks which are registered via the backend.
//
// COMPANION NOTE
//   A companion device has no access to the owner's phone book, so it skips
//   the device permission entirely and shows the snapshot the primary synced
//   to the backend (GET /me/synced-contacts). The primary uploads that
//   snapshot (PUT /me/synced-contacts, primary-only) after each successful
//   load, and falls back to it when contacts permission is denied or the
//   phone book is empty (e.g. a new phone that hasn't restored contacts yet).

import { useState, useEffect, useCallback } from 'react';
import { getContactsAsync, requestPermissionsAsync, Fields } from 'expo-contacts/legacy';
import { normalizePhone, chunkArray } from '../utils/phoneUtils';
import { endpoints, type SyncedContactDTO } from '../api/endpoints';
import { useAuth } from '../context/AuthContext';
import { mediaService } from '../services/mediaService';

export interface AppContact {
  userId:            string;
  phone:             string;
  displayName:       string;
  isSaved:           boolean;
  photoUri?:         string;
  firebasePhotoURL?: string;
}

type PermState = 'granted' | 'denied' | 'undetermined';

// Backend limits for PUT /me/synced-contacts.
const SYNC_MAX_CONTACTS = 5000;
const SYNC_MAX_NAME_LEN = 200;

function sortByName(list: AppContact[]): AppContact[] {
  return list.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
}

/** True when the value looks like a bare object key (no URI scheme). */
function isObjectKey(v: string | undefined): v is string {
  return !!v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && !v.startsWith('/');
}

/**
 * Resolve avatar object keys in a contacts list to short-lived download URLs.
 * Object keys cannot be rendered directly by <Image>; they need a presigned
 * URL. Local `file:` URIs and full `https:` URLs pass through unchanged.
 */
async function resolveAvatarUrls(list: AppContact[]): Promise<AppContact[]> {
  const keys = list
    .map((c) => c.firebasePhotoURL)
    .filter(isObjectKey);
  if (keys.length === 0) return list;
  const uniqueKeys = [...new Set(keys)];
  let urls: Record<string, string> = {};
  try { urls = await mediaService.getDownloadUrls(uniqueKeys); } catch { /* leave unresolved */ }
  return list.map((c) => ({
    ...c,
    firebasePhotoURL:
      c.firebasePhotoURL && isObjectKey(c.firebasePhotoURL)
        ? urls[c.firebasePhotoURL] ?? undefined
        : c.firebasePhotoURL,
  }));
}

/** The owner's synced phone book (companion view / primary fallback). */
async function loadSyncedContacts(): Promise<AppContact[]> {
  const res = await endpoints.listSyncedContacts();
  if (!res.ok) {
    console.warn('[useContacts] synced contacts load failed:', res.error.code);
    return [];
  }
  return sortByName(
    res.data.contacts.map((c) => ({
      userId:           c.userId ?? c.phone,
      phone:            c.phone,
      displayName:      c.displayName,
      isSaved:          c.isSaved,
      firebasePhotoURL: c.avatarObjectKey ?? undefined,
    })),
  );
}

// ── Snapshot upload (primary only) ───────────────────────────────────────────
// Every screen mounts its own useContacts, so identical snapshots are only
// uploaded once per owner (and never while an identical upload is in flight).
let lastUploadedSignature: string | null = null;
let uploadInFlight: string | null = null;

function toSyncedSnapshot(contacts: AppContact[]): SyncedContactDTO[] {
  return contacts
    .filter((c) => c.phone && c.phone.length >= 3 && c.phone.length <= 32)
    // Registered contacts first so they survive the backend's size cap.
    .sort((a, b) => Number(b.isSaved) - Number(a.isSaved))
    .slice(0, SYNC_MAX_CONTACTS)
    .map((c) => ({
      phone:           c.phone,
      displayName:     (c.displayName || c.phone).slice(0, SYNC_MAX_NAME_LEN),
      userId:          c.isSaved ? c.userId : null,
      isSaved:         c.isSaved,
      avatarObjectKey: c.isSaved ? c.firebasePhotoURL ?? null : null,
    }));
}

function uploadSyncedContacts(ownerUid: string, contacts: AppContact[]): void {
  const snapshot = toSyncedSnapshot(contacts);
  const signature = `${ownerUid}|${snapshot
    .map((c) => `${c.phone}:${c.userId ?? ''}:${c.displayName}:${c.avatarObjectKey ?? ''}`)
    .sort()
    .join('|')}`;
  if (signature === lastUploadedSignature || signature === uploadInFlight) return;

  uploadInFlight = signature;
  endpoints.replaceSyncedContacts(snapshot)
    .then((res) => {
      if (res.ok) lastUploadedSignature = signature;
      else console.warn('[useContacts] synced contacts upload failed:', res.error.code);
    })
    .catch((err) => console.warn('[useContacts] synced contacts upload failed:', err))
    .finally(() => {
      if (uploadInFlight === signature) uploadInFlight = null;
    });
}

export function useContacts() {
  const { ownerUid, isCompanion } = useAuth();

  const [contacts,    setContacts]    = useState<AppContact[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);
  const [permission,  setPermission]  = useState<PermState>('undetermined');
  const [canAskAgain, setCanAskAgain] = useState(true);

  const loadContacts = useCallback(async () => {
    // Wait for auth: the backend calls below need a signed-in owner.
    if (!ownerUid) { setLoading(false); return; }

    try {
      setLoading(true); setError(null);

      // ── Companion: the owner's synced phone book, no device permission ──
      if (isCompanion) {
        setPermission('granted');
        setCanAskAgain(true);
        setContacts(await resolveAvatarUrls(await loadSyncedContacts()));
        return;
      }

      // ── Primary ─────────────────────────────────────────────────────────
      const perm   = await requestPermissionsAsync();
      const status = perm.status as PermState;
      console.log('[useContacts] permission status:', status, 'canAskAgain:', perm.canAskAgain, 'accessPrivileges:', (perm as any).accessPrivileges);
      setPermission(status);
      setCanAskAgain(perm.canAskAgain ?? true);

      if (status !== 'granted') {
        setError(status === 'denied'
          ? 'Contacts permission denied. Enable it in Settings to invite friends.'
          : 'Contacts permission required.');
        // Fall back to the phone book this account last synced to the backend.
        setContacts(await resolveAvatarUrls(await loadSyncedContacts()));
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
        // Nothing on this device yet — show the last synced snapshot, if any.
        const synced = await resolveAvatarUrls(await loadSyncedContacts());
        if (synced.length === 0) setError('No contacts found on this device.');
        setContacts(synced);
        return;
      }

      const phones = Array.from(contactsByPhone.keys());
      const registeredUsers = new Map<string, { userId: string; photoURL?: string }>();

      let matchFailed = false;
      const chunks = chunkArray(phones, 500);
      for (const chunk of chunks) {
        const res = await endpoints.matchContacts(chunk);
        if (!res.ok) {
          console.error('[useContacts] backend match failed:', res.error);
          matchFailed = true;
          continue;
        }
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

      sortByName(appContacts);
      setContacts(await resolveAvatarUrls(appContacts));

      // Sync the matched snapshot for companion devices (fire-and-forget). Only
      // after a fully successful match, so a partial result never overwrites
      // the owner's synced list.
      if (!matchFailed) uploadSyncedContacts(ownerUid, appContacts);
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load contacts');
    } finally {
      setLoading(false);
    }
  }, [ownerUid, isCompanion]);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  return {
    contacts, loading, error, permission, canAskAgain,
    hasPermission: permission === 'granted',
    reload: loadContacts,
  };
}
