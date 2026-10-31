// ─── Component: Incoming Call Manager ────────────────────────────────────────
// Manages incoming call detection and display

import React, { useEffect } from 'react';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../hooks/useAuth';
import { useIncomingCalls } from '../hooks/useIncomingCalls';
import { useCallContext } from '../context/CallContext';
import { useRingtone } from '../hooks/useRingtone';
import { SignalingService } from '../services/signalingService';
import { IncomingCallOverlay } from '.';
import type { RootStackParamList } from '../types';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export function IncomingCallManager() {
  const { user } = useAuth();
  const navigation = useNavigation<NavigationProp>();
  const { incomingCall, setIncomingCall, resetCallState } = useCallContext();
  const ringtone = useRingtone();
  
  // Listen for incoming calls
  useIncomingCalls(user?.uid || null);

  // Play/stop ringtone when incoming call state changes
  useEffect(() => {
    if (incomingCall) {
      console.log('[IncomingCallManager] Incoming call detected, playing ringtone');
      ringtone.play();
    } else {
      console.log('[IncomingCallManager] No incoming call, stopping ringtone');
      ringtone.stop();
    }

    // Cleanup: stop ringtone on unmount
    return () => {
      ringtone.stop();
    };
  }, [incomingCall]);

  // Handle answer
  const handleAnswer = async () => {
    if (!incomingCall) return;

    console.log('[IncomingCallManager] Answering call:', incomingCall.callId, 'Type:', incomingCall.type);

    try {
      // Navigate directly to the call screen. The screen's own setupCall
      // useEffect will emit call:join (flushing the buffered offer from the
      // server), subscribe to call:signal events, receive the offer, create an
      // answer, and complete the WebRTC handshake. Trying to read the offer
      // from the local Map *before* subscribing always fails because the callee
      // hasn't joined the call room yet and the offer is still buffered server-
      // side in Redis.
      const screen = incomingCall.type === 'video' ? 'VideoCall' : 'AudioCall';
      navigation.navigate(screen as any, {
        callId: incomingCall.callId,
        isOutgoing: false,
        otherParty: incomingCall.caller,
      });

      // Clear incoming call from context after navigation starts
      setTimeout(() => setIncomingCall(null), 200);
    } catch (error) {
      console.error('[IncomingCallManager] Error answering call:', error);
      setIncomingCall(null);
    }
  };

  // Handle reject
  const handleReject = async () => {
    if (!incomingCall) return;

    console.log('[IncomingCallManager] Rejecting call:', incomingCall.callId);

    try {
      await SignalingService.updateCallStatus(incomingCall.callId, 'rejected');
      setIncomingCall(null);
    } catch (error) {
      console.error('[IncomingCallManager] Error rejecting call:', error);
      setIncomingCall(null);
    }
  };

  return (
    <IncomingCallOverlay
      visible={!!incomingCall}
      call={incomingCall}
      onAnswer={handleAnswer}
      onReject={handleReject}
    />
  );
}
