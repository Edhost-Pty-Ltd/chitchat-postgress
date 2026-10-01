// ─── Customer reply gate ──────────────────────────────────────────────────────
// When a chat is assigned to an agent, the CUSTOMER may only send via Urgent.
// Agents are unaffected. Detection of "customer" is: the member of the chat
// that is not the team owner.

import { useMemo, useState, useCallback } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { ConversationStatus } from '../types';

const fsDb = () => db as ReturnType<typeof firestore>;

interface Args {
  teamOwnerUid:   string | null;
  chatMembers:    string[] | null;
  currentUserId:  string | null;
  assignedTo:     string | null;
  assignedToName: string | null;
  status:         ConversationStatus;
}

export function useCustomerReplyGate({
  teamOwnerUid, chatMembers, currentUserId,
  assignedTo, assignedToName, status,
}: Args) {
  const [urgentMode, setUrgentMode] = useState(false);

  const isCustomer = useMemo(() => {
    if (!currentUserId || !chatMembers) return false;
    if (!teamOwnerUid) return false;
    // customer is any member that is NOT the owner
    return currentUserId !== teamOwnerUid && chatMembers.includes(currentUserId);
  }, [teamOwnerUid, chatMembers, currentUserId]);

  const locked = useMemo(() => {
    if (!isCustomer) return false;
    if (!assignedTo) return false;
    if (status === 'resolved') return false;
    return true;
  }, [isCustomer, assignedTo, status]);

  const toggleUrgent = useCallback(() => setUrgentMode((v) => !v), []);
  const resetUrgent  = useCallback(() => setUrgentMode(false), []);

  return {
    isCustomer,
    locked,
    canSend:    !locked || urgentMode,
    urgentMode,
    toggleUrgent,
    resetUrgent,
    lockReason: locked
      ? `${assignedToName ?? 'An agent'} is handling this conversation. Enable Urgent to send anyway.`
      : null,
  };
}

// ─── Send a message honouring the urgent flag ────────────────────────────────
export async function sendBusinessMessage(args: {
  chatId:     string;
  senderId:   string;
  senderName: string;
  text:       string;
  isUrgent:   boolean;
}): Promise<void> {
  const { chatId, senderId, senderName, text, isUrgent } = args;
  const chatRef = fsDb().collection('chats').doc(chatId);
  const batch   = fsDb().batch();

  const msgRef = chatRef.collection('messages').doc();
  batch.set(msgRef, {
    messageId:  msgRef.id,   // keep consistent with the existing message schema
    senderId,                // must match request.auth.uid per Firestore rule
    senderName,
    text,
    type:       'text',
    isUrgent:   isUrgent || false,
    visibleTo:  'all',
    timestamp:  firestore.FieldValue.serverTimestamp(), // consistent field name
    readBy:     [senderId],
    deliveredTo: [],
  });

  const updates: any = {
    'lastMessage.text':      text,
    'lastMessage.senderId':  senderId,
    'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
  };
  if (isUrgent) updates.hasUrgent = true;

  batch.update(chatRef, updates);

  try {
    await batch.commit();
  } catch (err: any) {
    console.error('[sendBusinessMessage] Firestore write failed:', err?.code ?? err?.message ?? err);
    throw err; // re-throw so the caller can show the user an error
  }
}