// ─── Component: Floating Call Manager ────────────────────────────────────────
// Renders the floating call overlay when a call is minimized

import React from 'react';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { useFloatingCall } from '../context/FloatingCallContext';
import { FloatingCallOverlay } from './FloatingCallOverlay';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

export function FloatingCallManager() {
  const navigation = useNavigation<NavProp>();
  const { floatingCall, maximizeCall, endFloatingCall } = useFloatingCall();

  if (!floatingCall) return null;

  const handleMaximize = () => {
    const call = maximizeCall();
    if (!call) return;

    // Navigate back to the call screen
    if (call.isVideo) {
      navigation.navigate('VideoCall', {
        callId: call.callId,
        isOutgoing: call.isOutgoing,
        otherParty: call.otherParty,
      });
    } else {
      navigation.navigate('AudioCall', {
        callId: call.callId,
        isOutgoing: call.isOutgoing,
        otherParty: call.otherParty,
      });
    }
  };

  const handleEndCall = async () => {
    try {
      // End call in Firestore
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('calls').doc(floatingCall.callId).update({
        status: 'ended',
        endedAt: new Date(),
      });
      endFloatingCall();
    } catch (error) {
      console.error('[FloatingCallManager] Failed to end call:', error);
      // Still remove the floating call even if Firestore update fails
      endFloatingCall();
    }
  };

  return (
    <FloatingCallOverlay
      displayName={floatingCall.displayName}
      avatar={floatingCall.avatar}
      color={floatingCall.color}
      duration={floatingCall.duration}
      isVideo={floatingCall.isVideo}
      localStream={floatingCall.localStream}
      remoteStream={floatingCall.remoteStream}
      localIsMain={floatingCall.localIsMain}
      onMaximize={handleMaximize}
      onEndCall={handleEndCall}
    />
  );
}
