// ─── Screen: Calendar ────────────────────────────────────────────────────────
import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, TextInput, Modal,
  Pressable, ScrollView, Animated, Platform, ActivityIndicator,
  Alert, Image, Easing, Share,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import DateTimePickerModal from 'react-native-modal-datetime-picker';
import firestore from '@react-native-firebase/firestore';
import * as Notifications from 'expo-notifications';
import * as Contacts from 'expo-contacts';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { readAsStringAsync, EncodingType } from 'expo-file-system/legacy';

import { BottomNav } from '../components';
import { ParticipantPickerSheet } from '../components/ParticipantPickerSheet';
import { useAuth } from '../context/AuthContext';
import { useContacts, AppContact } from '../hooks/useContacts';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList } from '../types';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';

const GEMINI_API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;

type NavProp = NativeStackNavigationProp<RootStackParamList, 'Calendar'>;

type TabType = 'Upcoming' | 'Past';
const REMINDER_MILESTONES = [60, 30, 15, 10];

interface Meeting {
  id: string;
  title: string;
  date: Date;
  endDate: Date | null;
  duration: string;
  participants: string[];
  organizerId: string;
  type: 'online' | 'in-person';
  reminders: number[];
  minutes: string | null;
  hasRecordings: boolean;
  recordings: { url: string; durationMs: number }[];
  attendance: string[]; // joinedMembers — who actually attended
  isActive: boolean;
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false,
    shouldShowBanner: true, shouldShowList: true,
  }),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
const stringToColor = (str: string) => {
  const c = ['#f97316','#8b5cf6','#ec4899','#06b6d4','#10b981','#f59e0b','#6366f1','#e11d48'];
  let h = 0; for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return c[Math.abs(h) % c.length];
};
const getInitials = (n: string) => {
  const p = n.trim().split(' ');
  return p.length >= 2 ? (p[0][0] + p[p.length - 1][0]).toUpperCase() : n.slice(0, 2).toUpperCase();
};
const formatTime = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const formatDate = (d: Date) => d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
const formatDateFull = (d: Date) => d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
const calcDuration = (s: Date, e: Date) => {
  const m = Math.round((e.getTime() - s.getTime()) / 60000);
  if (m <= 0) return '0m';
  const h = Math.floor(m / 60), r = m % 60;
  return h > 0 && r > 0 ? `${h}h ${r}m` : h > 0 ? `${h}h` : `${r}m`;
};
const deriveEnd = (start: Date, duration: string): Date => {
  const hMatch = duration.match(/(\d+)\s*h/);
  const mMatch = duration.match(/(\d+)\s*m/);
  const mins = (hMatch ? parseInt(hMatch[1], 10) * 60 : 0) + (mMatch ? parseInt(mMatch[1], 10) : 0);
  return new Date(start.getTime() + (mins || 60) * 60000);
};
const getEndTime = (m: Meeting): Date => m.endDate ?? deriveEnd(m.date, m.duration);
const isMeetingActive = (m: Meeting, now: Date) => m.isActive && now >= m.date && now <= getEndTime(m);
const isMeetingPast   = (m: Meeting, now: Date) => !m.isActive || getEndTime(m) < now;

const fmtRemaining = (ms: number) => {
  if (ms <= 0) return 'Ending…';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s left`;
  return `${s}s left`;
};

function LiveDot({ size = 10 }: { size?: number }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.in(Easing.ease),  useNativeDriver: true }),
    ]));
    loop.start(); return () => loop.stop();
  }, [pulse]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View pointerEvents="none" style={{
        position: 'absolute', width: size, height: size, borderRadius: size / 2,
        backgroundColor: '#22c55e', transform: [{ scale }], opacity,
      }} />
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#22c55e' }} />
    </View>
  );
}

function ContactAvatar({ contact, size = 36 }: { contact: AppContact; size?: number }) {
  const photo = contact.photoUri || contact.firebasePhotoURL;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, overflow: 'hidden',
      backgroundColor: stringToColor(contact.displayName), alignItems: 'center', justifyContent: 'center' }}>
      {photo
        ? <Image source={{ uri: photo }} style={{ width: size, height: size }} />
        : <Text style={{ color: '#fff', fontSize: size * 0.36, fontWeight: '700' }}>
            {getInitials(contact.displayName)}
          </Text>}
    </View>
  );
}

// ─── Meeting Row ─────────────────────────────────────────────────────────────
const MeetingRow = React.memo(function MeetingRow({
  item, bevel, textColor, fontFamily, FGsecondary, isOrganizer, isActive, isPast,
  onPress, onJoin, remainingLabel,
}: any) {
  const timeString = formatTime(item.date);
  const endTimeString = formatTime(getEndTime(item));
  const urgent = isActive && remainingLabel && remainingLabel.includes('m')
    && parseInt(remainingLabel) <= 5;

  const handlePress = () => {
    if (isActive) { onJoin(); return; }
    onPress(); // always open the detail sheet — it handles past, upcoming, and minutes
  };

  return (
    <TouchableOpacity
      style={[styles.meetingCard, bevel, isActive && styles.meetingCardActive]}
      activeOpacity={0.75}
      onPress={handlePress}
    >
      <View style={styles.timeBlock}>
        <AppText style={[styles.timeText, { color: textColor }]}>{timeString.split(' ')[0]}</AppText>
        <AppText style={styles.amPmText}>{timeString.split(' ')[1]}</AppText>
        {!isPast && <AppText style={[styles.endTimeText, { color: FGsecondary }]}>{endTimeString}</AppText>}
      </View>

      <View style={[styles.cardDivider, {
        backgroundColor: isActive ? '#22c55e' : stringToColor(item.title),
        opacity: isPast ? 0.4 : 0.8,
      }]} />

      <View style={[styles.meetingDetails, isPast && { opacity: 0.85 }]}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <AppText style={[styles.meetingTitle, { color: textColor, fontFamily }]} numberOfLines={1}>
            {item.title}
          </AppText>
          {isActive && (
            <View style={styles.liveBadge}>
              <LiveDot size={6} />
              <AppText style={styles.liveBadgeText}>LIVE</AppText>
            </View>
          )}
          {isPast && item.minutes && (
            <View style={styles.minutesBadge}>
              <AppIcon name="document-text-outline" size={10} color={COLORS.blue} />
              <AppText style={styles.minutesBadgeText}>MINUTES</AppText>
            </View>
          )}
          {!isActive && isOrganizer && !isPast && (
            <View style={styles.organizerBadge}>
              <AppText style={styles.organizerBadgeText}>Organizer</AppText>
            </View>
          )}
        </View>

        <View style={styles.meetingMetaRow}>
          <AppIcon name="calendar-outline" size={12} color={COLORS.sub} />
          <AppText style={[styles.meetingMetaText, { color: FGsecondary }]}>{formatDate(item.date)}</AppText>
          <AppText style={[styles.meetingMetaText, { color: FGsecondary }]}> • {item.duration}</AppText>
        </View>

        <View style={styles.meetingMetaRow}>
          <AppIcon name={item.type === 'online' ? 'videocam-outline' : 'location-outline'} size={12} color={COLORS.sub} />
          <AppText style={[styles.meetingMetaText, { color: FGsecondary }]}>
            {item.type === 'online' ? 'Video Call' : 'In Person'}
          </AppText>
          <AppText style={[styles.meetingMetaText, { color: FGsecondary }]}> • {item.participants.length} attending</AppText>
        </View>

        {isActive && remainingLabel && (
          <View style={[styles.remainingRow, urgent && styles.remainingRowUrgent]}>
            <AppIcon name="timer-outline" size={12} color={urgent ? '#ef4444' : '#16a34a'} />
            <AppText style={[styles.remainingText, urgent && styles.remainingTextUrgent]}>
              {remainingLabel}
            </AppText>
          </View>
        )}

        {isActive && <AppText style={styles.activeHint}>Meeting is in progress — tap to join</AppText>}
        {!isActive && !isPast && <AppText style={[styles.minutesHint, { color: COLORS.sub }]}>Tap for details</AppText>}
        {isPast && <AppText style={[styles.minutesHint, { color: COLORS.sub }]}>Tap to view details</AppText>}
      </View>

      {isActive ? (
        <TouchableOpacity onPress={onJoin} activeOpacity={0.85} style={styles.joinBtnWrap}>
          <LinearGradient colors={['#22c55e', '#16a34a']} style={styles.joinBtn}>
            <AppIcon name="videocam" size={16} color="#fff" fixedColor />
            <AppText fixedColor style={styles.joinBtnText}>Join</AppText>
          </LinearGradient>
        </TouchableOpacity>
      ) : (
        <AppIcon name="chevron-forward" size={18} color={COLORS.sub} />
      )}
    </TouchableOpacity>
  );
});

// ─── New Meeting Sheet ────────────────────────────────────────────────────────
function NewMeetingSheet({
  onBack, onDone, userId, participantIds, onOpenParticipantPicker, onOpenDatePicker,
  startTime, endTime, title, setTitle,
}: any) {
  const [creating, setCreating] = useState(false);
  const { contacts } = useContacts();
  const { bevel } = useGlass();
  const { textColor } = useTypography();
  const duration = useMemo(() => calcDuration(startTime, endTime), [startTime, endTime]);

  const [phoneCount, setPhoneCount] = useState(0);
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Contacts.requestPermissionsAsync();
        if (status !== 'granted') return;
        const { data } = await Contacts.getContactsAsync({
          fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
        });
        setPhoneCount(data.length);
      } catch {}
    })();
  }, []);

  const handleCreate = async () => {
    if (!title.trim() || !userId) return;
    if (endTime <= startTime) {
      Alert.alert('Invalid Time', 'End time must be after start time.');
      return;
    }
    setCreating(true);
    const allParticipants = Array.from(new Set([userId, ...participantIds]));
    try {
      await firestore().collection('meetings').add({
        title,
        date: firestore.Timestamp.fromDate(startTime),
        endDate: firestore.Timestamp.fromDate(endTime),
        duration,
        participants: allParticipants,
        organizerId: userId,
        type: 'online',
        reminders: REMINDER_MILESTONES,
        joinedMembers: [],
        mutedUsers: [],
        kickedUsers: [],
        isActive: true,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
      const now = new Date();
      for (const mins of REMINDER_MILESTONES) {
        const t = new Date(startTime.getTime() - mins * 60000);
        if (t > now) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: 'Meeting Reminder',
              body: `"${title}" starts in ${mins === 60 ? '1 hour' : `${mins} minutes`}.`,
              sound: true,
            },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: t },
          });
        }
      }
      const startNudge = new Date(startTime.getTime() + 60 * 1000);
      if (startNudge > now) {
        await Notifications.scheduleNotificationAsync({
          content: { title: 'Meeting starting now', body: `"${title}" — tap to join.`, sound: true },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: startNudge },
        });
      }
      for (let i = 5; i <= 30; i += 5) {
        const t = new Date(startTime.getTime() + i * 60000);
        if (t > now) {
          await Notifications.scheduleNotificationAsync({
            content: {
              title: `Waiting for "${title}"`,
              body: `Meeting started ${i} min ago. Tap to join.`,
              sound: false,
            },
            trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: t },
          });
        }
      }
      onDone();
    } catch (e) {
      console.error('Error creating meeting: ', e);
      Alert.alert('Error', 'Could not create meeting. Please try again.');
    } finally { setCreating(false); }
  };

  const selectedContacts = participantIds
    .map((uid: string) => contacts.find(c => c.userId === uid))
    .filter(Boolean) as AppContact[];

  return (
    <>
      <View style={styles.sheetSubHeader}>
        <TouchableOpacity onPress={onBack} style={styles.iconPad} disabled={creating}>
          <AppIcon name="close" size={22} color={COLORS.sub} />
        </TouchableOpacity>
        <AppText style={[styles.sheetTitle, { color: textColor }]}>Organize Meeting</AppText>
        {title.trim().length > 0 && (
          <TouchableOpacity onPress={handleCreate} activeOpacity={0.85} disabled={creating}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.nextBtnGrad}>
              {creating
                ? <ActivityIndicator size="small" color="#fff" />
                : <AppText style={styles.nextBtnText}>Save</AppText>}
            </LinearGradient>
          </TouchableOpacity>
        )}
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.sheetContent}>
        <AppText style={styles.inputLabel}>Meeting Title</AppText>
        <View style={[styles.glassInput, bevel]}>
          <AppIcon name="text-outline" size={18} color={COLORS.sub} />
          <TextInput
            style={[styles.inputField, { color: textColor }]}
            placeholder="E.g. Technical Architecture Review"
            placeholderTextColor={COLORS.sub} value={title} onChangeText={setTitle}
          />
        </View>

        <AppText style={styles.inputLabel}>Start — date & time</AppText>
        <TouchableOpacity style={[styles.glassInput, bevel]} onPress={() => onOpenDatePicker('start')}>
          <AppIcon name="calendar-outline" size={18} color={COLORS.blue} />
          <AppText style={[styles.inputField, { color: textColor }]}>
            {formatDateFull(startTime)} at {formatTime(startTime)}
          </AppText>
        </TouchableOpacity>

        <AppText style={styles.inputLabel}>End — date & time</AppText>
        <TouchableOpacity style={[styles.glassInput, bevel]} onPress={() => onOpenDatePicker('end')}>
          <AppIcon name="time-outline" size={18} color={COLORS.blue} />
          <AppText style={[styles.inputField, { color: textColor }]}>
            {formatDateFull(endTime)} at {formatTime(endTime)}
          </AppText>
        </TouchableOpacity>

        <View style={[styles.autoReminderInfo, bevel]}>
          <AppIcon name="hourglass-outline" size={18} color={COLORS.blue} />
          <View style={{ flex: 1 }}>
            <AppText style={[styles.autoReminderTitle, { color: textColor }]}>Duration: {duration}</AppText>
            <AppText style={styles.autoReminderSub}>Auto-calculated from start and end times.</AppText>
          </View>
        </View>

        <AppText style={styles.inputLabel}>Participants</AppText>
        <TouchableOpacity
          style={[styles.glassInput, bevel, { minHeight: 48 }]}
          onPress={onOpenParticipantPicker}
          activeOpacity={0.75}
        >
          <AppIcon name="people-outline" size={18} color={COLORS.blue} />
          {selectedContacts.length === 0 ? (
            <AppText style={[styles.inputField, { color: COLORS.sub }]}>
              Tap to pick from your contacts
            </AppText>
          ) : (
            <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {selectedContacts.slice(0, 4).map(c => (
                <View key={c.userId} style={styles.participantChip}>
                  <ContactAvatar contact={c} size={18} />
                  <AppText style={[styles.chipText, { color: textColor }]} numberOfLines={1}>
                    {c.displayName.split(' ')[0]}
                  </AppText>
                </View>
              ))}
              {selectedContacts.length > 4 && (
                <View style={styles.participantChip}>
                  <AppText style={[styles.chipText, { color: COLORS.blue }]}>
                    +{selectedContacts.length - 4} more
                  </AppText>
                </View>
              )}
            </View>
          )}
          <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />
        </TouchableOpacity>
        {phoneCount > 0 && (
          <AppText style={styles.phoneHint}>{phoneCount} contacts available on this device</AppText>
        )}

        <View style={[styles.autoReminderInfo, bevel]}>
          <AppIcon name="notifications-outline" size={18} color={COLORS.blue} />
          <View style={{ flex: 1 }}>
            <AppText style={[styles.autoReminderTitle, { color: textColor }]}>Automated Reminders Set</AppText>
            <AppText style={styles.autoReminderSub}>
              You'll be reminded at 1 hr, 30 min, 15 min, and 10 min before — and every 5 min
              after the meeting starts until you join.
            </AppText>
          </View>
        </View>
      </ScrollView>
    </>
  );
}

// ─── RecordingPlayer ─────────────────────────────────────────────────────────
// Self-contained component for a single recording row inside MeetingDetailSheet.
// Handles: play/pause, summarize via Gemini, inline minutes display, PDF share.
function RecordingPlayer({
  rec, index, total, meetingTitle, existingMinutes, onMinutesGenerated,
}: {
  rec: { id: string; url: string; durationMs: number };
  index: number;
  total: number;
  meetingTitle: string;
  existingMinutes: string | null;
  onMinutesGenerated: (text: string) => void;
}) {
  const { textColor } = useTypography();
  const { FG } = useForeground();
  const { bevel } = useGlass();

  const player = useAudioPlayer(rec.url ? { uri: rec.url } : null as any);
  const status = useAudioPlayerStatus(player);
  const isPlaying = status.playing ?? false;

  const [summarizing, setSummarizing] = useState(false);
  const [minutes, setMinutes] = useState<string | null>(existingMinutes);
  const [exportingPdf, setExportingPdf] = useState(false);

  // Keep in sync if parent passes down freshly fetched minutes
  useEffect(() => { if (existingMinutes && !minutes) setMinutes(existingMinutes); }, [existingMinutes]);

  const fmtDuration = (ms: number) => {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const fmtPos = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const handlePlayPause = () => {
    if (!rec.url) return;
    if (isPlaying) {
      player.pause();
    } else {
      player.play();
    }
  };

  const handleSummarize = async () => {
    if (!rec.url) {
      Alert.alert('No recording', 'Recording URL is not available.');
      return;
    }
    if (!GEMINI_API_KEY) {
      Alert.alert('Not configured', 'Gemini API key is not set. Add GEMINI_API_KEY to your .env file.');
      return;
    }
    setSummarizing(true);
    try {
      // Download audio to a temp path so we can base64 it
      const { downloadAsync, documentDirectory } = await import('expo-file-system/legacy');
      const dest = `${documentDirectory}rec_${rec.id}_tmp.m4a`;
      await downloadAsync(rec.url, dest);
      const base64Audio = await readAsStringAsync(dest, { encoding: EncodingType.Base64 });

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: 'Act as an executive meeting recorder. Produce clear minutes with: 1. Executive Summary 2. Key Decisions 3. Attendees & Action Items. Format as structured plain text.' },
                { inlineData: { mimeType: 'audio/mp4', data: base64Audio } },
              ],
            }],
          }),
        }
      );
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? 'No content returned.';
      setMinutes(text);
      onMinutesGenerated(text);
    } catch (e: any) {
      console.error('[RecordingPlayer] summarize failed:', e);
      Alert.alert('Summarize failed', e?.message ?? 'Could not generate minutes. Please try again.');
    } finally {
      setSummarizing(false);
    }
  };

  const handleSharePdf = async () => {
    if (!minutes) return;
    setExportingPdf(true);
    try {
      const html = `
        <html><head><meta charset="utf-8"/>
        <style>
          body{font-family:-apple-system,Helvetica,Arial,sans-serif;padding:32px;color:#111}
          h1{font-size:22px;margin-bottom:4px}
          h2{font-size:14px;color:#555;margin-top:0;font-weight:500}
          .meta{margin:16px 0 24px;padding:12px;background:#f5f7fa;border-radius:8px;font-size:12px}
          pre{white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.55}
        </style></head>
        <body>
          <h1>${meetingTitle}</h1>
          <h2>Meeting Minutes</h2>
          <div class="meta"><div><b>Recording:</b> ${total > 1 ? `#${index + 1}` : 'Available'}</div></div>
          <pre>${minutes.replace(/[<>&]/g, (c: string) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as any)[c])}</pre>
        </body></html>`;
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Share meeting minutes',
          UTI: 'com.adobe.pdf',
        });
      } else {
        Alert.alert('PDF saved', `Saved to: ${uri}`);
      }
    } catch (e: any) {
      console.error('[RecordingPlayer] PDF export failed:', e);
      Alert.alert('Export failed', 'Could not generate PDF.');
    } finally {
      setExportingPdf(false);
    }
  };

  const positionSecs = (status.currentTime ?? 0);
  const durationSecs = rec.durationMs > 0 ? rec.durationMs / 1000 : (status.duration ?? 0);
  const progress = durationSecs > 0 ? Math.min(1, positionSecs / durationSecs) : 0;

  return (
    <View style={[styles.recCard, bevel]}>
      {/* ── Row 1: play/pause + title + share audio ── */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <TouchableOpacity
          onPress={handlePlayPause}
          style={styles.recPlayBtn}
          activeOpacity={0.8}
          disabled={!rec.url}
        >
          <AppIcon
            name={isPlaying ? 'pause' : 'play'}
            size={20} color="#fff" fixedColor
          />
        </TouchableOpacity>

        <View style={{ flex: 1 }}>
          <AppText style={[styles.contactName, { color: textColor }]}>
            Recording{total > 1 ? ` ${index + 1}` : ''}
          </AppText>
          <AppText style={[styles.contactPhone, { color: FG.secondary }]}>
            {isPlaying
              ? `${fmtPos(positionSecs)} / ${fmtPos(durationSecs)}`
              : rec.durationMs > 0 ? fmtDuration(rec.durationMs) : 'Tap to play'}
          </AppText>
        </View>

        <TouchableOpacity
          onPress={() => Share.share({ url: rec.url, message: rec.url }).catch(() => {})}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          disabled={!rec.url}
        >
          <AppIcon name="share-outline" size={18} color={COLORS.blue} />
        </TouchableOpacity>
      </View>

      {/* ── Progress bar ── */}
      {(isPlaying || positionSecs > 0) && (
        <View style={styles.recProgressTrack}>
          <View style={[styles.recProgressFill, { width: `${progress * 100}%` as any }]} />
        </View>
      )}

      {/* ── Row 2: Summarize button ── */}
      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <TouchableOpacity
          style={[styles.recActionBtn, { flex: 1 }]}
          onPress={handleSummarize}
          activeOpacity={0.8}
          disabled={summarizing || !rec.url}
        >
          {summarizing ? (
            <ActivityIndicator size="small" color={COLORS.blue} />
          ) : (
            <AppIcon name="sparkles-outline" size={15} color={COLORS.blue} />
          )}
          <AppText style={[styles.recActionText, { color: COLORS.blue }]}>
            {summarizing ? 'Generating…' : minutes ? 'Re-summarize' : 'Summarize'}
          </AppText>
        </TouchableOpacity>

        {minutes && (
          <TouchableOpacity
            style={[styles.recActionBtn, { flex: 1 }]}
            onPress={handleSharePdf}
            activeOpacity={0.8}
            disabled={exportingPdf}
          >
            {exportingPdf ? (
              <ActivityIndicator size="small" color="#16a34a" />
            ) : (
              <AppIcon name="document-text-outline" size={15} color="#16a34a" />
            )}
            <AppText style={[styles.recActionText, { color: '#16a34a' }]}>
              {exportingPdf ? 'Exporting…' : 'Share PDF'}
            </AppText>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Minutes ── */}
      {minutes && (
        <View style={{ marginTop: 12 }}>
          <AppText style={[styles.minutesSectionLabel, { color: FG.secondary, marginBottom: 6 }]}>
            MINUTES
          </AppText>
          <AppText style={[styles.minutesBody, { color: textColor, fontSize: 13, lineHeight: 20 }]}>
            {minutes}
          </AppText>
        </View>
      )}
    </View>
  );
}

// ─── Meeting Detail Sheet ─────────────────────────────────────────────────────
// Shows details for any non-active meeting (upcoming or past).
function MeetingDetailSheet({
  meeting, visible, onClose, onJoin, currentUserId,
}: {
  meeting: Meeting | null;
  visible: boolean;
  onClose: () => void;
  onJoin: (m: Meeting) => void;
  currentUserId: string;
}) {
  const { textColor } = useTypography();
  const { FG } = useForeground();
  const { bevel } = useGlass();
  const { contacts } = useContacts();

  // Lazily fetch recordings subcollection when the sheet opens
  const [subRecordings, setSubRecordings] = useState<{ id: string; url: string; durationMs: number }[]>([]);
  const [recLoading, setRecLoading] = useState(false);
  // Minutes generated from a recording inside this sheet (overrides Firestore value if set)
  const [generatedMinutes, setGeneratedMinutes] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || !meeting) { setSubRecordings([]); setGeneratedMinutes(null); return; }
    setRecLoading(true);
    firestore()
      .collection('meetings').doc(meeting.id).collection('recordings')
      .orderBy('createdAt', 'asc')
      .get()
      .then(snap => {
        setSubRecordings(snap.docs.map(d => ({
          id: d.id,
          url: d.data().url ?? '',
          durationMs: d.data().durationMs ?? 0,
        })));
      })
      .catch(() => {
        // Fall back to top-level array already on meeting object
        setSubRecordings(
          meeting.recordings.map((r, i) => ({ id: String(i), url: r.url, durationMs: r.durationMs }))
        );
      })
      .finally(() => setRecLoading(false));
  }, [visible, meeting?.id]); // eslint-disable-line

  if (!meeting) return null;

  const nowDate = new Date();
  const isPast = isMeetingPast(meeting, nowDate);
  const isUpcoming = !isPast && !isMeetingActive(meeting, nowDate);
  const isOrganizer = meeting.organizerId === currentUserId;
  const didAttend = meeting.attendance.includes(currentUserId);
  const accentColor = stringToColor(meeting.title);

  const participantContacts = meeting.participants
    .map(uid => contacts.find(c => c.userId === uid))
    .filter(Boolean) as AppContact[];

  const allRecordings = subRecordings.length > 0
    ? subRecordings
    : meeting.recordings.map((r, i) => ({ id: String(i), url: r.url, durationMs: r.durationMs }));

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={[styles.sheet, { height: '92%' }]}>
        <AppBg />
        <View style={styles.handle} />

        {/* Header */}
        <View style={styles.sheetSubHeader}>
          <TouchableOpacity onPress={onClose} style={styles.iconPad}>
            <AppIcon name="close" size={22} color={COLORS.sub} />
          </TouchableOpacity>
          <AppText style={[styles.sheetTitle, { color: textColor }]} numberOfLines={1}>
            Meeting Details
          </AppText>
        </View>

        <ScrollView contentContainerStyle={styles.minutesContent} showsVerticalScrollIndicator={false}>

          {/* Title card */}
          <View style={[styles.detailTitleCard, { borderLeftColor: accentColor }]}>
            <AppText style={[styles.detailTitle, { color: textColor }]}>{meeting.title}</AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 }}>
              {isPast && (
                <View style={styles.detailStatusBadge}>
                  <AppText style={styles.detailStatusText}>Completed</AppText>
                </View>
              )}
              {isUpcoming && (
                <View style={[styles.detailStatusBadge, { backgroundColor: 'rgba(30,156,240,0.15)' }]}>
                  <AppText style={[styles.detailStatusText, { color: COLORS.blue }]}>Upcoming</AppText>
                </View>
              )}
              {isOrganizer && (
                <View style={styles.organizerBadge}>
                  <AppText style={styles.organizerBadgeText}>You organized this</AppText>
                </View>
              )}
              {isPast && !didAttend && (
                <View style={[styles.detailStatusBadge, { backgroundColor: 'rgba(239,68,68,0.12)' }]}>
                  <AppText style={[styles.detailStatusText, { color: '#ef4444' }]}>You didn't attend</AppText>
                </View>
              )}
              {isPast && didAttend && !isOrganizer && (
                <View style={[styles.detailStatusBadge, { backgroundColor: 'rgba(34,197,94,0.12)' }]}>
                  <AppText style={[styles.detailStatusText, { color: '#16a34a' }]}>Attended</AppText>
                </View>
              )}
            </View>
          </View>

          {/* Info card */}
          <View style={[styles.minutesMetaCard, bevel]}>
            <View style={styles.minutesMetaRow}>
              <AppIcon name="calendar-outline" size={14} color={COLORS.sub} />
              <AppText style={[styles.minutesMetaText, { color: FG.secondary }]}>
                {formatDateFull(meeting.date)}
              </AppText>
            </View>
            <View style={styles.minutesMetaRow}>
              <AppIcon name="time-outline" size={14} color={COLORS.sub} />
              <AppText style={[styles.minutesMetaText, { color: FG.secondary }]}>
                {formatTime(meeting.date)} – {formatTime(getEndTime(meeting))}
                {'  ·  '}{meeting.duration}
              </AppText>
            </View>
            <View style={styles.minutesMetaRow}>
              <AppIcon name={meeting.type === 'online' ? 'videocam-outline' : 'location-outline'} size={14} color={COLORS.sub} />
              <AppText style={[styles.minutesMetaText, { color: FG.secondary }]}>
                {meeting.type === 'online' ? 'Video Call' : 'In Person'}
              </AppText>
            </View>
            <View style={styles.minutesMetaRow}>
              <AppIcon name="people-outline" size={14} color={COLORS.sub} />
              <AppText style={[styles.minutesMetaText, { color: FG.secondary }]}>
                {meeting.participants.length} invited
                {isPast && meeting.attendance.length > 0
                  ? `  ·  ${meeting.attendance.length} attended`
                  : ''}
              </AppText>
            </View>
          </View>

          {/* Participants */}
          <AppText style={[styles.minutesSectionLabel, { color: FG.secondary, marginTop: 16 }]}>
            PARTICIPANTS
          </AppText>
          <View style={[styles.minutesMetaCard, bevel, { gap: 12 }]}>
            {participantContacts.map(c => {
              const attended = meeting.attendance.includes(c.userId);
              return (
                <View key={c.userId} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <ContactAvatar contact={c} size={34} />
                  <View style={{ flex: 1 }}>
                    <AppText style={[styles.contactName, { color: textColor }]}>{c.displayName}</AppText>
                    {c.phone ? (
                      <AppText style={[styles.contactPhone, { color: FG.secondary }]}>{c.phone}</AppText>
                    ) : null}
                  </View>
                  {c.userId === meeting.organizerId && (
                    <View style={styles.organizerBadge}>
                      <AppText style={styles.organizerBadgeText}>Organizer</AppText>
                    </View>
                  )}
                  {isPast && (
                    <AppIcon
                      name={attended ? 'checkmark-circle' : 'close-circle-outline'}
                      size={18}
                      color={attended ? '#16a34a' : COLORS.sub}
                    />
                  )}
                  {c.userId === currentUserId && (
                    <AppText style={[styles.minutesMetaText, { color: COLORS.sub }]}>You</AppText>
                  )}
                </View>
              );
            })}
            {/* Participants not in local contacts */}
            {meeting.participants
              .filter(uid => !participantContacts.find(c => c.userId === uid))
              .map(uid => {
                const attended = meeting.attendance.includes(uid);
                return (
                  <View key={uid} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <View style={{
                      width: 34, height: 34, borderRadius: 17,
                      backgroundColor: stringToColor(uid),
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
                        {uid === currentUserId ? 'ME' : '?'}
                      </Text>
                    </View>
                    <AppText style={[styles.minutesMetaText, { color: FG.secondary, flex: 1 }]} numberOfLines={1}>
                      {uid === currentUserId ? 'You' : uid.slice(0, 8) + '…'}
                    </AppText>
                    {isPast && (
                      <AppIcon
                        name={attended ? 'checkmark-circle' : 'close-circle-outline'}
                        size={18}
                        color={attended ? '#16a34a' : COLORS.sub}
                      />
                    )}
                  </View>
                );
              })}
          </View>

          {/* Recordings — each with play/pause, summarize, and PDF share */}
          {(meeting.hasRecordings || allRecordings.length > 0 || recLoading) && (
            <>
              <AppText style={[styles.minutesSectionLabel, { color: FG.secondary, marginTop: 16 }]}>
                RECORDING{allRecordings.length > 1 ? 'S' : ''}
              </AppText>
              {recLoading ? (
                <View style={[styles.minutesMetaCard, bevel, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
                  <ActivityIndicator size="small" color={COLORS.blue} />
                  <AppText style={[styles.minutesMetaText, { color: FG.secondary }]}>Loading recording…</AppText>
                </View>
              ) : allRecordings.length > 0 ? (
                allRecordings.map((rec, i) => (
                  <RecordingPlayer
                    key={rec.id}
                    rec={rec}
                    index={i}
                    total={allRecordings.length}
                    meetingTitle={meeting.title}
                    existingMinutes={generatedMinutes ?? meeting.minutes}
                    onMinutesGenerated={text => setGeneratedMinutes(text)}
                  />
                ))
              ) : (
                <View style={[styles.minutesMetaCard, bevel]}>
                  <AppText style={[styles.minutesMetaText, { color: FG.secondary }]}>
                    Recording is still being processed.
                  </AppText>
                </View>
              )}
            </>
          )}

          {/* Minutes — shows Firestore minutes, or minutes generated by RecordingPlayer */}
          {isPast && !allRecordings.length && (
            <>
              <AppText style={[styles.minutesSectionLabel, { color: FG.secondary, marginTop: 16 }]}>
                MEETING MINUTES
              </AppText>
              {(generatedMinutes ?? meeting.minutes) ? (
                <AppText style={[styles.minutesBody, { color: textColor }]}>
                  {generatedMinutes ?? meeting.minutes}
                </AppText>
              ) : (
                <View style={styles.minutesEmpty}>
                  <AppIcon name="document-text-outline" size={44} color={COLORS.sub} />
                  <AppText style={[styles.minutesEmptyText, { color: FG.secondary }]}>
                    No minutes available for this meeting.
                  </AppText>
                </View>
              )}
            </>
          )}

          {/* Actions */}
          <View style={{ marginTop: 24, gap: 10 }}>
            {isUpcoming && (
              <TouchableOpacity
                onPress={() => { onClose(); onJoin(meeting); }}
                activeOpacity={0.85}
                style={styles.joinBtnWrap}
              >
                <LinearGradient colors={['#22c55e', '#16a34a']} style={[styles.joinBtn, styles.actionBtnFull]}>
                  <AppIcon name="videocam" size={18} color="#fff" fixedColor />
                  <AppText fixedColor style={[styles.joinBtnText, { fontSize: 15 }]}>Join Meeting</AppText>
                </LinearGradient>
              </TouchableOpacity>
            )}
          </View>

        </ScrollView>
      </View>
    </Modal>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function CalendarScreen() {
  const navigation = useNavigation<NavProp>();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel, iconButton } = useGlass();

  const [tab, setTab] = useState<TabType>('Upcoming');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailMeeting, setDetailMeeting] = useState<Meeting | null>(null);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ── Sheet / picker state ───────────────────────────────────────────────────
  const [sheetOpen, setSheetOpen] = useState(false);
  const [participantPickerOpen, setParticipantPickerOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [startTime, setStartTime] = useState(new Date());
  const [endTime, setEndTime] = useState(new Date(Date.now() + 60 * 60 * 1000));
  const [datePicker, setDatePicker] = useState<null | 'start' | 'end'>(null);
  const [draftParticipants, setDraftParticipants] = useState<string[]>([]);

  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchRef = useRef<TextInput>(null);

  const openMeetingSheet = () => {
    setTitle('');
    setStartTime(new Date());
    setEndTime(new Date(Date.now() + 60 * 60 * 1000));
    setDraftParticipants([]);
    setSheetOpen(true);
  };

  const closeSheet = () => {
    setSheetOpen(false);
    setDatePicker(null);
    setParticipantPickerOpen(false);
  };

  // Date picker and participant picker are rendered INSIDE the sheet Modal tree
  // so they layer on top without needing to close/reopen the sheet.
  const handleOpenDatePicker = (which: 'start' | 'end') => setDatePicker(which);

  const handleDateConfirm = (d: Date) => {
    if (datePicker === 'start') {
      setStartTime(d);
      if (d >= endTime) setEndTime(new Date(d.getTime() + 60 * 60 * 1000));
    } else if (datePicker === 'end') {
      setEndTime(d);
    }
    setDatePicker(null);
  };

  const handleDateCancel = () => setDatePicker(null);

  const handleOpenParticipantPicker = () => setParticipantPickerOpen(true);

  const handleParticipantConfirm = (ids: string[]) => {
    setDraftParticipants(ids);
    setParticipantPickerOpen(false);
  };

  const handleParticipantClose = () => setParticipantPickerOpen(false);

  // ── Firestore ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user?.uid) return;
    const unsub = firestore()
      .collection('meetings')
      .where('participants', 'array-contains', user.uid)
      .orderBy('date', 'asc')
      .onSnapshot(
        (snap) => {
          if (!snap) return;
          setMeetings(snap.docs.map(doc => {
            const d = doc.data();
            const start = d.date ? d.date.toDate() : new Date();
            return {
              id: doc.id,
              title: d.title || 'Untitled',
              date: start,
              endDate: d.endDate ? d.endDate.toDate() : null,
              duration: d.duration || '1h',
              participants: d.participants || [],
              organizerId: d.organizerId || '',
              type: d.type || 'online',
              reminders: d.reminders || [],
              minutes: d.minutes ?? null,
              hasRecordings: Array.isArray(d.recordings) ? d.recordings.length > 0 : false,
              recordings: Array.isArray(d.recordings)
                ? d.recordings.map((r: any) => ({ url: r.url ?? '', durationMs: r.durationMs ?? 0 }))
                : [],
              attendance: Array.isArray(d.joinedMembers) ? d.joinedMembers : [],
              isActive: d.isActive !== false,
            } as Meeting;
          }));
          setLoading(false);
        },
        (err) => { console.error('Firestore Error:', err); setLoading(false); }
      );
    return () => unsub();
  }, [user?.uid]);

  const nowDate = useMemo(() => new Date(now), [now]);
  const hasActiveMeeting = useMemo(
    () => meetings.some(m => isMeetingActive(m, nowDate)),
    [meetings, nowDate]
  );

  const filteredData = useMemo(() => {
    const q = query.toLowerCase().trim();
    return meetings.filter(m => {
      const active = isMeetingActive(m, nowDate);
      const past   = isMeetingPast(m, nowDate);
      const matchesTab = tab === 'Upcoming' ? (!past || active) : past;
      const matchesQuery = !q || m.title.toLowerCase().includes(q);
      return matchesTab && matchesQuery;
    });
  }, [meetings, tab, query, nowDate]);

  const openSearch = () => {
    setSearchOpen(true);
    Animated.spring(searchAnim, { toValue: 1, useNativeDriver: false, friction: 7, tension: 60 })
      .start(() => searchRef.current?.focus());
  };
  const closeSearch = () => {
    setQuery('');
    Animated.spring(searchAnim, { toValue: 0, useNativeDriver: false, friction: 7, tension: 60 })
      .start(() => setSearchOpen(false));
  };

  const handleJoinMeeting = useCallback((meeting: Meeting) => {
    if (!user?.uid) return;
    try {
      const firstParticipant = meeting.participants.find(p => p !== user.uid) || meeting.participants[0];
      (navigation as any).navigate('VideoCall', {
        callId: meeting.id,
        isOutgoing: meeting.organizerId === user.uid,
        otherParty: {
          userId: firstParticipant,
          displayName: meeting.title,
          photoUrl: null,
        },
        meetingId: meeting.id,
        meetingTitle: meeting.title,
      });
    } catch (err) {
      console.error('[Calendar] Failed to join meeting:', err);
      Alert.alert('Cannot Join', 'Meeting room is not available yet.');
    }
  }, [navigation, user?.uid]);

  const renderMeeting = useCallback(({ item }: { item: Meeting }) => {
    const active = isMeetingActive(item, nowDate);
    const past   = isMeetingPast(item, nowDate);
    const remainingMs = active ? Math.max(0, getEndTime(item).getTime() - now) : 0;
    const remainingLabel = active ? fmtRemaining(remainingMs) : null;

    return (
      <MeetingRow
        item={item}
        bevel={bevel}
        textColor={textColor}
        fontFamily={fontFamily}
        FGsecondary={FG.secondary}
        isOrganizer={item.organizerId === user?.uid}
        isActive={active}
        isPast={past}
        remainingLabel={remainingLabel}
        onPress={() => setDetailMeeting(item)}
        onJoin={() => handleJoinMeeting(item)}
      />
    );
  }, [bevel, textColor, fontFamily, FG.secondary, user?.uid, nowDate, now, handleJoinMeeting]);

  return (
    <View style={styles.root}>
      <AppBg />

      {/* ── New Meeting Sheet ─────────────────────────────────────────────── */}
      <Modal
        visible={sheetOpen}
        transparent
        animationType="slide"
        onRequestClose={closeSheet}
        statusBarTranslucent
      >
        <Pressable style={styles.overlay} onPress={closeSheet} />
        <View style={styles.sheet}>
          <AppBg />
          <View style={styles.handle} />
          <NewMeetingSheet
            userId={user?.uid || ''}
            participantIds={draftParticipants}
            title={title}
            setTitle={setTitle}
            startTime={startTime}
            endTime={endTime}
            onOpenParticipantPicker={handleOpenParticipantPicker}
            onOpenDatePicker={handleOpenDatePicker}
            onBack={closeSheet}
            onDone={closeSheet}
          />
        </View>

        {/* Pickers live inside this Modal so they render above the sheet on iOS */}
        <DateTimePickerModal
          isVisible={datePicker !== null}
          mode="datetime"
          date={datePicker === 'end' ? endTime : startTime}
          minimumDate={datePicker === 'end' ? startTime : undefined}
          onConfirm={handleDateConfirm}
          onCancel={handleDateCancel}
        />
        <ParticipantPickerSheet
          visible={participantPickerOpen}
          selected={draftParticipants}
          onConfirm={handleParticipantConfirm}
          onClose={handleParticipantClose}
        />
      </Modal>

      {/* ── Meeting Detail Sheet ─────────────────────────────────────────── */}
      <MeetingDetailSheet
        meeting={detailMeeting}
        visible={!!detailMeeting}
        onClose={() => setDetailMeeting(null)}
        onJoin={handleJoinMeeting}
        currentUserId={user?.uid || ''}
      />

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerRow}>
          <AppText style={[styles.appName, { color: textColor, fontFamily }]}>Calendar</AppText>
          {!searchOpen && (
            <TouchableOpacity style={iconButton} onPress={openSearch} activeOpacity={0.8}>
              <AppIcon name="search-outline" size={20} color={COLORS.blue} />
            </TouchableOpacity>
          )}
        </View>
        {searchOpen && (
          <Animated.View style={[styles.searchBubble, {
            opacity: searchAnim,
            transform: [{ translateY: searchAnim.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
          }]}>
            <AppIcon name="search-outline" size={15} color={COLORS.sub} />
            <TextInput
              ref={searchRef} style={[styles.searchInput, { color: textColor }]}
              placeholder="Search meetings" placeholderTextColor={COLORS.sub}
              value={query} onChangeText={setQuery}
            />
            <TouchableOpacity onPress={closeSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon name="close-circle" size={18} color={COLORS.sub} />
            </TouchableOpacity>
          </Animated.View>
        )}
      </View>

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <View style={styles.tabBar}>
        {(['Upcoming', 'Past'] as TabType[]).map(t => {
          const active = tab === t;
          const showLive = t === 'Upcoming' && hasActiveMeeting;
          return active ? (
            <TouchableOpacity key={t} onPress={() => setTab(t)} activeOpacity={0.85}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.tabPillActive}>
                <AppText style={styles.tabLabelActive}>{t}</AppText>
                {showLive && <View style={{ marginLeft: 6 }}><LiveDot size={8} /></View>}
              </LinearGradient>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              key={t}
              style={[styles.tabPillInactive, bevel]}
              onPress={() => setTab(t)}
              activeOpacity={0.7}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <AppText style={[styles.tabLabel, { color: FG.secondary }]}>{t}</AppText>
                {showLive && <View style={{ marginLeft: 6 }}><LiveDot size={8} /></View>}
              </View>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── List ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <View style={styles.emptyWrap}>
          <ActivityIndicator size="large" color={COLORS.blue} />
          <AppText style={styles.emptyText}>Syncing Calendar...</AppText>
        </View>
      ) : (
        <FlatList
          data={filteredData}
          keyExtractor={item => item.id}
          renderItem={renderMeeting}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <AppIcon name="calendar-outline" size={52} color={COLORS.sub} />
              <AppText style={styles.emptyText}>
                {tab === 'Past' ? 'No completed meetings yet' : `No ${tab.toLowerCase()} meetings found`}
              </AppText>
            </View>
          }
        />
      )}

      {/* ── FAB ──────────────────────────────────────────────────────────── */}
      <TouchableOpacity
        style={[styles.fab, bevel, { bottom: insets.bottom + 150 },
          Platform.OS === 'web' && styles.fabWeb]}
        activeOpacity={0.85}
        onPress={openMeetingSheet}
      >
        <AppIcon name="add" size={28} color={COLORS.blue} fixedColor />
      </TouchableOpacity>

      <BottomNav active="calendar" />
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.sky1 },
  header: { paddingHorizontal: 14, paddingBottom: 10, gap: 8 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  appName: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  searchBubble: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(30,156,240,0.06)', borderWidth: 1, borderColor: 'rgba(30,156,240,0.18)', borderRadius: RADIUS.full, paddingHorizontal: 14, height: 42 },
  searchInput: { flex: 1, fontSize: 14, padding: 0 },
  tabBar: { flexDirection: 'row', paddingHorizontal: 14, marginBottom: 10, gap: 6 },
  tabPillActive: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 9, borderRadius: RADIUS.full, ...SHADOW.button },
  tabPillInactive: { paddingHorizontal: 22, paddingVertical: 9, borderRadius: RADIUS.full },
  tabLabel: { fontSize: 14, fontWeight: '600' },
  tabLabelActive: { fontSize: 14, fontWeight: '700', color: '#fff' },
  listContent: { paddingHorizontal: 14, paddingBottom: 110 },

  meetingCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 14 },
  meetingCardActive: { borderWidth: 1.5, borderColor: 'rgba(34,197,94,0.45)', backgroundColor: 'rgba(34,197,94,0.06)' },
  timeBlock: { alignItems: 'center', minWidth: 50 },
  timeText: { fontSize: 16, fontWeight: '700' },
  amPmText: { fontSize: 11, fontWeight: '600', color: COLORS.sub },
  endTimeText: { fontSize: 10, fontWeight: '500', marginTop: 2 },
  cardDivider: { width: 3, height: '100%', borderRadius: 2 },
  meetingDetails: { flex: 1, gap: 4 },
  meetingTitle: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  meetingMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meetingMetaText: { fontSize: 12 },
  organizerBadge: { backgroundColor: 'rgba(30,156,240,0.15)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: RADIUS.full },
  organizerBadgeText: { fontSize: 10, fontWeight: '700', color: COLORS.blue },

  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(34,197,94,0.16)', paddingHorizontal: 7, paddingVertical: 2, borderRadius: RADIUS.full },
  liveBadgeText: { fontSize: 10, fontWeight: '800', color: '#16a34a', letterSpacing: 0.5 },
  minutesBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(30,156,240,0.14)', paddingHorizontal: 7, paddingVertical: 2, borderRadius: RADIUS.full },
  minutesBadgeText: { fontSize: 10, fontWeight: '800', color: COLORS.blue, letterSpacing: 0.5 },
  activeHint: { fontSize: 11, color: '#16a34a', fontWeight: '600', marginTop: 2 },
  minutesHint: { fontSize: 11, color: COLORS.blue, fontWeight: '600', marginTop: 2 },

  remainingRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4, alignSelf: 'flex-start', backgroundColor: 'rgba(34,197,94,0.15)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.full },
  remainingRowUrgent: { backgroundColor: 'rgba(239,68,68,0.15)' },
  remainingText: { fontSize: 11, fontWeight: '700', color: '#16a34a' },
  remainingTextUrgent: { color: '#ef4444' },

  joinBtnWrap: { borderRadius: RADIUS.full, overflow: 'hidden', ...SHADOW.button },
  joinBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS.full },
  joinBtnText: { fontSize: 12, fontWeight: '700', color: '#fff' },
  actionBtnFull: { paddingHorizontal: 20, paddingVertical: 14, justifyContent: 'center' },

  fab: { position: 'absolute', right: 20, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  fabWeb: { right: 16 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '85%', borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden', ...SHADOW.glow },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(30,156,240,0.30)', marginTop: 10, marginBottom: 4 },

  sheetSubHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  iconPad: { padding: 4 },
  sheetTitle: { flex: 1, fontSize: 17, fontWeight: '700' },
  nextBtnGrad: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: RADIUS.full, ...SHADOW.button },
  nextBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  sheetContent: { paddingHorizontal: 14, paddingBottom: 40, paddingTop: 10 },
  inputLabel: { fontSize: 12, fontWeight: '600', color: COLORS.sub, marginLeft: 4, marginBottom: 6, marginTop: 14 },
  glassInput: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 12 },
  inputField: { flex: 1, fontSize: 14, padding: 0 },
  autoReminderInfo: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, padding: 14, borderRadius: RADIUS.md },
  autoReminderTitle: { fontSize: 13, fontWeight: '700' },
  autoReminderSub: { fontSize: 11, color: COLORS.sub, marginTop: 2 },
  phoneHint: { fontSize: 11, color: COLORS.sub, marginLeft: 6, marginTop: 6 },
  participantChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(30,156,240,0.10)', borderRadius: RADIUS.full, paddingHorizontal: 8, paddingVertical: 3 },
  chipText: { fontSize: 12, fontWeight: '600', maxWidth: 70 },

  emptyWrap: { alignItems: 'center', gap: 12, flex: 1, justifyContent: 'center', paddingBottom: 80 },
  emptyText: { fontSize: 15, color: COLORS.sub },

  minutesContent: { paddingHorizontal: 18, paddingBottom: 40, paddingTop: 6 },
  minutesMetaCard: { borderRadius: RADIUS.lg, padding: 14, gap: 8, marginBottom: 16 },
  minutesMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  minutesMetaText: { fontSize: 12.5 },
  minutesSectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 10 },
  minutesBody: { fontSize: 14.5, lineHeight: 23 },
  minutesEmpty: { alignItems: 'center', paddingVertical: 40, gap: 10 },
  minutesEmptyText: { fontSize: 14, textAlign: 'center' },

  // Detail sheet extras
  detailTitleCard: { borderLeftWidth: 4, borderRadius: RADIUS.md, paddingLeft: 14, paddingVertical: 10, marginBottom: 14 },
  detailTitle: { fontSize: 20, fontWeight: '800' },
  detailStatusBadge: { backgroundColor: 'rgba(100,100,100,0.15)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.full },
  detailStatusText: { fontSize: 11, fontWeight: '700', color: COLORS.sub },
  contactName: { fontSize: 14, fontWeight: '600' },
  contactPhone: { fontSize: 12, marginTop: 1 },

  // RecordingPlayer
  recCard: {
    borderRadius: RADIUS.lg, padding: 14, marginBottom: 10,
    borderWidth: 1, borderColor: 'rgba(30,156,240,0.18)',
  },
  recPlayBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: COLORS.blue,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },
  recProgressTrack: {
    height: 3, borderRadius: 2,
    backgroundColor: 'rgba(30,156,240,0.18)',
    marginTop: 10, overflow: 'hidden',
  },
  recProgressFill: {
    height: '100%',
    backgroundColor: COLORS.blue,
    borderRadius: 2,
  },
  recActionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 9, paddingHorizontal: 12,
    borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: 'rgba(30,156,240,0.25)',
    backgroundColor: 'rgba(30,156,240,0.08)',
  },
  recActionText: { fontSize: 12, fontWeight: '700' },
});
