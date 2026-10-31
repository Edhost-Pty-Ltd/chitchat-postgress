// ─── MeetingBubble ────────────────────────────────────────────────────────────
// Rich meeting-invite card rendered inside a chat thread. Replaces the old
// plain italic "You're invited…" system line. Shows the title, schedule, venue
// and organizer, with a primary action: virtual meetings open the web meeting
// room in the browser; in-person meetings open directions to the venue.

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Dimensions, Linking, Alert } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_W = Math.min(SCREEN_W * 0.78, 320);

export interface MeetingCardData {
  meetingId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  venue: 'online' | 'in-person';
  joinUrl: string;
  organizerName?: string | null;
  location?: {
    name: string | null;
    address: string | null;
    lat: number | null;
    lng: number | null;
  } | null;
}

interface Props {
  meeting: MeetingCardData;
  isOutgoing: boolean;
  timestamp?: string;
  tickIcon?: { icon: 'checkmark' | 'checkmark-done'; color: string };
}

function fmtSchedule(startISO: string, endISO: string): { day: string; time: string } {
  const start = new Date(startISO);
  const end = new Date(endISO);
  const dayValid = !isNaN(start.getTime());
  const day = dayValid
    ? start.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' })
    : 'Scheduled';
  const t = (d: Date) =>
    isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const startT = t(start);
  const endT = t(end);
  const time = startT && endT ? `${startT} – ${endT}` : startT || '';
  return { day, time };
}

function openDirections(meeting: MeetingCardData) {
  const loc = meeting.location;
  let url: string | null = null;
  if (loc?.lat != null && loc?.lng != null) {
    url = `https://www.google.com/maps/search/?api=1&query=${loc.lat},${loc.lng}`;
  } else if (loc?.address) {
    url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(loc.address)}`;
  }
  if (!url) {
    Alert.alert('No location', 'This meeting has no venue details.');
    return;
  }
  Linking.openURL(url).catch(() => Alert.alert('Cannot open maps', 'Unable to open the location.'));
}

function openJoin(meeting: MeetingCardData) {
  if (!meeting.joinUrl) {
    Alert.alert('No link', 'This meeting has no join link.');
    return;
  }
  Linking.openURL(meeting.joinUrl).catch(() =>
    Alert.alert('Cannot open link', 'Unable to open the meeting link.'),
  );
}

export const MeetingBubble = React.memo(function MeetingBubble({
  meeting,
  isOutgoing,
  timestamp,
  tickIcon,
}: Props) {
  const { day, time } = fmtSchedule(meeting.startsAt, meeting.endsAt);
  const isVirtual = meeting.venue !== 'in-person';
  const loc = meeting.location;
  const hasLocation = !!(loc && (loc.address || (loc.lat != null && loc.lng != null)));

  return (
    <View style={[styles.wrapper, isOutgoing ? styles.wrapperOut : styles.wrapperIn]}>
      <View style={styles.card}>
        {/* Gradient header: title + venue badge */}
        <LinearGradient colors={GRADIENTS.primary} style={styles.header}>
          <View style={styles.headerIconWrap}>
            <Ionicons name={isVirtual ? 'videocam' : 'location'} size={18} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.kicker}>MEETING INVITATION</Text>
            <Text style={styles.title} numberOfLines={2}>{meeting.title}</Text>
          </View>
        </LinearGradient>

        <View style={styles.body}>
          {/* Schedule */}
          <View style={styles.detailRow}>
            <Ionicons name="calendar-outline" size={15} color={COLORS.blue} style={styles.detailIcon} />
            <View style={{ flex: 1 }}>
              <Text style={styles.detailText}>{day}</Text>
              {!!time && <Text style={styles.detailSub}>{time}</Text>}
            </View>
          </View>

          {/* Venue */}
          <View style={styles.detailRow}>
            <Ionicons
              name={isVirtual ? 'globe-outline' : 'business-outline'}
              size={15}
              color={COLORS.blue}
              style={styles.detailIcon}
            />
            <View style={{ flex: 1 }}>
              <Text style={styles.detailText}>{isVirtual ? 'Virtual meeting' : (loc?.name || 'In person')}</Text>
              {isVirtual ? (
                <Text style={styles.detailSub} numberOfLines={1}>Opens in your browser</Text>
              ) : loc?.address ? (
                <Text style={styles.detailSub} numberOfLines={2}>{loc.address}</Text>
              ) : null}
            </View>
          </View>

          {/* Organizer */}
          {!!meeting.organizerName && (
            <View style={styles.detailRow}>
              <Ionicons name="person-outline" size={15} color={COLORS.blue} style={styles.detailIcon} />
              <Text style={[styles.detailText, { flex: 1 }]} numberOfLines={1}>
                Hosted by {meeting.organizerName}
              </Text>
            </View>
          )}

          {/* Primary action(s). Virtual → a single Join button. In-person →
              Directions plus a "Join online" button so anyone who can't attend
              in person can still join the live meeting from their browser. */}
          {isVirtual ? (
            <TouchableOpacity activeOpacity={0.85} onPress={() => openJoin(meeting)} style={styles.actionBtnWrap}>
              <LinearGradient colors={['#22c55e', '#16a34a']} style={styles.actionBtn}>
                <Ionicons name="videocam" size={17} color="#fff" />
                <Text style={styles.actionText}>Join Meeting</Text>
              </LinearGradient>
            </TouchableOpacity>
          ) : (
            <>
              <View style={styles.actionRow}>
                {hasLocation && (
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => openDirections(meeting)}
                    style={[styles.actionBtnWrap, styles.actionFlex]}
                  >
                    <LinearGradient colors={GRADIENTS.primary} style={styles.actionBtn}>
                      <Ionicons name="navigate" size={16} color="#fff" />
                      <Text style={styles.actionTextSm}>Directions</Text>
                    </LinearGradient>
                  </TouchableOpacity>
                )}
                {!!meeting.joinUrl && (
                  <TouchableOpacity
                    activeOpacity={0.85}
                    onPress={() => openJoin(meeting)}
                    style={[styles.actionBtnWrap, styles.actionFlex]}
                  >
                    <LinearGradient colors={['#22c55e', '#16a34a']} style={styles.actionBtn}>
                      <Ionicons name="videocam" size={16} color="#fff" />
                      <Text style={styles.actionTextSm}>Join online</Text>
                    </LinearGradient>
                  </TouchableOpacity>
                )}
              </View>
              {!!meeting.joinUrl && (
                <Text style={styles.joinHint}>Can't attend in person? Join live online.</Text>
              )}
            </>
          )}

          {/* Footer: time + tick */}
          <View style={styles.footerRow}>
            {!!timestamp && <Text style={styles.timeText}>{timestamp}</Text>}
            {isOutgoing && tickIcon && (
              <Ionicons name={tickIcon.icon} size={13} color={tickIcon.color} style={{ marginLeft: 3 }} />
            )}
          </View>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: { marginVertical: 3, marginHorizontal: 6, maxWidth: CARD_W },
  wrapperOut: { alignSelf: 'flex-end' },
  wrapperIn: { alignSelf: 'flex-start' },
  card: {
    width: CARD_W,
    borderRadius: RADIUS.lg,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.14)',
    overflow: 'hidden',
    ...SHADOW.card,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  headerIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  kicker: { color: 'rgba(255,255,255,0.85)', fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  title: { color: '#fff', fontSize: 15.5, fontWeight: '800', lineHeight: 20, marginTop: 1 },

  body: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10 },
  detailRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10 },
  detailIcon: { marginRight: 9, marginTop: 1 },
  detailText: { fontSize: 13.5, fontWeight: '700', color: COLORS.text },
  detailSub: { fontSize: 12, color: COLORS.sub, marginTop: 1 },

  actionBtnWrap: { marginTop: 2, ...SHADOW.button },
  actionRow: { flexDirection: 'row', gap: 8 },
  actionFlex: { flex: 1 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 11,
    paddingHorizontal: 6,
    borderRadius: RADIUS.md,
  },
  actionText: { color: '#fff', fontSize: 14.5, fontWeight: '800' },
  actionTextSm: { color: '#fff', fontSize: 13, fontWeight: '800' },
  joinHint: { fontSize: 11, color: COLORS.sub, textAlign: 'center', marginTop: 8 },

  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 8 },
  timeText: { fontSize: 11, color: COLORS.sub },
});
