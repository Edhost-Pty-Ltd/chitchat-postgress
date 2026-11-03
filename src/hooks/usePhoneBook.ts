// ─── usePhoneBook Hook ───────────────────────────────────────────────────────
// Exposes a Map<E.164 phone, contactName> and a resolver implementing the
// app-wide name rule:
//   • phone saved in the device contacts → the saved contact name
//   • phone NOT saved                    → the raw phone number
//
// Perf: this reuses the SAME device-contact read that useContacts performs
// (shared, cached) instead of doing its own getContactsAsync scan. Screens like
// ChatScreen and CallsScreen use both hooks, so sharing the read removes a
// second full phone-book scan on every mount. Only if useContacts hasn't
// populated the cache yet does this fall back to a direct read.

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import { normalizePhone } from '../utils/phoneUtils';
import { peekCachedContacts, subscribeContacts, type AppContact } from './useContacts';

/** Build the phone→name map from resolved contacts. */
function buildMap(contacts: AppContact[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of contacts) {
    if (c.phone && c.displayName) map.set(normalizePhone(c.phone), c.displayName);
  }
  return map;
}

export function usePhoneBook() {
  const [contactsMap, setContactsMap] = useState<Map<string, string>>(() => {
    const cached = peekCachedContacts();
    return cached ? buildMap(cached) : new Map();
  });
  const fallbackLoaded = useRef(false);

  useEffect(() => {
    // Primary source: reuse useContacts' shared resolved list.
    const seed = peekCachedContacts();
    if (seed) setContactsMap(buildMap(seed));
    const unsub = subscribeContacts((contacts) => setContactsMap(buildMap(contacts)));

    // Fallback: if nothing has populated the shared cache shortly after mount
    // (e.g. a screen that uses usePhoneBook but not useContacts), do one direct
    // device read so names still resolve.
    const t = setTimeout(() => {
      if (!fallbackLoaded.current && peekCachedContacts() === null) {
        fallbackLoaded.current = true;
        void directRead().then((m) => { if (m) setContactsMap(m); });
      }
    }, 600);

    return () => { unsub(); clearTimeout(t); };
  }, []);

  /**
   * Resolve a display name from a phone number: the saved contact name if the
   * number is in the device phone book, otherwise the phone number itself.
   */
  const resolveName = useCallback(
    (phone?: string | null, fallback?: string): string => {
      if (!phone) return fallback ?? 'Unknown';
      return contactsMap.get(phone) ?? contactsMap.get(normalizePhone(phone)) ?? phone;
    },
    [contactsMap]
  );

  // reloadPhoneBook is now a no-op trigger kept for API compatibility — the map
  // refreshes automatically via the shared-contacts subscription.
  const reloadPhoneBook = useCallback(() => {
    const cached = peekCachedContacts();
    if (cached) setContactsMap(buildMap(cached));
  }, []);

  return { contactsMap, resolveName, reloadPhoneBook };
}

/** One-off direct device read, used only as a fallback. */
async function directRead(): Promise<Map<string, string> | null> {
  try {
    if (Platform.OS === 'web') return null;
    const { getContactsAsync, requestPermissionsAsync, Fields } = require('expo-contacts/legacy');
    const { status } = await requestPermissionsAsync();
    if (status !== 'granted') return null;
    const { data } = await getContactsAsync({ fields: [Fields.Name, Fields.PhoneNumbers] });
    const map = new Map<string, string>();
    for (const contact of data) {
      if (!contact.phoneNumbers || !contact.name) continue;
      for (const pn of contact.phoneNumbers) {
        if (pn.number) map.set(normalizePhone(pn.number), contact.name);
      }
    }
    return map;
  } catch (err) {
    console.warn('[usePhoneBook] fallback read failed:', err);
    return null;
  }
}
