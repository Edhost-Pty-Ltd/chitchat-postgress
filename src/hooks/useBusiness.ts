// ─── Business account lifecycle ───────────────────────────────────────────────
// Source of truth: businesses/{businessId}
// Per-user pointer: users/{uid}.businessId

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { Business, UserRole, AgentStatus } from '../types';

const fsDb = () => db as ReturnType<typeof firestore>;

// ─── Live business document ───────────────────────────────────────────────────
export function useBusiness(businessId: string | null) {
  const [business, setBusiness] = useState<Business | null>(null);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    if (!businessId) { setBusiness(null); setLoading(false); return; }
    const unsub = fsDb().collection('businesses').doc(businessId).onSnapshot(
      (snap) => {
        if (!snap.exists()) { setBusiness(null); setLoading(false); return; }
        const d = snap.data()!;
        setBusiness({
          businessId: snap.id,
          name:       d.name    ?? '',
          ownerId:    d.ownerId ?? '',
          agents:     d.agents  ?? [],
          plan:       d.plan    ?? 'free',
          createdAt:  d.createdAt?.toDate?.() ?? new Date(),
          settings:   d.settings ?? { autoAssign: false, routingStrategy: 'manual' },
        });
        setLoading(false);
      },
      () => setLoading(false),
    );
    return () => unsub();
  }, [businessId]);

  return { business, loading };
}

// ─── Resolve the signed-in user's business identity ──────────────────────────
export function useMyBusinessIdentity(uid: string | null) {
  const [businessId,  setBusinessId]  = useState<string | null>(null);
  const [role,        setRole]        = useState<UserRole | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>('available');
  const [loading,     setLoading]     = useState(true);
  const [isOwner,     setIsOwner]     = useState(false);

  useEffect(() => {
    if (!uid) { setLoading(false); return; }
    const unsub = fsDb().collection('users').doc(uid).onSnapshot(
      (snap) => {
        if (!snap.exists()) { setLoading(false); return; }
        const d = snap.data()!;
        setBusinessId(d.businessId ?? null);
        setRole((d.role as UserRole) ?? 'customer');
        setAgentStatus((d.agentStatus as AgentStatus) ?? 'available');
        setLoading(false);
      },
      () => setLoading(false),
    );
    return () => unsub();
  }, [uid]);

  useEffect(() => {
    if (!businessId || !uid) { setIsOwner(false); return; }
    const unsub = fsDb().collection('businesses').doc(businessId).onSnapshot(
      (snap) => setIsOwner(snap.exists() && snap.data()!.ownerId === uid),
      () => setIsOwner(false),
    );
    return () => unsub();
  }, [businessId, uid]);

  return { businessId, role, isOwner, agentStatus, loading };
}

// ─── Create a new business ───────────────────────────────────────────────────
export async function createBusiness(
  ownerUid: string,
  name:     string,
): Promise<string> {
  const ref = fsDb().collection('businesses').doc();
  const batch = fsDb().batch();

  batch.set(ref, {
    businessId: ref.id,
    name:       name.trim(),
    ownerId:    ownerUid,
    agents:     [ownerUid],
    plan:       'pro',
    createdAt:  firestore.FieldValue.serverTimestamp(),
    settings:   { autoAssign: false, routingStrategy: 'manual' },
  });

  batch.update(fsDb().collection('users').doc(ownerUid), {
    businessId:            ref.id,
    role:                  'admin',
    agentStatus:           'available',
    agentStatusUpdatedAt:  firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return ref.id;
}

// ─── Update the current user's own availability ──────────────────────────────
export async function setAgentStatus(uid: string, status: AgentStatus) {
  await fsDb().collection('users').doc(uid).update({
    agentStatus:           status,
    agentStatusUpdatedAt:  firestore.FieldValue.serverTimestamp(),
  });
}