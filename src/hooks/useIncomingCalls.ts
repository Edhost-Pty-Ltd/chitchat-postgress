// ─── Hook: Incoming Calls ────────────────────────────────────────────────────
// Listens for incoming calls via Socket.IO call:incoming events.

import { useEffect } from 'react';
import { useCallContext } from '../context/CallContext';
import type { CallParticipant, CallType } from '../types/call';
import { socketClient } from '../realtime/socket';

export function useIncomingCalls(userId: string | null) {
  const { setIncomingCall } = useCallContext();

  useEffect(() => {
    if (!userId) return;
    void socketClient.connect();
    const unsub = socketClient.subscribe('call:incoming', (payload) => {
      const p = payload as { callId?: string; caller?: CallParticipant; type?: CallType };
      if (!p?.callId || !p.caller || !p.type) return;
      setIncomingCall({ callId: p.callId, caller: p.caller, type: p.type });
    });
    return () => unsub();
  }, [userId, setIncomingCall]);
}
