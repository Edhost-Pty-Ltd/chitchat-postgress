// ─── Display Name Resolution ─────────────────────────────────────────────────
// Resolves the human-readable name to show for a chat row.
//
// Priority chain for direct chats:
//   1. Saved contact name via UID  (most reliable — no phone format dependency)
//   2. Saved contact name via phone (legacy fallback for unmatched contacts)
//   3. Raw phone number (contact not in device book)
//   4. Display name from backend profile (last resort — may be generic)
//   5. 'Unknown'
//
// Group chats always use groupName or "Group".
// A raw Firebase UID is NEVER returned as the display name.

export interface ChatInfo {
  type:      string;
  members:   string[];
  groupName: string | null;
}

export interface FirestoreUserInfo {
  displayName: string;
  phone:       string;
}

/**
 * @param chat           - Chat to resolve a name for
 * @param currentUserId  - The signed-in user's UID (excluded from member search)
 * @param contactsMap    - Map<phone (E.164), saved contact name>
 * @param firestoreUsers - Map<uid, { displayName, phone }>
 * @param uidToContact   - Map<uid, { displayName, phone }> built from registered contacts
 */
export function resolveDisplayName(
  chat:           ChatInfo,
  currentUserId:  string,
  contactsMap:    Map<string, string>,
  firestoreUsers: Map<string, FirestoreUserInfo>,
  uidToContact?:  Map<string, { displayName: string; phone: string }>,
): string {
  // Groups always use their group name
  if (chat.type === 'group') {
    return chat.groupName ?? 'Group';
  }

  const otherMemberId = chat.members.find((id) => id !== currentUserId);
  if (!otherMemberId) return 'Unknown';

  // 1. Direct UID → saved contact name (most reliable, no phone format dependency)
  const directContact = uidToContact?.get(otherMemberId);
  if (directContact?.displayName) return directContact.displayName;

  // 2. UID → phone → saved contact name (legacy path via firestoreUsersMap)
  const otherUser = firestoreUsers.get(otherMemberId);
  if (otherUser?.phone) {
    const contactName = contactsMap.get(otherUser.phone);
    if (contactName) return contactName;

    // 3. Raw phone number — better than a UID
    if (otherUser.phone.length > 4) return otherUser.phone;
  }

  // 4. Backend display name (may be a business name set during signup)
  if (otherUser?.displayName && otherUser.displayName !== otherMemberId) {
    return otherUser.displayName;
  }

  return 'Unknown';
}
