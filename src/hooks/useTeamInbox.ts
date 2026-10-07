// ─── useTeamInbox Hook ────────────────────────────────────────────────────────
// Real-time inbox views for the multi-agent team inbox.
//
// Data model:
//   businessTeams/{ownerUid}/agents/{agentUid}  → TeamAgent
//   chats/{chatId}  →  + status, assignedTo, assignedToName, assignedAt, resolvedAt, resolvedBy
//   chats/{chatId}/assignmentHistory/{entryId}  → AssignmentHistoryEntry
//
// An agent belongs to a business (identified by the ownerUid).
// The ownerUid is stored on the agent's own user doc under `businessOwnerUid`.

import { useState, useEffect, useCallback } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import {
  InboxConversation,
  ConversationStatus,
  AssignmentHistoryEntry,
  TeamAgent,
} from '../types';

const fsDb = () => db as ReturnType<typeof firestore>;

// ─── Helper: convert raw Firestore doc to InboxConversation ──────────────────
function docToInbox(doc: firestore.QueryDocumentSnapshot): InboxConversation {
  const d = doc.data();
  const lm = d.lastMessage;
  return {
    chatId:         doc.id,
    type:           d.type ?? 'direct',
    members:        d.members ?? [],
    groupName:      d.groupName ?? null,
    lastMessage:    lm?.text ?? '',
    lastSenderId:   lm?.senderId ?? '',
    timestamp:      lm?.timestamp
      ? (lm.timestamp as firestore.Timestamp).toDate()
      : null,
    unreadCount:    0, // caller sets this per-agent if needed
    status:         d.status ?? 'open',
    assignedTo:     d.assignedTo ?? null,
    assignedToName: d.assignedToName ?? null,
  };
}

// ─── useInboxConversations ────────────────────────────────────────────────────
// Real-time listener for inbox conversations visible to this agent.
//
// BOUNDED QUERIES (Issue 6 fix):
//   Admins:     single query — all of the owner's chats, capped at 200.
//   Non-admins: two parallel server-side queries, each capped at 100:
//                 1. Chats assigned to this agent (open or assigned status).
//                 2. Unassigned open chats (available to take).
//
//   This pushes visibility filtering to the server so a regular agent's device
//   never downloads conversations assigned to other agents or resolved chats.
//   Results from both queries are merged, de-duped, and sorted client-side.
export function useInboxConversations(
  ownerUid: string | null,
  currentUid: string | null,
  isAdmin: boolean,
) {
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [loading, setLoading]             = useState(true);
  const [error,   setError]               = useState<string | null>(null);

  useEffect(() => {
    if (!ownerUid || !currentUid) {
      setConversations([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const ADMIN_LIMIT = 200;
    const AGENT_LIMIT = 100;

    // ── Merge helper ─────────────────────────────────────────────────────────
    // Merges two result arrays, de-dupes by chatId, and sorts.
    const mergeAndSort = (a: InboxConversation[], b: InboxConversation[]) => {
      const map = new Map<string, InboxConversation>();
      [...a, ...b].forEach((c) => map.set(c.chatId, c));
      return Array.from(map.values()).sort((x, y) => {
        if (x.status === 'resolved' && y.status !== 'resolved') return 1;
        if (x.status !== 'resolved' && y.status === 'resolved') return -1;
        const tx = x.timestamp?.getTime() ?? 0;
        const ty = y.timestamp?.getTime() ?? 0;
        return ty - tx;
      });
    };

    if (isAdmin) {
      // ── Admin path: bounded single query ─────────────────────────────────
      const unsub = fsDb()
        .collection('chats')
        .where('members', 'array-contains', ownerUid)
        .orderBy('lastMessage.timestamp', 'desc')
        .limit(ADMIN_LIMIT)
        .onSnapshot(
          (snap) => {
            const result = snap.docs.map(docToInbox).sort((a, b) => {
              if (a.status === 'resolved' && b.status !== 'resolved') return 1;
              if (a.status !== 'resolved' && b.status === 'resolved') return -1;
              const ta = a.timestamp?.getTime() ?? 0;
              const tb = b.timestamp?.getTime() ?? 0;
              return tb - ta;
            });
            setConversations(result);
            setLoading(false);
          },
          (err) => { setError(err.message); setLoading(false); },
        );
      return () => unsub();
    }

    // ── Non-admin path: two bounded server-side queries ───────────────────
    // Query 1: chats assigned to this agent (open or assigned)
    // Query 2: unassigned open chats (available pool)
    //
    // Both queries scope to the owner's chats via `members array-contains`.
    // Each result set is kept in a ref so merging is correct when either fires.

    let assigned: InboxConversation[] = [];
    let unassigned: InboxConversation[] = [];
    let bothLoaded = 0; // incremented to 2 once both queries have fired once

    const notify = () => {
      if (bothLoaded < 2) return; // wait for both queries to fire at least once
      setConversations(mergeAndSort(assigned, unassigned));
      setLoading(false);
    };

    const unsub1 = fsDb()
      .collection('chats')
      .where('members', 'array-contains', ownerUid)
      .where('assignedTo', '==', currentUid)
      .where('status', 'in', ['open', 'assigned'])
      .orderBy('lastMessage.timestamp', 'desc')
      .limit(AGENT_LIMIT)
      .onSnapshot(
        (snap) => {
          assigned = snap.docs.map(docToInbox);
          if (bothLoaded < 2) bothLoaded++;
          notify();
        },
        (err) => { setError(err.message); setLoading(false); },
      );

    const unsub2 = fsDb()
      .collection('chats')
      .where('members', 'array-contains', ownerUid)
      .where('assignedTo', '==', null)
      .where('status', '==', 'open')
      .orderBy('lastMessage.timestamp', 'desc')
      .limit(AGENT_LIMIT)
      .onSnapshot(
        (snap) => {
          unassigned = snap.docs.map(docToInbox);
          if (bothLoaded < 2) bothLoaded++;
          notify();
        },
        (err) => { setError(err.message); setLoading(false); },
      );

    return () => { unsub1(); unsub2(); };
  }, [ownerUid, currentUid, isAdmin]);

  return { conversations, loading, error };
}

// ─── useConversationAssignment ────────────────────────────────────────────────
// Real-time listener for a single chat's assignment state.
export function useConversationAssignment(chatId: string | null) {
  const [status,          setStatus]          = useState<ConversationStatus>('open');
  const [assignedTo,      setAssignedTo]      = useState<string | null>(null);
  const [assignedToName,  setAssignedToName]  = useState<string | null>(null);
  const [resolvedBy,      setResolvedBy]      = useState<string | null>(null);
  const [loading,         setLoading]         = useState(true);

  useEffect(() => {
    if (!chatId) { setLoading(false); return; }

    const unsub = fsDb()
      .collection('chats')
      .doc(chatId)
      .onSnapshot(
        (snap) => {
          if (!snap.exists()) { setLoading(false); return; }
          const d = snap.data()!;
          setStatus(d.status         ?? 'open');
          setAssignedTo(d.assignedTo     ?? null);
          setAssignedToName(d.assignedToName ?? null);
          setResolvedBy(d.resolvedBy     ?? null);
          setLoading(false);
        },
        () => setLoading(false),
      );

    return () => unsub();
  }, [chatId]);

  return { status, assignedTo, assignedToName, resolvedBy, loading };
}

// ─── useAssignmentHistory ─────────────────────────────────────────────────────
// Real-time listener for a conversation's assignment/transfer history.
export function useAssignmentHistory(chatId: string | null) {
  const [history, setHistory] = useState<AssignmentHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!chatId) { setLoading(false); return; }

    const unsub = fsDb()
      .collection('chats')
      .doc(chatId)
      .collection('assignmentHistory')
      .orderBy('timestamp', 'desc')
      .limit(50)
      .onSnapshot(
        (snap) => {
          const entries: AssignmentHistoryEntry[] = snap.docs.map((doc) => {
            const d = doc.data();
            // d.timestamp is null locally until the server resolves serverTimestamp().
            // Coalesce to Date.now() so freshly written entries sort to the top
            // rather than producing Invalid Date and landing at an undefined position.
            let ts: Date;
            if (d.timestamp && typeof d.timestamp.toDate === 'function') {
              ts = d.timestamp.toDate();
            } else if (d.timestamp) {
              const parsed = new Date(d.timestamp);
              ts = isNaN(parsed.getTime()) ? new Date() : parsed;
            } else {
              ts = new Date(); // pending server timestamp — treat as "just now"
            }
            return {
              id:        doc.id,
              action:    d.action,
              byUid:     d.byUid,
              byName:    d.byName,
              toUid:     d.toUid     ?? null,
              toName:    d.toName    ?? null,
              timestamp: ts,
              note:      d.note      ?? undefined,
            };
          });
          setHistory(entries);
          setLoading(false);
        },
        () => setLoading(false),
      );

    return () => unsub();
  }, [chatId]);

  return { history, loading };
}

// ─── Assignment actions ───────────────────────────────────────────────────────

interface ActionActor {
  uid:  string;
  name: string;
}

/** Assign or transfer a conversation to an agent. */
export async function assignConversation(
  chatId:      string,
  actor:       ActionActor,
  toAgent:     { uid: string; name: string },
  previousAssignedTo: string | null,
): Promise<void> {
  const action: AssignmentHistoryEntry['action'] =
    previousAssignedTo ? 'transferred' : 'assigned';

  const batch = fsDb().batch();

  batch.update(fsDb().collection('chats').doc(chatId), {
    status:          'assigned',
    assignedTo:      toAgent.uid,
    assignedToName:  toAgent.name,
    assignedAt:      firestore.FieldValue.serverTimestamp(),
    resolvedAt:      null,
    resolvedBy:      null,
  });

  const histRef = fsDb()
    .collection('chats').doc(chatId)
    .collection('assignmentHistory').doc();
  batch.set(histRef, {
    action,
    byUid:     actor.uid,
    byName:    actor.name,
    toUid:     toAgent.uid,
    toName:    toAgent.name,
    timestamp: firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
}

/** Take over a conversation (agent assigns it to themselves). */
export async function takeConversation(
  chatId: string,
  actor:  ActionActor,
  previousAssignedTo: string | null,
): Promise<void> {
  await assignConversation(chatId, actor, actor, previousAssignedTo);
}

/** Resolve a conversation. */
export async function resolveConversation(
  chatId: string,
  actor:  ActionActor,
): Promise<void> {
  const batch = fsDb().batch();

  batch.update(fsDb().collection('chats').doc(chatId), {
    status:      'resolved',
    resolvedAt:  firestore.FieldValue.serverTimestamp(),
    resolvedBy:  actor.uid,
    assignedTo:  null,
    assignedToName: null,
  });

  const histRef = fsDb()
    .collection('chats').doc(chatId)
    .collection('assignmentHistory').doc();
  batch.set(histRef, {
    action:    'resolved',
    byUid:     actor.uid,
    byName:    actor.name,
    toUid:     null,
    toName:    null,
    timestamp: firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
}

/** Re-open a resolved conversation. */
export async function reopenConversation(
  chatId: string,
  actor:  ActionActor,
): Promise<void> {
  const batch = fsDb().batch();

  batch.update(fsDb().collection('chats').doc(chatId), {
    status:      'open',
    resolvedAt:  null,
    resolvedBy:  null,
    assignedTo:  null,
    assignedToName: null,
  });

  const histRef = fsDb()
    .collection('chats').doc(chatId)
    .collection('assignmentHistory').doc();
  batch.set(histRef, {
    action:    'reopened',
    byUid:     actor.uid,
    byName:    actor.name,
    toUid:     null,
    toName:    null,
    timestamp: firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
}

// ─── useOwnerUidForAgent ──────────────────────────────────────────────────────
// Resolves the business owner's UID for a given agent.
// Returns null if the user is not an agent of any team (i.e. they ARE the owner).
export function useOwnerUidForAgent(uid: string | null) {
  const [ownerUid,  setOwnerUid]  = useState<string | null>(null);
  const [role,      setRole]      = useState<'admin' | 'agent' | 'owner' | null>(null);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    if (!uid) { setLoading(false); return; }

    // The current user's own Firestore doc has `businessOwnerUid` if they are an agent.
    const unsub = fsDb()
      .collection('users')
      .doc(uid)
      .onSnapshot(
        (snap) => {
          if (!snap.exists()) { setOwnerUid(null); setRole('owner'); setLoading(false); return; }
          const d = snap.data()!;
          const bOwner = d.businessOwnerUid ?? null;
          const agentRole = d.agentRole ?? null;
          setOwnerUid(bOwner);
          setRole(bOwner ? (agentRole ?? 'agent') : 'owner');
          setLoading(false);
        },
        () => { setOwnerUid(null); setRole('owner'); setLoading(false); },
      );

    return () => unsub();
  }, [uid]);

  return { ownerUid, role, loading };
}
