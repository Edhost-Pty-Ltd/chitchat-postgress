// ─── useChatActions Hook ──────────────────────────────────────────────────────
// Creates new chats (1-on-1 and group) and handles sending messages
// with proper unread count increments for all members.

import {
  collection, doc, addDoc, getDoc, getDocs,
  query, where, serverTimestamp, updateDoc,
  increment, writeBatch,
} from 'firebase/firestore';
import { db } from '../config/firebase';
import { uploadFile, generateFileName, getFileExtension } from '../config/storage';
import { fetchUserPrivacySettings, isVisibleTo } from './usePrivacySettings';

// ── Create or get existing 1-on-1 chat ───────────────────────────────────────
export async function getOrCreateDirectChat(
  currentUserId: string,
  otherUserId: string,
): Promise<string> {
  // Ensure consistent ordering of user IDs to prevent duplicates
  const sortedIds = [currentUserId, otherUserId].sort();
  
  console.log('[getOrCreateDirectChat] Looking for chat between:', sortedIds);
  
  // Check if a direct chat already exists between these two users
  // Query for chats where both users are members
  const q = query(
    collection(db, 'chats'),
    where('type', '==', 'direct'),
    where('members', '==', sortedIds), // Exact match with sorted array
  );

  const snap = await getDocs(q);
  
  if (snap.docs.length > 0) {
    console.log('[getOrCreateDirectChat] Found existing chat:', snap.docs[0].id);
    return snap.docs[0].id;
  }

  console.log('[getOrCreateDirectChat] Creating new chat');
  
  // Create new direct chat with sorted member IDs
  const newChat = await addDoc(collection(db, 'chats'), {
    type:        'direct',
    members:     sortedIds, // Always store in sorted order
    groupName:   null,
    groupPhoto:  null,
    createdBy:   currentUserId,
    createdAt:   serverTimestamp(),
    lastMessage: null,
    unreadCounts: {
      [currentUserId]: 0,
      [otherUserId]:   0,
    },
  });

  console.log('[getOrCreateDirectChat] Created new chat:', newChat.id);
  return newChat.id;
}

// ── Create a new group chat ───────────────────────────────────────────────────
export async function createGroupChat(
  currentUserId: string,
  memberIds: string[],   // include currentUserId
  groupName: string,
): Promise<{ chatId: string; blockedByPrivacy: string[] }> {
  const requested = Array.from(new Set([currentUserId, ...memberIds]));

  // Check each non-self member's privacyGroups setting.
  // "Contacts" is treated as allowed here since we can only add from contacts;
  // "Nobody" means they have opted out of being added to groups entirely.
  const blockedByPrivacy: string[] = [];
  const allowed: string[] = [currentUserId];

  await Promise.all(
    requested
      .filter((id) => id !== currentUserId)
      .map(async (id) => {
        const privacy = await fetchUserPrivacySettings(id);
        // Simplified: 'Everyone' or 'Contacts' = allow (contacts are already
        // verified at the call site). 'Nobody' = block.
        if (privacy.groups === 'Nobody') {
          blockedByPrivacy.push(id);
        } else {
          allowed.push(id);
        }
      }),
  );

  const allMembers = allowed;

  // Build unreadCounts map: { userId: 0 } for each member
  const unreadCounts = Object.fromEntries(
    allMembers.map((id) => [id, 0])
  );

  const newChat = await addDoc(collection(db, 'chats'), {
    type:         'group',
    members:      allMembers,
    groupName,
    groupPhoto:   null,
    createdBy:    currentUserId,
    createdAt:    serverTimestamp(),
    lastMessage:  null,
    unreadCounts,
  });

  return { chatId: newChat.id, blockedByPrivacy };
}

// ── Send a message with unread increments ─────────────────────────────────────
export async function sendMessage(
  chatId: string,
  senderId: string,
  text: string,
): Promise<boolean> {
  try {
    const trimmed = text.trim();
    if (!trimmed) return false;

    // Fetch chat to get member list
    const chatRef  = doc(db, 'chats', chatId);
    const chatSnap = await getDoc(chatRef);
    if (!chatSnap.exists()) return false;

    const members: string[] = chatSnap.data().members ?? [];
    const otherMembers = members.filter((id) => id !== senderId);

    // Calculate expiry time (72 hours from now)
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    // Use a batch write for atomicity
    const batch = writeBatch(db);

    // 1. Add message document
    const msgRef = doc(collection(db, 'chats', chatId, 'messages'));
    batch.set(msgRef, {
      messageId: msgRef.id,
      senderId,
      text:      trimmed,
      imageUrl:  null,
      voiceUrl:  null,
      type:      'text',
      timestamp: serverTimestamp(),
      expiresAt: expiresAt,
      readBy:    [senderId],
      deliveredTo: [],
    });

    // 2. Update chat lastMessage + increment unread for other members
    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id) => [`unreadCounts.${id}`, increment(1)])
    );

    batch.update(chatRef, {
      'lastMessage.text':      trimmed,
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return true;
  } catch (err) {
    console.error('sendMessage error:', err);
    return false;
  }
}

// ── Mark chat as read for a user ──────────────────────────────────────────────
export async function markChatAsRead(
  chatId: string,
  userId: string,
): Promise<void> {
  try {
    const chatRef = doc(db, 'chats', chatId);
    await updateDoc(chatRef, {
      [`unreadCounts.${userId}`]: 0,
    });
  } catch (_) {
    // Non-critical
  }
}

// ── Send a voice message with unread increments ───────────────────────────────
export async function sendVoiceMessage(
  chatId: string,
  senderId: string,
  voiceUrl: string,
  durationMs: number,
): Promise<{ success: boolean; messageId: string }> {
  try {
    // Fetch chat to get member list
    const chatRef  = doc(db, 'chats', chatId);
    const chatSnap = await getDoc(chatRef);
    if (!chatSnap.exists()) return { success: false, messageId: '' };

    const members: string[] = chatSnap.data().members ?? [];
    const otherMembers = members.filter((id) => id !== senderId);

    // Calculate expiry time (72 hours from now)
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

    // Use a batch write for atomicity
    const batch = writeBatch(db);

    // 1. Create message document
    const msgRef = doc(collection(db, 'chats', chatId, 'messages'));
    batch.set(msgRef, {
      messageId: msgRef.id,
      senderId,
      text:      null,
      imageUrl:  null,
      voiceUrl,
      type:      'voice',
      duration:  durationMs,
      timestamp: serverTimestamp(),
      expiresAt: expiresAt,
      readBy:    [senderId],
      deliveredTo: [],
    });

    // 2. Update chat lastMessage + increment unread for other members
    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id) => [`unreadCounts.${id}`, increment(1)])
    );

    batch.update(chatRef, {
      'lastMessage.text':      '[Voice Note]',
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return { success: true, messageId: msgRef.id };
  } catch (err) {
    console.error('sendVoiceMessage error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send an image message ─────────────────────────────────────────────────────
export async function sendImageMessage(
  chatId: string,
  senderId: string,
  imageUri: string,
  onProgress?: (progress: number) => void,
): Promise<{ success: boolean; messageId: string }> {
  try {
    console.log('[sendImageMessage] Starting upload...');
    
    // Upload image to Storage
    const { uploadFile, generateFileName, getFileExtension } = await import('../config/storage');
    const fileName = generateFileName(getFileExtension(imageUri));
    
    const imageUrl = await uploadFile(imageUri, 'chatMedia', {
      chatId,
      fileName,
    }, onProgress);
    
    console.log('[sendImageMessage] Upload complete, creating message...');
    
    // Get chat members
    const chatRef = doc(db, 'chats', chatId);
    const chatSnap = await getDoc(chatRef);
    if (!chatSnap.exists()) return { success: false, messageId: '' };
    
    const members: string[] = chatSnap.data().members ?? [];
    const otherMembers = members.filter((id) => id !== senderId);
    
    // Calculate expiry time (72 hours from now)
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    
    // Create message
    const batch = writeBatch(db);
    const msgRef = doc(collection(db, 'chats', chatId, 'messages'));
    
    batch.set(msgRef, {
      messageId: msgRef.id,
      senderId,
      text: null,
      type: 'image',
      imageUrl,
      timestamp: serverTimestamp(),
      expiresAt: expiresAt,
      readBy: [senderId],
      deliveredTo: [],
    });
    
    // Update chat
    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id) => [`unreadCounts.${id}`, increment(1)])
    );
    
    batch.update(chatRef, {
      'lastMessage.text': '📷 Photo',
      'lastMessage.senderId': senderId,
      'lastMessage.timestamp': serverTimestamp(),
      ...unreadUpdates,
    });
    
    await batch.commit();
    console.log('[sendImageMessage] Message created successfully');
    return { success: true, messageId: msgRef.id };
  } catch (err) {
    console.error('sendImageMessage error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send a video message ──────────────────────────────────────────────────────
export async function sendVideoMessage(
  chatId: string,
  senderId: string,
  videoUri: string,
  thumbnailUri?: string,
  onProgress?: (progress: number) => void,
): Promise<{ success: boolean; messageId: string }> {
  try {
    console.log('[sendVideoMessage] Starting upload...');
    
    const { uploadFile, generateFileName, getFileExtension } = await import('../config/storage');
    
    // Upload video
    const videoFileName = generateFileName(getFileExtension(videoUri));
    const videoUrl = await uploadFile(videoUri, 'chatMedia', {
      chatId,
      fileName: videoFileName,
    }, onProgress);
    
    // Upload thumbnail if provided
    let thumbnailUrl: string | undefined;
    if (thumbnailUri) {
      const thumbFileName = generateFileName('.jpg');
      thumbnailUrl = await uploadFile(thumbnailUri, 'chatMedia', {
        chatId,
        fileName: thumbFileName,
      });
    }
    
    console.log('[sendVideoMessage] Upload complete, creating message...');
    
    // Get chat members
    const chatRef = doc(db, 'chats', chatId);
    const chatSnap = await getDoc(chatRef);
    if (!chatSnap.exists()) return { success: false, messageId: '' };
    
    const members: string[] = chatSnap.data().members ?? [];
    const otherMembers = members.filter((id) => id !== senderId);
    
    // Calculate expiry time (72 hours from now)
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    
    // Create message
    const batch = writeBatch(db);
    const msgRef = doc(collection(db, 'chats', chatId, 'messages'));
    
    batch.set(msgRef, {
      messageId: msgRef.id,
      senderId,
      text: null,
      type: 'video',
      videoUrl,
      thumbnailUrl,
      timestamp: serverTimestamp(),
      expiresAt: expiresAt,
      readBy: [senderId],
      deliveredTo: [],
    });
    
    // Update chat
    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id) => [`unreadCounts.${id}`, increment(1)])
    );
    
    batch.update(chatRef, {
      'lastMessage.text': '🎥 Video',
      'lastMessage.senderId': senderId,
      'lastMessage.timestamp': serverTimestamp(),
      ...unreadUpdates,
    });
    
    await batch.commit();
    console.log('[sendVideoMessage] Message created successfully');
    return { success: true, messageId: msgRef.id };
  } catch (err) {
    console.error('sendVideoMessage error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send a file message ───────────────────────────────────────────────────────
export async function sendFileMessage(
  chatId: string,
  senderId: string,
  fileUri: string,
  fileName: string,
  fileSize: number,
  mimeType: string,
  onProgress?: (progress: number) => void,
): Promise<{ success: boolean; messageId: string }> {
  try {
    console.log('[sendFileMessage] Starting upload...');
    
    // Upload file
    const fileUrl = await uploadFile(fileUri, 'chatMedia', {
      chatId,
      fileName,
    }, onProgress);
    
    console.log('[sendFileMessage] Upload complete, creating message...');
    
    // Get chat members
    const chatRef = doc(db, 'chats', chatId);
    const chatSnap = await getDoc(chatRef);
    if (!chatSnap.exists()) return { success: false, messageId: '' };
    
    const members: string[] = chatSnap.data().members ?? [];
    const otherMembers = members.filter((id) => id !== senderId);
    
    // Calculate expiry time (72 hours from now)
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
    
    // Create message
    const batch = writeBatch(db);
    const msgRef = doc(collection(db, 'chats', chatId, 'messages'));
    
    batch.set(msgRef, {
      messageId: msgRef.id,
      senderId,
      text: null,
      type: 'file',
      fileUrl,
      fileName,
      fileSize,
      mimeType,
      timestamp: serverTimestamp(),
      expiresAt: expiresAt,
      readBy: [senderId],
      deliveredTo: [],
    });
    
    // Update chat
    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id) => [`unreadCounts.${id}`, increment(1)])
    );
    
    batch.update(chatRef, {
      'lastMessage.text': `📎 ${fileName}`,
      'lastMessage.senderId': senderId,
      'lastMessage.timestamp': serverTimestamp(),
      ...unreadUpdates,
    });
    
    await batch.commit();
    console.log('[sendFileMessage] Message created successfully');
    return { success: true, messageId: msgRef.id };
  } catch (err) {
    console.error('sendFileMessage error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send number change notification to all chats ──────────────────────────────
export async function sendNumberChangeNotification(
  currentUserId: string,
  oldNumber: string,
  newNumber: string,
  displayName: string,
): Promise<{ success: boolean; count: number }> {
  try {
    console.log('[sendNumberChangeNotification] Sending to all chats...');
    
    // Get all chats where the user is a member
    const chatsQuery = query(
      collection(db, 'chats'),
      where('members', 'array-contains', currentUserId)
    );
    
    const chatsSnap = await getDocs(chatsQuery);
    console.log(`[sendNumberChangeNotification] Found ${chatsSnap.docs.length} chats`);
    
    const messageText = `${displayName} changed their phone number from ${oldNumber} to ${newNumber}`;
    
    // Send system message to each chat
    for (const chatDoc of chatsSnap.docs) {
      const chatId = chatDoc.id;
      const members: string[] = chatDoc.data().members ?? [];
      const otherMembers = members.filter((id) => id !== currentUserId);
      
      const batch = writeBatch(db);
      
      // Add system message
      const msgRef = doc(collection(db, 'chats', chatId, 'messages'));
      
      // Calculate expiry time (72 hours from now)
      const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
      
      batch.set(msgRef, {
        messageId: msgRef.id,
        senderId: currentUserId,
        text: messageText,
        type: 'system',
        subtype: 'number-change',
        oldNumber,
        newNumber,
        timestamp: serverTimestamp(),
        expiresAt: expiresAt,
        readBy: [currentUserId],
      });
      
      // Update chat lastMessage + increment unread for other members
      const unreadUpdates = Object.fromEntries(
        otherMembers.map((id) => [`unreadCounts.${id}`, increment(1)])
      );
      
      batch.update(doc(db, 'chats', chatId), {
        'lastMessage.text': messageText,
        'lastMessage.senderId': currentUserId,
        'lastMessage.timestamp': serverTimestamp(),
        ...unreadUpdates,
      });
      
      await batch.commit();
    }
    
    console.log('[sendNumberChangeNotification] Notifications sent successfully');
    return { success: true, count: chatsSnap.docs.length };
  } catch (err) {
    console.error('[sendNumberChangeNotification] Error:', err);
    return { success: false, count: 0 };
  }
}


