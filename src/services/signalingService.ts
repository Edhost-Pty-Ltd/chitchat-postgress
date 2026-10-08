// ─── Signaling Service ───────────────────────────────────────────────────────
// WebRTC signaling. On the legacy path this uses Firestore (offer/answer/ICE in
// a call doc). On the backend path (feature flag 'calls') it relays each signal
// as a Socket.IO 'call:signal' event, with ICE sent one candidate per event.
//
// The static method surface is unchanged so CallContext / useWebRTC / the call
// screens keep working untouched. onCallUpdated reconstructs the same Call shape
// the UI already consumes by accumulating signals as they arrive.

import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import type { Call, CallStatus, CallParticipant, CallType } from '../types/call';
import { useBackend } from '../config/featureFlags';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

const fsDb = () => db as ReturnType<typeof firestore>;

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

// ── Backend-path in-memory call state ────────────────────────────────────────
// Accumulates signals arriving over the socket so onCallUpdated can emit a Call
// object matching the legacy Firestore shape.
interface BackendCallState {
  call: Partial<Call> & { callId: string };
  listeners: Set<(c: Call | null) => void>;
}
const backendCalls = new Map<string, BackendCallState>();

function emitBackendCall(callId: string): void {
  const state = backendCalls.get(callId);
  if (!state) return;
  const c = state.call;
  const full: Call = {
    callId,
    caller: c.caller as CallParticipant,
    callee: c.callee as CallParticipant,
    status: c.status ?? 'ringing',
    type: c.type ?? 'audio',
    startTime: c.startTime ?? null,
    endTime: c.endTime ?? null,
    duration: c.duration ?? null,
    offer: c.offer ?? null,
    answer: c.answer ?? null,
    callerIceCandidates: c.callerIceCandidates ?? [],
    calleeIceCandidates: c.calleeIceCandidates ?? [],
    createdAt: c.createdAt ?? new Date(),
    updatedAt: new Date(),
  };
  state.listeners.forEach((cb) => cb(full));
}

export class SignalingService {
  // ── Create a new call document ─────────────────────────────────────────────
  static async createCall(
    callerId: string,
    calleeId: string,
    callerInfo: CallParticipant,
    calleeInfo: CallParticipant,
    type: CallType = 'audio',
  ): Promise<string> {
    const callId = `${callerId}_${calleeId}_${Date.now()}`;

    if (useBackend('calls')) {
      // Seed local state so onCallUpdated can emit a coherent Call.
      backendCalls.set(callId, {
        call: { callId, caller: callerInfo, callee: calleeInfo, type, status: 'ringing', createdAt: new Date() },
        listeners: backendCalls.get(callId)?.listeners ?? new Set(),
      });
      await socketClient.connect();
      socketClient.setActiveCall(callId); // joins the call room
      const res = await endpoints.createCall(callId, calleeId, callerInfo, calleeInfo, type);
      if (!res.ok) throw new Error(`createCall failed: ${res.error.message}`);
      console.log('[SignalingService] Call created (backend):', callId);
      return callId;
    }

    const callRef = fsDb().collection('calls').doc(callId);

    await callRef.set({
      callId,
      caller: callerInfo,
      callee: calleeInfo,
      status: 'ringing',
      type,
      startTime: null,
      endTime: null,
      duration: null,
      offer: null,
      answer: null,
      callerIceCandidates: [],
      calleeIceCandidates: [],
      createdAt: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });

    console.log('[SignalingService] Call created:', callId);
    return callId;
  }

  // ── Save WebRTC offer ───────────────────────────────────────────────────────
  static async saveOffer(callId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    if (useBackend('calls')) {
      socketClient.emit('call:signal', { callId, kind: 'offer', data: offer });
      console.log('[SignalingService] Offer sent (backend):', callId);
      return;
    }
    await fsDb().collection('calls').doc(callId).update({
      offer,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
    console.log('[SignalingService] Offer saved for call:', callId);
  }

  // ── Save WebRTC answer ──────────────────────────────────────────────────────
  static async saveAnswer(callId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    if (useBackend('calls')) {
      // Callee joins the call room so buffered offer/ICE flush to it, then answers.
      await socketClient.connect();
      socketClient.setActiveCall(callId);
      socketClient.emit('call:signal', { callId, kind: 'answer', data: answer });
      console.log('[SignalingService] Answer sent (backend):', callId);
      return;
    }
    await fsDb().collection('calls').doc(callId).update({
      answer,
      status: 'accepted',
      startTime: firestore.FieldValue.serverTimestamp(),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
    console.log('[SignalingService] Answer saved for call:', callId);
  }

  // ── Add ICE candidate ───────────────────────────────────────────────────────
  static async addIceCandidate(
    callId: string,
    candidate: RTCIceCandidateInit,
    isCallee: boolean,
  ): Promise<void> {
    if (useBackend('calls')) {
      // Each ICE candidate is relayed as its own event (Req 8.2).
      socketClient.emit('call:signal', { callId, kind: 'ice', data: candidate, isCallee });
      console.log('[SignalingService] ICE candidate sent (backend):', { callId, isCallee });
      return;
    }
    const field = isCallee ? 'calleeIceCandidates' : 'callerIceCandidates';
    await fsDb().collection('calls').doc(callId).update({
      [field]: firestore.FieldValue.arrayUnion(candidate),
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
    console.log('[SignalingService] ICE candidate added:', { callId, isCallee });
  }

  // ── Update call status ──────────────────────────────────────────────────────
  static async updateCallStatus(
    callId: string,
    status: CallStatus,
    duration?: number,
  ): Promise<void> {
    if (useBackend('calls')) {
      // Map terminal transitions to signaling kinds the server understands.
      if (status === 'rejected') {
        socketClient.emit('call:signal', { callId, kind: 'reject', data: {} });
      } else if (status === 'ended' || status === 'missed') {
        socketClient.emit('call:signal', { callId, kind: 'end', data: { duration } });
      } else {
        socketClient.emit('call:signal', { callId, kind: 'state', data: { status, duration } });
      }
      if (status === 'ended' || status === 'rejected' || status === 'missed' || status === 'failed') {
        socketClient.setActiveCall(null);
      }
      console.log('[SignalingService] Call status sent (backend):', { callId, status });
      return;
    }

    const updates: any = {
      status,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    };

    if (status === 'ended' || status === 'rejected' || status === 'missed') {
      updates.endTime = firestore.FieldValue.serverTimestamp();
      if (duration !== undefined) updates.duration = duration;
    }

    if (status === 'connected') {
      updates.startTime = firestore.FieldValue.serverTimestamp();
    }

    await fsDb().collection('calls').doc(callId).update(updates);
    console.log('[SignalingService] Call status updated:', { callId, status });
  }

  // ── Listen for call updates ─────────────────────────────────────────────────
  static onCallUpdated(callId: string, callback: (call: Call | null) => void): () => void {
    if (useBackend('calls')) {
      let state = backendCalls.get(callId);
      if (!state) {
        state = { call: { callId }, listeners: new Set() };
        backendCalls.set(callId, state);
      }
      state.listeners.add(callback);

      // Translate inbound socket signals into accumulated Call state.
      const unsub = socketClient.subscribe('call:signal', (payload) => {
        const p = payload as {
          callId?: string;
          kind?: string;
          data?: unknown;
          from?: string;
        };
        if (p?.callId !== callId) return;
        const s = backendCalls.get(callId);
        if (!s) return;

        switch (p.kind) {
          case 'offer':
            s.call.offer = p.data as RTCSessionDescriptionInit;
            break;
          case 'answer':
            s.call.answer = p.data as RTCSessionDescriptionInit;
            s.call.status = 'accepted';
            s.call.startTime = s.call.startTime ?? new Date();
            break;
          case 'ice': {
            // The sender tags isCallee; store on the matching side.
            const cand = p.data as RTCIceCandidateInit;
            // When the remote is the callee, these are calleeIceCandidates.
            const fromCallee = s.call.callee?.userId === p.from;
            if (fromCallee) s.call.calleeIceCandidates = [...(s.call.calleeIceCandidates ?? []), cand];
            else s.call.callerIceCandidates = [...(s.call.callerIceCandidates ?? []), cand];
            break;
          }
          case 'reject':
            s.call.status = 'rejected';
            s.call.endTime = new Date();
            break;
          case 'end':
            s.call.status = 'ended';
            s.call.endTime = new Date();
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

      // Emit the current snapshot immediately.
      emitBackendCall(callId);

      return () => {
        const s = backendCalls.get(callId);
        s?.listeners.delete(callback);
        unsub();
        if (s && s.listeners.size === 0) backendCalls.delete(callId);
      };
    }

    return fsDb().collection('calls').doc(callId).onSnapshot((snap) => {
      if (!snap.exists) { callback(null); return; }

      const data = snap.data()!;
      callback({
        callId:               snap.id,
        caller:               data.caller,
        callee:               data.callee,
        status:               data.status,
        type:                 data.type,
        startTime:            data.startTime  ? toDate(data.startTime)  : null,
        endTime:              data.endTime    ? toDate(data.endTime)    : null,
        duration:             data.duration   ?? null,
        offer:                data.offer      ?? null,
        answer:               data.answer     ?? null,
        callerIceCandidates:  data.callerIceCandidates ?? [],
        calleeIceCandidates:  data.calleeIceCandidates ?? [],
        createdAt:            toDate(data.createdAt),
        updatedAt:            toDate(data.updatedAt),
      });
    });
  }

  // ── Get call document ───────────────────────────────────────────────────────
  static async getCall(callId: string): Promise<Call | null> {
    if (useBackend('calls')) {
      // On the backend path the Call's signaling fields are transient and live
      // in local accumulated state rather than a readable document.
      const state = backendCalls.get(callId);
      if (!state) return null;
      const c = state.call;
      return {
        callId,
        caller: c.caller as CallParticipant,
        callee: c.callee as CallParticipant,
        status: c.status ?? 'ringing',
        type: c.type ?? 'audio',
        startTime: c.startTime ?? null,
        endTime: c.endTime ?? null,
        duration: c.duration ?? null,
        offer: c.offer ?? null,
        answer: c.answer ?? null,
        callerIceCandidates: c.callerIceCandidates ?? [],
        calleeIceCandidates: c.calleeIceCandidates ?? [],
        createdAt: c.createdAt ?? new Date(),
        updatedAt: new Date(),
      };
    }

    const snap = await fsDb().collection('calls').doc(callId).get();
    if (!snap.exists) return null;

    const data = snap.data()!;
    return {
      callId:               snap.id,
      caller:               data.caller,
      callee:               data.callee,
      status:               data.status,
      type:                 data.type,
      startTime:            data.startTime  ? toDate(data.startTime)  : null,
      endTime:              data.endTime    ? toDate(data.endTime)    : null,
      duration:             data.duration   ?? null,
      offer:                data.offer      ?? null,
      answer:               data.answer     ?? null,
      callerIceCandidates:  data.callerIceCandidates ?? [],
      calleeIceCandidates:  data.calleeIceCandidates ?? [],
      createdAt:            toDate(data.createdAt),
      updatedAt:            toDate(data.updatedAt),
    };
  }

  // ── Save call to history ────────────────────────────────────────────────────
  static async saveToCallHistory(
    userId: string,
    callId: string,
    otherParty: CallParticipant,
    type: CallType,
    direction: 'incoming' | 'outgoing',
    status: 'completed' | 'missed' | 'rejected' | 'busy' | 'failed',
    duration: number | null,
  ): Promise<void> {
    if (useBackend('calls')) {
      // The server records call history for both parties on end/reject/missed,
      // so the client does not write history on the backend path (Req 8.9).
      return;
    }
    await fsDb()
      .collection('users').doc(userId).collection('callHistory').doc(callId)
      .set({
        callId,
        otherParty,
        type,
        direction,
        status,
        duration,
        timestamp: firestore.FieldValue.serverTimestamp(),
      });
    console.log('[SignalingService] Call saved to history:', { userId, callId });
  }
}
