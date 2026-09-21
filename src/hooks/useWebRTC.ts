// ─── Hook: WebRTC ────────────────────────────────────────────────────────────
// Manages WebRTC peer connections, streams, and ICE candidates

import { useState, useRef, useCallback, useEffect } from 'react';
import { Platform } from 'react-native';
import {
  getRTCPeerConnection,
  getRTCSessionDescription,
  getRTCIceCandidate,
  getMediaDevices,
  MediaStream,
} from '../utils/webrtc-platform';

// Public STUN servers (Google)
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

export interface WebRTCHandlers {
  onLocalStream?: (stream: MediaStream) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onIceCandidate?: (candidate: RTCIceCandidateInit) => void;
  onConnectionStateChange?: (state: string) => void;
  onNetworkQualityChange?: (quality: NetworkQuality) => void;
}

export type NetworkQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

export function useWebRTC(handlers?: WebRTCHandlers) {
  // Use refs for stream storage to persist across parent hook re-renders
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  
  // State trigger for UI updates when streams change
  const [streamVersion, setStreamVersion] = useState(0);
  
  const [connectionState, setConnectionState] = useState<string>('new');
  const [networkQuality, setNetworkQuality] = useState<NetworkQuality>('unknown');
  
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Initialize peer connection ────────────────────────────────────────────
  const initializePeerConnection = useCallback(async (isVideo: boolean = false) => {
    try {
      console.log('[useWebRTC] Initializing peer connection... Video:', isVideo);
      
      // Create peer connection
      const pc = new (getRTCPeerConnection())(ICE_SERVERS);
      peerConnectionRef.current = pc;

      // Get local stream (audio + video if requested)
      const stream = await getMediaDevices().getUserMedia({
        audio: true,
        video: isVideo ? {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          facingMode: 'user',
        } : false,
      });
      
      console.log('[useWebRTC] Local stream obtained');
      handlers?.onLocalStream?.(stream);

      // Add local stream tracks to peer connection
      stream.getTracks().forEach((track:any) => {
        pc.addTrack(track, stream);
        console.log('[useWebRTC] Added track:', track.kind);
      });

      // Assign local stream to ref and trigger UI update
      localStreamRef.current = stream;
      setStreamVersion(v => v + 1);

      const pcAny = pc as any;

      // Handle remote stream
      pcAny.ontrack = (event: any) => {
        console.log('[useWebRTC] Remote track received:', event.track.kind);
        if (event.streams && event.streams[0]) {
          // Assign remote stream to ref and trigger UI update
          remoteStreamRef.current = event.streams[0];
          setStreamVersion(v => v + 1);
          handlers?.onRemoteStream?.(event.streams[0]);
        }
      };

      // Handle ICE candidates
      pcAny.onicecandidate = (event: any) => {
        if (event.candidate) {
          console.log('[useWebRTC] ICE candidate generated');
          // Convert candidate to plain object (toJSON might not exist)
          const candidateInit: RTCIceCandidateInit = {
            candidate: event.candidate.candidate,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sdpMid: event.candidate.sdpMid,
          };
          handlers?.onIceCandidate?.(candidateInit);
        }
      };

      // Handle connection state changes
      pcAny.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log('[useWebRTC] Connection state:', state);
        setConnectionState(state);
        handlers?.onConnectionStateChange?.(state);
      };

      // Handle ICE connection state
      pcAny.oniceconnectionstatechange = () => {
        console.log('[useWebRTC] ICE connection state:', pc.iceConnectionState);
      };

      console.log('[useWebRTC] Peer connection initialized');
      return pc;
    } catch (error) {
      console.error('[useWebRTC] Failed to initialize:', error);
      throw error;
    }
  }, [handlers]);

  // ── Create offer ───────────────────────────────────────────────────────────
  const createOffer = useCallback(async (isVideo: boolean = false): Promise<RTCSessionDescriptionInit> => {
    try {
      const pc = peerConnectionRef.current;
      if (!pc) throw new Error('Peer connection not initialized');

      console.log('[useWebRTC] Creating offer... Video:', isVideo);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: isVideo,
      });

      await pc.setLocalDescription(offer);
      console.log('[useWebRTC] Offer created and set as local description');
      
      // Return the offer as a plain object
      return {
        type: offer.type!,
        sdp: offer.sdp!,
      } as RTCSessionDescriptionInit;
    } catch (error) {
      console.error('[useWebRTC] Failed to create offer:', error);
      throw error;
    }
  }, []);

  // ── Create answer ──────────────────────────────────────────────────────────
  const createAnswer = useCallback(
    async (offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> => {
      try {
        const pc = peerConnectionRef.current;
        if (!pc) throw new Error('Peer connection not initialized');

        console.log('[useWebRTC] Setting remote description (offer)...');
        await pc.setRemoteDescription(new (getRTCSessionDescription())(offer as any));

        console.log('[useWebRTC] Creating answer...');
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        console.log('[useWebRTC] Answer created and set as local description');
        
        // Return the answer as a plain object
        return {
          type: answer.type!,
          sdp: answer.sdp!,
        } as RTCSessionDescriptionInit;
      } catch (error) {
        console.error('[useWebRTC] Failed to create answer:', error);
        throw error;
      }
    },
    []
  );

  // ── Set remote answer ──────────────────────────────────────────────────────
  const setRemoteAnswer = useCallback(
    async (answer: RTCSessionDescriptionInit): Promise<void> => {
      try {
        const pc = peerConnectionRef.current;
        if (!pc) throw new Error('Peer connection not initialized');

        // Check if we can set remote description
        if (pc.signalingState !== 'have-local-offer') {
          console.warn('[useWebRTC] Cannot set remote answer. Current state:', pc.signalingState);
          throw new Error(`Cannot set remote answer in state: ${pc.signalingState}`);
        }

        console.log('[useWebRTC] Setting remote description (answer)...');
        await pc.setRemoteDescription(new (getRTCSessionDescription())(answer as any));
        console.log('[useWebRTC] Remote answer set successfully');
      } catch (error) {
        console.error('[useWebRTC] Failed to set remote answer:', error);
        throw error;
      }
    },
    []
  );

  // ── Add ICE candidate ──────────────────────────────────────────────────────
  const addIceCandidate = useCallback(
    async (candidate: RTCIceCandidateInit): Promise<void> => {
      try {
        const pc = peerConnectionRef.current;
        if (!pc) {
          console.warn('[useWebRTC] Cannot add ICE candidate: peer connection not initialized');
          return;
        }

        // Check if remote description is set
        if (!pc.remoteDescription) {
          console.warn('[useWebRTC] Remote description not set yet, queuing ICE candidate');
          // In production, you might want to queue these candidates
          return;
        }

        await pc.addIceCandidate(new (getRTCIceCandidate())(candidate));
        console.log('[useWebRTC] ICE candidate added');
      } catch (error) {
        console.error('[useWebRTC] Failed to add ICE candidate:', error);
      }
    },
    []
  );

  // ── Toggle mute ────────────────────────────────────────────────────────────
  const toggleMute = useCallback((muted: boolean) => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = !muted;
      });
      console.log('[useWebRTC] Microphone muted:', muted);
    }
  }, []);

  // ── Toggle video ───────────────────────────────────────────────────────────
  const toggleVideo = useCallback((enabled: boolean) => {
    if (localStreamRef.current) {
      localStreamRef.current.getVideoTracks().forEach((track) => {
        track.enabled = enabled;
      });
      console.log('[useWebRTC] Camera enabled:', enabled);
    }
  }, []);

  // ── Switch camera (front/back) ─────────────────────────────────────────────
  const switchCamera = useCallback(async (facingMode: 'user' | 'environment') => {
    try {
      const pc = peerConnectionRef.current;
      if (!pc || !localStreamRef.current) {
        console.warn('[useWebRTC] Cannot switch camera: not initialized');
        return;
      }

      console.log('[useWebRTC] Switching camera to:', facingMode);

      // Get current video track
      const oldVideoTrack = localStreamRef.current.getVideoTracks()[0];
      if (!oldVideoTrack) {
        console.warn('[useWebRTC] No video track to switch');
        return;
      }

      // Store old track settings before replacement
      const wasEnabled = oldVideoTrack.enabled;

      // Get new video stream with different facing mode
      const newStream = await getMediaDevices().getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
          facingMode,
        },
      });

      const newVideoTrack = newStream.getVideoTracks()[0];
      
      // Preserve enabled state from old track
      newVideoTrack.enabled = wasEnabled;
      
      // Find video sender in peer connection
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        // Replace track in peer connection (this sends to remote peer)
        await sender.replaceTrack(newVideoTrack);
        console.log('[useWebRTC] Video track replaced in peer connection');
      }

      // Update local stream reference
      localStreamRef.current.removeTrack(oldVideoTrack);
      localStreamRef.current.addTrack(newVideoTrack);

      // Stop old track AFTER everything is set up
      oldVideoTrack.stop();

      // Single UI update at the end
      setStreamVersion(v => v + 1);
      
      console.log('[useWebRTC] Camera switched successfully');
    } catch (error) {
      console.error('[useWebRTC] Failed to switch camera:', error);
      throw error; // Re-throw to let the caller handle it
    }
  }, []);

  // ── Monitor network quality ────────────────────────────────────────────────
  const startNetworkMonitoring = useCallback(() => {
    if (!peerConnectionRef.current) return;

    // Clear existing interval
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
    }

    // Check connection stats every 2 seconds
    statsIntervalRef.current = setInterval(async () => {
      const pc = peerConnectionRef.current;
      if (!pc || pc.connectionState !== 'connected') return;

      try {
        const stats = await pc.getStats();
        let packetsLost = 0;
        let packetsReceived = 0;
        let jitter = 0;
        let rtt = 0;

        stats.forEach((report: any) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            packetsLost = report.packetsLost || 0;
            packetsReceived = report.packetsReceived || 0;
            jitter = report.jitter || 0;
          }
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rtt = report.currentRoundTripTime || 0;
          }
        });

        // Calculate quality based on metrics
        const quality = calculateNetworkQuality(packetsLost, packetsReceived, jitter, rtt);
        
        if (quality !== networkQuality) {
          setNetworkQuality(quality);
          handlers?.onNetworkQualityChange?.(quality);
          console.log('[useWebRTC] Network quality:', quality, {
            packetsLost,
            packetsReceived,
            jitter: jitter.toFixed(3),
            rtt: rtt.toFixed(3),
          });
        }
      } catch (error) {
        console.error('[useWebRTC] Failed to get stats:', error);
      }
    }, 2000);

    console.log('[useWebRTC] Network monitoring started');
  }, [networkQuality, handlers]);

  const stopNetworkMonitoring = useCallback(() => {
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
      console.log('[useWebRTC] Network monitoring stopped');
    }
  }, []);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    console.log('[useWebRTC] Cleaning up...');

    // Stop network monitoring first
    if (statsIntervalRef.current) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
      console.log('[useWebRTC] Network monitoring stopped');
    }

    // Stop and remove local stream tracks immediately
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        track.stop();
        console.log('[useWebRTC] Stopped local track:', track.kind);
      });
      localStreamRef.current = null;
      setStreamVersion(v => v + 1);
    }

    // Remove remote stream immediately
    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach((track) => {
        track.stop();
        console.log('[useWebRTC] Stopped remote track:', track.kind);
      });
      remoteStreamRef.current = null;
      setStreamVersion(v => v + 1);
    }

    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
      console.log('[useWebRTC] Peer connection closed');
    }

    setConnectionState('closed');
    setNetworkQuality('unknown');
  }, []); // No dependencies needed as we use refs

  // Cleanup on unmount only
  useEffect(() => {
    return () => {
      console.log('[useWebRTC] Component unmounting, cleaning up...');
      
      // Stop network monitoring
      if (statsIntervalRef.current) {
        clearInterval(statsIntervalRef.current);
        statsIntervalRef.current = null;
      }

      // Stop local stream
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          track.stop();
        });
      }

      // Close peer connection
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
    };
  }, []); // Empty deps - only run on unmount

  return {
    localStream: localStreamRef.current,
    remoteStream: remoteStreamRef.current,
    streamVersion,
    connectionState,
    networkQuality,
    initializePeerConnection,
    createOffer,
    createAnswer,
    setRemoteAnswer,
    addIceCandidate,
    toggleMute,
    toggleVideo,
    switchCamera,
    startNetworkMonitoring,
    stopNetworkMonitoring,
    cleanup,
    /** Returns the live RTCPeerConnection instance (used for screen-share sender replacement). */
    getPeerConnection: () => peerConnectionRef.current,
  };
}

// ── Helper: Calculate network quality ──────────────────────────────────────
function calculateNetworkQuality(
  packetsLost: number,
  packetsReceived: number,
  jitter: number,
  rtt: number
): NetworkQuality {
  // Calculate packet loss percentage
  const totalPackets = packetsLost + packetsReceived;
  const lossPercentage = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;

  // Quality thresholds
  // Excellent: < 1% loss, < 0.03s jitter, < 100ms RTT
  // Good: < 3% loss, < 0.05s jitter, < 200ms RTT
  // Fair: < 5% loss, < 0.1s jitter, < 300ms RTT
  // Poor: >= 5% loss or >= 0.1s jitter or >= 300ms RTT

  if (lossPercentage >= 5 || jitter >= 0.1 || rtt >= 0.3) {
    return 'poor';
  } else if (lossPercentage >= 3 || jitter >= 0.05 || rtt >= 0.2) {
    return 'fair';
  } else if (lossPercentage >= 1 || jitter >= 0.03 || rtt >= 0.1) {
    return 'good';
  } else {
    return 'excellent';
  }
}
