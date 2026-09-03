// ─── Screen: Video Call ──────────────────────────────────────────────────────
// Layout:
//   • Full-screen main view (remote or local camera)
//   • PiP tiles stacked top-right — tap avatar to swap to main
//   • Vertical icon list right side (below PiPs):
//       camera-reverse  → flip camera (only active when local is main)
//       chatbubble      → open chat
//       person-add      → add participant
//   • Bottom bar: mute | speaker | audio-only | end
//   • No flip icon anywhere else — single source of truth
//   • Works identically on mobile + web
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, TouchableOpacity, StyleSheet, Dimensions,
  Platform, Modal, ScrollView, Pressable, Animated, ActivityIndicator, BackHandler,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallContext } from '../context/CallContext';
import { useOutgoingCall } from '../hooks/useOutgoingCall';
import { useIncomingCallAnswer } from '../hooks/useIncomingCallAnswer';
import { useAuth } from '../hooks/useAuth';
import { useFloatingCall } from '../context/FloatingCallContext';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { getOrCreateDirectChat } from '../hooks/useChatActions';

let CameraView: any = null;
let useCameraPermissions: (() => [any, () => Promise<any>]) | null = null;
let RTCView: any = null;
try {
  const cam = require('expo-camera');
  CameraView = cam.CameraView;
  useCameraPermissions = cam.useCameraPermissions;
  // Try to load RTCView for native remote/local stream rendering
  try {
    const rtc = require('@livekit/react-native-webrtc');
    RTCView = rtc.RTCView;
  } catch {
    // Use MediaStream/<video> if RTCView not available (e.g. on web)
    RTCView = null;
  }
} catch { /* Expo Go */ }

function useCameraPerms(): [any, () => Promise<any>] {
  if (useCameraPermissions) return useCameraPermissions(); // eslint-disable-line react-hooks/rules-of-hooks
  return [null, async () => ({ granted: false })];
}

import { AppText, AppIcon, AppBg, useGlass } from '../context/ThemeContext';
import { Avatar } from '../components';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList, Contact } from '../types';
import { CONTACTS } from '../data/mockData';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'VideoCall'>;
type RouteP  = RouteProp<RootStackParamList, 'VideoCall'>;

const { height } = Dimensions.get('window');
const PIP_W = 100;
const PIP_H = 140;

interface Participant { id: string; contact: Contact; isLocal: boolean; }

const LOCAL_CONTACT: Contact = {
  id: -1, name: 'You', avatar: 'ME', color: COLORS.blue,
  status: 'online', lastMsg: '', time: '', unread: 0,
};

function CameraTile({ facing }: { facing: 'front' | 'back' }) {
  if (!CameraView) return <View style={[StyleSheet.absoluteFill, { backgroundColor: '#1a1a2e' }]} />;
  return <CameraView style={StyleSheet.absoluteFill} facing={facing} />;
}

// ─── Live stream tile ─────────────────────────────────────────────────────────
// Renders an actual MediaStream (local or remote) once available.
// • Native: RTCView from react-native-webrtc
// • Web: plain <video> element bound to the MediaStream via a ref callback
// Falls back to `fallback` (camera preview or avatar) while the stream isn't ready.
const StreamTile = React.memo(({
  stream, mirror, muted, fallback,
}: {
  stream: any; mirror?: boolean; muted?: boolean; fallback: React.ReactNode;
}) => {
  if (!stream) return <>{fallback}</>;

  if (Platform.OS === 'web') {
    // react-native-web supports plain HTML host elements via createElement.
    return React.createElement('video', {
      key: stream.id, // Force remount when stream changes
      ref: (el: HTMLVideoElement | null) => {
        if (el && el.srcObject !== stream) {
          el.srcObject = stream;
          // Force play after setting srcObject
          el.play().catch(err => console.log('[StreamTile] Play failed:', err));
        }
      },
      autoPlay: true,
      playsInline: true,
      muted: !!muted,
      style: {
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        width: '100%', height: '100%', objectFit: 'cover',
        transform: mirror ? 'scaleX(-1)' : undefined,
      },
    });
  }

  if (RTCView) {
    return (
      <RTCView
        key={stream.id} // Force remount when stream changes
        streamURL={stream.toURL()}
        style={StyleSheet.absoluteFill}
        objectFit="cover"
        mirror={!!mirror}
      />
    );
  }

  // No RTCView available on native (e.g. Expo Go) — show fallback instead.
  return <>{fallback}</>;
});

// ─── PiP tile — tap the avatar/profile to swap to main ───────────────────────
const PipTile = React.memo(({
  participant: p, facing, canShowCamera, onTap, localStream, remoteStream,
}: {
  participant: Participant; facing: 'front' | 'back';
  canShowCamera: boolean; onTap: () => void;
  localStream: any; remoteStream: any;
}) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handleTap = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.88, duration: 80, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1,    duration: 80, useNativeDriver: true }),
    ]).start(onTap);
  };

  return (
    <Animated.View style={[styles.pipTile, { transform: [{ scale: scaleAnim }] }]}>
      {/* Live camera feed (local) or live remote feed, with fallback */}
      {p.isLocal ? (
        <StreamTile
          stream={localStream}
          mirror={facing === 'front'}
          muted
          fallback={canShowCamera
            ? <CameraTile facing={facing} />
            : <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.55)' }]} />}
        />
      ) : (
        <StreamTile
          stream={remoteStream}
          fallback={<View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.55)' }]} />}
        />
      )}

      {/* Full-tile touchable — tap to become main */}
      <TouchableOpacity style={styles.pipTouch} onPress={handleTap} activeOpacity={0.8}>
        {/* Remote: show avatar centred only while no stream yet */}
        {!p.isLocal && !remoteStream && (
          <View style={styles.pipAvatarWrap}>
            <Avatar initials={p.contact.avatar} color={p.contact.color} size={42} />
            <AppText fixedColor style={styles.pipNamePill} numberOfLines={1}>
              {p.contact.name}
            </AppText>
          </View>
        )}
      </TouchableOpacity>
      {/* "You" label at bottom for local tile */}
      {p.isLocal && <AppText fixedColor style={styles.pipNameBar}>You</AppText>}
    </Animated.View>
  );
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function VideoCallScreen() {
  const navigation  = useNavigation<NavProp>();
  const route       = useRoute<RouteP>();
  const { callId, isOutgoing, otherParty } = route.params;
  const { user } = useAuth();
  const { minimizeCall, updateDuration } = useFloatingCall();
  const { bevel } = useGlass();

  const [permission, requestPermission] = useCameraPerms();
  const [muted,      setMuted]          = useState(false);
  const [speakerOn,  setSpeakerOn]      = useState(true);
  const [facing,     setFacing]         = useState<'front' | 'back'>('front');
  const [duration,   setDuration]       = useState(0);
  const [addOpen,    setAddOpen]        = useState(false);
  const [callStatus, setCallStatus]     = useState<string>('connecting');
  const [showQuality, setShowQuality]   = useState(false);
  const [switchingCamera, setSwitchingCamera] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [showCameraToggle, setShowCameraToggle] = useState(false);

  // Shared WebRTC instance — sourced from CallContext (single instance across all components)
  const {
    localStream,
    remoteStream,
    connectionState,
    networkQuality,
    initializePeerConnection,
    createOffer,
    createAnswer,
    setRemoteAnswer,
    addIceCandidate,
    toggleMute: toggleMuteWebRTC,
    toggleVideo,
    switchCamera: switchCameraWebRTC,
    startNetworkMonitoring,
    cleanup: cleanupWebRTC,
  } = useCallContext();

  // Outgoing call hook (if this is the caller)
  const { initiateCall: initiateOutgoingCall } = useOutgoingCall();

  // Incoming call answer hook (if this is the receiver)
  const { answerCall } = useIncomingCallAnswer();

  // Sync connection state → local callStatus
  useEffect(() => {
    if (connectionState === 'connected') {
      setCallStatus('connected');
    } else if (connectionState === 'disconnected' || connectionState === 'failed') {
      setCallStatus('disconnected');
    }
  }, [connectionState]);

  // Sync network quality → quality notification
  useEffect(() => {
    if (networkQuality === 'poor' || networkQuality === 'fair') {
      setShowQuality(true);
      const t = setTimeout(() => setShowQuality(false), 3000);
      return () => clearTimeout(t);
    }
  }, [networkQuality]);

  // Build initial participant list:
  // • Other party + local "You"
  const otherContact: Contact = {
    id: parseInt(otherParty.userId) || -2,
    name: otherParty.displayName,
    avatar: otherParty.displayName.split(' ').map((n) => n[0]).join('').toUpperCase(),
    color: COLORS.blue,
    status: 'online',
    lastMsg: '',
    time: '',
    unread: 0,
  };

  const [participants, setParticipants] = useState<Participant[]>([
    { id: `remote-${otherParty.userId}`, contact: otherContact, isLocal: false },
    { id: 'local', contact: LOCAL_CONTACT, isLocal: true },
  ]);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubscribeCallRef = useRef<(() => void) | null>(null);
  // Mirrors `remoteStream` without being captured stale inside the one-shot
  // useEffect below — onSnapshot fires repeatedly (e.g. when ICE candidates
  // are appended), so the closure must read live state, not state frozen
  // at effect-setup time.
  const remoteStreamRef = useRef<any>(null);
  useEffect(() => { remoteStreamRef.current = remoteStream; }, [remoteStream]);

  // Initialize WebRTC and call setup
  useEffect(() => {
    const setupCall = async () => {
      try {
        // Load stored duration from Firestore if continuing call
        const fsDb = db as ReturnType<typeof firestore>;
        const callRef = fsDb.collection('calls').doc(callId);
        const callSnapshot = await callRef.get();
        const callData = callSnapshot.data();
        
        // Set duration from stored value if exists
        if (callData?.lastDuration) {
          setDuration(callData.lastDuration);
        } else if (callData?.startedAt) {
          const startTime = callData.startedAt.toDate().getTime();
          const currentTime = Date.now();
          const elapsedSeconds = Math.floor((currentTime - startTime) / 1000);
          setDuration(elapsedSeconds);
        }

        // Restore participant order if returning from minimized state
        if (callData?.localIsMain === true) {
          // Local is main - swap participants
          setParticipants([
            { id: 'local', contact: LOCAL_CONTACT, isLocal: true },
            { id: `remote-${otherParty.userId}`, contact: otherContact, isLocal: false },
          ]);
        }

        if (Platform.OS !== 'web' && !permission?.granted) {
          await requestPermission();
        }

        // Initialize WebRTC peer connection
        await initializePeerConnection(true); // true for video call

        if (isOutgoing) {
          // Caller: Create offer and send to Firestore
          console.log('[VideoCall] Creating offer as caller...');
          const offer = await createOffer(true);

          // Update call document with offer
          await callRef.update({
            offer: offer,
            status: 'ringing',
          });

          // Listen for answer from callee
          unsubscribeCallRef.current = callRef.onSnapshot((snapshot) => {
            const data = snapshot.data();
            if (data?.answer && !remoteStreamRef.current) {
              console.log('[VideoCall] Received answer, setting remote description...');
              setRemoteAnswer(data.answer).catch(console.error);
            }
            if (data?.iceCandidates) {
              // Caller wants ICE candidates contributed by the callee.
              data.iceCandidates.forEach((candidate: any) => {
                if (candidate.from !== otherParty.userId) return;
                addIceCandidate(candidate).catch(console.error);
              });
            }
            // Check for video upgrade request from other user
            if (data?.videoUpgradeRequest && data.videoUpgradeRequest.requestedBy !== user?.uid) {
              console.log('[VideoCall] Video upgrade requested by other user');
              setShowCameraToggle(true);
            }
            if (data?.status === 'ended') {
              navigation.goBack();
            }
          });
        } else {
          // Callee: Listen for offer and create answer
          console.log('[VideoCall] Waiting for offer as callee...');

          unsubscribeCallRef.current = callRef.onSnapshot(async (snapshot) => {
            const data = snapshot.data();
            if (data?.offer && !remoteStreamRef.current) {
              console.log('[VideoCall] Received offer, creating answer...');
              const answer = await createAnswer(data.offer);

              // Update call document with answer
              await callRef.update({
                answer: answer,
                status: 'active',
              });
            }
            if (data?.iceCandidates) {
              // Callee wants ICE candidates contributed by the caller.
              data.iceCandidates.forEach((candidate: any) => {
                if (candidate.from !== otherParty.userId) return;
                addIceCandidate(candidate).catch(console.error);
              });
            }
            // Check for video upgrade request from other user
            if (data?.videoUpgradeRequest && data.videoUpgradeRequest.requestedBy !== user?.uid) {
              console.log('[VideoCall] Video upgrade requested by other user');
              setShowCameraToggle(true);
            }
            if (data?.status === 'ended') {
              navigation.goBack();
            }
          });
        }

        // Start call timer
        timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
      } catch (error) {
        console.error('[VideoCall] Setup failed:', error);
        setCallStatus('failed');
        cleanupWebRTC();
      }
    };

    setupCall();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (unsubscribeCallRef.current) unsubscribeCallRef.current();
      cleanupWebRTC();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Start network monitoring when connection is established
  useEffect(() => {
    if (connectionState === 'connected') {
      console.log('[VideoCall] Starting network monitoring...');
      startNetworkMonitoring();
    }
  }, [connectionState, startNetworkMonitoring]);

  // Handle Android back button - minimize call instead of ending it
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      // Compute localIsMain from current participants state
      const isLocalMain = participants[0]?.isLocal || false;
      
      // Save main/PiP state to Firestore before minimizing (don't await)
      const fsDbMinimize = db as ReturnType<typeof firestore>;
      const callRefMinimize = fsDbMinimize.collection('calls').doc(callId);
      callRefMinimize.update({
        localIsMain: isLocalMain,
      }).catch((err: any) => console.warn('[VideoCall] Failed to save localIsMain:', err));
      
      // Minimize the call
      minimizeCall({
        callId,
        displayName: otherParty.displayName,
        avatar: otherParty.displayName.split(' ').map((n) => n[0]).join('').toUpperCase(),
        color: COLORS.blue,
        duration: fmt(duration),
        isVideo: true,
        isOutgoing,
        localStream,
        remoteStream,
        localIsMain: isLocalMain,
        otherParty,
      });
      
      // Navigate back without ending call
      navigation.goBack();
      return true; // Prevent default back behavior
    });

    return () => backHandler.remove();
  }, [duration, callId, isOutgoing, otherParty, participants, minimizeCall, navigation]); // Removed streams from deps

  // Update floating call duration while minimized (throttled)
  useEffect(() => {
    // Only update every second, and use a ref to prevent unnecessary updates
    const durationStr = fmt(duration);
    updateDuration(durationStr);
  }, [duration]); // Remove updateDuration from deps to prevent recreation

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const swapToMain = useCallback((id: string) => {
    setParticipants((prev) => {
      const idx = prev.findIndex((p) => p.id === id);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[0], next[idx]] = [next[idx], next[0]];
      return next;
    });
  }, []);

  const flipCamera = useCallback(async () => {
    if (switchingCamera) {
      console.log('[VideoCall] Camera switch already in progress, ignoring');
      return; // Prevent multiple simultaneous switches
    }
    
    try {
      console.log('[VideoCall] Starting camera flip...');
      setSwitchingCamera(true);
      
      const newFacing = facing === 'front' ? 'back' : 'front';
      const facingMode = newFacing === 'front' ? 'user' : 'environment';
      
      console.log('[VideoCall] Switching to:', newFacing, facingMode);
      
      // Switch the WebRTC camera
      await switchCameraWebRTC(facingMode);
      
      // Only update state after successful switch
      setFacing(newFacing);
      
      console.log('[VideoCall] Camera flip successful');
    } catch (error) {
      console.error('[VideoCall] Failed to flip camera:', error);
      // Don't change facing state on error - keep current camera
    } finally {
      // Always clear the switching flag
      setSwitchingCamera(false);
    }
  }, [facing, switchingCamera, switchCameraWebRTC]);

  const handleCameraToggle = () => {
    const newEnabled = !cameraEnabled;
    setCameraEnabled(newEnabled);
    toggleVideo(newEnabled);
    if (!newEnabled) {
      setShowCameraToggle(false); // Hide toggle once user makes choice
    }
  };

  const addParticipant = (c: Contact) => {
    if (participants.some((p) => p.contact.id === c.id)) return;
    setParticipants((prev) => [...prev, { id: `remote-${c.id}`, contact: c, isLocal: false }]);
    setAddOpen(false);
  };

  const mainP   = participants[0];
  const pipList = participants.slice(1);
  const localIsMain = mainP.isLocal; // Track if local camera is in main view

  const hangUp = async () => {
    try {
      // End call in Firestore
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('calls').doc(callId).update({
        status: 'ended',
        endedAt: new Date(),
      });
    } catch (error) {
      console.error('[VideoCall] Failed to update call status:', error);
    }

    cleanupWebRTC();
    navigation.goBack();
  };

  const handleMuteToggle = () => {
    const newMuted = !muted;
    setMuted(newMuted);
    toggleMuteWebRTC(newMuted);
  };

  const switchToAudio = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    
    // Save current duration to Firestore before switching
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('calls').doc(callId).update({
        lastDuration: duration,
      });
    } catch (error) {
      console.error('[VideoCall] Failed to save duration:', error);
    }
    
    cleanupWebRTC();
    navigation.replace('AudioCall', { callId, isOutgoing, otherParty });
  };

  const openChat = async () => {
    try {
      if (!user?.uid) {
        console.error('[VideoCall] Cannot open chat: user not authenticated');
        return;
      }
      
      // Get or create the actual chat ID for this conversation
      const actualChatId = await getOrCreateDirectChat(user.uid, otherParty.userId);
      
      // Navigate to chat with the actual chat ID
      navigation.navigate('Chat', {
        chatId: actualChatId,
        displayName: otherParty.displayName,
        isGroup: false,
        otherUserId: otherParty.userId,
        otherUserPhoto: otherParty.photoUrl,
      });
    } catch (error) {
      console.error('[VideoCall] Failed to open chat:', error);
    }
  };

  const availableContacts = CONTACTS.filter(
    (c) => !participants.some((p) => p.contact.id === c.id),
  );
  const canShowCamera  = Platform.OS === 'web' || !!permission?.granted;

  // Network quality indicator color
  const getQualityColor = () => {
    switch (networkQuality) {
      case 'excellent': return '#10b981';
      case 'good': return '#3b82f6';
      case 'fair': return '#f59e0b';
      case 'poor': return '#ef4444';
      default: return 'transparent';
    }
  };

  const getQualityText = () => {
    switch (networkQuality) {
      case 'excellent': return 'Excellent connection';
      case 'good': return 'Good connection';
      case 'fair': return 'Fair connection';
      case 'poor': return 'Poor connection';
      default: return 'Connecting...';
    }
  };

  return (
    <View style={styles.root}>
      <AppBg />
      <View style={styles.darkOverlay} />

      {/* ── Main view ── */}
      <View style={styles.mainView}>
        {mainP.isLocal ? (
          <StreamTile
            stream={localStream}
            mirror={facing === 'front'}
            muted
            fallback={canShowCamera
              ? <CameraTile facing={facing} />
              : <View style={[StyleSheet.absoluteFill, { backgroundColor: '#0a1a30' }]} />}
          />
        ) : (
          <StreamTile
            stream={remoteStream}
            fallback={<View style={[StyleSheet.absoluteFill, { backgroundColor: '#0a1a30' }]} />}
          />
        )}
        {/* Avatar overlay shown for the remote party only until their stream connects */}
        {!mainP.isLocal && !remoteStream && (
          <View style={styles.mainAvatarOverlay}>
            <Avatar initials={mainP.contact.avatar} color={mainP.contact.color} size={120} />
            <AppText fixedColor style={styles.mainName}>{mainP.contact.name}</AppText>
            <AppText fixedColor style={styles.mainSub}>In call · {fmt(duration)}</AppText>
          </View>
        )}
      </View>

      {/* ── Top bar (back only + timer) ── */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={hangUp} style={styles.backBtn}>
          <AppIcon name="chevron-back" size={26} color="rgba(255,255,255,0.80)" fixedColor />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <AppText fixedColor style={styles.topName}>{mainP.contact.name}</AppText>
          <AppText fixedColor style={styles.topStatus}>
            {fmt(duration)} · {participants.length} participant{participants.length !== 1 ? 's' : ''}
          </AppText>
        </View>

        {/* Network quality indicator */}
        {networkQuality !== 'unknown' && (
          <View style={[styles.qualityBadge, { backgroundColor: getQualityColor() }]}>
            <AppIcon
              name={networkQuality === 'excellent' || networkQuality === 'good' ? 'wifi' : 'wifi-outline'}
              size={14}
              color="#fff"
              fixedColor
            />
          </View>
        )}
      </View>

      {/* Network quality notification */}
      {showQuality && (networkQuality === 'poor' || networkQuality === 'fair') && (
        <View style={[styles.qualityAlert, { backgroundColor: getQualityColor() }]}>
          <AppIcon name="warning-outline" size={16} color="#fff" fixedColor />
          <AppText fixedColor style={styles.qualityText}>{getQualityText()}</AppText>
        </View>
      )}

      {/* Camera toggle notification for audio-to-video switch */}
      {showCameraToggle && (
        <View style={styles.cameraToggleAlert}>
          <View style={styles.cameraToggleContent}>
            <AppIcon name="videocam-outline" size={20} color="#fff" fixedColor />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <AppText fixedColor style={styles.cameraToggleTitle}>
                {otherParty.displayName} switched to video
              </AppText>
              <AppText fixedColor style={styles.cameraToggleSubtext}>
                Turn on your camera?
              </AppText>
            </View>
          </View>
          <View style={styles.cameraToggleButtons}>
            <TouchableOpacity 
              style={[styles.cameraToggleBtn, bevel]}
              onPress={() => {
                setCameraEnabled(false);
                toggleVideo(false);
                setShowCameraToggle(false);
              }}
            >
              <AppText fixedColor style={styles.cameraToggleBtnText}>Not now</AppText>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.cameraToggleBtn, styles.cameraToggleBtnPrimary]}
              onPress={() => {
                setCameraEnabled(true);
                toggleVideo(true);
                setShowCameraToggle(false);
              }}
            >
              <AppIcon name="videocam" size={16} color="#fff" fixedColor />
              <AppText fixedColor style={[styles.cameraToggleBtnText, { marginLeft: 6 }]}>
                Turn on
              </AppText>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Right-side vertical panel: PiPs then action icons ── */}
      <View style={styles.rightPanel}>

        {/* PiP tiles */}
        {pipList.map((p) => (
          <PipTile
            key={p.id}
            participant={p}
            facing={facing}
            canShowCamera={canShowCamera}
            onTap={() => swapToMain(p.id)}
            localStream={localStream}
            remoteStream={remoteStream}
          />
        ))}

        {/* Divider before action icons */}
        {pipList.length > 0 && <View style={styles.panelDivider} />}

        {/* Chat */}
        <TouchableOpacity style={styles.sideBtn} onPress={openChat} activeOpacity={0.75}>
          <AppIcon name="chatbubble-outline" size={20} color="#fff" fixedColor />
        </TouchableOpacity>

        {/* Add person */}
        <TouchableOpacity style={styles.sideBtn} onPress={() => setAddOpen(true)} activeOpacity={0.75}>
          <AppIcon name="person-add-outline" size={20} color="#fff" fixedColor />
        </TouchableOpacity>

        {/* Camera flip icon - always visible */}
        <TouchableOpacity
          style={[styles.sideBtn, styles.sideBtnActive, switchingCamera && styles.sideBtnDisabled]}
          onPress={flipCamera}
          activeOpacity={switchingCamera ? 1 : 0.75}
          disabled={switchingCamera}
        >
          {switchingCamera ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <AppIcon name="camera-reverse-outline" size={22} color="#fff" fixedColor />
          )}
        </TouchableOpacity>
      </View>

      {/* ── Bottom controls ── */}
      <View style={styles.controls}>
        <View style={styles.controlCol}>
          <TouchableOpacity style={[styles.controlBtn, muted && styles.controlBtnActive]}
            onPress={handleMuteToggle}>
            <AppIcon name={muted ? 'mic-off' : 'mic-outline'} size={24} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>{muted ? 'Unmute' : 'Mute'}</AppText>
        </View>

        <View style={styles.controlCol}>
          <TouchableOpacity style={[styles.controlBtn, speakerOn && styles.controlBtnActive]}
            onPress={() => setSpeakerOn((s) => !s)}>
            <AppIcon name={speakerOn ? 'volume-high-outline' : 'volume-mute-outline'} size={24} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>Speaker</AppText>
        </View>

        <View style={styles.controlCol}>
          <TouchableOpacity style={styles.controlBtn} onPress={switchToAudio}>
            <AppIcon name="call-outline" size={24} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>Audio only</AppText>
        </View>

        <View style={styles.controlCol}>
          <TouchableOpacity style={styles.hangUpBtn} onPress={hangUp}>
            <AppIcon name="call" size={28} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>End</AppText>
        </View>
      </View>

      {/* ── Add person modal ── */}
      <Modal visible={addOpen} transparent animationType="slide"
        onRequestClose={() => setAddOpen(false)}>
        <Pressable style={styles.addOverlay} onPress={() => setAddOpen(false)} />
        <View style={styles.addSheet}>
          <View style={styles.addHandle} />
          <AppText fixedColor style={styles.addTitle}>Add to call</AppText>
          {availableContacts.length === 0 ? (
            <AppText fixedColor style={styles.addEmpty}>All contacts are already in the call.</AppText>
          ) : (
            <ScrollView showsVerticalScrollIndicator={false}>
              {availableContacts.map((c) => (
                <TouchableOpacity key={c.id} style={styles.addContactRow}
                  onPress={() => addParticipant(c)} activeOpacity={0.8}>
                  <Avatar initials={c.avatar} color={c.color} size={46} status={c.status} />
                  <View style={styles.addContactMeta}>
                    <AppText fixedColor style={styles.addContactName}>{c.name}</AppText>
                    <AppText fixedColor style={styles.addContactSub}>
                      {c.status === 'online' ? 'Online' : 'Tap to add'}
                    </AppText>
                  </View>
                  <LinearGradient colors={GRADIENTS.primary} style={styles.addIconWrap}>
                    <AppIcon name="videocam-outline" size={18} color="#fff" fixedColor />
                  </LinearGradient>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#000' },
  darkOverlay: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.35)' },

  mainView:          { ...StyleSheet.absoluteFill },
  mainAvatarOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center', justifyContent: 'center', gap: 14,
  },
  mainName: { fontSize: 24, fontWeight: '700', color: '#fff' },
  mainSub:  { fontSize: 13, color: 'rgba(255,255,255,0.60)' },

  // Top bar — back button + name only, no action icons
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    paddingTop: Platform.OS === 'web' ? 16 : Platform.OS === 'ios' ? 54 : 36,
    paddingBottom: 12, paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.28)', gap: 10,
  },
  backBtn:   { padding: 6 },
  topName:   { fontSize: 15, fontWeight: '700', color: '#fff' },
  topStatus: { fontSize: 11, color: 'rgba(255,255,255,0.60)', marginTop: 1 },
  
  // Top bar icon buttons
  topIconBtn: { padding: 8 },
  topIconBtnGlass: {
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  topIconBtnActive: {
    backgroundColor: 'rgba(30,156,240,0.35)',
    borderColor: 'rgba(30,156,240,0.55)',
  },

  // ── Right vertical panel: PiPs + action icons ─────────────────────────────
  rightPanel: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 72 : Platform.OS === 'ios' ? 110 : 90,
    right: 10,
    alignItems: 'center',
    gap: 8,
  },

  // PiP tile
  pipTile: {
    width: PIP_W, height: PIP_H,
    borderRadius: RADIUS.md, overflow: 'hidden',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.30)',
    ...SHADOW.glow,
  },
  pipTouch: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center', justifyContent: 'center',
  },
  pipAvatarWrap: { alignItems: 'center', gap: 5 },
  pipNamePill: {
    fontSize: 10, color: '#fff', fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 7, paddingVertical: 2,
    borderRadius: RADIUS.full, overflow: 'hidden',
  },
  pipNameBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    textAlign: 'center', fontSize: 10, color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.45)', paddingVertical: 3,
  },

  // Thin divider between PiPs and action icons
  panelDivider: {
    width: 36, height: 1,
    backgroundColor: 'rgba(255,255,255,0.20)',
    marginVertical: 2,
  },

  // Action icon buttons in vertical list
  sideBtn: {
    width: 48, height: 52,
    borderRadius: RADIUS.sm,
    backgroundColor: 'rgba(0,0,0,0.40)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    gap: 3,
  },
  sideBtnActive: {
    backgroundColor: 'rgba(30,156,240,0.35)',
    borderColor: 'rgba(30,156,240,0.55)',
  },
  sideBtnDisabled: {
    opacity: 0.6,
  },
  sideBtnLabel: {
    fontSize: 9, color: 'rgba(255,255,255,0.75)', fontWeight: '600',
  },

  // Camera toggle notification
  cameraToggleAlert: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 100 : 82,
    left: 12, right: 12,
    backgroundColor: 'rgba(10, 26, 48, 0.95)',
    borderRadius: RADIUS.lg,
    borderWidth: 1.5,
    borderColor: 'rgba(59, 130, 246, 0.5)',
    padding: 14,
    ...SHADOW.glow,
  },
  cameraToggleContent: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  cameraToggleTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  cameraToggleSubtext: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.7)',
    marginTop: 2,
  },
  cameraToggleButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  cameraToggleBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: RADIUS.md,
    ...SHADOW.card,
  },
  cameraToggleBtnPrimary: {
    backgroundColor: '#3b82f6',
  },
  cameraToggleBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  },

  controls: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end',
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    paddingTop: 16, paddingHorizontal: 8,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  controlCol:       { alignItems: 'center', gap: 6 },
  controlLabel:     { fontSize: 10, color: 'rgba(255,255,255,0.70)' },
  controlBtn: {
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.card,
  },
  controlBtnActive: { backgroundColor: 'rgba(255,255,255,0.35)' },
  hangUpBtn: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#e84343',
    alignItems: 'center', justifyContent: 'center',
    transform: [{ rotate: '135deg' }],
    ...SHADOW.button,
  },

  addOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.50)' },
  addSheet: {
    backgroundColor: '#0d2040',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: height * 0.65,
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    paddingHorizontal: 16, paddingTop: 12,
    ...SHADOW.glow,
  },
  addHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    alignSelf: 'center', marginBottom: 14,
  },
  addTitle: { fontSize: 17, fontWeight: '700', color: '#fff', marginBottom: 14 },
  addEmpty: { fontSize: 14, color: 'rgba(255,255,255,0.55)', textAlign: 'center', paddingVertical: 24 },
  addContactRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  addContactMeta: { flex: 1 },
  addContactName: { fontSize: 15, fontWeight: '600', color: '#fff' },
  addContactSub:  { fontSize: 12, color: 'rgba(255,255,255,0.55)', marginTop: 2 },
  addIconWrap: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },

  // Network quality indicator
  qualityBadge: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.card,
  },
  qualityAlert: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 72 : Platform.OS === 'ios' ? 110 : 90,
    left: 12, right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: RADIUS.md,
    ...SHADOW.card,
  },
  qualityText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  },

  // Flip camera icon for small screens (positioned in main view)
  flipIconContainer: {
    position: 'absolute',
    bottom: 100,
    right: 20,
  },
  flipIconBtn: {
    width: 48,
    height: 52,
    borderRadius: RADIUS.sm,
    backgroundColor: 'rgba(30,156,240,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.glow,
  },
});
