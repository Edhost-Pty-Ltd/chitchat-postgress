// ─── Signaling Service ───────────────────────────────────────────────────────
// WebRTC signaling via Socket.IO call:signal events.
// Accumulates signals in memory so onCallUpdated emits a coherent Call object.

import type { Call, CallStatus, CallParticipant, CallType } from '../types/call';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

interface BackendCallState {
  call:      Partial<Call> & { callId: string };
  listeners: Set<(c: Call | null) => void>;
}
const backendCalls = new Map<string, BackendCallState>();

function emitBackendCall(callId: string): void {
  const state = backendCalls.get(callId);
  if (!state) return;
  const c = state.call;
  const full: Call = {
    callId,
    caller:               c.caller               as CallParticipant,
    callee:               c.callee               as CallParticipant,
    status:               c.status               ?? 'ringing',
    type:                 c.type                 ?? 'audio',
    startTime:            c.startTime            ?? null,
    endTime:              c.endTime              ?? null,
    duration:             c.duration             ?? null,
    offer:                c.offer                ?? null,
    answer:               c.answer               ?? null,
    callerIceCandidates:  c.callerIceCandidates  ?? [],
    calleeIceCandidates:  c.calleeIceCandidates  ?? [],
    createdAt:            c.createdAt            ?? new Date(),
    updatedAt:            new Date(),
  };
  state.listeners.forEach((cb) => cb(full));
}

export class SignalingService {
  static async createCall(
    callerId: string, calleeId: string,
    callerInfo: CallParticipant, calleeInfo: CallParticipant,
    type: CallType = 'audio',
  ): Promise<string> {
    const callId = `${callerId}_${calleeId}_${Date.now()}`;
    backendCalls.set(callId, {
      call: { callId, caller: callerInfo, callee: calleeInfo, type, status: 'ringing', createdAt: new Date() },
      listeners: backendCalls.get(callId)?.listeners ?? new Set(),
    });
    await socketClient.connect();
    socketClient.setActiveCall(callId);
    const res = await endpoints.createCall(callId, calleeId, callerInfo, calleeInfo, type);
    if (!res.ok) throw new Error(`createCall failed: ${res.error.message}`);
    return callId;
  }

  static async saveOffer(callId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    socketClient.emit('call:signal', { callId, kind: 'offer', data: offer });
  }

  static async saveAnswer(callId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    await socketClient.connect();
    socketClient.setActiveCall(callId);
    socketClient.emit('call:signal', { callId, kind: 'answer', data: answer });
  }

  static async addIceCandidate(
    callId: string, candidate: RTCIceCandidateInit, isCallee: boolean,
  ): Promise<void> {
    socketClient.emit('call:signal', { callId, kind: 'ice', data: candidate, isCallee });
  }

  static async updateCallStatus(callId: string, status: CallStatus, duration?: number): Promise<void> {
    if (status === 'rejected') {
      socketClient.emit('call:signal', { callId, kind: 'reject', data: {} });
    } else if (status === 'ended' || status === 'missed') {
      socketClient.emit('call:signal', { callId, kind: 'end', data: { duration } });
    } else {
      socketClient.emit('call:signal', { callId, kind: 'state', data: { status, duration } });
    }
    if (['ended', 'rejected', 'missed', 'failed'].includes(status)) {
      socketClient.setActiveCall(null);
    }
  }

  static onCallUpdated(callId: string, callback: (call: Call | null) => void): () => void {
    let state = backendCalls.get(callId);
    if (!state) {
      state = { call: { callId }, listeners: new Set() };
      backendCalls.set(callId, state);
    }
    state.listeners.add(callback);

    const unsub = socketClient.subscribe('call:signal', (payload) => {
      const p = payload as { callId?: string; kind?: string; data?: unknown; from?: string };
      if (p?.callId !== callId) return;
      const s = backendCalls.get(callId);
      if (!s) return;

      switch (p.kind) {
        case 'offer':  s.call.offer  = p.data as RTCSessionDescriptionInit; break;
        case 'answer':
          s.call.answer = p.data as RTCSessionDescriptionInit;
          s.call.status = 'accepted';
          s.call.startTime = s.call.startTime ?? new Date();
          break;
        case 'ice': {
          const cand = p.data as RTCIceCandidateInit;
          const fromCallee = s.call.callee?.userId === p.from;
          if (fromCallee) s.call.calleeIceCandidates = [...(s.call.calleeIceCandidates ?? []), cand];
          else s.call.callerIceCandidates = [...(s.call.callerIceCandidates ?? []), cand];
          break;
        }
        case 'reject': s.call.status = 'rejected'; s.call.endTime = new Date(); break;
        case 'end':
          s.call.status = 'ended'; s.call.endTime = new Date();
          s.call.duration = (p.data as { duration?: number })?.duration ?? s.call.duration ?? null;
          break;
        case 'state': {
          const st = (p.data as { status?: CallStatus })?.status;
          if (st) s.call.status = st;
          break;
        }
      }
      emitBackendCall(callId);
    });

    emitBackendCall(callId);

    return () => {
      const s = backendCalls.get(callId);
      s?.listeners.delete(callback);
      unsub();
      if (s && s.listeners.size === 0) backendCalls.delete(callId);
    };
  }

  static async getCall(callId: string): Promise<Call | null> {
    const state = backendCalls.get(callId);
    if (!state) return null;
    const c = state.call;
    return {
      callId,
      caller:               c.caller              as CallParticipant,
      callee:               c.callee              as CallParticipant,
      status:               c.status              ?? 'ringing',
      type:                 c.type                ?? 'audio',
      startTime:            c.startTime           ?? null,
      endTime:              c.endTime             ?? null,
      duration:             c.duration            ?? null,
      offer:                c.offer               ?? null,
      answer:               c.answer              ?? null,
      callerIceCandidates:  c.callerIceCandidates ?? [],
      calleeIceCandidates:  c.calleeIceCandidates ?? [],
      createdAt:            c.createdAt           ?? new Date(),
      updatedAt:            new Date(),
    };
  }

  /** Server records call history for both parties on end/reject/missed. No-op here. */
  static async saveToCallHistory(
    _userId: string, _callId: string, _otherParty: CallParticipant,
    _type: CallType, _direction: 'incoming' | 'outgoing',
    _status: 'completed' | 'missed' | 'rejected' | 'busy' | 'failed',
    _duration: number | null,
  ): Promise<void> {}
}
