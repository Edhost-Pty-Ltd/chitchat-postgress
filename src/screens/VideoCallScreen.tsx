// ─── Screen: Video Call (meeting-aware) ──────────────────────────────────────
// In a 1:1 call this behaves exactly like before.
// In a meeting (meetingId set) it also provides:
//   • recording, in-call chat, minutes, PDF export
//   • screen share
//   • add-participant (from phone contacts), mute-all, long-press kick/mute
//   • live joined-members count
//   • meeting countdown (time remaining until scheduled end)
//   • auto-posted summary in chat when new participants join (if recorded)
//   • end-for-all vs leave-only flow for organizer
//   • post-meeting report (attendees + time spent + minutes PDF)
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, TouchableOpacity, StyleSheet, Dimensions, Platform,
  Modal, ScrollView, Pressable, Animated, ActivityIndicator,
  BackHandler, Alert, AlertButton, Share, AppState,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallContext } from '../context/CallContext';
import { useOutgoingCall } from '../hooks/useOutgoingCall';
import { useIncomingCallAnswer } from '../hooks/useIncomingCallAnswer';
import { useAuth } from '../hooks/useAuth';
import { useFloatingCall } from '../context/FloatingCallContext';
import { useContacts } from '../hooks/useContacts';
import { useMeetingRoom } from '../hooks/useMeetingRoom';
import { endpoints, type MeetingStateDTO } from '../api/endpoints';
import { SignalingService } from '../services/signalingService';
import { socketClient } from '../realtime/socket';
import { mediaService, fileSize } from '../services/mediaService';
import { getOrCreateDirectChat } from '../hooks/useChatActions';
import { setSpeakerphoneOn } from '../utils/webrtc-platform';
import { useAudioRecorder, AudioModule, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import { documentDirectory, copyAsync, getInfoAsync } from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

let CameraView: any = null;
let useCameraPermissions: (() => [any, () => Promise<any>]) | null = null;
let RTCView: any = null;
try {
  const cam = require('expo-camera');
  CameraView = cam.CameraView;
  useCameraPermissions = cam.useCameraPermissions;
  try {
    const rtc = require('@livekit/react-native-webrtc');
    RTCView = rtc.RTCView;
  } catch { RTCView = null; }
} catch { /* Expo Go */ }

function useCameraPerms(): [any, () => Promise<any>] {
  if (useCameraPermissions) return useCameraPermissions(); // eslint-disable-line
  return [null, async () => ({ granted: false })];
}

import { AppText, AppIcon, AppBg, useGlass, useTypography, useForeground } from '../context/ThemeContext';
import { Avatar } from '../components';
import { MeetingChatSheet } from '../components/MeetingChatSheet';
import { ParticipantPickerSheet } from '../components/ParticipantPickerSheet';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList, Contact } from '../types';

// Server-side minutes generation can take a few minutes; stop showing the
// "Generating minutes…" overlay if no result arrives within this window.
const MINUTES_WAIT_TIMEOUT_MS = 6 * 60 * 1000;

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

const StreamTile = React.memo(({ stream, mirror, muted, fallback }: {
  stream: any; mirror?: boolean; muted?: boolean; fallback: React.ReactNode;
}) => {
  if (!stream) return <>{fallback}</>;

  if (Platform.OS === 'web') {
    return React.createElement('video', {
      key: stream.id,
      ref: (el: HTMLVideoElement | null) => {
        if (el && el.srcObject !== stream) {
          el.srcObject = stream;
          el.play().catch(err => console.log('[StreamTile] Play failed:', err));
        }
      },
      autoPlay: true, playsInline: true, muted: !!muted,
      style: {
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        width: '100%', height: '100%', objectFit: 'cover',
        transform: mirror ? 'scaleX(-1)' : undefined,
      },
    });
  }
  if (RTCView) {
    return (
      <RTCView key={stream.id} streamURL={stream.toURL()}
        style={StyleSheet.absoluteFill} objectFit="cover" mirror={!!mirror} />
    );
  }
  return <>{fallback}</>;
});

const PipTile = React.memo(({
  participant: p, facing, canShowCamera, onTap, onLongPress, localStream, remoteStream, organizerActions, isScreenSharing
}: {
  participant: Participant; facing: 'front' | 'back';
  canShowCamera: boolean; onTap: () => void;
  onLongPress?: () => void;
  localStream: any; remoteStream: any;
  organizerActions?: boolean;
  isScreenSharing?: boolean;
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
      {p.isLocal ? (
        <StreamTile
          stream={localStream} mirror={!isScreenSharing && facing === 'front'} muted
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

      <TouchableOpacity
        style={styles.pipTouch}
        onPress={handleTap}
        onLongPress={organizerActions ? onLongPress : undefined}
        delayLongPress={400}
        activeOpacity={0.8}
      >
        {!p.isLocal && !remoteStream && (
          <View style={styles.pipAvatarWrap}>
            <Avatar initials={p.contact.avatar} color={p.contact.color} size={42} />
            <AppText fixedColor style={styles.pipNamePill} numberOfLines={1}>
              {p.contact.name}
            </AppText>
          </View>
        )}
      </TouchableOpacity>
      {p.isLocal && <AppText fixedColor style={styles.pipNameBar}>You</AppText>}
      {organizerActions && !p.isLocal && (
        <View style={styles.pipOrgHint}>
          <AppIcon name="ellipsis-horizontal" size={11} color="#fff" fixedColor />
        </View>
      )}
    </Animated.View>
  );
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function VideoCallScreen() {
  const navigation  = useNavigation<NavProp>();
  const route       = useRoute<RouteP>();
  const {
    callId, isOutgoing, otherParty,
    meetingId: routeMeetingId,
    meetingTitle: routeMeetingTitle,
  } = route.params as any;

  const { user } = useAuth();
  const { minimizeCall, updateDuration } = useFloatingCall();
  const { bevel } = useGlass();
  const { textColor } = useTypography();

  const meetingId: string | null = routeMeetingId ?? null;
  const isMeeting = !!meetingId;

  const {
    room, loading: roomLoading,
    join, leave, muteUser, unmuteUser, muteAll, unmuteAll,
    removeUser, addParticipants, addRecording, endMeeting, setRecordingState,
  } = useMeetingRoom(meetingId);

  const isOrganizer = !!user?.uid && room.organizerId === user.uid;
  const [permission, requestPermission] = useCameraPerms();
  const [muted,      setMuted]          = useState(false);
  const [speakerOn,  setSpeakerOn]      = useState(true);
  const [facing,     setFacing]         = useState<'front' | 'back'>('front');
  const [duration,   setDuration]       = useState(0);
  const [addOpen,    setAddOpen]        = useState(false);
  const [chatOpen,   setChatOpen]       = useState(false);
  const [callStatus, setCallStatus]     = useState<string>('connecting');
  const [showQuality, setShowQuality]   = useState(false);
  const [switchingCamera, setSwitchingCamera] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [showCameraToggle, setShowCameraToggle] = useState(false);
  // Incremented on every camera flip to force RTCView to remount with the new track
  const [flipKey, setFlipKey] = useState(0);

  // Screen share
  const [screenSharing, setScreenSharing] = useState(false);
  const screenShareStreamRef = useRef<any>(null); // holds the display MediaStream on native

  // Meeting schedule (countdown)
  const [meetingEndTime, setMeetingEndTime] = useState<Date | null>(null);
  const [meetingStartTime, setMeetingStartTime] = useState<Date | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Report modal
  const [reportOpen, setReportOpen] = useState(false);
  const [reportData, setReportData] = useState<{
    startedAt: Date | null;
    endedAt: Date | null;
    attendees: { id: string; name: string; joinedAt: Date | null; leftAt: Date | null; seconds: number }[];
    totalSeconds: number;
  } | null>(null);

  // Recording state
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Minutes generation state. Minutes are generated server-side after a
  // recording is registered; isSummarizing shows the overlay while we wait for
  // the meeting:updated 'minutes' event.
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [minutesText, setMinutesText]     = useState<string | null>(room.minutes);
  const [minutesPdfUri, setMinutesPdfUri] = useState<string | null>(null);
  // Tracks the last uploaded recording's playback URL so it can be shown in the report
  const lastRecordingUrlRef = useRef<string | null>(null);
  const [reportRecordingUrl, setReportRecordingUrl] = useState<string | null>(null);
  const minutesWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (minutesWaitTimerRef.current) clearTimeout(minutesWaitTimerRef.current);
    };
  }, []);

  // Sync minutes from the server (room state)
  useEffect(() => { setMinutesText(room.minutes); }, [room.minutes]);

  const startAwaitingMinutes = useCallback(() => {
    if (!mountedRef.current) return;
    setIsSummarizing(true);
    if (minutesWaitTimerRef.current) clearTimeout(minutesWaitTimerRef.current);
    minutesWaitTimerRef.current = setTimeout(() => {
      minutesWaitTimerRef.current = null;
      if (mountedRef.current) setIsSummarizing(false);
    }, MINUTES_WAIT_TIMEOUT_MS);
  }, []);

  const stopAwaitingMinutes = useCallback(() => {
    if (minutesWaitTimerRef.current) {
      clearTimeout(minutesWaitTimerRef.current);
      minutesWaitTimerRef.current = null;
    }
    if (mountedRef.current) setIsSummarizing(false);
  }, []);

  // Attendance log (userId -> join/leave timestamps)
  const attendanceRef = useRef<Map<string, { name: string; joinedAt: Date; leftAt: Date | null }>>(new Map());
  const sessionStartRef = useRef<Date | null>(null);

  // ── WebRTC context ──────────────────────────────────────────────
  const {
    localStream, remoteStream, connectionState, networkQuality,
    setActiveCallId, setIsCaller,
    initializePeerConnection, createOffer, createAnswer, setRemoteAnswer,
    addIceCandidate, toggleMute: toggleMuteWebRTC, toggleVideo,
    switchCamera: switchCameraWebRTC, startNetworkMonitoring, cleanup: cleanupWebRTC,
    getPeerConnection,
  } = useCallContext();

  const { initiateCall: initiateOutgoingCall } = useOutgoingCall();
  const { answerCall } = useIncomingCallAnswer();
  const { contacts } = useContacts();

  // The actual stream that should be displayed locally
  const activeLocalStream = screenSharing && screenShareStreamRef.current 
    ? screenShareStreamRef.current 
    : localStream;

  useEffect(() => {
    if (connectionState === 'connected') setCallStatus('connected');
    else if (connectionState === 'disconnected' || connectionState === 'failed') setCallStatus('disconnected');
  }, [connectionState]);

  useEffect(() => {
    if (networkQuality === 'poor' || networkQuality === 'fair') {
      setShowQuality(true);
      const t = setTimeout(() => setShowQuality(false), 3000);
      return () => clearTimeout(t);
    }
  }, [networkQuality]);

  // ── Contact build (other party) ─────────────────────────────────
  const otherContact: Contact = useMemo(() => ({
    id: parseInt(otherParty.userId) || -2,
    name: meetingTitleFallback(routeMeetingTitle, otherParty.displayName),
    avatar: (otherParty.displayName || 'XX').split(' ').map((n: string) => n[0]).join('').toUpperCase(),
    color: COLORS.blue,
    status: 'online',
    lastMsg: '', time: '', unread: 0,
  }), [otherParty, routeMeetingTitle]);

  const [participants, setParticipants] = useState<Participant[]>([
    { id: `remote-${otherParty.userId}`, contact: otherContact, isLocal: false },
    { id: 'local', contact: LOCAL_CONTACT, isLocal: true },
  ]);

  const timerRef            = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubscribeCallRef  = useRef<(() => void) | null>(null);
  const answerApplied       = useRef(false);
  const iceApplied          = useRef<Set<string>>(new Set());
  // Set true just before navigating away to the floating overlay. The live
  // peer connection lives in the shared CallContext, so when minimizing we must
  // NOT tear it down on unmount — the overlay keeps the call running. Only a
  // real end (hang up / remote end) should call cleanupWebRTC().
  const isMinimizingRef     = useRef(false);
  const remoteStreamRef = useRef<any>(null);
  useEffect(() => { remoteStreamRef.current = remoteStream; }, [remoteStream]);

  // ── Meeting schedule (start/end for the countdown) ──────────────
  // Comes from the live room state (startsAt / endsAt). Ending the meeting is
  // handled by the meeting:ended subscription further down.
  const scheduleStartMs = room.startsAt?.getTime() ?? null;
  const scheduleEndMs   = room.endsAt?.getTime() ?? null;
  useEffect(() => {
    if (!isMeeting) return;
    if (scheduleEndMs != null)   setMeetingEndTime(new Date(scheduleEndMs));
    if (scheduleStartMs != null) setMeetingStartTime(new Date(scheduleStartMs));
  }, [isMeeting, scheduleStartMs, scheduleEndMs]);

  // ── Join meeting presence on mount ──────────────────────────────
  useEffect(() => {
    if (!isMeeting || !user?.uid) return;
    sessionStartRef.current = new Date();
    attendanceRef.current.set(user.uid, {
      name: user.displayName || user.phoneNumber || 'You',
      joinedAt: sessionStartRef.current,
      leftAt: null,
    });
    join(user.uid);

    if (room.kickedUsers.includes(user.uid)) {
      Alert.alert('Removed', 'You were removed from this meeting.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
    return () => {
      const entry = attendanceRef.current.get(user.uid);
      if (entry) entry.leftAt = new Date();
      leave(user.uid);
    };
  }, [isMeeting, user?.uid]); // eslint-disable-line

  // ── Auto-post summary in chat when new participants join ────────
  const prevJoinedRef = useRef<string[]>([]);
  useEffect(() => {
    // Wait for the server's room state: before it arrives joinedMembers only
    // holds our own optimistic join, which would make everyone look "new".
    if (!isMeeting || !meetingId || roomLoading) return;
    const current = room.joinedMembers.slice();
    const prev = prevJoinedRef.current;
    if (prev.length > 0) {
      const newlyJoined = current.filter(id => !prev.includes(id) && id !== user?.uid);
      if (newlyJoined.length > 0 && minutesText) {
        // Broadcast a recap to room chat so newcomers see prior context
        socketClient.emit('meeting:message', {
          meetingId,
          text: `📋 Recap of what was discussed before you joined:\n\n${minutesText}`,
          isSystem: true,
          senderName: 'Meeting Recap',
        });
      }
    }
    prevJoinedRef.current = current;
  }, [room.joinedMembers, minutesText, isMeeting, meetingId, user?.uid, roomLoading]);

  // ── Initial call setup ──────────────────────────────────────────
  useEffect(() => {
    const setupCall = async () => {
      try {
        if (Platform.OS !== 'web' && !permission?.granted) await requestPermission();

        // NOTE: Do NOT call expo-audio's setAudioModeAsync here — WebRTC owns
        // the iOS AVAudioSession for the call. Overriding it silences audio.

        // Meeting joins use their own fresh peer connection.
        if (isMeeting) {
          await initializePeerConnection(true);
          setCallStatus('connected');
          timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
          return;
        }

        // ── 1:1 call signaling (offer/answer/ICE over Socket.IO) ──
        setActiveCallId(callId);
        setIsCaller(isOutgoing);
        await SignalingService.joinCall(callId);

        let answerApplied = false;
        let offerAnswered = false;
        const appliedIce = new Set<string>();
        const applyRemoteIce = (candidates?: RTCIceCandidateInit[]) => {
          if (!candidates) return;
          for (const cand of candidates) {
            const key = `${cand.candidate}-${cand.sdpMLineIndex}-${cand.sdpMid}`;
            if (appliedIce.has(key)) continue;
            appliedIce.add(key);
            addIceCandidate(cand).catch((e) => console.warn('[VideoCall] addIceCandidate failed:', e));
          }
        };
        const endFromRemote = (data: { status?: string }) => {
          if (data.status === 'ended' || data.status === 'rejected' || data.status === 'missed') {
            cleanupWebRTC();
            navigation.goBack();
            return true;
          }
          return false;
        };

        if (isOutgoing) {
          // ── OUTGOING ─────────────────────────────────────────────────────
          // The peer connection, offer, and socket room join were all handled
          // by useOutgoingCall.initiateCall (called from CallsScreen before
          // navigation). Re-creating them here would destroy that PC and send
          // a duplicate offer. Only re-attach the signaling listener.
          unsubscribeCallRef.current = SignalingService.onCallUpdated(callId, async (data) => {
            if (!data) return;
            if (
              data.status === 'ended' ||
              data.status === 'rejected' ||
              data.status === 'missed'
            ) {
              navigation.goBack();
              return;
            }

            // Apply the callee's answer once the peer connection has an offer set.
            if (data.answer && !answerApplied.current) {
              answerApplied.current = true;
              await setRemoteAnswer(data.answer).catch(console.error);
          const offer = await createOffer(true);
          await SignalingService.saveOffer(callId, offer);
          unsubscribeCallRef.current = SignalingService.onCallUpdated(callId, (data) => {
            if (!data) return;
            if (data.answer && !answerApplied) {
              answerApplied = true;
              setRemoteAnswer(data.answer).catch(console.error);
            }

            // Apply callee ICE candidates (deduplicated).
            for (const cand of data.calleeIceCandidates ?? []) {
              const key = `${cand.candidate}-${cand.sdpMLineIndex}`;
              if (!iceApplied.current.has(key)) {
                iceApplied.current.add(key);
                await addIceCandidate(cand).catch(console.error);
              }
            }
          });
        } else {
          // ── INCOMING ─────────────────────────────────────────────────────
          // Pre-warm the peer connection NOW (acquire camera + mic) so the
          // slow getUserMedia step happens in parallel with waiting for the
          // offer — not serially after it. answerCall reuses this pre-warmed
          // connection (initializePeerConnection is idempotent), so by the time
          // the offer arrives we only need setRemoteDescription + createAnswer,
          // and remote video appears almost instantly.
          await initializePeerConnection(true);

          unsubscribeCallRef.current = SignalingService.onCallUpdated(callId, async (data) => {
            if (!data) return;
            if (data.status === 'ended') {
              navigation.goBack();
              return;
            }

            // Set remote desc, create answer, join socket room — exactly once.
            if (data.offer && !answerApplied.current) {
              answerApplied.current = true;
              await answerCall(callId, data.offer, 'video');
            }

            // Apply caller ICE candidates (answerCall's internal listener
            // also handles these; dedup ensures no duplicate addIceCandidate).
            for (const cand of data.callerIceCandidates ?? []) {
              const key = `${cand.candidate}-${cand.sdpMLineIndex}`;
              if (!iceApplied.current.has(key)) {
                iceApplied.current.add(key);
                await addIceCandidate(cand).catch(console.error);
              }
            }
          });
        }
        // 1:1 call duration starts once WebRTC actually connects — see the
        // callStatus effect below. Starting it here would start each device's
        // clock at a different moment (whenever its own signaling round-trip
        // happens to finish), which is what let the two sides drift apart.
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
      // Only tear down the shared peer connection on a real teardown. When
      // minimizing to the floating overlay the call must keep running, so skip
      // cleanup — otherwise maximizing shows a dead connection.
      if (!isMinimizingRef.current) cleanupWebRTC();
    };
  }, []); // eslint-disable-line

  useEffect(() => {
    if (connectionState === 'connected') startNetworkMonitoring();
  }, [connectionState, startNetworkMonitoring]);

  // Apply the output route (loudspeaker vs earpiece) whenever the toggle flips
  // or the call connects. Done via the native AudioRouteModule — NOT
  // expo-audio's setAudioModeAsync, which would reconfigure the shared audio
  // session and silence the live call. For meetings, audio is live as soon as
  // the peer connection is up, so we also apply once the status is 'connected'.
  useEffect(() => {
    if (callStatus === 'connected' || connectionState === 'connected') {
      setSpeakerphoneOn(speakerOn);
    }
  }, [speakerOn, connectionState, callStatus]);

  // ── React to being muted by organizer ───────────────────────────
  useEffect(() => {
    if (!isMeeting || !user?.uid) return;
    const amMutedByOrg = room.mutedUsers.includes(user.uid);
    if (amMutedByOrg && !muted) {
      setMuted(true);
      toggleMuteWebRTC(true);
    }
  }, [room.mutedUsers, user?.uid, muted]); // eslint-disable-line

  // ── Android back → minimize ─────────────────────────────────────
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      const isLocalMain = participants[0]?.isLocal || false;
      // localIsMain is a UI hint — no persistence needed on backend path.
      minimizeCall({
        callId,
        displayName: otherParty.displayName,
        avatar: otherParty.displayName.split(' ').map((n: string) => n[0]).join('').toUpperCase(),
        color: COLORS.blue,
        duration: fmt(duration),
        isVideo: true,
        isOutgoing,
        localStream: activeLocalStream,
        remoteStream,
        localIsMain: isLocalMain,
        otherParty,
      });
      isMinimizingRef.current = true;
      navigation.goBack();
      return true;
    });
    return () => backHandler.remove();
  }, [duration, callId, isOutgoing, otherParty, participants, minimizeCall, navigation, activeLocalStream]);

  // ── iOS: minimize on background / lock screen ───────────────────
  // On iOS there is no hardware back button, so the Android handler above
  // never fires when the user locks the phone or swipes home. AppState
  // 'background'/'inactive' catches both cases.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        const isLocalMain = participants[0]?.isLocal || false;
        minimizeCall({
          callId,
          displayName: otherParty.displayName,
          avatar: otherParty.displayName.split(' ').map((n: string) => n[0]).join('').toUpperCase(),
          color: COLORS.blue,
          duration: fmt(duration),
          isVideo: true,
          isOutgoing,
          localStream: activeLocalStream,
          remoteStream,
          localIsMain: isLocalMain,
          otherParty,
        });
        isMinimizingRef.current = true;
        navigation.goBack();
      }
    });
    return () => sub.remove();
  }, [duration, callId, isOutgoing, otherParty, participants, minimizeCall, navigation, activeLocalStream, remoteStream]);

  useEffect(() => { updateDuration(fmt(duration)); }, [duration]); // eslint-disable-line

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const fmtHuman = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  };

  // ── Swap main / PiP ─────────────────────────────────────────────
  const swapToMain = useCallback((id: string) => {
    setParticipants((prev) => {
      const idx = prev.findIndex((p) => p.id === id);
      if (idx <= 0) return prev;
      const next = [...prev];
      [next[0], next[idx]] = [next[idx], next[0]];
      return next;
    });
  }, []);

  // ── Camera flip ─────────────────────────────────────────────────
  const flipCamera = useCallback(async () => {
    if (switchingCamera) return;
    try {
      setSwitchingCamera(true);
      const newFacing = facing === 'front' ? 'back' : 'front';
      const facingMode = newFacing === 'front' ? 'user' : 'environment';
      await switchCameraWebRTC(facingMode);
      setFacing(newFacing);
      // Bump key so the local StreamTile remounts with the new video track
      setFlipKey((k) => k + 1);
    } catch (err) {
      console.error('[VideoCall] flip failed:', err);
    } finally {
      setSwitchingCamera(false);
    }
  }, [facing, switchingCamera, switchCameraWebRTC]);

  // ── Screen share ────────────────────────────────────────────────
  const toggleScreenShare = useCallback(async () => {
    try {
      if (screenSharing) {
        // ── Stop sharing ──
        if (screenShareStreamRef.current) {
          const tracks: any[] = screenShareStreamRef.current.getTracks?.() ?? [];
          tracks.forEach((t: any) => t.stop?.());
          screenShareStreamRef.current = null;
        }

        // Restore camera track in WebRTC
        if (localStream) {
          const pc = getPeerConnection() as any;
          const camTrack = localStream.getVideoTracks?.()[0];
          if (pc && camTrack) {
            const senders: any[] = pc.getSenders?.() ?? [];
            const videoSender = senders.find((s: any) => s.track?.kind === 'video' || s.track === null || !s.track);
            if (videoSender) {
              await videoSender.replaceTrack(camTrack).catch((e: any) => console.warn('Failed to restore camera track', e));
            }
          }
        }
        setScreenSharing(false);
        return;
      }

      // ── Start sharing ──
      let disp: any = null;

      if (Platform.OS === 'web') {
        const md: any = (navigator as any).mediaDevices;
        if (!md?.getDisplayMedia) {
          Alert.alert('Not supported', 'Screen share is not available on this browser.');
          return;
        }
        disp = await md.getDisplayMedia({ video: true, audio: false });
      } else {
        let webrtcModule: any = null;
        try { webrtcModule = require('@livekit/react-native-webrtc'); } catch { /* not available */ }

        if (!webrtcModule?.mediaDevices?.getDisplayMedia) {
          Alert.alert('Not supported', 'Screen share requires a native build with react-native-webrtc.');
          return;
        }
        disp = await webrtcModule.mediaDevices.getDisplayMedia({ video: true });
      }

      screenShareStreamRef.current = disp;
      const screenTrack = disp.getVideoTracks?.()[0];

      if (screenTrack) {
        const pc = getPeerConnection() as any;
        if (pc) {
          const senders: any[] = pc.getSenders?.() ?? [];
          const videoSender = senders.find((s: any) => s.track?.kind === 'video' || s.track === null || !s.track);
          if (videoSender) {
            await videoSender.replaceTrack(screenTrack);
          } else {
            pc.addTrack?.(screenTrack, disp);
          }
        }

        // Handle when the user manually stops sharing via the system/browser toolbar
        screenTrack.onended = () => {
          screenShareStreamRef.current = null;
          setScreenSharing(false);
          const currentPc = getPeerConnection() as any;
          const camTrack = localStream?.getVideoTracks?.()[0];
          if (currentPc && camTrack) {
            const snds: any[] = currentPc.getSenders?.() ?? [];
            const vs = snds.find((s: any) => s.track?.kind === 'video' || s.track === null || !s.track);
            if (vs) {
              vs.replaceTrack(camTrack).catch((e: any) => console.warn('Failed to restore camera track onended', e));
            }
          }
        };
      }

      setScreenSharing(true);
    } catch (err: any) {
      if (err?.message?.includes('cancelled') || err?.message?.includes('canceled')) {
        return;
      }
      if (err?.name === 'AbortError' || err?.message?.includes('AbortError')) {
        Alert.alert(
          'Screen Share Unavailable',
          'Native screen sharing requires a Broadcast Extension configured in Xcode. ' +
          'Please contact the developer to enable this feature.',
        );
        return;
      }
      console.error('[VideoCall] screen share failed:', err);
      Alert.alert('Screen share', 'Could not start screen sharing. Make sure the app has screen recording permission.');
    }
  }, [screenSharing, localStream, getPeerConnection]);

  // ── Recording ───────────────────────────────────────────────────
  /** Start the recorder and flag the meeting as recorded for everyone. */
  const beginRecording = useCallback(async () => {
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await audioRecorder.prepareToRecordAsync();
    if (!mountedRef.current) return;
    audioRecorder.record();
    setIsRecording(true);
    setRecordingMs(0);
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = setInterval(() => setRecordingMs(ms => ms + 1000), 1000);
    // Notify all participants ("This meeting is being recorded")
    setRecordingState(true).catch(() => {});
  }, [audioRecorder, setRecordingState]);

  /**
   * Upload a finished recording to the meeting's media prefix and register it.
   * The server then generates the minutes in the background, saves them on the
   * meeting, posts them to the meeting chat and emits meeting:updated
   * (reason 'minutes').
   */
  const uploadRecording = useCallback(async (localPath: string, durationMs: number) => {
    if (!meetingId) throw new Error('Not in a meeting');
    // The backend rejects sizeBytes 0, so fall back to the legacy stat.
    let sizeBytes = await fileSize(localPath);
    if (!sizeBytes) {
      const info = await getInfoAsync(localPath);
      sizeBytes = info.exists ? info.size : 0;
    }
    if (!sizeBytes) throw new Error('Recording file is empty');
    const objectKey = await mediaService.upload(localPath, 'meeting', {
      meetingId,
      sizeBytes,
      contentType: 'audio/mp4',
      ext: 'm4a',
    });
    const result = await addRecording({ objectKey, durationMs });
    if (result.recording.url) lastRecordingUrlRef.current = result.recording.url;
    return result;
  }, [meetingId, addRecording]);

  const toggleRecording = useCallback(async () => {
    if (isRecording) {
      try {
        setIsRecording(false);
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        setRecordingState(false).catch(() => {});
        await audioRecorder.stop();
        const uri = audioRecorder.uri;
        if (uri) {
          const newPath = `${documentDirectory}Meeting_${meetingId ?? callId}_${Date.now()}.m4a`;
          await copyAsync({ from: uri, to: newPath });
          try {
            const { summarizing } = await uploadRecording(newPath, recordingMs);
            // Minutes are generated server-side; wait for meeting:updated 'minutes'.
            if (summarizing) startAwaitingMinutes();
          } catch (upErr) {
            console.warn('[VideoCall] Upload failed, saving local only:', upErr);
            Alert.alert('Saved Locally', `Recording saved locally but not uploaded.`);
          }
        }
      } catch (err) {
        console.error('[VideoCall] stop recording failed:', err);
      }
      setRecordingMs(0);
      return;
    }

    try {
      const { granted } = await AudioModule.requestRecordingPermissionsAsync();
      if (!granted) { Alert.alert('Permission denied', 'Microphone access is required to record.'); return; }
      await beginRecording();
    } catch (err) {
      console.error('[VideoCall] start recording failed:', err);
    }
  }, [isRecording, audioRecorder, meetingId, callId, recordingMs, setRecordingState,
      uploadRecording, startAwaitingMinutes, beginRecording]);

  // ── Auto-start recording for the organizer so minutes are always generated ──
  // Runs once per call, after setup, as soon as the room has loaded and shows
  // that we are the organizer.
  const autoRecordAttemptedRef = useRef(false);
  useEffect(() => {
    if (!isMeeting || !isOrganizer || callStatus !== 'connected') return;
    if (autoRecordAttemptedRef.current) return;
    autoRecordAttemptedRef.current = true;
    (async () => {
      try {
        const { granted } = await AudioModule.requestRecordingPermissionsAsync();
        if (granted) await beginRecording();
      } catch (recErr) {
        console.warn('[VideoCall] auto-start recording failed:', recErr);
      }
    })();
  }, [isMeeting, isOrganizer, callStatus, beginRecording]);

  // Cleanup recording timer on unmount
  useEffect(() => () => {
    if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
  }, []);

  // ── Organizer: mute-all toggle ──────────────────────────────────
  const allMuted = useMemo(() => {
    if (!room.participants.length) return false;
    return room.participants.every(id => room.mutedUsers.includes(id));
  }, [room.participants, room.mutedUsers]);

  const handleMuteAll = useCallback(async () => {
    if (allMuted) await unmuteAll(room.participants);
    else await muteAll(room.participants);
  }, [allMuted, room.participants, muteAll, unmuteAll]);

  // ── Organizer: long-press participant ───────────────────────────
  const handleParticipantLongPress = useCallback((targetUserId: string) => {
    if (!isOrganizer) return;
    if (targetUserId === user?.uid) return;

    const isCurrentlyMuted = room.mutedUsers.includes(targetUserId);

    const buttons: AlertButton[] = [
      {
        text: isCurrentlyMuted ? 'Unmute' : 'Mute',
        onPress: async () => {
          if (isCurrentlyMuted) await unmuteUser(targetUserId);
          else await muteUser(targetUserId);
        },
      },
      {
        text: 'Remove from meeting',
        style: 'destructive',
        onPress: async () => {
          await removeUser(targetUserId);
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ];

    Alert.alert('Participant options', 'Choose an action', buttons);
  }, [isOrganizer, user?.uid, room.mutedUsers, muteUser, unmuteUser, removeUser]);

  // ── Add participants (from sheet, sourced from phone contacts) ──
  const handleAddParticipants = useCallback(async (ids: string[]) => {
    if (!ids.length || !user?.uid || !meetingId) return;

    // 1. Add them to the meeting so they can see it in Calendar (the server
    //    also invites them with a chat message + push)
    try {
      await addParticipants(ids, user.displayName || null);
    } catch (err: any) {
      console.warn('[VideoCall] add participants failed:', err);
      Alert.alert('Could not add participants', err?.message || 'Please try again.');
      return;
    }

    // 2. Ring each newly added participant so they get an incoming call
    //    that drops them straight into the meeting.
    const callerName = user.displayName || user.phoneNumber || 'Meeting Host';
    const meetingTitle = meetingTitleFallback(routeMeetingTitle, 'Meeting');

    for (const calleeId of ids) {
      try {
        await initiateOutgoingCall(
          user.uid,
          calleeId,
          {
            userId: user.uid,
            displayName: callerName,
            photoUrl: user.photoURL ?? null,
          },
          {
            userId: calleeId,
            displayName: meetingTitle,
            photoUrl: null,
          },
          'video'
        );
      } catch (err) {
        console.warn('[VideoCall] Failed to ring participant', calleeId, err);
      }
    }
  }, [addParticipants, initiateOutgoingCall, user, meetingId, routeMeetingTitle]);

  const excludeIds = useMemo(
    () => room.participants.filter(id => id !== user?.uid),
    [room.participants, user?.uid]
  );

  // ── Build & show post-meeting report ────────────────────────────
  const buildAndShowReport = useCallback(async (meetingDoc?: MeetingStateDTO) => {
    try {
      const attendees: { id: string; name: string; joinedAt: Date | null; leftAt: Date | null; seconds: number }[] = [];
      const now = new Date();
      // Local user
      attendanceRef.current.forEach((entry, uid) => {
        const leftAt = entry.leftAt ?? now;
        attendees.push({
          id: uid,
          name: entry.name,
          joinedAt: entry.joinedAt,
          leftAt: entry.leftAt,
          seconds: Math.max(0, Math.floor((leftAt.getTime() - entry.joinedAt.getTime()) / 1000)),
        });
      });

      // Merge with the backend meeting state if available. The backend returns
      // ISO date strings; coerce them with `new Date(...)`.
      const toDate = (v: unknown): Date | null => {
        if (!v) return null;
        const d = new Date(v as string);
        return Number.isNaN(d.getTime()) ? null : d;
      };
      let startedAt: Date | null = sessionStartRef.current;
      let endedAt: Date | null = null;
      let doc = meetingDoc;
      if (!doc && meetingId) {
        const res = await endpoints.getMeeting(meetingId);
        if (res.ok) doc = res.data.state;
      }
      if (doc) {
        startedAt = toDate(doc.startsAt) ?? startedAt;
        endedAt = toDate(doc.endedAt);
      }

      const totalSeconds = startedAt
        ? Math.floor(((endedAt ?? now).getTime() - startedAt.getTime()) / 1000)
        : duration;

      setReportData({
        startedAt,
        endedAt: endedAt ?? now,
        attendees,
        totalSeconds,
      });
      // Playback URL of the recording registered in this call, else the
      // latest one the server listed for the meeting.
      const latestRecording = room.recordings[room.recordings.length - 1];
      setReportRecordingUrl(lastRecordingUrlRef.current ?? latestRecording?.url ?? null);
      setReportOpen(true);
    } catch (e) {
      console.warn('[VideoCall] buildReport failed:', e);
    }
  }, [duration, meetingId, room.recordings]);

  // ── PDF export for minutes ──────────────────────────────────────
  const exportMinutesPdf = useCallback(async () => {
    if (!minutesText) {
      Alert.alert('No minutes', 'Minutes have not been generated yet.');
      return;
    }
    try {
      const title = meetingTitleFallback(routeMeetingTitle, 'Meeting');
      const attendeesList = reportData?.attendees.map(a => a.name).join(', ') ?? '—';
      const html = `
        <html>
          <head>
            <meta charset="utf-8" />
            <style>
              body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 32px; color: #111; }
              h1 { font-size: 22px; margin-bottom: 4px; }
              h2 { font-size: 14px; color: #555; margin-top: 0; font-weight: 500; }
              .meta { margin: 16px 0 24px; padding: 12px; background: #f5f7fa; border-radius: 8px; font-size: 12px; }
              .meta div { margin: 4px 0; }
              pre { white-space: pre-wrap; font-family: inherit; font-size: 13px; line-height: 1.55; }
            </style>
          </head>
          <body>
            <h1>${title}</h1>
            <h2>Meeting Minutes</h2>
            <div class="meta">
              <div><b>Started:</b> ${reportData?.startedAt?.toLocaleString() ?? '—'}</div>
              <div><b>Ended:</b> ${reportData?.endedAt?.toLocaleString() ?? '—'}</div>
              <div><b>Duration:</b> ${reportData ? fmtHuman(reportData.totalSeconds) : '—'}</div>
              <div><b>Attendees (${reportData?.attendees.length ?? 0}):</b> ${attendeesList}</div>
            </div>
            <pre>${(minutesText || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as any)[c])}</pre>
          </body>
        </html>
      `;
      const { uri } = await Print.printToFileAsync({ html });
      setMinutesPdfUri(uri);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Share meeting minutes',
          UTI: 'com.adobe.pdf',
        });
      } else {
        Alert.alert('PDF ready', `Saved to: ${uri}`);
      }
    } catch (e) {
      console.error('[VideoCall] PDF export failed:', e);
      Alert.alert('Error', 'Could not generate PDF.');
    }
  }, [minutesText, reportData, routeMeetingTitle]);

  // ── Actions ─────────────────────────────────────────────────────
  // Set while we are leaving so our own meeting:ended doesn't pop the report.
  const hangingUpRef = useRef(false);

  const doHangUp = useCallback(async (endForAll: boolean) => {
    hangingUpRef.current = true;
    if (!isMeeting) {
      try {
        // Emit the 'end' signal so the server relays it to the other party
        // (their screen closes too) and records history for both sides.
        // A positive duration means the call was answered → 'completed'.
        await SignalingService.updateCallStatus(
          callId,
          'ended',
          callStatus === 'connected' ? duration : 0,
        );
      } catch (err) {
        console.warn('[VideoCall] end call update failed:', err);
      }
    }

    if (isMeeting && meetingId) {
      const me = user?.uid && attendanceRef.current.get(user.uid);
      if (me) me.leftAt = new Date();

      if (endForAll && isOrganizer) {
        try {
          await endMeeting();
        } catch (e) {
          console.warn('[VideoCall] endMeeting failed:', e);
        }
      }
    }

    // ── Stop recording, upload, and let the server generate minutes ──
    if (isRecording && isMeeting) {
      try {
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        setIsRecording(false);
        // Ending for all already cleared the "being recorded" flag server-side.
        if (!(endForAll && isOrganizer)) setRecordingState(false).catch(() => {});
        await audioRecorder.stop();
        const uri = audioRecorder.uri;
        if (uri) {
          const newPath = `${documentDirectory}Meeting_${meetingId ?? callId}_${Date.now()}.m4a`;
          await copyAsync({ from: uri, to: newPath });
          const elapsed = recordingMs;
          // Upload + register in the background so leaving isn't blocked. The
          // server generates the minutes from the stored recording and posts
          // them to the meeting chat; the overlay only shows if still mounted.
          uploadRecording(newPath, elapsed)
            .then(({ summarizing }) => { if (summarizing) startAwaitingMinutes(); })
            .catch((upErr) => {
              console.warn('[VideoCall] upload on hangup failed:', upErr);
              Alert.alert('Saved Locally', `Recording saved locally but not uploaded.`);
            });
        }
      } catch (stopErr) {
        console.warn('[VideoCall] stop recording on hangup failed:', stopErr);
      }
    } else if (isRecording) {
      // 1:1 call — just stop without uploading
      try {
        if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
        await audioRecorder.stop();
      } catch {}
    }

    cleanupWebRTC();
    navigation.goBack();
  }, [callId, isMeeting, meetingId, isOrganizer, endMeeting, user?.uid, isRecording,
      audioRecorder, recordingMs, setRecordingState, uploadRecording, startAwaitingMinutes,
      cleanupWebRTC, navigation, duration]);

  const hangUp = useCallback(() => {
    if (isMeeting && isOrganizer) {
      Alert.alert(
        'End meeting',
        'Do you want to end the meeting for everyone, or just leave?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Just leave', onPress: () => { doHangUp(false); } },
          { text: 'End for all', style: 'destructive', onPress: () => { doHangUp(true); } },
        ],
      );
      return;
    }
    if (isMeeting) {
      // Non-organizer: just leave, meeting stays live
      doHangUp(false);
      return;
    }
    // 1:1 call — legacy behavior
    doHangUp(true);
  }, [isMeeting, isOrganizer, doHangUp]);

  const handleMuteToggle = () => {
    const newMuted = !muted;
    setMuted(newMuted);
    toggleMuteWebRTC(newMuted);
  };

  // ── Server-driven meeting events ────────────────────────────────
  // meeting:ended arrives on both the user room and the meeting room, so each
  // outcome is handled once. Handlers read this render's values via a ref so
  // the socket subscriptions are made once per meeting.
  const meetingEndedHandledRef = useRef(false);
  const removedHandledRef = useRef(false);
  const meetingEventsRef = useRef<{
    ended: () => void;
    kicked: () => void;
    muted: (mutedByOrganizer: boolean) => void;
    updated: (reason: string | undefined) => void;
  } | null>(null);
  meetingEventsRef.current = {
    // Meeting ended for all — navigate everyone (including non-organizers) away
    ended: () => {
      if (meetingEndedHandledRef.current || hangingUpRef.current) return;
      meetingEndedHandledRef.current = true;
      if (isOrganizer) {
        // Organizer sees the report
        if (!reportOpen) buildAndShowReport().catch(() => {});
      } else {
        // Participants get a brief alert then go back to Calendar
        Alert.alert(
          'Meeting ended',
          'The organizer has ended this meeting.',
          [{ text: 'OK', onPress: () => navigation.goBack() }],
          { cancelable: false },
        );
      }
    },
    // The organizer removed us: leave the room right away, then go back.
    kicked: () => {
      if (removedHandledRef.current || hangingUpRef.current) return;
      removedHandledRef.current = true;
      if (user?.uid) void leave(user.uid);
      Alert.alert(
        'Removed from meeting',
        'The organizer removed you from this meeting.',
        [{ text: 'OK', onPress: () => navigation.goBack() }],
        { cancelable: false },
      );
    },
    // The organizer muted us: apply it to the local mic. (Unmuting is left to
    // the participant, as before.)
    muted: (mutedByOrganizer) => {
      if (mutedByOrganizer && !muted) {
        setMuted(true);
        toggleMuteWebRTC(true);
      }
    },
    // Server-side minutes for the recording we just registered.
    updated: (reason) => {
      if (!isSummarizing) return;
      if (reason === 'minutes') {
        stopAwaitingMinutes();
      } else if (reason === 'recording-failed') {
        stopAwaitingMinutes();
        Alert.alert('Minutes Error', 'Could not generate minutes from the recording.');
      }
    },
  };

  useEffect(() => {
    if (!isMeeting || !meetingId) return;
    const forThisMeeting = (payload: unknown) =>
      (payload as { meetingId?: string } | null)?.meetingId === meetingId;
    const unsubs = [
      socketClient.subscribe('meeting:ended', (payload) => {
        if (forThisMeeting(payload)) meetingEventsRef.current?.ended();
      }),
      socketClient.subscribe('meeting:kicked', (payload) => {
        if (forThisMeeting(payload)) meetingEventsRef.current?.kicked();
      }),
      socketClient.subscribe('meeting:muted', (payload) => {
        if (!forThisMeeting(payload)) return;
        meetingEventsRef.current?.muted(!!(payload as { muted?: boolean }).muted);
      }),
      socketClient.subscribe('meeting:updated', (payload) => {
        if (!forThisMeeting(payload)) return;
        meetingEventsRef.current?.updated((payload as { reason?: string }).reason);
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [isMeeting, meetingId]);

  const switchToAudio = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    // Duration is tracked locally; no persistence needed on backend path.
    cleanupWebRTC();
    navigation.replace('AudioCall', { callId, isOutgoing, otherParty, meetingId: meetingId ?? undefined });
  };

  const openChat = async () => {
    if (isMeeting) { setChatOpen(true); return; }
    try {
      if (!user?.uid) return;
      const actualChatId = await getOrCreateDirectChat(user.uid, otherParty.userId);
      navigation.navigate('Chat', {
        chatId: actualChatId,
        displayName: otherParty.displayName,
        isGroup: false,
        otherUserId: otherParty.userId,
        otherUserPhoto: otherParty.photoUrl,
      });
    } catch (e) {
      console.error('[VideoCall] open chat failed:', e);
    }
  };

  const shareMinutesText = async () => {
    if (!minutesText) return;
    try {
      await Share.share({ message: minutesText, title: 'Meeting Minutes' });
    } catch (e) {
      console.warn('[VideoCall] share failed:', e);
    }
  };

  const mainP   = participants[0];
  const pipList = participants.slice(1);
  const canShowCamera = Platform.OS === 'web' || !!permission?.granted;

  const getQualityColor = () => {
    switch (networkQuality) {
      case 'excellent': return '#10b981';
      case 'good':      return '#3b82f6';
      case 'fair':      return '#f59e0b';
      case 'poor':      return '#ef4444';
      default:          return 'transparent';
    }
  };
  const getQualityText = () => {
    switch (networkQuality) {
      case 'excellent': return 'Excellent connection';
      case 'good':      return 'Good connection';
      case 'fair':      return 'Fair connection';
      case 'poor':      return 'Poor connection';
      default:          return 'Connecting...';
    }
  };

  const joinedCount = isMeeting ? room.joinedMembers.length : participants.length;

  // Meeting countdown
  const remainingMs = meetingEndTime ? Math.max(0, meetingEndTime.getTime() - now) : 0;
  const hasSchedule = isMeeting && meetingEndTime !== null;
  const remainingMin = Math.floor(remainingMs / 60000);
  const remainingSec = Math.floor((remainingMs % 60000) / 1000);
  const remainingLabel = hasSchedule
    ? remainingMs > 0
      ? `${remainingMin}m ${String(remainingSec).padStart(2, '0')}s left`
      : 'Time is up'
    : null;

  const topStatusText = isMeeting
    ? `${fmt(duration)} · ${joinedCount} participant${joinedCount === 1 ? '' : 's'}`
    : `${fmt(duration)} · ${participants.length} participant${participants.length === 1 ? '' : 's'}`;

  return (
    <View style={styles.root}>
      <AppBg />
      <View style={styles.darkOverlay} />

      {/* ── Main view ── */}
      <View style={styles.mainView}>
        {mainP.isLocal ? (
          <StreamTile
            stream={activeLocalStream}
            mirror={!screenSharing && facing === 'front'}
            muted
            key={`local-${flipKey}`}
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
        {!mainP.isLocal && !remoteStream && (
          <View style={styles.mainAvatarOverlay}>
            <Avatar initials={mainP.contact.avatar} color={mainP.contact.color} size={120} imageUrl={otherParty.photoUrl} />
            <AppText fixedColor style={styles.mainName}>{mainP.contact.name}</AppText>
            <AppText fixedColor style={styles.mainSub}>
              {isRecording ? `● Recording ${fmt(Math.floor(recordingMs / 1000))}` : `In call · ${fmt(duration)}`}
            </AppText>
          </View>
        )}
      </View>

      {/* ── Top bar ── */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={hangUp} style={styles.backBtn}>
          <AppIcon name="chevron-back" size={26} color="rgba(255,255,255,0.80)" fixedColor />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <AppText fixedColor style={styles.topName} numberOfLines={1}>
            {mainP.contact.name}
          </AppText>
          <AppText fixedColor style={styles.topStatus}>{topStatusText}</AppText>
          {remainingLabel && (
            <AppText fixedColor style={[styles.topStatus, { color: remainingMs < 60000 ? '#fca5a5' : '#a7f3d0' }]}>
              ⏱ {remainingLabel}
            </AppText>
          )}
        </View>

        {isRecording && (
          <View style={styles.recordingBadge}>
            <View style={styles.recordingDot} />
            <AppText fixedColor style={styles.recordingBadgeText}>
              REC {fmt(Math.floor(recordingMs / 1000))}
            </AppText>
          </View>
        )}

        {networkQuality !== 'unknown' && (
          <View style={[styles.qualityBadge, { backgroundColor: getQualityColor() }]}>
            <AppIcon
              name={networkQuality === 'excellent' || networkQuality === 'good' ? 'wifi' : 'wifi-outline'}
              size={14} color="#fff" fixedColor
            />
          </View>
        )}
      </View>

      {showQuality && (networkQuality === 'poor' || networkQuality === 'fair') && (
        <View style={[styles.qualityAlert, { backgroundColor: getQualityColor() }]}>
          <AppIcon name="warning-outline" size={16} color="#fff" fixedColor />
          <AppText fixedColor style={styles.qualityText}>{getQualityText()}</AppText>
        </View>
      )}

      {/* ── Alone-in-meeting banner ── */}
      {isMeeting && room.joinedMembers.length <= 1 && (
        <View style={styles.aloneBanner}>
          <AppIcon name="people-outline" size={16} color="#fff" fixedColor />
          <AppText fixedColor style={styles.aloneText}>
            You're the only one here. Share the meeting link to invite others.
          </AppText>
        </View>
      )}

      {/* ── Recording indicator for non-organizer participants ── */}
      {isMeeting && !isOrganizer && room.isRecording && (
        <View style={styles.recordingNoticeBanner}>
          <View style={styles.recordingNoticeDot} />
          <AppText fixedColor style={styles.recordingNoticeText}>
            This meeting is being recorded
          </AppText>
        </View>
      )}

      {showCameraToggle && (
        <View style={styles.cameraToggleAlert}>
          <View style={styles.cameraToggleContent}>
            <AppIcon name="videocam-outline" size={20} color="#fff" fixedColor />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <AppText fixedColor style={styles.cameraToggleTitle}>
                {otherParty.displayName} switched to video
              </AppText>
              <AppText fixedColor style={styles.cameraToggleSubtext}>Turn on your camera?</AppText>
            </View>
          </View>
          <View style={styles.cameraToggleButtons}>
            <TouchableOpacity style={[styles.cameraToggleBtn, bevel]} onPress={() => {
              setCameraEnabled(false); toggleVideo(false); setShowCameraToggle(false);
            }}>
              <AppText fixedColor style={styles.cameraToggleBtnText}>Not now</AppText>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.cameraToggleBtn, styles.cameraToggleBtnPrimary]}
              onPress={() => {
                setCameraEnabled(true); toggleVideo(true); setShowCameraToggle(false);
              }}
            >
              <AppIcon name="videocam" size={16} color="#fff" fixedColor />
              <AppText fixedColor style={[styles.cameraToggleBtnText, { marginLeft: 6 }]}>Turn on</AppText>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── Right side panel ── */}
      <View style={styles.rightPanel}>
        {pipList.map((p) => {
          const targetUserId = p.isLocal ? (user?.uid ?? '') : p.id.replace('remote-', '');
          const canManage = isOrganizer && !p.isLocal && targetUserId !== user?.uid;
          return (
            <PipTile
              key={p.id}
              participant={p}
              facing={facing}
              canShowCamera={canShowCamera}
              onTap={() => swapToMain(p.id)}
              onLongPress={() => handleParticipantLongPress(targetUserId)}
              organizerActions={canManage}
              localStream={activeLocalStream}
              remoteStream={remoteStream}
              isScreenSharing={screenSharing}
            />
          );
        })}

        {pipList.length > 0 && <View style={styles.panelDivider} />}

        {/* Chat */}
        <TouchableOpacity style={styles.sideBtn} onPress={openChat} activeOpacity={0.75}>
          <AppIcon name="chatbubble-outline" size={20} color="#fff" fixedColor />
        </TouchableOpacity>

        {/* Add person (meeting only) */}
        {isMeeting && (
          <TouchableOpacity
            style={[styles.sideBtn, styles.sideBtnActive]}
            onPress={() => setAddOpen(true)}
            activeOpacity={0.75}
          >
            <AppIcon name="person-add-outline" size={20} color="#fff" fixedColor />
          </TouchableOpacity>
        )}

        {/* Screen share */}
        <TouchableOpacity
          style={[styles.sideBtn, screenSharing && styles.sideBtnActive]}
          onPress={toggleScreenShare}
          activeOpacity={0.75}
        >
          <AppIcon name={screenSharing ? 'desktop' : 'desktop-outline'} size={20} color="#fff" fixedColor />
        </TouchableOpacity>
        {/* Recording indicator */}
        {isMeeting && isOrganizer && (
          <TouchableOpacity
            style={[styles.sideBtn, isRecording && styles.sideBtnActive]}
            onPress={toggleRecording}
            activeOpacity={0.75}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <AppIcon name="radio-button-on" size={20} color="#ef4444" fixedColor />
              {isRecording && <View  />}
            </View>
          </TouchableOpacity>
        )}

        {/* Flip camera */}
        <TouchableOpacity
          style={[styles.sideBtn, styles.sideBtnActive, switchingCamera && styles.sideBtnDisabled]}
          onPress={flipCamera}
          activeOpacity={switchingCamera ? 1 : 0.75}
          disabled={switchingCamera}
        >
          {switchingCamera
            ? <ActivityIndicator size="small" color="#fff" />
            : <AppIcon name="camera-reverse-outline" size={22} color="#fff" fixedColor />}
        </TouchableOpacity>

        {/* Mute all (organizer only, meeting only) */}
        {isMeeting && isOrganizer && (
          <TouchableOpacity
            style={[styles.sideBtn, allMuted && styles.sideBtnActive]}
            onPress={handleMuteAll}
            activeOpacity={0.75}
          >
            <AppIcon name={allMuted ? 'mic-off-outline' : 'mic-outline'} size={20} color="#fff" fixedColor />
          </TouchableOpacity>
        )}
      </View>

      {/* ── Bottom controls ── */}
      <View style={styles.controls}>
        <View style={styles.controlCol}>
          <TouchableOpacity
            style={[styles.controlBtn, muted && styles.controlBtnActive]}
            onPress={handleMuteToggle}
          >
            <AppIcon name={muted ? 'mic-off' : 'mic-outline'} size={24} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>{muted ? 'Unmute' : 'Mute'}</AppText>
        </View>

        <View style={styles.controlCol}>
          <TouchableOpacity
            style={[styles.controlBtn, speakerOn && styles.controlBtnActive]}
            onPress={() => setSpeakerOn((s) => !s)}
          >
            <AppIcon name={speakerOn ? 'volume-high' : 'ear-outline'} size={24} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>{speakerOn ? 'Speaker' : 'Earpiece'}</AppText>
        </View>
 

        {/* Minutes PDF shortcut when available */}
        {isMeeting && minutesText && (
          <View style={styles.controlCol}>
            <TouchableOpacity style={styles.controlBtn} onPress={exportMinutesPdf}>
              <AppIcon name="document-text-outline" size={24} color="#fff" fixedColor />
            </TouchableOpacity>
            <AppText fixedColor style={styles.controlLabel}>Minutes</AppText>
          </View>
        )}

        <View style={styles.controlCol}>
          <TouchableOpacity style={styles.controlBtn} onPress={switchToAudio}>
            <AppIcon name="call-outline" size={24} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>Audio only</AppText>
        </View>

        {/* Camera on/off toggle — clearly labelled so it's distinct from screen share */}
        <View style={styles.controlCol}>
          <TouchableOpacity
            style={[styles.controlBtn, !cameraEnabled && styles.controlBtnActive]}
            onPress={() => {
              const next = !cameraEnabled;
              setCameraEnabled(next);
              toggleVideo(next);
            }}
          >
            <AppIcon name={cameraEnabled ? 'videocam-outline' : 'videocam-off-outline'} size={24} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>{cameraEnabled ? 'Camera' : 'Cam off'}</AppText>
        </View>

        <View style={styles.controlCol}>
          <TouchableOpacity style={styles.hangUpBtn} onPress={hangUp}>
            <AppIcon name="call" size={28} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>End</AppText>
        </View>
      </View>

      {/* ── Summarizing overlay ── */}
      {isSummarizing && (
        <View style={styles.summarizingOverlay} pointerEvents="none">
          <View style={styles.summarizingCard}>
            <ActivityIndicator size="small" color="#fff" />
            <AppText fixedColor style={styles.summarizingText}>
              Generating minutes from recording…
            </AppText>
          </View>
        </View>
      )}

      {/* ── Chat sheet ── */}
      {isMeeting && user?.uid && (
        <MeetingChatSheet
          visible={chatOpen}
          meetingId={meetingId!}
          userId={user.uid}
          userDisplayName={user.displayName || user.phoneNumber || 'You'}
          onClose={() => setChatOpen(false)}
        />
      )}
 
      {isMeeting && (
        <ParticipantPickerSheet
          visible={addOpen}
          selected={[]}
          excludeIds={excludeIds}
          onConfirm={handleAddParticipants}
          onClose={() => setAddOpen(false)}
          title="Add to meeting"
        />
      )}

      {/* ── Post-meeting report ── */}
      <Modal visible={reportOpen} transparent animationType="slide" onRequestClose={() => setReportOpen(false)}>
        <View style={styles.reportOverlay}>
          <View style={styles.reportSheet}>
            <AppBg />
            <View style={styles.handle} />
            <View style={styles.reportHeader}>
              <AppText style={[styles.reportTitle, { color: textColor }]}>Meeting Report</AppText>
              <TouchableOpacity onPress={() => setReportOpen(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <AppIcon name="close" size={22} color={COLORS.sub} />
              </TouchableOpacity>
            </View>
            <ScrollView contentContainerStyle={styles.reportContent} showsVerticalScrollIndicator={false}>
              <View style={[styles.reportMeta, bevel]}>
                <View style={styles.reportMetaRow}>
                  <AppIcon name="time-outline" size={14} color={COLORS.blue} />
                  <AppText style={[styles.reportMetaText, { color: textColor }]}>
                    Duration: {reportData ? fmtHuman(reportData.totalSeconds) : '—'}
                  </AppText>
                </View>
                <View style={styles.reportMetaRow}>
                  <AppIcon name="people-outline" size={14} color={COLORS.blue} />
                  <AppText style={[styles.reportMetaText, { color: textColor }]}>
                    Attendees: {reportData?.attendees.length ?? 0}
                  </AppText>
                </View>
                {reportData?.startedAt && (
                  <View style={styles.reportMetaRow}>
                    <AppIcon name="calendar-outline" size={14} color={COLORS.blue} />
                    <AppText style={[styles.reportMetaText, { color: textColor }]}>
                      Started: {reportData.startedAt.toLocaleString()}
                    </AppText>
                  </View>
                )}
                {reportData?.endedAt && (
                  <View style={styles.reportMetaRow}>
                    <AppIcon name="flag-outline" size={14} color={COLORS.blue} />
                    <AppText style={[styles.reportMetaText, { color: textColor }]}>
                      Ended: {reportData.endedAt.toLocaleString()}
                    </AppText>
                  </View>
                )}
              </View>

              <AppText style={[styles.reportSectionLabel, { color: COLORS.sub }]}>ATTENDANCE</AppText>
              {reportData?.attendees.length ? reportData.attendees.map((a, i) => (
                <View key={`${a.id}-${i}`} style={[styles.reportAttendeeRow, bevel]}>
                  <Avatar initials={(a.name || '??').split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase()} color={COLORS.blue} size={32} />
                  <View style={{ flex: 1 }}>
                    <AppText style={[styles.reportAttendeeName, { color: textColor }]} numberOfLines={1}>
                      {a.name}
                    </AppText>
                    <AppText style={[styles.reportAttendeeMeta, { color: COLORS.sub }]}>
                      {fmtHuman(a.seconds)} in meeting
                    </AppText>
                  </View>
                </View>
              )) : (
                <AppText style={[styles.reportEmpty, { color: COLORS.sub }]}>No attendance data.</AppText>
              )}

              {minutesText && (
                <>
                  <AppText style={[styles.reportSectionLabel, { color: COLORS.sub, marginTop: 18 }]}>MINUTES</AppText>
                  <View style={[styles.reportMeta, bevel]}>
                    <AppText style={{ color: textColor, fontSize: 13, lineHeight: 20 }} numberOfLines={8}>
                      {minutesText}
                    </AppText>
                  </View>
                </>
              )}

              {/* ── Recording attachment ── */}
              {reportRecordingUrl ? (
                <>
                  <AppText style={[styles.reportSectionLabel, { color: COLORS.sub, marginTop: 18 }]}>
                    RECORDING
                  </AppText>
                  <TouchableOpacity
                    style={[styles.reportMeta, bevel, { flexDirection: 'row', alignItems: 'center', gap: 12 }]}
                    onPress={() => Share.share({ url: reportRecordingUrl, message: reportRecordingUrl })}
                    activeOpacity={0.75}
                  >
                    <AppIcon name="mic-outline" size={22} color={COLORS.blue} />
                    <View style={{ flex: 1 }}>
                      <AppText style={[styles.reportMetaText, { color: textColor, fontWeight: '700' }]}>
                        Meeting Recording
                      </AppText>
                      <AppText style={[styles.reportMetaText, { color: COLORS.sub, fontSize: 11 }]} numberOfLines={1}>
                        Tap to share
                      </AppText>
                    </View>
                    <AppIcon name="share-outline" size={18} color={COLORS.blue} />
                  </TouchableOpacity>
                </>
              ) : isSummarizing ? (
                <View style={[styles.reportMeta, bevel, { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 18 }]}>
                  <ActivityIndicator size="small" color={COLORS.blue} />
                  <AppText style={[styles.reportMetaText, { color: COLORS.sub }]}>
                    Generating minutes from recording…
                  </AppText>
                </View>
              ) : null}

              <View style={styles.reportActions}>
                <TouchableOpacity
                  style={[styles.reportBtn, { backgroundColor: 'rgba(9,178,238,0.15)', borderColor: 'rgba(9,178,238,0.35)' }]}
                  onPress={exportMinutesPdf}
                  disabled={!minutesText}
                >
                  <AppIcon name="document-text-outline" size={18} color={COLORS.blue} />
                  <AppText style={[styles.reportBtnText, { color: COLORS.blue }]}>View Minutes PDF</AppText>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.reportBtn, { backgroundColor: 'rgba(34,197,94,0.15)', borderColor: 'rgba(34,197,94,0.35)' }]}
                  onPress={shareMinutesText}
                  disabled={!minutesText}
                >
                  <AppIcon name="share-outline" size={18} color="#16a34a" />
                  <AppText style={[styles.reportBtnText, { color: '#16a34a' }]}>Share Minutes</AppText>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function meetingTitleFallback(title: string | undefined, fallback: string) {
  return title || fallback;
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:        { flex: 1, backgroundColor: '#000' },
  darkOverlay: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.35)' },

  mainView:          { ...StyleSheet.absoluteFill },
  mainAvatarOverlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', gap: 14 },
  mainName: { fontSize: 24, fontWeight: '700', color: '#fff' },
  mainSub:  { fontSize: 13, color: 'rgba(255,255,255,0.60)' },

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

  recordingBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: 'rgba(239,68,68,0.85)',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: RADIUS.full,
  },
  recordingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#fff' },
  recordingBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },

  rightPanel: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 72 : Platform.OS === 'ios' ? 110 : 90,
    right: 10,
    alignItems: 'center',
    gap: 8,
  },

  pipTile: {
    width: PIP_W, height: PIP_H,
    borderRadius: RADIUS.md, overflow: 'hidden',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.30)',
    ...SHADOW.glow,
  },
  pipTouch: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
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
  pipOrgHint: {
    position: 'absolute', top: 4, right: 4,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },

  panelDivider: { width: 36, height: 1, backgroundColor: 'rgba(255,255,255,0.20)', marginVertical: 2 },

  sideBtn: {
    width: 48, height: 52,
    borderRadius: RADIUS.sm,
    backgroundColor: 'rgba(0,0,0,0.40)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    gap: 3,
  },
  sideBtnActive: {
    backgroundColor: 'rgba(9,178,238,0.35)',
    borderColor: 'rgba(9,178,238,0.55)',
  },
  sideBtnDisabled: { opacity: 0.6 },

  cameraToggleAlert: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 100 : 82,
    left: 12, right: 12,
    backgroundColor: 'rgba(10, 26, 48, 0.95)',
    borderRadius: RADIUS.lg, borderWidth: 1.5,
    borderColor: 'rgba(59, 130, 246, 0.5)',
    padding: 14, ...SHADOW.glow,
  },
  cameraToggleContent: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  cameraToggleTitle: { fontSize: 14, fontWeight: '600', color: '#fff' },
  cameraToggleSubtext: { fontSize: 12, color: 'rgba(255, 255, 255, 0.7)', marginTop: 2 },
  cameraToggleButtons: { flexDirection: 'row', gap: 8 },
  cameraToggleBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 10, borderRadius: RADIUS.md, ...SHADOW.card,
  },
  cameraToggleBtnPrimary: { backgroundColor: '#3b82f6' },
  cameraToggleBtnText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  controls: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end',
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    paddingTop: 16, paddingHorizontal: 4,
    backgroundColor: 'rgba(0,0,0,0.42)',
  },
  controlCol:   { alignItems: 'center', gap: 6 },
  controlLabel: { fontSize: 10, color: 'rgba(255,255,255,0.70)' },
  controlBtn: {
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.card,
  },
  controlBtnActive:    { backgroundColor: 'rgba(255,255,255,0.35)' },
  controlBtnRecording: { backgroundColor: '#ef4444', borderColor: '#ef4444' },
  hangUpBtn: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#e84343',
    alignItems: 'center', justifyContent: 'center',
    transform: [{ rotate: '135deg' }],
    ...SHADOW.button,
  },

  qualityBadge: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.card,
  },
  qualityAlert: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 72 : Platform.OS === 'ios' ? 110 : 90,
    left: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: RADIUS.md, ...SHADOW.card,
  },
  qualityText: { fontSize: 13, fontWeight: '600', color: '#fff' },

  aloneBanner: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 72 : Platform.OS === 'ios' ? 110 : 90,
    left: 12, right: 12,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(9,178,238,0.72)',
    ...SHADOW.card,
  },
  aloneText: { flex: 1, fontSize: 13, fontWeight: '600', color: '#fff' },

  recordingNoticeBanner: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 140 : 120,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(0,0,0,0.72)',
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: RADIUS.full,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.5)',
  },
  recordingNoticeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ef4444',
  },
  recordingNoticeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
    letterSpacing: 0.2,
  },

  summarizingOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  summarizingCard: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    backgroundColor: 'rgba(10,26,48,0.95)',
    paddingHorizontal: 18, paddingVertical: 14,
    borderRadius: RADIUS.lg,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
    ...SHADOW.glow,
  },
  summarizingText: { color: '#fff', fontSize: 13, fontWeight: '600' },

  // Report modal
  reportOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end',
  },
  reportSheet: {
    height: '82%',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    overflow: 'hidden',
    ...SHADOW.glow,
  },
  handle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.30)', marginTop: 10, marginBottom: 4,
  },
  reportHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 12,
  },
  reportTitle: { fontSize: 18, fontWeight: '700' },
  reportContent: { paddingHorizontal: 18, paddingBottom: 40, paddingTop: 6 },
  reportMeta: {
    borderRadius: RADIUS.lg, padding: 14, gap: 8,
    borderWidth: 1, borderColor: 'rgba(9,178,238,0.20)',
  },
  reportMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reportMetaText: { fontSize: 13 },
  reportSectionLabel: {
    fontSize: 11, fontWeight: '700', letterSpacing: 0.6,
    marginTop: 18, marginBottom: 10,
  },
  reportAttendeeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, borderRadius: RADIUS.md, marginBottom: 8,
  },
  reportAttendeeName: { fontSize: 14, fontWeight: '600' },
  reportAttendeeMeta: { fontSize: 11, marginTop: 2 },
  reportEmpty: { fontSize: 13, textAlign: 'center', paddingVertical: 12 },
  reportActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  reportBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 12, borderRadius: RADIUS.md,
    borderWidth: 1,
  },
  reportBtnText: { fontSize: 13, fontWeight: '700' },
});