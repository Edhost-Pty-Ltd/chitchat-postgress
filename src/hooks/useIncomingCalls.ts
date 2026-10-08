// ─── Hook: Incoming Calls ────────────────────────────────────────────────────
// Listen for incoming calls in Firestore.

import { useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { useCallContext } from '../context/CallContext';
import type { Call, CallParticipant, CallType } from '../types/call';
import { useBackend } from '../config/featureFlags';
import { socketClient } from '../realtime/socket';

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

export function useIncomingCalls(userId: string | null) {
  const { setIncomingCall } = useCallContext();
  const backend = useBackend('calls');

  useEffect(() => {
    if (!userId) return;

    if (backend) {
      // Incoming calls arrive as 'call:incoming' socket events (Req 8.5).
      void socketClient.connect();
      const unsub = socketClient.subscribe('call:incoming', (payload) => {
        const p = payload as { callId?: string; caller?: CallParticipant; type?: CallType };
        if (!p?.callId || !p.caller || !p.type) return;
        console.log('[useIncomingCalls] Incoming call (backend):', p.callId);
        setIncomingCall({ callId: p.callId, caller: p.caller, type: p.type });
      });
      return () => unsub();
    }

    console.log('[useIncomingCalls] Setting up listener for user:', userId);

    const fsDb = db as ReturnType<typeof firestore>;

    // Cleanup stale ringing calls on mount
    (async () => {
      try {
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
        const snapshot = await fsDb
          .collection('calls')
          .where('callee.userId', '==', userId)
          .where('status', '==', 'ringing')
          .get();

        for (const docSnap of snapshot.docs) {
          const data = docSnap.data();
          if (data.createdAt && toDate(data.createdAt) < twoMinutesAgo) {
            await docSnap.ref.update({
              status:    'missed',
              endTime:   firestore.FieldValue.serverTimestamp(),
              updatedAt: firestore.FieldValue.serverTimestamp(),
            });
            console.log('[useIncomingCalls] Marked stale call as missed:', docSnap.id);
          }
        }
      } catch (error) {
        console.error('[useIncomingCalls] Error cleaning up stale calls:', error);
      }
    })();

    const unsubscribe = fsDb
      .collection('calls')
      .where('callee.userId', '==', userId)
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
        (error) => console.error('[useIncomingCalls] Error:', error),
      );

    return () => { console.log('[useIncomingCalls] Cleaning up'); unsubscribe(); };
  }, [userId, setIncomingCall, backend]);
}
