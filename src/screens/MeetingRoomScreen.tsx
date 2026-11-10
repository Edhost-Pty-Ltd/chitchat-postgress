// ─── MeetingRoomScreen ────────────────────────────────────────────────────────
// Entry point for /meet/:meetingId links opened in the web app.
// Authenticated users join directly via VideoCall. Guest (unauthenticated)
// users enter a display name to mint a guest token and join.
//
// Server routes used:
//   GET  /meet/:id/info   — public, no auth — check meeting exists/joinable
//   POST /meet/:id/guest  — public, no auth — mint short-lived guest JWT
//
// The VideoCallScreen handles the actual WebRTC session once the user is
// authenticated (Firebase or guest JWT).

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, TextInput, TouchableOpacity, StyleSheet, Platform,
  ActivityIndicator, ScrollView,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { AppBg, AppText, AppIcon, useForeground, useGlass } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList } from '../types';
import { API_URL } from '../config/env';
import { endpoints } from '../api/endpoints';

type NavProp   = NativeStackNavigationProp<RootStackParamList, 'MeetingRoom'>;
type RouteP    = RouteProp<RootStackParamList, 'MeetingRoom'>;

type MeetingInfo = {
  id: string;
  title: string;
  type: 'online' | 'in-person';
  isActive: boolean;
  endedAt: string | null;
  joinedCount: number;
};

async function fetchMeetingInfo(meetingId: string): Promise<
  { exists: true; joinable: boolean; reason: string; meeting: MeetingInfo }
  | { exists: false; joinable: false; reason: string }
> {
  const base = API_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/meet/${encodeURIComponent(meetingId)}/info`);
  if (!res.ok) return { exists: false, joinable: false, reason: 'network_error' };
  return res.json();
}

async function fetchGuestToken(
  meetingId: string,
  displayName: string,
): Promise<{ token: string; guestId: string; displayName: string; meeting: MeetingInfo }> {
  const base = API_URL.replace(/\/+$/, '');
  const res = await fetch(`${base}/meet/${encodeURIComponent(meetingId)}/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).message ?? 'Failed to join meeting');
  }
  return res.json();
}

export default function MeetingRoomScreen() {
  const navigation  = useNavigation<NavProp>();
  const route       = useRoute<RouteP>();
  const { meetingId } = route.params;
  const { isSignedIn, user, userId } = useAuth();
  const { FG } = useForeground();
  const { bevel } = useGlass();

  const [info,        setInfo]       = useState<MeetingInfo | null>(null);
  const [infoError,   setInfoError]  = useState<string | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);

  // Guest-only state
  const [guestName,    setGuestName]    = useState('');
  const [joiningGuest, setJoiningGuest] = useState(false);
  const [guestError,   setGuestError]   = useState<string | null>(null);
  const nameInputRef = useRef<TextInput>(null);

  // ── Load meeting info ──────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchMeetingInfo(meetingId);
        if (cancelled) return;
        if (!data.exists) {
          setInfoError(
            data.reason === 'not_found'
              ? "This meeting doesn't exist or the link is invalid."
              : 'Invalid meeting link.',
          );
        } else if (!data.joinable) {
          setInfoError('This meeting has ended.');
        } else {
          setInfo(data.meeting);
          // If the user is already signed in, auto-join as a member.
          if (isSignedIn && userId) {
            setLoadingInfo(false);
            joinAsMember(data.meeting);
            return;
          }
        }
      } catch (err: any) {
        if (!cancelled) setInfoError('Could not reach the server. Check your connection.');
      } finally {
        if (!cancelled) setLoadingInfo(false);
      }
    })();
    return () => { cancelled = true; };
  }, [meetingId, isSignedIn, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Authenticated member join ─────────────────────────────────────────────
  const joinAsMember = useCallback((meeting: MeetingInfo) => {
    navigation.replace('VideoCall', {
      callId: meeting.id,
      isOutgoing: false,
      otherParty: {
        userId: 'meeting',
        displayName: meeting.title,
        photoUrl: null,
      },
    });
  }, [navigation]);

  // ── Guest join ────────────────────────────────────────────────────────────
  const handleGuestJoin = async () => {
    const name = guestName.trim();
    if (!name) { setGuestError('Please enter your name.'); return; }
    if (!info) return;

    setGuestError(null);
    setJoiningGuest(true);
    try {
      const { token } = await fetchGuestToken(info.id, name);
      // Store the guest token so VideoCallScreen can use it for signalling
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(`meeting_guest_token_${info.id}`, token);
        sessionStorage.setItem(`meeting_guest_name_${info.id}`, name);
      }
      navigation.replace('VideoCall', {
        callId: info.id,
        isOutgoing: false,
        otherParty: {
          userId: 'guest',
          displayName: info.title,
          photoUrl: null,
        },
      });
    } catch (err: any) {
      setGuestError(err.message ?? 'Failed to join. Please try again.');
    } finally {
      setJoiningGuest(false);
    }
  };

  // ── Loading ───────────────────────────────────────────────────────────────
  if (loadingInfo) {
    return (
      <View style={styles.centred}>
        <AppBg />
        <ActivityIndicator size="large" color={COLORS.blue} />
        <AppText style={[styles.loadingText, { color: FG.secondary }]}>
          Looking up meeting…
        </AppText>
      </View>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (infoError) {
    return (
      <View style={styles.centred}>
        <AppBg />
        <View style={styles.errorIcon}>
          <AppIcon name="calendar-outline" size={44} color={COLORS.sub} />
        </View>
        <AppText style={[styles.errorTitle, { color: FG.primary }]}>
          Meeting Unavailable
        </AppText>
        <AppText style={[styles.errorSub, { color: FG.secondary }]}>
          {infoError}
        </AppText>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Chats')}
          activeOpacity={0.8}
        >
          <AppText style={styles.backBtnText}>Go to ChitChat</AppText>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Auto-joining signed-in user ───────────────────────────────────────────
  if (isSignedIn) {
    return (
      <View style={styles.centred}>
        <AppBg />
        <ActivityIndicator size="large" color={COLORS.blue} />
        <AppText style={[styles.loadingText, { color: FG.secondary }]}>
          Joining {info?.title ?? 'meeting'}…
        </AppText>
      </View>
    );
  }

  // ── Guest pre-join screen ─────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      <AppBg />
      <LinearGradient
        colors={['rgba(9,178,238,0.08)', 'rgba(9,178,238,0.02)', 'transparent']}
        style={StyleSheet.absoluteFill}
      />

      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Brand */}
        <View style={styles.brandRow}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.brandIcon}>
            <AppIcon name="chatbubbles" size={20} color="#fff" fixedColor />
          </LinearGradient>
          <AppText style={styles.brandName}>ChitChat Business</AppText>
        </View>

        {/* Meeting card */}
        <View style={[styles.card, bevel]}>
          <View style={styles.meetingIconWrap}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.meetingIcon}>
              <AppIcon name="videocam" size={22} color="#fff" fixedColor />
            </LinearGradient>
          </View>

          <AppText style={[styles.meetingTitle, { color: FG.primary }]}>
            {info?.title ?? 'Meeting'}
          </AppText>

          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: info?.isActive ? COLORS.green : COLORS.amber }]} />
            <AppText style={[styles.statusText, { color: FG.secondary }]}>
              {info?.isActive
                ? `Live now · ${info.joinedCount} participant${info.joinedCount === 1 ? '' : 's'}`
                : 'Meeting scheduled — join when it starts'}
            </AppText>
          </View>

          <View style={styles.divider} />

          <AppText style={[styles.inputLabel, { color: FG.secondary }]}>
            Your name
          </AppText>
          <View style={[styles.inputWrap, bevel]}>
            <AppIcon name="person-outline" size={17} color={COLORS.sub} />
            <TextInput
              ref={nameInputRef}
              style={[styles.input, { color: FG.primary }]}
              placeholder="Enter your name to join"
              placeholderTextColor={COLORS.textFaint}
              value={guestName}
              onChangeText={(t) => { setGuestName(t); setGuestError(null); }}
              returnKeyType="done"
              onSubmitEditing={handleGuestJoin}
              autoFocus
              maxLength={80}
            />
          </View>

          {guestError && (
            <AppText style={styles.guestError}>{guestError}</AppText>
          )}

          <TouchableOpacity
            onPress={handleGuestJoin}
            activeOpacity={0.85}
            disabled={joiningGuest || !guestName.trim()}
          >
            <LinearGradient
              colors={guestName.trim() ? GRADIENTS.primary : ['#ccc', '#bbb']}
              style={styles.joinBtn}
            >
              {joiningGuest
                ? <ActivityIndicator color="#fff" size="small" />
                : (
                  <>
                    <AppIcon name="videocam" size={18} color="#fff" fixedColor />
                    <AppText style={styles.joinBtnText} fixedColor>Join Meeting</AppText>
                  </>
                )}
            </LinearGradient>
          </TouchableOpacity>

          <AppText style={[styles.signInHint, { color: FG.secondary }]}>
            Already have an account?{' '}
            <AppText
              style={[styles.signInLink, { color: COLORS.blue }]}
              onPress={() => navigation.navigate('SignIn')}
            >
              Sign in for full access
            </AppText>
          </AppText>
        </View>

        {/* Footer */}
        <AppText style={[styles.footer, { color: FG.faint }]}>
          Your name is visible only to other participants.{'\n'}
          No account required to join.
        </AppText>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1 },
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 32,
  },

  loadingText: { fontSize: 15, marginTop: 8 },

  errorIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(142,142,147,0.12)',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 8,
  },
  errorTitle: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  errorSub:   { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  backBtn: {
    marginTop: 20,
    paddingHorizontal: 28, paddingVertical: 12,
    borderRadius: RADIUS.md,
    backgroundColor: COLORS.blue,
  },
  backBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: Platform.OS === 'web' ? 40 : 80,
    paddingBottom: 60,
  },

  brandRow: {
    flexDirection: 'row', alignItems: 'center',
    gap: 10, marginBottom: 40, alignSelf: 'flex-start',
  },
  brandIcon: {
    width: 38, height: 38, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },
  brandName: { fontSize: 16, fontWeight: '800', color: COLORS.text },

  card: {
    width: '100%',
    maxWidth: 440,
    borderRadius: RADIUS.xl,
    padding: 28,
    gap: 0,
    ...SHADOW.card,
  },

  meetingIconWrap: { alignItems: 'center', marginBottom: 16 },
  meetingIcon: {
    width: 60, height: 60, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.glow,
  },
  meetingTitle: {
    fontSize: 22, fontWeight: '800', textAlign: 'center', marginBottom: 10,
    letterSpacing: -0.3,
  },
  statusRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 7, marginBottom: 20,
  },
  statusDot:  { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 13 },

  divider: {
    height: 1, backgroundColor: COLORS.border, marginBottom: 20,
  },

  inputLabel: { fontSize: 12, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: RADIUS.md, padding: 13, marginBottom: 4,
  },
  input: { flex: 1, fontSize: 15 },

  guestError: { fontSize: 13, color: COLORS.missed, marginTop: 4, marginBottom: 4 },

  joinBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, borderRadius: RADIUS.md, paddingVertical: 15,
    marginTop: 16, ...SHADOW.button,
  },
  joinBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  signInHint: { fontSize: 13, textAlign: 'center', marginTop: 16 },
  signInLink: { fontWeight: '700' },

  footer: {
    fontSize: 12, textAlign: 'center', lineHeight: 18,
    marginTop: 28, maxWidth: 340,
  },
});
