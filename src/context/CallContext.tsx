// ─── Context: Call ───────────────────────────────────────────────────────────
// Global call state management for WebRTC calls

import React, { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';
import type { CallState, IncomingCallData, CallStatus } from '../types/call';
import { useWebRTC, type NetworkQuality, type WebRTCHandlers } from '../hooks/useWebRTC';
import type { MediaStream } from '../utils/webrtc-platform';
import { SignalingService } from '../services/signalingService';

interface CallContextValue extends CallState {
  // Call state setters
  setActiveCallId: (callId: string | null) => void;
  setIncomingCall: (call: IncomingCallData | null) => void;
  setCallStatus: (status: CallStatus | null) => void;
  setMuted: (muted: boolean) => void;
  setSpeakerOn: (speakerOn: boolean) => void;
  setCallDuration: (duration: number) => void;
  incrementCallDuration: () => void;
  resetCallState: () => void;
  setIsCaller: (isCaller: boolean) => void;

  // WebRTC instance properties
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  streamVersion: number;
  connectionState: string;
  networkQuality: NetworkQuality;

  // WebRTC instance methods
  initializePeerConnection: (isVideo: boolean) => Promise<import('../utils/webrtc-platform').RTCPeerConnectionType>;
  createOffer: (isVideo: boolean) => Promise<RTCSessionDescriptionInit>;
  createAnswer: (offer: RTCSessionDescriptionInit) => Promise<RTCSessionDescriptionInit>;
  setRemoteAnswer: (answer: RTCSessionDescriptionInit) => Promise<void>;
  addIceCandidate: (candidate: RTCIceCandidateInit) => Promise<void>;
  toggleMute: (muted: boolean) => void;
  toggleVideo: (enabled: boolean) => void;
  switchCamera: (facingMode: 'user' | 'environment') => Promise<void>;
  startNetworkMonitoring: () => void;
  stopNetworkMonitoring: () => void;
  cleanup: () => void;
  getPeerConnection: () => import('../utils/webrtc-platform').RTCPeerConnectionType | null;
}

const CallContext = createContext<CallContextValue | undefined>(undefined);

const INITIAL_STATE: CallState = {
  activeCallId: null,
  incomingCall: null,
  callStatus: null,
  isMuted: false,
  isSpeakerOn: false,
  callDuration: 0,
};

export function CallProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CallState>(INITIAL_STATE);
  
  // Track active call ID for WebRTC handlers
  const activeCallIdRef = useRef<string | null>(null);
  const isCallerRef = useRef<boolean>(false);

  // WebRTC handlers
  const handlersRef = useRef<WebRTCHandlers>({
    onIceCandidate: (candidate) => {
      const callId = activeCallIdRef.current;
      if (!callId) return;

      console.log('[CallContext] ICE candidate generated, sending via signaling');
      SignalingService.addIceCandidate(callId, candidate, isCallerRef.current === false);
    },

    onConnectionStateChange: (connectionState) => {
      console.log('[CallContext] Connection state changed:', connectionState);
      
      if (connectionState === 'connected') {
        setState((prev) => ({ ...prev, callStatus: 'connected' }));
      } else if (connectionState === 'failed' || connectionState === 'closed') {
        setState((prev) => ({ ...prev, callStatus: 'ended' }));
      }
    },

    onNetworkQualityChange: (quality) => {
      console.log('[CallContext] Network quality changed:', quality);
    },
  });

  // Create shared WebRTC instance
  const webrtc = useWebRTC(handlersRef.current);

  const setActiveCallId = useCallback((callId: string | null) => {
    setState((prev) => ({ ...prev, activeCallId: callId }));
    activeCallIdRef.current = callId;
  }, []);

  const setIncomingCall = useCallback((call: IncomingCallData | null) => {
    setState((prev) => ({ ...prev, incomingCall: call }));
  }, []);

  const setCallStatus = useCallback((status: CallStatus | null) => {
    setState((prev) => ({ ...prev, callStatus: status }));
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    setState((prev) => ({ ...prev, isMuted: muted }));
  }, []);

  const setSpeakerOn = useCallback((speakerOn: boolean) => {
    setState((prev) => ({ ...prev, isSpeakerOn: speakerOn }));
  }, []);

  const setCallDuration = useCallback((duration: number) => {
    setState((prev) => ({ ...prev, callDuration: duration }));
  }, []);

  const incrementCallDuration = useCallback(() => {
    setState((prev) => ({ ...prev, callDuration: prev.callDuration + 1 }));
  }, []);

  const resetCallState = useCallback(() => {
    console.log('[CallContext] Resetting call state');
    setState({
      activeCallId: null,
      incomingCall: null,
      callStatus: null,
      isMuted: false,
      isSpeakerOn: false,
      callDuration: 0,
    });
    isCallerRef.current = false;
  }, []);

  const setIsCaller = useCallback((isCaller: boolean) => {
    isCallerRef.current = isCaller;
  }, []);

  const value: CallContextValue = {
    ...state,
    setActiveCallId,
    setIncomingCall,
    setCallStatus,
    setMuted,
    setSpeakerOn,
    setCallDuration,
    incrementCallDuration,
    resetCallState,
    setIsCaller,

    // WebRTC instance properties
    localStream: webrtc.localStream,
    remoteStream: webrtc.remoteStream,
    streamVersion: webrtc.streamVersion,
    connectionState: webrtc.connectionState,
    networkQuality: webrtc.networkQuality,

    // WebRTC instance methods
    initializePeerConnection: webrtc.initializePeerConnection,
    createOffer: webrtc.createOffer,
    createAnswer: webrtc.createAnswer,
    setRemoteAnswer: webrtc.setRemoteAnswer,
    addIceCandidate: webrtc.addIceCandidate,
    toggleMute: webrtc.toggleMute,
    toggleVideo: webrtc.toggleVideo,
    switchCamera: webrtc.switchCamera,
    startNetworkMonitoring: webrtc.startNetworkMonitoring,
    stopNetworkMonitoring: webrtc.stopNetworkMonitoring,
    cleanup: webrtc.cleanup,
    getPeerConnection: webrtc.getPeerConnection,
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCallContext() {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCallContext must be used within CallProvider');
  }
  return context;
}
