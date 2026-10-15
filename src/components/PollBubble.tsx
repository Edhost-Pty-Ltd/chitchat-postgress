// ─── PollBubble ───────────────────────────────────────────────────────────────
// Interactive poll card rendered inside a chat thread. Tapping an option casts
// (or retracts) the current user's vote; results update live via Firestore.
// A "View votes" button opens a results sheet grouped by option (winner first),
// showing exactly who voted for each.

import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions, Modal,
  ScrollView, Image, ActivityIndicator, Animated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import firestore from '@react-native-firebase/firestore';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';
import { db } from '../config/firebase';
import { usePhoneBook } from '../hooks/usePhoneBook';
import { normalizePhone } from '../utils/phoneUtils';

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_W = Math.min(SCREEN_W * 0.74, 300);

export interface PollData {
  question: string;
  options: { id: string; text: string }[];
  votes: Record<string, string[]>;
  multiple: boolean;
}

interface Props {
  poll: PollData;
  isOutgoing: boolean;
  currentUserId: string | null;
  onVote: (optionId: string) => void;
  timestamp?: string;
  tickIcon?: { icon: 'checkmark' | 'checkmark-done'; color: string };
}

interface VoterInfo { uid: string; name: string; photoURL: string | null }

function getInitials(name: string): string {
  const p = (name || '').trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[1][0]).toUpperCase() : (name || '?').slice(0, 2).toUpperCase();
}

// ── Single poll option row with an animated fill bar ─────────────────────────
// The fill width animates smoothly between vote states instead of snapping,
// which removes the "scratchy" jump when votes change.
interface PollOptionProps {
  text: string;
  count: number;
  pct: number;        // 0..100
  mine: boolean;
  isLeading: boolean;
  onPress: () => void;
}

function PollOption({ text, count, pct, mine, isLeading, onPress }: PollOptionProps) {
  const fill = useRef(new Animated.Value(pct)).current;

  useEffect(() => {
    Animated.timing(fill, {
      toValue: pct,
      duration: 320,
      useNativeDriver: false, // animating width % → can't use native driver
    }).start();
  }, [pct, fill]);

  const widthInterpolate = fill.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
    extrapolate: 'clamp',
  });

  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={styles.option}>
      <Animated.View
        style={[
          styles.optionFill,
          { width: widthInterpolate },
          mine && styles.optionFillMine,
          isLeading && !mine && styles.optionFillLead,
        ]}
      />
      <View style={styles.optionContent}>
        <View style={styles.optionLeft}>
          <View style={[styles.radio, mine && styles.radioOn]}>
            {mine && <Ionicons name="checkmark" size={11} color="#fff" />}
          </View>
          <Text style={styles.optionText} numberOfLines={2}>{text}</Text>
          {isLeading && count > 0 && (
            <Ionicons name="trophy" size={12} color={COLORS.amber} style={{ marginLeft: 2 }} />
          )}
        </View>
        <Text style={styles.optionPct}>{count}</Text>
      </View>
    </TouchableOpacity>
  );
}

export function PollBubble({ poll, isOutgoing, currentUserId, onVote, timestamp, tickIcon }: Props) {
  const { resolveName } = usePhoneBook();
  const [resultsOpen, setResultsOpen] = useState(false);
  const [voterMap, setVoterMap] = useState<Record<string, VoterInfo>>({});
  const [loadingVoters, setLoadingVoters] = useState(false);

  // ── Optimistic votes ──────────────────────────────────────────────────────
  // We keep a local copy of the vote map so a tap updates the UI instantly
  // (no waiting on the Firestore round-trip). When fresh server state arrives
  // via the `poll.votes` prop, we adopt it as the new source of truth — this
  // reconciles our optimistic guess and shows everyone else's votes live.
  const [localVotes, setLocalVotes] = useState<Record<string, string[]>>(poll.votes ?? {});

  // Remembers the current user's optimistic selection (set of option ids they
  // voted for) while the Firestore write is in flight. We only adopt a fresh
  // server snapshot once it actually agrees with this pending selection —
  // otherwise an older snapshot arriving mid-write would revert the tap and
  // make it look like the first tap "unchecked" the option.
  const pendingSelection = useRef<Set<string> | null>(null);

  useEffect(() => {
    const serverVotes = poll.votes ?? {};
    if (pendingSelection.current && currentUserId) {
      const serverSelection = new Set(
        Object.keys(serverVotes).filter((id) => serverVotes[id]?.includes(currentUserId)),
      );
      const pending = pendingSelection.current;
      const matches =
        serverSelection.size === pending.size &&
        [...pending].every((id) => serverSelection.has(id));
      if (!matches) {
        // Server hasn't caught up to our tap yet — keep showing the optimistic
        // state and ignore this (stale) snapshot.
        return;
      }
      // Server now reflects our vote; clear the pending flag and adopt it.
      pendingSelection.current = null;
    }
    setLocalVotes(serverVotes);
  }, [poll.votes, currentUserId]);

  const votes = localVotes;

  const totalVotes = useMemo(
    () => Object.values(votes ?? {}).reduce((s, arr) => s + (arr?.length ?? 0), 0),
    [votes],
  );

  // Options sorted by vote count, highest first (the "winners" on top).
  const rankedOptions = useMemo(() => {
    return [...poll.options]
      .map((o) => ({ ...o, count: votes?.[o.id]?.length ?? 0 }))
      .sort((a, b) => b.count - a.count);
  }, [poll.options, votes]);

  // Apply the same vote mutation locally that the server will perform, so the
  // UI reflects the result of a tap immediately and smoothly.
  const handleVote = useCallback((optionId: string) => {
    if (!currentUserId) return;
    setLocalVotes((prev) => {
      const next: Record<string, string[]> = {};
      for (const o of poll.options) next[o.id] = [...(prev[o.id] ?? [])];
      const already = next[optionId]?.includes(currentUserId);
      if (!poll.multiple) {
        for (const id of Object.keys(next)) {
          next[id] = next[id].filter((u) => u !== currentUserId);
        }
        if (!already) next[optionId] = [...next[optionId], currentUserId];
      } else {
        if (already) next[optionId] = next[optionId].filter((u) => u !== currentUserId);
        else next[optionId] = [...next[optionId], currentUserId];
      }
      // Record exactly which options the user now has selected, so the
      // reconciliation effect waits for the server to match this before
      // adopting any incoming snapshot.
      pendingSelection.current = new Set(
        Object.keys(next).filter((id) => next[id].includes(currentUserId)),
      );
      return next;
    });
    onVote(optionId);
  }, [currentUserId, poll.options, poll.multiple, onVote]);

  const topCount = rankedOptions[0]?.count ?? 0;

  // Resolve each unique voter UID → name + photo (phone-book name rule).
  const loadVoters = useCallback(async () => {
    const uids = Array.from(new Set(Object.values(votes ?? {}).flat()));
    const missing = uids.filter((u) => !voterMap[u]);
    if (missing.length === 0) return;
    setLoadingVoters(true);
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      const results = await Promise.all(
        missing.map(async (uid) => {
          try {
            const snap = await fsDb.collection('users').doc(uid).get();
            const d: any = snap.exists() ? snap.data() : null;
            const phone = d?.phone ?? d?.phoneNumber ?? null;
            const fallback = d?.displayName ?? 'Unknown';
            const name = phone ? resolveName(normalizePhone(phone), fallback) : fallback;
            return { uid, name, photoURL: d?.photoURL ?? null } as VoterInfo;
          } catch {
            return { uid, name: 'Unknown', photoURL: null } as VoterInfo;
          }
        }),
      );
      setVoterMap((prev) => {
        const next = { ...prev };
        results.forEach((r) => { next[r.uid] = r; });
        return next;
      });
    } finally {
      setLoadingVoters(false);
    }
  }, [votes, voterMap, resolveName]);

  const openResults = () => {
    setResultsOpen(true);
    loadVoters();
  };

  return (
    <View style={[styles.wrapper, isOutgoing ? styles.wrapperOut : styles.wrapperIn]}>
      <View style={[styles.card, isOutgoing ? styles.cardOut : styles.cardIn]}>
        <View style={styles.headerRow}>
          <Ionicons name="stats-chart" size={14} color={COLORS.blue} />
          <Text style={styles.pollLabel}>Poll{poll.multiple ? ' · multiple' : ''}</Text>
        </View>
        <Text style={styles.question}>{poll.question}</Text>

        {poll.options.map((opt) => {
          const voters = votes?.[opt.id] ?? [];
          const count = voters.length;
          const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
          const mine = currentUserId ? voters.includes(currentUserId) : false;
          const isLeading = count > 0 && count === topCount;
          return (
            <PollOption
              key={opt.id}
              text={opt.text}
              count={count}
              pct={pct}
              mine={mine}
              isLeading={isLeading}
              onPress={() => handleVote(opt.id)}
            />
          );
        })}

        {/* View votes button */}
        <TouchableOpacity
          style={styles.viewVotesBtn}
          activeOpacity={0.75}
          onPress={openResults}
          disabled={totalVotes === 0}
        >
          <Ionicons name="people-outline" size={14} color={totalVotes === 0 ? COLORS.sub : COLORS.blue} />
          <Text style={[styles.viewVotesText, totalVotes === 0 && { color: COLORS.sub }]}>
            {totalVotes === 0 ? 'No votes yet' : `View votes (${totalVotes})`}
          </Text>
        </TouchableOpacity>

        <View style={styles.footerRow}>
          <Text style={styles.footerText}>
            {totalVotes} vote{totalVotes === 1 ? '' : 's'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            {timestamp && <Text style={styles.timeText}>{timestamp}</Text>}
            {isOutgoing && tickIcon && (
              <Ionicons name={tickIcon.icon} size={13} color={tickIcon.color} style={{ marginLeft: 3 }} />
            )}
          </View>
        </View>
      </View>

      {/* ── Results sheet ── */}
      <Modal visible={resultsOpen} transparent animationType="slide" onRequestClose={() => setResultsOpen(false)}>
        <TouchableOpacity style={rs.backdrop} activeOpacity={1} onPress={() => setResultsOpen(false)} />
        <View style={rs.sheet}>
          <View style={rs.handle} />
          <LinearGradient colors={GRADIENTS.primary} style={rs.header}>
            <Ionicons name="stats-chart" size={18} color="#fff" />
            <View style={{ flex: 1 }}>
              <Text style={rs.headerTitle} numberOfLines={2}>{poll.question}</Text>
              <Text style={rs.headerSub}>{totalVotes} vote{totalVotes === 1 ? '' : 's'}</Text>
            </View>
            <TouchableOpacity onPress={() => setResultsOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color="#fff" />
            </TouchableOpacity>
          </LinearGradient>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 28 }}>
            {loadingVoters && (
              <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                <ActivityIndicator color={COLORS.blue} />
              </View>
            )}
            {rankedOptions.map((opt, idx) => {
              const voters = votes?.[opt.id] ?? [];
              const pct = totalVotes > 0 ? Math.round((opt.count / totalVotes) * 100) : 0;
              const isWinner = idx === 0 && opt.count > 0;
              return (
                <View key={opt.id} style={rs.optionBlock}>
                  <View style={rs.optionHeader}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                      {isWinner && <Ionicons name="trophy" size={15} color={COLORS.amber} />}
                      <Text style={[rs.optionTitle, isWinner && { color: COLORS.blue }]} numberOfLines={1}>{opt.text}</Text>
                    </View>
                    <Text style={rs.optionStat}>{opt.count} · {pct}%</Text>
                  </View>
                  <View style={rs.bar}>
                    <View style={[rs.barFill, { width: `${pct}%` }, isWinner && { backgroundColor: COLORS.blue }]} />
                  </View>

                  {voters.length === 0 ? (
                    <Text style={rs.noVoters}>No votes</Text>
                  ) : (
                    <View style={rs.votersWrap}>
                      {voters.map((uid) => {
                        const info = voterMap[uid];
                        const name = info?.name ?? '…';
                        return (
                          <View key={uid} style={rs.voterRow}>
                            {info?.photoURL ? (
                              <Image source={{ uri: info.photoURL }} style={rs.voterAvatar} />
                            ) : (
                              <View style={[rs.voterAvatar, rs.voterAvatarFallback]}>
                                <Text style={rs.voterInitials}>{getInitials(name)}</Text>
                              </View>
                            )}
                            <Text style={rs.voterName} numberOfLines={1}>
                              {uid === currentUserId ? 'You' : name}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  )}
                </View>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginVertical: 3, marginHorizontal: 6, maxWidth: CARD_W },
  wrapperOut: { alignSelf: 'flex-end' },
  wrapperIn: { alignSelf: 'flex-start' },
  card: {
    width: CARD_W,
    borderRadius: RADIUS.lg,
    padding: 14,
    ...SHADOW.card,
    borderWidth: 1,
  },
  cardOut: { backgroundColor: '#fff', borderColor: 'rgba(30,156,240,0.14)' },
  cardIn: { backgroundColor: '#fff', borderColor: 'rgba(30,156,240,0.10)' },

  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 6 },
  pollLabel: { fontSize: 11, fontWeight: '800', color: COLORS.blue, letterSpacing: 0.4, textTransform: 'uppercase' },
  question: { fontSize: 15, fontWeight: '700', color: COLORS.text, lineHeight: 20, marginBottom: 10 },

  option: {
    position: 'relative',
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    marginBottom: 8,
    backgroundColor: 'rgba(30,156,240,0.06)',
    minHeight: 42,
    justifyContent: 'center',
  },
  optionFill: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(30,156,240,0.14)',
  },
  optionFillMine: { backgroundColor: 'rgba(30,156,240,0.26)' },
  optionFillLead: { backgroundColor: 'rgba(30,156,240,0.18)' },
  optionContent: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 12, paddingVertical: 9, gap: 10,
  },
  optionLeft: { flexDirection: 'row', alignItems: 'center', gap: 9, flex: 1 },
  radio: {
    width: 18, height: 18, borderRadius: 9,
    borderWidth: 2, borderColor: COLORS.blue,
    alignItems: 'center', justifyContent: 'center',
  },
  radioOn: { backgroundColor: COLORS.blue },
  optionText: { fontSize: 13.5, color: COLORS.text, fontWeight: '600', flexShrink: 1 },
  optionPct: { fontSize: 12.5, fontWeight: '700', color: COLORS.sub },

  viewVotesBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginTop: 2, marginBottom: 6, paddingVertical: 9,
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)',
  },
  viewVotesText: { fontSize: 13, fontWeight: '700', color: COLORS.blue },

  footerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 },
  footerText: { fontSize: 11, color: COLORS.sub },
  timeText: { fontSize: 11, color: COLORS.sub },
});

// ── Results sheet styles ──────────────────────────────────────────────────────
const rs = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '82%', paddingBottom: 8, overflow: 'hidden',
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.15)', marginTop: 8, marginBottom: 4 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 18, paddingVertical: 14,
  },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '800', lineHeight: 20 },
  headerSub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 2 },

  optionBlock: { paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.05)' },
  optionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  optionTitle: { fontSize: 14.5, fontWeight: '700', color: COLORS.text },
  optionStat: { fontSize: 12.5, fontWeight: '700', color: COLORS.sub },
  bar: { height: 6, borderRadius: 3, backgroundColor: 'rgba(30,156,240,0.10)', overflow: 'hidden', marginBottom: 10 },
  barFill: { height: 6, borderRadius: 3, backgroundColor: 'rgba(30,156,240,0.5)' },

  votersWrap: { gap: 8 },
  voterRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  voterAvatar: { width: 34, height: 34, borderRadius: 17 },
  voterAvatarFallback: { backgroundColor: COLORS.blue, alignItems: 'center', justifyContent: 'center' },
  voterInitials: { color: '#fff', fontSize: 12, fontWeight: '700' },
  voterName: { fontSize: 14, color: COLORS.text, fontWeight: '500', flex: 1 },
  noVoters: { fontSize: 12.5, color: COLORS.sub, fontStyle: 'italic' },
});
