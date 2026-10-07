// ─── useTeamAgents Hook ───────────────────────────────────────────────────────
// Agent management for the business owner/admin.
//
// Agents are stored at:
//   businessTeams/{ownerUid}/agents/{agentUid}  →  TeamAgent
//
// The agent's own user doc also carries:
//   users/{agentUid}.businessOwnerUid = ownerUid
//   users/{agentUid}.agentRole        = 'admin' | 'agent'
//
// This dual-write keeps lookups cheap from either direction.

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { TeamAgent, AgentRole } from '../types';

const fsDb = () => db as ReturnType<typeof firestore>;

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

// ─── useTeamAgents ────────────────────────────────────────────────────────────
// Real-time list of all agents for a business owner.
export function useTeamAgents(ownerUid: string | null) {
  const [agents,  setAgents]  = useState<TeamAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!ownerUid) { setAgents([]); setLoading(false); return; }

    setLoading(true);

    const unsub = fsDb()
      .collection('businessTeams')
      .doc(ownerUid)
      .collection('agents')
      .orderBy('addedAt', 'asc')
      .onSnapshot(
        (snap) => {
          const result: TeamAgent[] = snap.docs.map((doc) => {
            const d = doc.data();
            return {
              uid:         doc.id,
              displayName: d.displayName ?? '',
              photoURL:    d.photoURL    ?? null,
              phone:       d.phone       ?? '',
              role:        d.role        ?? 'agent',
              addedAt:     toDate(d.addedAt),
              addedBy:     d.addedBy     ?? '',
              isActive:    d.isActive    ?? true,
            };
          });
          setAgents(result);
          setLoading(false);
        },
        (err) => {
          setError(err.message);
          setLoading(false);
        },
      );

    return () => unsub();
  }, [ownerUid]);

  return { agents, loading, error };
}

// ─── addAgent ─────────────────────────────────────────────────────────────────
// Looks up a user by phone number and adds them as an agent.
// Returns an error string on failure, or null on success.
export async function addAgent(
  ownerUid:    string,
  addedByUid:  string,
  phone:       string,     // E.164 e.g. "+27821234567"
  role:        AgentRole,
): Promise<{ success: boolean; error?: string; agent?: TeamAgent }> {
  try {
    // 1. Find the user by phone
    const snap = await fsDb()
      .collection('users')
      .where('phone', '==', phone)
      .limit(1)
      .get();

    if (snap.empty) {
      return { success: false, error: 'No account found with that phone number. Ask the person to create a ChitChatBusiness account first.' };
    }

    const userDoc  = snap.docs[0];
    const agentUid = userDoc.id;
    const userData = userDoc.data();

    // 2. Prevent owner from adding themselves
    if (agentUid === ownerUid) {
      return { success: false, error: 'You cannot add yourself as an agent.' };
    }

    // 3. Check if already an agent of THIS or ANOTHER team
    const existingTeamDoc = await fsDb()
      .collection('businessTeams')
      .doc(ownerUid)
      .collection('agents')
      .doc(agentUid)
      .get();

    if (existingTeamDoc.exists()) {
      return { success: false, error: 'This person is already a member of your team.' };
    }

    // If they belong to another owner's team, reject
    const agentUserSnap = await fsDb().collection('users').doc(agentUid).get();
    if (agentUserSnap.exists()) {
      const existingOwner = agentUserSnap.data()!.businessOwnerUid;
      if (existingOwner && existingOwner !== ownerUid) {
        return { success: false, error: 'This person already belongs to another business team.' };
      }
    }

    const agent: Omit<TeamAgent, 'addedAt'> & { addedAt: any } = {
      uid:         agentUid,
      displayName: userData.displayName ?? phone,
      photoURL:    userData.photoURL    ?? null,
      phone:       userData.phone       ?? phone,
      role,
      addedAt:     firestore.FieldValue.serverTimestamp(),
      addedBy:     addedByUid,
      isActive:    true,
    };

    const batch = fsDb().batch();

    // Write to businessTeams/{ownerUid}/agents/{agentUid}
    batch.set(
      fsDb().collection('businessTeams').doc(ownerUid).collection('agents').doc(agentUid),
      agent,
    );

    // Write back-reference to the agent's own user doc
    batch.update(fsDb().collection('users').doc(agentUid), {
      businessOwnerUid: ownerUid,
      agentRole:        role,
    });

    await batch.commit();

    return {
      success: true,
      agent: { ...agent, addedAt: new Date() } as TeamAgent,
    };
  } catch (err: any) {
    console.error('[useTeamAgents] addAgent error:', err);
    return { success: false, error: err?.message ?? 'Failed to add agent. Please try again.' };
  }
}

// ─── removeAgent ──────────────────────────────────────────────────────────────
export async function removeAgent(
  ownerUid:  string,
  agentUid:  string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const batch = fsDb().batch();

    // Remove from businessTeams
    batch.delete(
      fsDb().collection('businessTeams').doc(ownerUid).collection('agents').doc(agentUid),
    );

    // Remove back-reference from agent's user doc
    batch.update(fsDb().collection('users').doc(agentUid), {
      businessOwnerUid: firestore.FieldValue.delete(),
      agentRole:        firestore.FieldValue.delete(),
    });

    await batch.commit();

    // Unassign any open conversations assigned to this agent.
    // This query needs a composite index on (members array-contains, assignedTo ==).
    // If the index doesn't exist yet Firestore throws a failed-precondition error.
    // We catch it so the agent removal still succeeds — the conversations will
    // simply remain assigned to the now-removed agent uid until manually
    // reassigned or until the index is created and a re-run completes the cleanup.
    try {
      const assignedSnap = await fsDb()
        .collection('chats')
        .where('members', 'array-contains', ownerUid)
        .where('assignedTo', '==', agentUid)
        .get();

      if (!assignedSnap.empty) {
        const unassignBatch = fsDb().batch();
        assignedSnap.docs.forEach((doc) => {
          unassignBatch.update(doc.ref, {
            assignedTo:     null,
            assignedToName: null,
            status:         'open',
          });
        });
        await unassignBatch.commit();
      }
    } catch (unassignErr: any) {
      // Log but don't fail — agent is removed; conversations may need manual cleanup.
      // Most likely cause: missing composite index for (members array-contains + assignedTo ==).
      // Create it at: https://console.firebase.google.com/project/_/firestore/indexes
      console.warn(
        '[useTeamAgents] removeAgent: could not unassign conversations —',
        unassignErr?.message ?? unassignErr,
        '— agent was removed successfully; please create the required Firestore composite index.',
      );
    }

    return { success: true };
  } catch (err: any) {
    console.error('[useTeamAgents] removeAgent error:', err);
    return { success: false, error: err?.message ?? 'Failed to remove agent.' };
  }
}

// ─── updateAgentRole ──────────────────────────────────────────────────────────
export async function updateAgentRole(
  ownerUid:  string,
  agentUid:  string,
  newRole:   AgentRole,
): Promise<{ success: boolean; error?: string }> {
  try {
    const batch = fsDb().batch();

    batch.update(
      fsDb().collection('businessTeams').doc(ownerUid).collection('agents').doc(agentUid),
      { role: newRole },
    );

    batch.update(fsDb().collection('users').doc(agentUid), {
      agentRole: newRole,
    });

    await batch.commit();
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message ?? 'Failed to update role.' };
  }
}

// ─── useIsTeamMember ──────────────────────────────────────────────────────────
// Quick check: is the given UID an admin/agent of the given owner?
export function useIsTeamMember(ownerUid: string | null, uid: string | null) {
  const [isMember,  setIsMember]  = useState(false);
  const [agentRole, setAgentRole] = useState<AgentRole | null>(null);
  const [loading,   setLoading]   = useState(true);

  useEffect(() => {
    if (!ownerUid || !uid || ownerUid === uid) {
      setIsMember(ownerUid === uid);
      setAgentRole(null);
      setLoading(false);
      return;
    }

    const unsub = fsDb()
      .collection('businessTeams')
      .doc(ownerUid)
      .collection('agents')
      .doc(uid)
      .onSnapshot(
        (snap) => {
          setIsMember(snap.exists());
          setAgentRole(snap.exists() ? (snap.data()!.role ?? 'agent') : null);
          setLoading(false);
        },
        () => { setIsMember(false); setLoading(false); },
      );

    return () => unsub();
  }, [ownerUid, uid]);

  return { isMember, agentRole, loading };
}
