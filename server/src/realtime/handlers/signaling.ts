import type { AuthedSocket } from '../gateway.js';
import { emitToUser, rooms, getIO } from '../emitter.js';
import { bufferSignal, flushBuffer } from '../callBuffer.js';
import {
  getCall,
  isParticipant,
  updateCallStatus,
  addCallHistory,
  type CallRow,
} from '../../db/repositories/calls.js';
import { isBlocked } from '../../db/repositories/blocks.js';
import { logger } from '../../config/logger.js';

type Ack = (response: { ok: boolean; error?: string }) => void;

export type SignalKind = 'offer' | 'answer' | 'ice' | 'accept' | 'reject' | 'end' | 'state';

interface SignalPayload {
  callId?: string;
  kind?: SignalKind;
  data?: unknown;
  isCallee?: boolean;
}

/** The other participant of a call relative to `userId`. */
function otherParty(call: CallRow, userId: string): string {
  return call.caller_id === userId ? call.callee_id : call.caller_id;
}

/** Whether the callee currently has a socket joined to the call room. */
async function calleeJoined(callId: string): Promise<boolean> {
  const io = getIO();
  if (!io) return false;
  const socketsInRoom = await io.in(rooms.call(callId)).fetchSockets();
  return socketsInRoom.length > 0;
}

export function registerSignalingHandlers(socket: AuthedSocket): void {
  const userId = socket.identity!.userId;

  // Join a call room; flush any buffered offer/ICE to this socket (Req 8.8).
  socket.on('call:join', async (payload: { callId?: string }, ack?: Ack) => {
    const callId = payload?.callId;
    if (!callId || !(await isParticipant(callId, userId))) {
      ack?.({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    await socket.join(rooms.call(callId));
    const buffered = await flushBuffer(callId);
    for (const signal of buffered) {
      socket.emit('call:signal', signal);
    }
    ack?.({ ok: true });
  });

  socket.on('call:leave', (payload: { callId?: string }, ack?: Ack) => {
    if (payload?.callId) void socket.leave(rooms.call(payload.callId));
    ack?.({ ok: true });
  });

  // Relay a signaling event to the other participant (Req 8.1, 8.2, 8.7).
  socket.on('call:signal', async (payload: SignalPayload, ack?: Ack) => {
    const { callId, kind, data } = payload ?? {};
    if (!callId || !kind) {
      ack?.({ ok: false, error: 'BAD_REQUEST' });
      return;
    }
    const call = await getCall(callId);
    if (!call || !(await isParticipant(callId, userId))) {
      // Non-participants are rejected (Req 8.7, Property 18).
      ack?.({ ok: false, error: 'FORBIDDEN' });
      return;
    }

    const peer = otherParty(call, userId);
    const relayed = { callId, kind, data, from: userId };

    // Update persisted call state for lifecycle transitions.
    try {
      if (kind === 'answer' || kind === 'accept') {
        await updateCallStatus(callId, 'accepted');
      } else if (kind === 'reject') {
        await updateCallStatus(callId, 'rejected');
        await recordHistory(call, 'rejected', null);
      } else if (kind === 'end') {
        const duration = typeof (data as { duration?: number })?.duration === 'number'
          ? (data as { duration: number }).duration
          : null;
        await updateCallStatus(callId, 'ended', duration);
        await recordHistory(call, 'completed', duration);
      }
    } catch (err) {
      logger.warn({ err, callId, kind }, 'call state update failed');
    }

    // Buffer offer/ICE until the callee has joined; otherwise relay live (Req 8.8).
    if ((kind === 'offer' || kind === 'ice') && peer === call.callee_id) {
      if (!(await calleeJoined(callId))) {
        await bufferSignal(callId, relayed);
        ack?.({ ok: true });
        return;
      }
    }

    emitToUser(peer, 'call:signal', relayed);
    ack?.({ ok: true });
  });
}

/** Write call history rows for both participants (Req 8.9). */
async function recordHistory(
  call: CallRow,
  status: 'completed' | 'missed' | 'rejected' | 'busy' | 'failed',
  durationSec: number | null,
): Promise<void> {
  await Promise.all([
    addCallHistory({
      userId: call.caller_id,
      callId: call.id,
      otherParty: call.callee_info,
      type: call.type,
      direction: 'outgoing',
      status,
      durationSec,
    }),
    addCallHistory({
      userId: call.callee_id,
      callId: call.id,
      otherParty: call.caller_info,
      type: call.type,
      direction: 'incoming',
      status: status === 'completed' ? 'completed' : status,
      durationSec,
    }),
  ]);
}

/**
 * Create a call and notify the callee (Req 8.5). Returns false when the caller
 * is blocked by the callee — the callee is not notified (Req 8.6, Property 7).
 * Called from the REST POST /calls handler after the row is created.
 */
export async function notifyIncomingCall(call: CallRow): Promise<boolean> {
  if (await isBlocked(call.callee_id, call.caller_id)) {
    return false;
  }
  emitToUser(call.callee_id, 'call:incoming', {
    callId: call.id,
    caller: call.caller_info,
    type: call.type,
  });
  return true;
}

export { recordHistory };
