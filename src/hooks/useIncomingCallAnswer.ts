// ─── Hook: Incoming Call Answer ──────────────────────────────────────────────
// Manages answering/rejecting incoming calls

import { useState, useCallback, useRef, useEffect } from 'react';
import { SignalingService } from '../services/signalingService';
import { useCallContext } from '../context/CallContext';

export function useIncomingCallAnswer() {
  const { 
    setActiveCallId, setCallStatus, resetCallState, setIsCaller,
    localStream, remoteStream, streamVersion, connectionState, networkQuality,
    initializePeerConnection, createAnswer, addIceCandidate,
    toggleMute, toggleVideo, cleanup
  } = useCallContext();
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callIdRef = useRef<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const iceCandidatesProcessedRef = useRef<Set<string>>(new Set()); // Track processed ICE candidates

  // Mark this hook as callee when initialized
  useEffect(() => {
    setIsCaller(false);
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

  // ── Answer call ────────────────────────────────────────────────────────────
  const answerCall = useCallback(
    async (callId: string, offer: RTCSessionDescriptionInit, callType: 'audio' | 'video' = 'audio'): Promise<boolean> => {
      setIsProcessing(true);
      setError(null);
      
      // Reset processing flags for new call
      iceCandidatesProcessedRef.current.clear();

      try {
        console.log('[useIncomingCallAnswer] Answering call:', callId, 'Type:', callType);
        
        callIdRef.current = callId;
        setActiveCallId(callId);
        setCallStatus('accepted');

        // Step 1: Initialize WebRTC peer connection
        const isVideo = callType === 'video';
        console.log('[useIncomingCallAnswer] Initializing peer connection... Video:', isVideo);
        await initializePeerConnection(isVideo);

        // Step 2: Create answer from the offer
        console.log('[useIncomingCallAnswer] Creating answer...');
        const answer = await createAnswer(offer);

        // Step 3: Send the answer through the signaling backend
        console.log('[useIncomingCallAnswer] Sending answer via signaling...');
        await SignalingService.saveAnswer(callId, answer);

        // Step 4: Listen for ICE candidates from caller and call status changes
        console.log('[useIncomingCallAnswer] Listening for ICE candidates and status updates...');
        console.log('[useIncomingCallAnswer] Listener setup for call:', callId);
        
        unsubscribeRef.current = SignalingService.onCallUpdated(callId, async (call) => {
          console.log('[useIncomingCallAnswer] ==== Signaling Listener Triggered ====');
          
          if (!call) {
            console.log('[useIncomingCallAnswer] Call document deleted, cleaning up...');
            setCallStatus('ended');
            cleanup();
            return;
          }

          console.log('[useIncomingCallAnswer] Signaling update - status:', call.status, 'callId:', call.callId);

          // Handle call ended by caller - IMMEDIATELY cleanup
          if (call.status === 'ended') {
            console.log('[useIncomingCallAnswer] ⚠️ DETECTED CALL ENDED - Starting immediate cleanup');
            
            // Cleanup WebRTC FIRST to stop audio immediately
            console.log('[useIncomingCallAnswer] Step 1: Cleaning up WebRTC...');
            cleanup();
            console.log('[useIncomingCallAnswer] Step 2: WebRTC cleanup complete');
            
            // Then update status
            console.log('[useIncomingCallAnswer] Step 3: Updating call status to ended...');
            setCallStatus('ended');
            console.log('[useIncomingCallAnswer] Step 4: Call status updated');
            
            // Unsubscribe from further updates
            if (unsubscribeRef.current) {
              console.log('[useIncomingCallAnswer] Step 5: Unsubscribing from signaling...');
              unsubscribeRef.current();
              unsubscribeRef.current = null;
              console.log('[useIncomingCallAnswer] Step 6: Unsubscribed successfully');
            }
            
            console.log('[useIncomingCallAnswer] ✅ Cleanup sequence complete');
            return; // Stop processing
          } else if (call.status === 'rejected') {
            console.log('[useIncomingCallAnswer] Call rejected');
            setCallStatus('rejected');
            cleanup();
            return;
          }

          // Add ICE candidates from caller (only new ones)
          if (call.callerIceCandidates.length > 0) {
            for (const candidate of call.callerIceCandidates) {
              // Create a unique key for this candidate
              const candidateKey = `${candidate.candidate}-${candidate.sdpMLineIndex}-${candidate.sdpMid}`;
              
              if (!iceCandidatesProcessedRef.current.has(candidateKey)) {
                iceCandidatesProcessedRef.current.add(candidateKey);
                console.log('[useIncomingCallAnswer] Adding ICE candidate');
                await addIceCandidate(candidate);
              }
            }
          }
        });

        setIsProcessing(false);
        console.log('[useIncomingCallAnswer] Call answered successfully');
        return true;
      } catch (err) {
        console.error('[useIncomingCallAnswer] Failed to answer call:', err);
        setError(err instanceof Error ? err.message : 'Failed to answer call');
        setCallStatus('failed');
        setIsProcessing(false);
        return false;
      }
    },
    [initializePeerConnection, createAnswer, addIceCandidate, cleanup, setActiveCallId, setCallStatus]
  );

  // ── Reject call ────────────────────────────────────────────────────────────
  const rejectCall = useCallback(async (callId: string): Promise<void> => {
    console.log('[useIncomingCallAnswer] Rejecting call:', callId);

    try {
      await SignalingService.updateCallStatus(callId, 'rejected');
      resetCallState();
      console.log('[useIncomingCallAnswer] Call rejected successfully');
    } catch (err) {
      console.error('[useIncomingCallAnswer] Error rejecting call:', err);
    }
  }, [resetCallState]);

  // ── End call ───────────────────────────────────────────────────────────────
  const endCall = useCallback(
    async (duration?: number) => {
      const callId = callIdRef.current;
      console.log('[useIncomingCallAnswer] ===== END CALL STARTED =====');
      console.log('[useIncomingCallAnswer] Call ID:', callId);
      console.log('[useIncomingCallAnswer] Duration:', duration);
      
      if (!callId) {
        console.log('[useIncomingCallAnswer] No callId, aborting');
        return;
      }

      console.log('[useIncomingCallAnswer] Ending call...');

      try {
        // Update call status via the signaling backend
        console.log('[useIncomingCallAnswer] Step 1: Updating call status to ended...');
        await SignalingService.updateCallStatus(callId, 'ended', duration);
        console.log('[useIncomingCallAnswer] Step 2: Call status updated successfully');

        // Save to call history
        console.log('[useIncomingCallAnswer] Step 3: Fetching call document...');
        const call = await SignalingService.getCall(callId);
        console.log('[useIncomingCallAnswer] Step 4: Call document fetched:', !!call);
        
        if (call) {
          // Save for caller (outgoing)
          console.log('[useIncomingCallAnswer] Step 5: Saving to caller history...');
          await SignalingService.saveToCallHistory(
            call.caller.userId,
            callId,
            call.callee,
            call.type,
            'outgoing',
            duration && duration > 0 ? 'completed' : 'missed',
            duration || null
          );
          console.log('[useIncomingCallAnswer] Step 6: Caller history saved');

          // Save for callee (incoming)
          console.log('[useIncomingCallAnswer] Step 7: Saving to callee history...');
          await SignalingService.saveToCallHistory(
            call.callee.userId,
            callId,
            call.caller,
            call.type,
            'incoming',
            duration && duration > 0 ? 'completed' : 'missed',
            duration || null
          );
          console.log('[useIncomingCallAnswer] Step 8: Callee history saved');
        }

        // Cleanup WebRTC
        console.log('[useIncomingCallAnswer] Step 9: Cleaning up WebRTC...');
        cleanup();
        console.log('[useIncomingCallAnswer] Step 10: WebRTC cleaned up');

        // Cleanup listener
        if (unsubscribeRef.current) {
          console.log('[useIncomingCallAnswer] Step 11: Unsubscribing listener...');
          unsubscribeRef.current();
          unsubscribeRef.current = null;
          console.log('[useIncomingCallAnswer] Step 12: Listener unsubscribed');
        }

        // Reset state
        callIdRef.current = null;
        resetCallState();

        console.log('[useIncomingCallAnswer] ===== END CALL COMPLETED =====');
      } catch (err) {
        console.error('[useIncomingCallAnswer] ❌ Error ending call:', err);
      }
    },
    [cleanup, resetCallState]
  );

  // Add method to accept a callId from outside (for when the hook is recreated)
  const setCallId = useCallback((id: string) => {
    console.log('[useIncomingCallAnswer] Setting callId to:', id);
    callIdRef.current = id;
  }, []);

  return {
    answerCall,
    rejectCall,
    endCall,
    setCallId,
    isProcessing,
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
