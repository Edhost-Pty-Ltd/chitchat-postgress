// ─── AudioCallScreen ──────────────────────────────────────────────────────────
// Uses the shared CallContext WebRTC peer connection that was initialised by
// useOutgoingCall (for outgoing) or useIncomingCallAnswer (for incoming).
// The screen NO LONGER creates its own useWebRTC instance — doing so caused a
// dual-peer-connection bug where two offers were sent and the answer listener
// was destroyed when CallsScreen unmounted.
import React, { useState, useRef, useEffect } from 'react';
import {
  View, TouchableOpacity, StyleSheet,
  Platform, BackHandler,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCallContext } from '../context/CallContext';
import { useIncomingCallAnswer } from '../hooks/useIncomingCallAnswer';
import { useAuth } from '../hooks/useAuth';
import { useFloatingCall } from '../context/FloatingCallContext';
import { endpoints } from '../api/endpoints';
import { SignalingService } from '../services/signalingService';
import { getOrCreateDirectChat } from '../hooks/useChatActions';
import { setSpeakerphoneOn } from '../utils/webrtc-platform';

import { AppText, AppIcon, AppBg, useGlass } from '../context/ThemeContext';
import { Avatar } from '../components';
import { COLORS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList } from '../types';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'AudioCall'>;
type RouteP  = RouteProp<RootStackParamList, 'AudioCall'>;

export default function AudioCallScreen() {
  const navigation = useNavigation<NavProp>();
  const route      = useRoute<RouteP>();
  const { callId, isOutgoing, otherParty } = route.params;
  const { user } = useAuth();
  const { minimizeCall, updateDuration } = useFloatingCall();
  const { bevel } = useGlass();

  const [muted,       setMuted]      = useState(false);
  // Default to speaker ON for audio calls. iOS routes WebRTC voiceChat audio to
  // the earpiece by default, which is inaudible unless the phone is held to the
  // ear. Defaulting to speaker makes the call audible; the user can toggle off.
  const [speakerOn,   setSpeakerOn]  = useState(true);
  const [duration,    setDuration]   = useState(0);
  const [callStatus,  setCallStatus] = useState<string>(isOutgoing ? 'ringing' : 'connecting');

  const timerRef           = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubscribeCallRef = useRef<(() => void) | null>(null);
  const answerApplied      = useRef(false);
  const iceApplied         = useRef<Set<string>>(new Set());

  // Shared WebRTC instance from CallContext.
  const {
    connectionState,
    networkQuality,
    setIsCaller,
    setActiveCallId,
    initializePeerConnection,
    createOffer,
    createAnswer,
    setRemoteAnswer,
    addIceCandidate,
    toggleMute: toggleMuteCtx,
    startNetworkMonitoring,
    cleanup: cleanupWebRTC,
  } = useCallContext();

  const incomingCall = useIncomingCallAnswer();

  // NOTE: This screen intentionally owns no expo-audio player. The ringtone is
  // owned by IncomingCallManager (callee only). A local useRingtone() instance
  // here could never stop that ringtone (separate player), and calling its
  // stop() on mount ran player.pause(), which made expo-audio deactivate the
  // iOS AVAudioSession right after getUserMedia started WebRTC's audio engine —
  // silencing the call in both directions.

  // Tell CallContext whether this device is the caller so outgoing ICE
  // candidates are tagged correctly (caller vs callee) for the relay.
  useEffect(() => { setIsCaller(isOutgoing); }, [isOutgoing, setIsCaller]);

  // Update floating overlay while minimised
  useEffect(() => {
    updateDuration(fmt(duration));
  }, [duration, updateDuration]);

  // Track connection state changes from context
  useEffect(() => {
    if (connectionState === 'connected') {
      setCallStatus('connected');
      startNetworkMonitoring();
    } else if (connectionState === 'disconnected' || connectionState === 'failed') {
      setCallStatus('disconnected');
    }
  }, [connectionState, startNetworkMonitoring]);

  // Apply the output route whenever the speaker toggle changes OR the call
  // becomes connected (iOS resets the route to the earpiece when the voiceChat
  // audio engine starts, so we must (re)assert speaker once audio is live).
  useEffect(() => {
    if (connectionState === 'connected') {
      setSpeakerphoneOn(speakerOn);
    }
  }, [speakerOn, connectionState]);

  // ── Call setup ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let ended = false;
    const appliedIce = new Set<string>();

    const endFromRemote = () => {
      if (ended) return;
      ended = true;
      cleanupWebRTC();
      navigation.goBack();
    };

    const applyRemoteIce = (candidates?: RTCIceCandidateInit[]) => {
      if (!candidates) return;
      for (const cand of candidates) {
        const key = `${cand.candidate}-${cand.sdpMLineIndex}-${cand.sdpMid}`;
        if (appliedIce.has(key)) continue;
        appliedIce.add(key);
        addIceCandidate(cand).catch((e) => console.warn('[AudioCall] addIceCandidate failed:', e));
      }
    };

    const setupCall = async () => {
      try {
        setActiveCallId(callId);
        await SignalingService.joinCall(callId);

        if (isOutgoing) {
          // ── OUTGOING: peer connection & offer already sent by useOutgoingCall.
          // Re-attach a listener here because the one in CallsScreen was destroyed
          // when that screen unmounted. Handle answer + ICE directly on context.
          unsubscribeCallRef.current = SignalingService.onCallUpdated(callId, async (data) => {
            if (!data) return;

            if (data.status === 'ended' || data.status === 'rejected' || data.status === 'missed') {
              endFromRemote();
              return;
            }

            // Apply the callee's answer once
            if (data.answer && data.status === 'accepted' && !answerApplied.current) {
              answerApplied.current = true;
              try {
                await setRemoteAnswer(data.answer);
                setCallStatus('connected');
              } catch (err) {
                console.error('[AudioCall] setRemoteAnswer failed:', err);
              }
            }

            applyRemoteIce(data.calleeIceCandidates);
          });
        } else {
          // ── INCOMING: create answer using the shared context peer connection.
          // Pre-warm: acquire the mic now so getUserMedia runs in parallel with
          // waiting for the offer. initializePeerConnection is idempotent.
          await initializePeerConnection(false);

          unsubscribeCallRef.current = SignalingService.onCallUpdated(callId, async (data) => {
            if (!data) return;

            if (data.status === 'ended') {
              endFromRemote();
              return;
            }

            // Answer once we have the offer
            if (data.offer && !answerApplied.current) {
              answerApplied.current = true;
              const ok = await incomingCall.answerCall(callId, data.offer, 'audio');
              if (ok) setCallStatus('connected');
            }

            applyRemoteIce(data.callerIceCandidates);
          });
        }
      } catch (err) {
        console.error('[AudioCall] Setup failed:', err);
        setCallStatus('failed');
      }
    };

    void setupCall();

    return () => {
      if (unsubscribeCallRef.current) unsubscribeCallRef.current();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Start the call-duration timer the moment WebRTC actually connects
  useEffect(() => {
    if (callStatus === 'connected' && !timerRef.current) {
      timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
    }
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [callStatus]);

  // Handle Android back button — minimize call instead of ending it
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      minimizeCall({
        callId,
        displayName: otherParty.displayName,
        avatar: otherParty.displayName.split(' ').map((n) => n[0]).join('').toUpperCase(),
        color: COLORS.blue,
        duration: fmt(duration),
        isVideo: false,
        isOutgoing,
        otherParty,
      });
      navigation.goBack();
      return true;
    });
    return () => sub.remove();
  }, [duration, callId, isOutgoing, otherParty, minimizeCall, navigation]);

  // ── helpers ─────────────────────────────────────────────────────────────────
  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const hangUp = async () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (unsubscribeCallRef.current) { unsubscribeCallRef.current(); unsubscribeCallRef.current = null; }
    try { await SignalingService.updateCallStatus(callId, 'ended', duration); } catch {}
    try { await endpoints.endCall(callId); } catch {}
    cleanupWebRTC();
    navigation.goBack();
  };

  const openChat = async () => {
    if (!user?.uid) return;
    try {
      const chatId = await getOrCreateDirectChat(user.uid, otherParty.userId);
      navigation.navigate('Chat', {
        chatId, displayName: otherParty.displayName, isGroup: false,
        otherUserId: otherParty.userId, otherUserPhoto: otherParty.photoUrl,
      });
    } catch (err) { console.error('[AudioCall] openChat:', err); }
  };

  const switchToVideo = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (unsubscribeCallRef.current) { unsubscribeCallRef.current(); unsubscribeCallRef.current = null; }
    navigation.replace('VideoCall', { callId, isOutgoing, otherParty });
  };

  const handleMuteToggle = () => {
    const next = !muted;
    setMuted(next);
    toggleMuteCtx(next);
  };

  const initials = otherParty.displayName.split(' ').map((n) => n[0]).join('').toUpperCase() || '??';

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      <AppBg />
      <View style={styles.overlay} />

      {/* ── Main area ── */}
      <View style={styles.mainArea}>
        <View style={styles.avatarRing}>
          <Avatar initials={initials} color={COLORS.blue} size={110} imageUrl={otherParty.photoUrl} />
        </View>
        <AppText fixedColor style={styles.callerName}>{otherParty.displayName}</AppText>
        <AppText fixedColor style={styles.callStatus}>
          {callStatus === 'ringing'      ? 'Ringing…'
            : callStatus === 'connecting' ? 'Connecting…'
            : callStatus === 'connected'  ? `Audio call · ${fmt(duration)}`
            : callStatus === 'disconnected' ? 'Reconnecting…'
            : callStatus === 'ended'      ? 'Call ended'
            : `${callStatus} · ${fmt(duration)}`}
        </AppText>
      </View>

      {/* ── Top bar ── */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => {
          minimizeCall({
            callId, displayName: otherParty.displayName,
            avatar: initials, color: COLORS.blue,
            duration: fmt(duration), isVideo: false, isOutgoing, otherParty,
          });
          navigation.goBack();
        }} style={styles.iconBtn}>
          <AppIcon name="chevron-back" size={26} color="rgba(255,255,255,0.80)" fixedColor />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <AppText fixedColor style={styles.topName}>{otherParty.displayName}</AppText>
          <AppText fixedColor style={styles.topStatus}>{fmt(duration)}</AppText>
        </View>
        <TouchableOpacity style={[styles.iconBtn, styles.iconBtnGlass, bevel]} onPress={openChat}>
          <AppIcon name="chatbubble-outline" size={20} color="#fff" fixedColor />
        </TouchableOpacity>
      </View>

      {/* ── Controls ── */}
      <View style={styles.controls}>
        <View style={styles.controlCol}>
          <TouchableOpacity style={[styles.controlBtn, muted && styles.controlBtnActive]} onPress={handleMuteToggle}>
            <AppIcon name={muted ? 'mic-off' : 'mic-outline'} size={24} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>{muted ? 'Unmute' : 'Mute'}</AppText>
        </View>

        <View style={styles.controlCol}>
          <TouchableOpacity style={[styles.controlBtn, speakerOn && styles.controlBtnActive]} onPress={() => setSpeakerOn((s) => !s)}>
            <AppIcon name={speakerOn ? 'volume-high' : 'ear-outline'} size={24} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>{speakerOn ? 'Speaker' : 'Earpiece'}</AppText>
        </View>

        <View style={styles.controlCol}>
          <TouchableOpacity style={styles.controlBtn} onPress={switchToVideo}>
            <AppIcon name="videocam-outline" size={24} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>Video</AppText>
        </View>

        <View style={styles.controlCol}>
          <TouchableOpacity style={styles.hangUpBtn} onPress={hangUp}>
            <AppIcon name="call" size={26} color="#fff" fixedColor />
          </TouchableOpacity>
          <AppText fixedColor style={styles.controlLabel}>End</AppText>
        </View>
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:    { flex: 1 },
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.55)' },

  mainArea: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center', justifyContent: 'center', gap: 14,
  },
  avatarRing: {
    padding: 6, borderRadius: 68,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.30)',
    ...SHADOW.glow,
  },
  callerName: { fontSize: 26, fontWeight: '700', color: '#fff' },
  callStatus: { fontSize: 15, color: 'rgba(255,255,255,0.65)' },

  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 54 : 36,
    paddingBottom: 12, paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.30)', gap: 6,
  },
  iconBtn:      { padding: 8 },
  iconBtnGlass: { borderRadius: 20 },
  topName:      { fontSize: 15, fontWeight: '700', color: '#fff' },
  topStatus:    { fontSize: 11, color: 'rgba(255,255,255,0.65)', marginTop: 2 },

  controls: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-around', alignItems: 'flex-end',
    paddingBottom: Platform.OS === 'ios' ? 40 : 24,
    paddingTop: 16, paddingHorizontal: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
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
});
