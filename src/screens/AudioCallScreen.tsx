// ─── Screen: Audio Call ──────────────────────────────────────────────────────
// • Duration preserved when switching to/from VideoCall
// • Chat button → opens conversation without ending call
// • Switch to video → VideoCallScreen with same duration (call continues)
// • Camera toggle shows local PiP (works on mobile + web)
import React, { useState, useRef, useEffect } from 'react';
import {
  View, TouchableOpacity, StyleSheet, Dimensions,
  Platform, Modal, ScrollView, Pressable, BackHandler,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { useWebRTC } from '../hooks/useWebRTC';
import { useAuth } from '../hooks/useAuth';
import { useFloatingCall } from '../context/FloatingCallContext';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { getOrCreateDirectChat } from '../hooks/useChatActions';

import { AppText, AppIcon, AppBg, useGlass } from '../context/ThemeContext';
import { Avatar } from '../components';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList, Contact } from '../types';
import { CONTACTS } from '../data/mockData';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'AudioCall'>;
type RouteP  = RouteProp<RootStackParamList, 'AudioCall'>;

const { height } = Dimensions.get('window');

export default function AudioCallScreen() {
  const navigation = useNavigation<NavProp>();
  const route      = useRoute<RouteP>();
  const { callId, isOutgoing, otherParty } = route.params;
  const { user } = useAuth();
  const { minimizeCall, updateDuration } = useFloatingCall();
  const { bevel } = useGlass();

  const [muted,        setMuted]        = useState(false);
  const [speakerOn,    setSpeakerOn]    = useState(false);
  const [duration,     setDuration]     = useState(0);
  const [addOpen,      setAddOpen]      = useState(false);
  const [callStatus,   setCallStatus]   = useState<string>('connecting');
  const [showQuality,  setShowQuality]  = useState(false);

  // WebRTC hook for managing peer connection and streams
  const {
    connectionState,
    networkQuality,
    initializePeerConnection,
    createOffer,
    createAnswer,
    setRemoteAnswer,
    addIceCandidate,
    toggleMute: toggleMuteWebRTC,
    startNetworkMonitoring,
    cleanup: cleanupWebRTC,
  } = useWebRTC({
    onConnectionStateChange: (state) => {
      console.log('[AudioCall] Connection state:', state);
      if (state === 'connected') {
        setCallStatus('connected');
        startNetworkMonitoring();
      } else if (state === 'disconnected' || state === 'failed') {
        setCallStatus('disconnected');
      }
    },
    onNetworkQualityChange: (quality) => {
      console.log('[AudioCall] Network quality:', quality);
      if (quality === 'poor' || quality === 'fair') {
        setShowQuality(true);
        setTimeout(() => setShowQuality(false), 3000);
      }
    },
  });

  // Build contact from otherParty
  const contact: Contact = {
    id: parseInt(otherParty.userId) || -2,
    name: otherParty.displayName,
    avatar: otherParty.displayName.split(' ').map((n) => n[0]).join('').toUpperCase(),
    color: COLORS.blue,
    status: 'online',
    lastMsg: '',
    time: '',
    unread: 0,
  };

  const [participants, setParticipants] = useState<Contact[]>([contact]);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unsubscribeCallRef = useRef<(() => void) | null>(null);

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

        // Initialize WebRTC peer connection for audio only
        await initializePeerConnection(false); // false for audio-only call

        if (isOutgoing) {
          // Caller: Create offer
          console.log('[AudioCall] Creating offer as caller...');
          const offer = await createOffer(false);
          
          // Update call document with offer
          await callRef.update({
            offer: offer,
            status: 'ringing',
          });

          // Listen for answer from callee
          unsubscribeCallRef.current = callRef.onSnapshot((snapshot) => {
            const data = snapshot.data();
            if (data?.answer) {
              console.log('[AudioCall] Received answer, setting remote description...');
              setRemoteAnswer(data.answer).catch(console.error);
            }
            if (data?.iceCandidates) {
              data.iceCandidates.forEach((candidate: any) => {
                if (candidate.from !== otherParty.userId) return;
                addIceCandidate(candidate).catch(console.error);
              });
            }
            if (data?.status === 'ended') {
              navigation.goBack();
            }
          });
        } else {
          // Callee: Listen for offer and create answer
          console.log('[AudioCall] Waiting for offer as callee...');
          
          unsubscribeCallRef.current = callRef.onSnapshot(async (snapshot) => {
            const data = snapshot.data();
            if (data?.offer) {
              console.log('[AudioCall] Received offer, creating answer...');
              const answer = await createAnswer(data.offer);
              
              await callRef.update({
                answer: answer,
                status: 'active',
              });
            }
            if (data?.iceCandidates) {
              data.iceCandidates.forEach((candidate: any) => {
                if (candidate.from === otherParty.userId) return;
                addIceCandidate(candidate).catch(console.error);
              });
            }
            if (data?.status === 'ended') {
              navigation.goBack();
            }
          });
        }

        // Start call timer
        timerRef.current = setInterval(() => setDuration((d) => d + 1), 1000);
      } catch (error) {
        console.error('[AudioCall] Setup failed:', error);
        setCallStatus('failed');
      }
    };

    setupCall();

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (unsubscribeCallRef.current) unsubscribeCallRef.current();
      cleanupWebRTC();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle Android back button - minimize call instead of ending it
  useEffect(() => {
    const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
      // Minimize the call
      minimizeCall({
        callId,
        displayName: contact.name,
        avatar: contact.avatar,
        color: contact.color,
        duration: fmt(duration),
        isVideo: false,
        isOutgoing,
        otherParty,
      });
      
      // Navigate back without ending call
      navigation.goBack();
      return true; // Prevent default back behavior
    });

    return () => backHandler.remove();
  }, [duration, callId, isOutgoing, otherParty, contact, minimizeCall, navigation]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update floating call duration while minimized
  useEffect(() => {
    updateDuration(fmt(duration));
  }, [duration, updateDuration]);

  const fmt = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  const hangUp = async () => {
    try {
      // End call in Firestore
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('calls').doc(callId).update({
        status: 'ended',
        endedAt: new Date(),
      });
    } catch (error) {
      console.error('[AudioCall] Failed to update call status:', error);
    }
    
    cleanupWebRTC();
    navigation.goBack();
  };

  const openChat = async () => {
    try {
      if (!user?.uid) {
        console.error('[AudioCall] Cannot open chat: user not authenticated');
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
      console.error('[AudioCall] Failed to open chat:', error);
    }
  };

  // Switch to video — save duration and cleanly transition
  const switchToVideo = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    
    // Save current duration to Firestore before switching
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('calls').doc(callId).update({
        lastDuration: duration,
        videoUpgradeRequest: {
          requestedBy: user?.uid || 'unknown',
          timestamp: new Date(),
        },
      });
    } catch (error) {
      console.error('[AudioCall] Failed to save duration:', error);
    }
    
    cleanupWebRTC();
    navigation.replace('VideoCall', { callId, isOutgoing, otherParty });
  };

  const handleMuteToggle = () => {
    const newMuted = !muted;
    setMuted(newMuted);
    toggleMuteWebRTC(newMuted);
  };

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

  const addContact = (c: Contact) => {
    if (participants.some((p) => p.id === c.id)) return;
    setParticipants((prev) => [...prev, c]);
    setAddOpen(false);
  };

  const availableContacts = CONTACTS.filter((c) => !participants.some((p) => p.id === c.id));

  return (
    <View style={styles.root}>
      <AppBg />
      <View style={styles.overlay} />

      {/* ── Main area ── */}
      <View style={styles.mainArea}>
        <View style={styles.avatarRing}>
          <Avatar initials={contact.avatar} color={contact.color} size={110} />
        </View>
        <AppText fixedColor style={styles.callerName}>{contact.name}</AppText>
        <AppText fixedColor style={styles.callStatus}>
          {callStatus === 'connecting' ? 'Connecting...' : 'Audio call'} · {fmt(duration)}
        </AppText>
        {participants.length > 1 && (
          <View style={styles.extraRow}>
            {participants.slice(1).map((p) => (
              <Avatar key={p.id} initials={p.avatar} color={p.color} size={36} />
            ))}
            <AppText fixedColor style={styles.extraLabel}>
              +{participants.length - 1} on call
            </AppText>
          </View>
        )}
        {/* Network quality badge */}
        {networkQuality !== 'unknown' && (
          <View style={[styles.qualityBadge, { backgroundColor: getQualityColor() }]}>
            <AppIcon 
              name={networkQuality === 'excellent' || networkQuality === 'good' ? 'wifi' : 'wifi-outline'} 
              size={16} 
              color="#fff" 
              fixedColor 
            />
            <AppText fixedColor style={styles.qualityBadgeText}>{getQualityText()}</AppText>
          </View>
        )}
      </View>

      {/* Network quality alert */}
      {showQuality && (networkQuality === 'poor' || networkQuality === 'fair') && (
        <View style={[styles.qualityAlert, { backgroundColor: getQualityColor() }]}>
          <AppIcon name="warning-outline" size={16} color="#fff" fixedColor />
          <AppText fixedColor style={styles.qualityText}>{getQualityText()}</AppText>
        </View>
      )}

      {/* ── Top bar ── */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={hangUp} style={styles.iconBtn}>
          <AppIcon name="chevron-back" size={26} color="rgba(255,255,255,0.80)" fixedColor />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <AppText fixedColor style={styles.topName}>{contact.name}</AppText>
          <AppText fixedColor style={styles.topStatus}>
            {fmt(duration)} · {participants.length} participant{participants.length > 1 ? 's' : ''}
          </AppText>
        </View>

        {/* Chat button */}
        <TouchableOpacity style={[styles.iconBtn, styles.iconBtnGlass, bevel]} onPress={openChat}>
          <AppIcon name="chatbubble-outline" size={20} color="#fff" fixedColor />
        </TouchableOpacity>

        {/* Add person */}
        <TouchableOpacity style={[styles.iconBtn, styles.iconBtnGlass, bevel]}
          onPress={() => setAddOpen(true)}>
          <AppIcon name="person-add-outline" size={20} color="#fff" fixedColor />
        </TouchableOpacity>
      </View>

      {/* ── Controls ── */}
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
                  onPress={() => addContact(c)} activeOpacity={0.8}>
                  <Avatar initials={c.avatar} color={c.color} size={46} status={c.status} />
                  <View style={styles.addContactMeta}>
                    <AppText fixedColor style={styles.addContactName}>{c.name}</AppText>
                    <AppText fixedColor style={styles.addContactSub}>
                      {c.status === 'online' ? 'Online' : 'Tap to add'}
                    </AppText>
                  </View>
                  <LinearGradient colors={GRADIENTS.primary} style={styles.addIconWrap}>
                    <AppIcon name="call-outline" size={18} color="#fff" fixedColor />
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
  extraRow:   { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  extraLabel: { fontSize: 13, color: 'rgba(255,255,255,0.65)' },

  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center',
    paddingTop: Platform.OS === 'ios' ? 54 : 36,
    paddingBottom: 12, paddingHorizontal: 12,
    backgroundColor: 'rgba(0,0,0,0.30)', gap: 6,
  },
  iconBtn:      { padding: 8 },
  iconBtnGlass: {
    borderRadius: 20,
  },
  iconBtnActive: {
    backgroundColor: 'rgba(30,156,240,0.35)',
    borderColor: 'rgba(30,156,240,0.55)',
  },
  topName:   { fontSize: 15, fontWeight: '700', color: '#fff' },
  topStatus: { fontSize: 11, color: 'rgba(255,255,255,0.65)', marginTop: 2 },

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

  addOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.50)' },
  addSheet: {
    backgroundColor: '#0d2040',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: height * 0.65,
    paddingBottom: Platform.OS === 'ios' ? 40 : 20,
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: RADIUS.full,
    marginTop: 8,
    ...SHADOW.card,
  },
  qualityBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
  qualityAlert: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 100 : 82,
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
});
