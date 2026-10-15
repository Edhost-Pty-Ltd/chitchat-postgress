// ─── Signaling Service ───────────────────────────────────────────────────────
// Uses Firestore for WebRTC signaling (offer/answer/ICE candidates exchange)

import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import type { Call, CallStatus, CallParticipant, CallType } from '../types/call';

const fsDb = () => db as ReturnType<typeof firestore>;

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
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
    await fsDb().collection('calls').doc(callId).update({
      offer,
      updatedAt: firestore.FieldValue.serverTimestamp(),
    });
    console.log('[SignalingService] Offer saved for call:', callId);
  }

  // ── Save WebRTC answer ──────────────────────────────────────────────────────
  static async saveAnswer(callId: string, answer: RTCSessionDescriptionInit): Promise<void> {
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
    await fsDb()
      .collection('users').doc(userId).collection('callHistory').doc(callId)
      .set({
        callId,
        otherParty,
        type,
        direction,
        status,
        duration,
        // Missed incoming calls start as unseen so the badge shows on the
        // Calls tab. CallsScreen marks them seen when the user opens the tab.
        seen: direction === 'incoming' && status === 'missed' ? false : true,
        timestamp: firestore.FieldValue.serverTimestamp(),
      });
    console.log('[SignalingService] Call saved to history:', { userId, callId });
  }
}
