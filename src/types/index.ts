// ─── App-wide TypeScript Types ───────────────────────────────────────────────

// ─── Catalog ──────────────────────────────────────────────────────────────────
export interface CatalogItem {
  id:           string;
  name:         string;
  price:        string;
  description?: string;
  imageUri?:    string | null;  // Firebase Storage download URL (after upload)
}

// ─── Broadcast ───────────────────────────────────────────────────────────────
export interface BroadcastList {
  id:          string;        // Firestore doc id
  name:        string;        // e.g. "VIP Customers"
  recipients:  string[];      // Firebase UIDs
  createdBy:   string;        // sender UID
  createdAt:   Date;
  lastSentAt:  Date | null;
  lastMessage: string | null; // preview of most recent send
}

// ─── Cart ─────────────────────────────────────────────────────────────────────
export interface CartItem {
  item:     CatalogItem;
  quantity: number;
  sellerUid: string; // which business this item belongs to
}

export type ContactStatus = 'online' | 'away' | 'offline';

export type CallType = 'Outgoing' | 'Incoming' | 'Missed';

export type MessageType = 'in' | 'out';

export interface Contact {
  id: number;
  name: string;
  avatar: string;       // initials, e.g. "AM"
  color: string;        // hex accent colour for avatar
  status: ContactStatus;
  lastMsg: string;
  time: string;
  unread: number;
  pinned?: boolean;
}

export interface Message {
  id: number;
  from: string;
  text?: string;
  image?: boolean;
  voice?: boolean;
  time: string;
  type: MessageType;
}

// ─── Real-time Chat Message (Firestore) ───────────────────────────────────────
export interface ChatMessage {
  messageId: string;
  senderId: string;
  text: string | null;
  type: 'text' | 'image' | 'video' | 'voice' | 'audio' | 'file' | 'system';
  
  // Media URLs
  imageUrl?: string | null;
  videoUrl?: string | null;
  voiceUrl?: string | null;
  audioUrl?: string | null;
  fileUrl?: string | null;
  
  // Media metadata
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  duration?: number;
  thumbnailUrl?: string;
  
  timestamp: Date;
  readBy: string[];
  editedAt?: Date | null;
  
  // Block status
  blockedMessage?: boolean; // Message sent while recipient was blocked
}


export interface Call {
  id: number;
  name: string;
  avatar: string;
  color: string;
  type: CallType;
  time: string;
  missed: boolean;
}

export interface StatusUpdate {
  id: number;
  name: string;
  avatar: string;
  color: string;
  time: string;
}

// ─── Firestore Status Update ───────────────────────────────────────────────────
export interface FireStatus {
  statusId: string;
  userId: string;
  displayName: string;
  userPhone: string | null; // Poster's E.164 phone, for contact-name resolution
  photoURL: string | null;
  
  // Media content
  mediaUrl: string | null;
  mediaType: 'image' | 'video' | 'text';
  thumbnailUrl?: string | null;
  durationMs?: number; // Duration for image (default 5000ms) and video playback
  
  // Text status
  caption: string | null;
  backgroundColor: string | null; // For text-only status
  textColor: string | null;
  
  // Metadata
  createdAt: Date;
  expiresAt: Date; // 24 hours from createdAt
  viewedBy: string[]; // Array of userId who viewed
  
  // Privacy
  visibility: 'everyone' | 'contacts' | 'except' | 'only';
  excludedUsers?: string[];
  selectedUsers?: string[];
}


// ─── Navigation param list ─────────────────────────────────────────────────
export type RootStackParamList = {
  Splash: undefined;
  SignIn: undefined;
  Chats: undefined;
  Chat: { chatId: string; displayName: string; isGroup: boolean; otherUserId?: string; otherUserPhoto?: string | null };
  Calendar:undefined;
  Calls: undefined;
  Status: undefined;
  Contacts: undefined;
  Settings: undefined;
  Appearance: undefined;
  Profile: undefined;
  CreateAccount: undefined;
  AccountSettings: undefined;
  PrivacySettings: undefined;
  NotificationSettings: undefined;
  ChangeNumber: undefined;
  Notifications: undefined;
  LinkedDevices: undefined;
  BlockedContacts: undefined;
  Broadcast: undefined;
  AudioCall: { 
    callId: string;
    isOutgoing: boolean;
    otherParty: {
      userId: string;
      displayName: string;
      photoUrl: string | null;
    };
    meetingId?: string;
  };
  VideoCall: { 
    callId: string;
    isOutgoing: boolean;
    otherParty: {
      userId: string;
      displayName: string;
      photoUrl: string | null;
    };
  };
};
