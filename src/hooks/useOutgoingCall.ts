// ─── Hook: Outgoing Call ─────────────────────────────────────────────────────
// Manages the flow of initiating an outgoing voice call

import { useState, useCallback, useRef, useEffect } from 'react';
import { SignalingService } from '../services/signalingService';
import { useCallContext } from '../context/CallContext';
import type { CallParticipant } from '../types/call';

export function useOutgoingCall() {
  const { 
    setActiveCallId, setCallStatus, resetCallState, setIsCaller,
    localStream, remoteStream, streamVersion, connectionState, networkQuality,
    toggleMute, toggleVideo, cleanup
  } = useCallContext();
  
  const [isInitiating, setIsInitiating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // Mark this hook as caller when initialized
  useEffect(() => {
    setIsCaller(true);
  }, [setIsCaller]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  // ── Initiate call ──────────────────────────────────────────────────────────
  // Only creates the backend call record (which notifies the callee) and
  // returns the callId. The WebRTC peer connection, offer/answer and ICE
  // exchange are owned entirely by AudioCallScreen / VideoCallScreen, so there
  // is a SINGLE peer connection per call (previously this hook created one and
  // the call screen created a second, conflicting one — the call never
  // connected).
  const initiateCall = useCallback(
    async (
      callerId: string,
      calleeId: string,
      callerInfo: CallParticipant,
      calleeInfo: CallParticipant,
      callType: 'audio' | 'video' = 'audio'
    ): Promise<string | null> => {
      setIsInitiating(true);
      setError(null);

      try {
        const callId = await SignalingService.createCall(
          callerId,
          calleeId,
          callerInfo,
          calleeInfo,
          callType
        );

        callIdRef.current = callId;
        setActiveCallId(callId);
        setCallStatus('ringing');
        setIsInitiating(false);
        return callId;
      } catch (err) {
        console.error('[useOutgoingCall] Failed to initiate call:', err);
        setError(err instanceof Error ? err.message : 'Failed to initiate call');
        setCallStatus('failed');
        setIsInitiating(false);
        return null;
      }
    },
    [setActiveCallId, setCallStatus]
  );

  // ── End call ───────────────────────────────────────────────────────────────
  const endCall = useCallback(
    async (duration?: number) => {
      // Get callId from context instead of ref
      const callId = callIdRef.current;
      console.log('[useOutgoingCall] ===== END CALL STARTED =====');
      console.log('[useOutgoingCall] Call ID from ref:', callId);
      console.log('[useOutgoingCall] Duration:', duration);
      
      if (!callId) {
        console.error('[useOutgoingCall] ❌ No callId in ref, cannot end call!');
        console.log('[useOutgoingCall] This means the hook was recreated and lost the callId');
        return;
      }

      console.log('[useOutgoingCall] Ending call...');

      try {
        // Update call status via the signaling backend
        console.log('[useOutgoingCall] Step 1: Updating call status to ended...');
        await SignalingService.updateCallStatus(callId, 'ended', duration);
        console.log('[useOutgoingCall] Step 2: Call status updated successfully');

        // Save to call history
        console.log('[useOutgoingCall] Step 3: Fetching call document...');
        const call = await SignalingService.getCall(callId);
        console.log('[useOutgoingCall] Step 4: Call document fetched:', !!call);
        
        if (call) {
          // Save for caller (outgoing)
          console.log('[useOutgoingCall] Step 5: Saving to caller history...');
          await SignalingService.saveToCallHistory(
            call.caller.userId,
            callId,
            call.callee,
            call.type,
            'outgoing',
            duration && duration > 0 ? 'completed' : 'missed',
            duration || null
          );
          console.log('[useOutgoingCall] Step 6: Caller history saved');

          // Save for callee (incoming)
          console.log('[useOutgoingCall] Step 7: Saving to callee history...');
          await SignalingService.saveToCallHistory(
            call.callee.userId,
            callId,
            call.caller,
            call.type,
            'incoming',
            duration && duration > 0 ? 'completed' : 'missed',
            duration || null
          );
          console.log('[useOutgoingCall] Step 8: Callee history saved');
        }

        // Cleanup WebRTC
        console.log('[useOutgoingCall] Step 9: Cleaning up WebRTC...');
        cleanup();
        console.log('[useOutgoingCall] Step 10: WebRTC cleaned up');

        // Cleanup listener
        if (unsubscribeRef.current) {
          console.log('[useOutgoingCall] Step 11: Unsubscribing listener...');
          unsubscribeRef.current();
          unsubscribeRef.current = null;
          console.log('[useOutgoingCall] Step 12: Listener unsubscribed');
        }

        // Reset state
        callIdRef.current = null;
        resetCallState();

        console.log('[useOutgoingCall] ===== END CALL COMPLETED =====');
      } catch (err) {
        console.error('[useOutgoingCall] ❌ Error ending call:', err);
      }
    },
    [cleanup, resetCallState]
  );

  // Add method to accept a callId from outside (for when the hook is recreated)
  const setCallId = useCallback((id: string) => {
    console.log('[useOutgoingCall] Setting callId to:', id);
    callIdRef.current = id;
  }, []);

  // ── Cancel call (before answered) ──────────────────────────────────────────
  const cancelCall = useCallback(async () => {
    const callId = callIdRef.current;
    if (!callId) return;

    console.log('[useOutgoingCall] Cancelling call...');

    try {
      await SignalingService.updateCallStatus(callId, 'ended');
      cleanup();

      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }

      callIdRef.current = null;
      resetCallState();

      console.log('[useOutgoingCall] Call cancelled');
    } catch (err) {
      console.error('[useOutgoingCall] Error cancelling call:', err);
    }
  }, [cleanup, resetCallState]);

  return {
    initiateCall,
    endCall,
    cancelCall,
    setCallId,
    isInitiating,
    error,
    localStream,
    remoteStream,
    streamVersion,
    connectionState,
    networkQuality,
    toggleMute,
    toggleVideo,
  };
}
