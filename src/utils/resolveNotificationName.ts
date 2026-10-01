// ─── Display Name Resolution ─────────────────────────────────────────────────
// Resolves a human-readable display name for a chat.
//
// Priority chain (direct chats):
//   1. Device phone book (via the other member's phone number)
//   2. Firestore users/{uid}.displayName — if it's set and looks like a real
//      name (i.e. not just the phone number)
//   3. Firestore users/{uid}.phone (raw phone as last resort)
//   4. Firestore users/{uid}.displayName even if it looks like a phone
//   5. 'Unknown'
//
// Group chats always use groupName (or 'Group').
//
// COMPANION NOTE
//   A companion device has a different (usually empty) phone book from the
//   primary. Falling back to Firestore displayName ensures the companion
//   still shows the same human names the primary sees.

export interface ChatInfo {
  type: string;
  members: string[];
  groupName: string | null;
}

export interface FirestoreUserInfo {
  displayName: string;
  phone: string;
}

const PHONE_LIKE = /^\+?[\d\s\-()]{5,}$/;

export function resolveDisplayName(
  chat: ChatInfo,
  currentUserId: string,
  contactsMap: Map<string, string>,
  firestoreUsers: Map<string, FirestoreUserInfo>,
): string {
  // 1. Group chats use groupName or fallback to "Group"
  if (chat.type === 'group') {
    return chat.groupName ?? 'Group';
  }

  // Direct chat — the other member
  const otherMemberId = chat.members.find((id) => id !== currentUserId);
  if (!otherMemberId) return 'Unknown';

  const otherUser = firestoreUsers.get(otherMemberId);
  if (!otherUser) return 'Unknown';

  const fsName  = (otherUser.displayName || '').trim();
  const phone   = (otherUser.phone || '').trim();

  // 2. Device phone book (via phone)
  if (phone) {
    const contactName = contactsMap.get(phone);
    if (contactName) return contactName;
  }

  // 3. Firestore displayName — if it's set and doesn't look like a phone
  if (fsName && fsName !== phone && !PHONE_LIKE.test(fsName) && fsName !== 'Unknown') {
    return fsName;
  }

  // 4. Raw phone number
  if (phone) return phone;

  // 5. Firestore displayName even if it looks like a phone
  if (fsName && fsName !== 'Unknown') return fsName;

  return 'Unknown';
}