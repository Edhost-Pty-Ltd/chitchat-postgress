// ─── Hook: Incoming Calls ────────────────────────────────────────────────────
// Listen for incoming calls in Firestore.
//
// COMPANION NOTE
//   `ownerUid` is the real account uid (== auth.uid on primary). Queries use
//   the caller's `effectiveUid()`; on a companion, the rule resolves to
//   ownerUid only if companionLinks/{anonUid} has propagated. Retry with
//   backoff to cover that window. The stale-call cleanup also runs against
//   the owner's uid — failures there are logged and ignored.

import { useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { useCallContext } from '../context/CallContext';
import type { Call } from '../types/call';

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

const MAX_PERM_RETRIES = 8;

export function useIncomingCalls(ownerUid: string | null) {
  const { setIncomingCall } = useCallContext();

  useEffect(() => {
    if (!ownerUid) return;
    console.log('[useIncomingCalls] Setting up listener for ownerUid:', ownerUid);

    let cancelled = false;
    let attempt = 0;
    let currentUnsub: (() => void) | null = null;

    const fsDb = db as ReturnType<typeof firestore>;

    // ── Cleanup stale ringing calls (best-effort, permission-safe) ──────────
    (async () => {
      try {
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
        const snapshot = await fsDb
          .collection('calls')
          .where('callee.userId', '==', ownerUid)
          .where('status', '==', 'ringing')
          .get();

        for (const docSnap of snapshot.docs) {
          const data = docSnap.data();
          if (data.createdAt && toDate(data.createdAt) < twoMinutesAgo) {
            try {
              await docSnap.ref.update({
                status:    'missed',
                endTime:   firestore.FieldValue.serverTimestamp(),
                updatedAt: firestore.FieldValue.serverTimestamp(),
              });
              console.log('[useIncomingCalls] Marked stale call as missed:', docSnap.id);
            } catch (updateErr) {
              // Not authorised to update this specific call — skip it.
              console.warn('[useIncomingCalls] Could not update stale call:', docSnap.id, updateErr);
            }
          }
        }
      } catch (error) {
        // Quiet — this is opportunistic cleanup. Permission-denied is expected
        // while the companion link is still propagating.
        console.warn('[useIncomingCalls] Cleanup skipped:', (error as any)?.code || error);
      }
    })();

    // ── Ringing-call listener (with permission-denied retry) ────────────────
    const attach = () => {
      if (cancelled) return;
      currentUnsub = fsDb
        .collection('calls')
        .where('callee.userId', '==', ownerUid)
        .where('status', '==', 'ringing')
        .onSnapshot(
          (snapshot) => {
            snapshot.docChanges().forEach((change) => {
              if (change.type !== 'added') return;
              const data = change.doc.data();

              if (data.createdAt) {
                const ageInSeconds = (Date.now() - toDate(data.createdAt).getTime()) / 1000;
                if (ageInSeconds > 60) {
                  console.log('[useIncomingCalls] Ignoring stale call:', change.doc.id);
                  return;
                }
              }

              const call: Call = {
                callId:               change.doc.id,
                caller:               data.caller,
                callee:               data.callee,
                status:               data.status,
                type:                 data.type,
                startTime:            data.startTime ? toDate(data.startTime) : null,
                endTime:              data.endTime   ? toDate(data.endTime)   : null,
                duration:             data.duration  ?? null,
                offer:                data.offer     ?? null,
                answer:               data.answer    ?? null,
                callerIceCandidates:  data.callerIceCandidates ?? [],
                calleeIceCandidates:  data.calleeIceCandidates ?? [],
                createdAt:            toDate(data.createdAt),
                updatedAt:            toDate(data.updatedAt),
              };

              console.log('[useIncomingCalls] Incoming call detected:', call.callId);
              setIncomingCall({ callId: call.callId, caller: call.caller, type: call.type });
            });
          },
          (err) => {
            if (cancelled) return;
            const isPerm =
              err?.message === 'firestore/permission-denied' ||
              /permission-denied/i.test(err?.message || '');
            if (isPerm && attempt < MAX_PERM_RETRIES) {
              const delay = Math.min(200 * (attempt + 1), 2000);
              attempt += 1;
              console.warn(
                `[useIncomingCalls] permission-denied — retry ${attempt}/${MAX_PERM_RETRIES} in ${delay}ms`,
              );
              setTimeout(() => { if (!cancelled) attach(); }, delay);
              return;
            }
            console.error('[useIncomingCalls] Error:', err);
          },
        );
    };

    attach();

    return () => {
      console.log('[useIncomingCalls] Cleaning up');
      cancelled = true;
      currentUnsub?.();
    };
  }, [ownerUid, setIncomingCall]);
}