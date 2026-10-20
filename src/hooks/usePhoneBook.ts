// ─── usePhoneBook Hook ───────────────────────────────────────────────────────
// Loads the device phone book into a Map<E.164 phone, contactName> and exposes
// a resolver implementing the app-wide name rule:
//   • phone saved in the device contacts → the saved contact name
//   • phone NOT saved                    → the raw phone number
//
// Reads only the device contacts (no Firestore), so it's cheap to use on any
// screen that needs to display a person's name.

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Platform } from 'react-native';
import { normalizePhone } from '../utils/phoneUtils';

export function usePhoneBook() {
  const [contactsMap, setContactsMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        if (Platform.OS === 'web') return; // no device contacts on web
        const { getContactsAsync, requestPermissionsAsync, Fields } = require('expo-contacts/legacy');

        const { status } = await requestPermissionsAsync();
        if (status !== 'granted') return;

        const { data } = await getContactsAsync({ fields: [Fields.Name, Fields.PhoneNumbers] });

        const map = new Map<string, string>();
        for (const contact of data) {
          if (!contact.phoneNumbers || !contact.name) continue;
          for (const pn of contact.phoneNumbers) {
            if (!pn.number) continue;
            map.set(normalizePhone(pn.number), contact.name);
          }
        }
        if (mounted) setContactsMap(map);
      } catch (err) {
        console.warn('[usePhoneBook] Failed to load contacts:', err);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, []);

  /**
   * Resolve a display name from a phone number: the saved contact name if the
   * number is in the device phone book, otherwise the phone number itself.
   */
  const resolveName = useCallback(
    (phone?: string | null, fallback?: string): string => {
      if (!phone) return fallback ?? 'Unknown';
      return contactsMap.get(phone) ?? phone;
    },
    [contactsMap]
  );

  return { contactsMap, resolveName };
}
