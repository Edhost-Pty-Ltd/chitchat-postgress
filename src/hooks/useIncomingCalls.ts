// ─── Hook: Incoming Calls ────────────────────────────────────────────────────
// Listens for incoming calls via Socket.IO call:incoming events.
//
// On receiving a call we must do TWO things immediately — before the user even
// sees the ringtone — so that tapping Answer works:
//
//   1. Join the call socket room (socketClient.setActiveCall).
//      The server buffers the WebRTC offer in Redis when the callee isn't in
//      the room yet.  Joining the room causes the server to flush that buffer
//      and deliver the offer via call:signal right away.
//
//   2. Subscribe to call:signal events (SignalingService.onCallUpdated).
//      This creates the in-memory backendCalls entry and wires up the
//      call:signal handler that stores the flushed offer.  Without this,
//      SignalingService.getCall() returns null and handleAnswer fails with
//      "Call document or offer not found".

import { useEffect, useRef } from 'react';
import { useCallContext } from '../context/CallContext';
import type { CallParticipant, CallType } from '../types/call';
import { socketClient } from '../realtime/socket';
import { SignalingService } from '../services/signalingService';

export function useIncomingCalls(userId: string | null) {
  const { setIncomingCall } = useCallContext();

  // Keeps the onCallUpdated unsubscribe for the currently-ringing call so we
  // can clean it up if a second call comes in before the first is resolved.
  const unsubUpdateRef  = useRef<(() => void) | null>(null);
  const pendingCallIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    void socketClient.connect();

    const unsub = socketClient.subscribe('call:incoming', (payload) => {
      const p = payload as { callId?: string; caller?: CallParticipant; type?: CallType };
      if (!p?.callId || !p.caller || !p.type) return;

      const { callId } = p;

      // If there was already a pending call whose subscription we set up,
      // clean it up before setting up the new one.
      if (unsubUpdateRef.current && pendingCallIdRef.current !== callId) {
        unsubUpdateRef.current();
        unsubUpdateRef.current = null;
      }

      // ── Step 1: subscribe to call:signal BEFORE joining the room ──────────
      // onCallUpdated creates the backendCalls entry (if absent) and attaches
      // the call:signal handler that will store the incoming offer.
      // Must come first so the offer that arrives during the room-join flush
      // is captured.
      if (!unsubUpdateRef.current) {
        unsubUpdateRef.current = SignalingService.onCallUpdated(callId, (call) => {
          // We only need the side-effects (backendCalls entry creation + the
          // call:signal subscription that buffers the offer). But we also
          // release this subscription once the call reaches a terminal state,
          // so the backendCalls entry + socket listener don't leak for the
          // whole app session after every call. By the time a call ends, the
          // call screen holds its own onCallUpdated listener, so dropping ours
          // never tears down the entry prematurely.
          const status = call?.status;
          if (status === 'ended' || status === 'rejected' || status === 'missed') {
            if (unsubUpdateRef.current && pendingCallIdRef.current === callId) {
              unsubUpdateRef.current();
              unsubUpdateRef.current = null;
              pendingCallIdRef.current = null;
            }
          }
        });
        pendingCallIdRef.current = callId;
      }

      // ── Step 2: join the call room ─────────────────────────────────────────
      // This emits call:join to the server.  The server sees the callee is now
      // in the room, flushes its Redis offer buffer, and sends the offer as a
      // call:signal event — which the handler wired up above will receive and
      // store in backendCalls.call.offer.
      socketClient.setActiveCall(callId);

      // Update context so the ringtone / overlay appears.
      setIncomingCall({ callId, caller: p.caller, type: p.type });
    });

    return () => {
      unsub();
      // Clean up any pending call subscription when the hook unmounts
      // (e.g. user signs out while the phone is ringing).
      if (unsubUpdateRef.current) {
        unsubUpdateRef.current();
        unsubUpdateRef.current = null;
      }
    };
  }, [userId, setIncomingCall]);
}
