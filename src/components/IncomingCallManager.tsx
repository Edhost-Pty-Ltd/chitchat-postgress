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
      // Verify the offer is already buffered (useIncomingCalls joined the room
      // and set up the signal listener, so it should be present).
      const callDoc = await SignalingService.getCall(incomingCall.callId);
      if (!callDoc || !callDoc.offer) {
        console.error('[IncomingCallManager] Call document or offer not found');
        setIncomingCall(null);
        return;
      }

      // Navigate to the call screen — it handles WebRTC setup (answerCall) to
      // avoid creating two peer connections when this manager also called it.
      if (incomingCall.type === 'video') {
        navigation.navigate('VideoCall', {
          callId: incomingCall.callId,
          isOutgoing: false,
          otherParty: incomingCall.caller,
        });
      } else {
        navigation.navigate('AudioCall', {
          callId: incomingCall.callId,
          isOutgoing: false,
          otherParty: incomingCall.caller,
        });
      }

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
