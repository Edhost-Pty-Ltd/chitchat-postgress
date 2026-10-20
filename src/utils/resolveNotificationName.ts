// ─── Notification Name Resolution ────────────────────────────────────────────
// Resolves display names for notifications using device contacts.
// Priority:
//   1. Contact name from device phone book (if phone number is saved)
//   2. Raw phone number (if NOT in contacts)
// 
// Never uses the user's Firebase displayName (account registration username).

import { getContactsAsync, Fields } from 'expo-contacts/legacy';
import { normalizePhone } from './phoneUtils';

let cachedPhoneToName: Map<string, string> | null = null;
let cachePromise: Promise<Map<string, string>> | null = null;

/**
 * Loads device contacts and builds a phone → name map.
 * Results are cached so subsequent calls return immediately.
 */
async function loadPhoneToNameMap(): Promise<Map<string, string>> {
  // Return cached map if already loaded
  if (cachedPhoneToName) {
    return cachedPhoneToName;
  }

  // If already loading, return the existing promise
  if (cachePromise) {
    return cachePromise;
  }

  // Start loading
  cachePromise = (async () => {
    const phoneToName = new Map<string, string>();

    try {
      const { data } = await getContactsAsync({
        fields: [Fields.Name, Fields.PhoneNumbers],
      });

      for (const contact of data) {
        if (!contact.phoneNumbers) continue;
        for (const pn of contact.phoneNumbers) {
          if (!pn.number) continue;
          const normalized = normalizePhone(pn.number);
          const name = contact.name || pn.number;
          phoneToName.set(normalized, name);
        }
      }

      console.log('[resolveNotificationName] Loaded', phoneToName.size, 'contacts');
    } catch (err) {
      console.error('[resolveNotificationName] Error loading contacts:', err);
      // Return empty map on error
    }

    cachedPhoneToName = phoneToName;
    cachePromise = null;
    return phoneToName;
  })();

  return cachePromise;
}

/**
 * Resolves a user's display name for notifications.
 * 
 * @param phoneNumber - User's phone number in E.164 format
 * @returns Contact name if saved in phone book, otherwise the phone number
 */
export async function resolveNotificationName(phoneNumber: string): Promise<string> {
  const phoneToName = await loadPhoneToNameMap();
  
  // Check if this phone number exists in contacts
  const contactName = phoneToName.get(phoneNumber);
  
  // Return contact name if found, otherwise return the phone number
  return contactName || phoneNumber;
}

/**
 * Clears the contact cache. Call this if contacts change.
 */
export function clearNotificationNameCache() {
  cachedPhoneToName = null;
  cachePromise = null;
}
