// ─── useMeetingRoom ──────────────────────────────────────────────────────────
// Subscribes to a meeting document and exposes real-time room state plus
// all the mutating operations the organizer needs (mute, kick, mute all, add).

import { useState, useEffect, useCallback, useRef } from 'react';
import firestore from '@react-native-firebase/firestore';

export interface RecordingMeta {
  id: string;
  url: string;
  durationMs: number;
  createdAt: Date;
}

export interface MeetingRoomState {
  participants: string[];
  joinedMembers: string[];
  mutedUsers: string[];
  kickedUsers: string[];
  isActive: boolean;
  endedAt: Date | null;
  minutes: string | null;
  minutesGeneratedAt: Date | null;
  recordings: RecordingMeta[];
  title: string;
  organizerId: string;
}

const EMPTY: MeetingRoomState = {
  participants: [], joinedMembers: [], mutedUsers: [], kickedUsers: [],
  isActive: false, endedAt: null, minutes: null, minutesGeneratedAt: null,
  recordings: [], title: '', organizerId: '',
};

export function useMeetingRoom(meetingId: string | null) {
  const [room, setRoom]       = useState<MeetingRoomState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [exists, setExists]   = useState(false);

  useEffect(() => {
    if (!meetingId) { setLoading(false); return; }
    setLoading(true);
    const unsub = firestore()
      .collection('meetings').doc(meetingId)
      .onSnapshot(
        snap => {
          if (!snap.exists) {
            setRoom(EMPTY); setExists(false); setLoading(false); return;
          }
          const d = snap.data() ?? {};
          setRoom({
            participants:      d.participants      ?? [],
            joinedMembers:     d.joinedMembers     ?? [],
            mutedUsers:        d.mutedUsers        ?? [],
            kickedUsers:       d.kickedUsers       ?? [],
            isActive:          !!d.isActive,
            endedAt:           d.endedAt?.toDate?.() ?? null,
            minutes:           d.minutes           ?? null,
            minutesGeneratedAt:d.minutesGeneratedAt?.toDate?.() ?? null,
            recordings:        [],
            title:             d.title             ?? 'Meeting',
            organizerId:       d.organizerId       ?? '',
          });
          setExists(true);
          setLoading(false);
        },
        err => {
          console.error('[useMeetingRoom] snapshot error:', err);
          setLoading(false);
        }
      );

    // Separate subscription for recordings subcollection
    const recUnsub = firestore()
      .collection('meetings').doc(meetingId).collection('recordings')
      .orderBy('createdAt', 'asc')
      .onSnapshot(
        snap => {
          if (!snap) return;
          const recs: RecordingMeta[] = snap.docs.map(d => {
            const data = d.data();
            return {
              id: d.id,
              url: data.url ?? '',
              durationMs: data.durationMs ?? 0,
              createdAt: data.createdAt?.toDate?.() ?? new Date(),
            };
          });
          setRoom(prev => ({ ...prev, recordings: recs }));
        },
        err => console.warn('[useMeetingRoom] recordings snapshot error:', err)
      );

    return () => { unsub(); recUnsub(); };
  }, [meetingId]);

  // ── Presence ──────────────────────────────────────────────────────────────
  const joinRoom = useCallback(async () => {
    if (!meetingId) return;
    try {
      await firestore().collection('meetings').doc(meetingId).set({
        joinedMembers: firestore.FieldValue.arrayUnion(meetingId ? undefined : undefined), // no-op, replaced below
      }, { merge: true });
    } catch {}
  }, [meetingId]);

  // Real joinRoom (the one above is a stub — this replaces it below)
  const join = useCallback(async (userId: string) => {
  if (!meetingId || !userId) return;
  try {
    await firestore().collection('meetings').doc(meetingId).set(
      {
        joinedMembers: firestore.FieldValue.arrayUnion(userId),
        isActive: true,
      },
      { merge: true }
    );
  } catch (err) {
    console.error('[useMeetingRoom] join failed:', err);
  }
}, [meetingId]);

  const leave = useCallback(async (userId: string) => {
    if (!meetingId || !userId) return;
    try {
      await firestore().collection('meetings').doc(meetingId).set(
        { joinedMembers: firestore.FieldValue.arrayRemove(userId) },
        { merge: true }
      );
    } catch (err) {
      console.warn('[useMeetingRoom] leave failed:', err);
    }
  }, [meetingId]);

  // ── Organizer actions ─────────────────────────────────────────────────────
  const muteUser = useCallback(async (targetId: string) => {
    if (!meetingId) return;
    await firestore().collection('meetings').doc(meetingId).update({
      mutedUsers: firestore.FieldValue.arrayUnion(targetId),
    });
  }, [meetingId]);

  const unmuteUser = useCallback(async (targetId: string) => {
    if (!meetingId) return;
    await firestore().collection('meetings').doc(meetingId).update({
      mutedUsers: firestore.FieldValue.arrayRemove(targetId),
    });
  }, [meetingId]);

  const muteAll = useCallback(async (allIds: string[]) => {
    if (!meetingId || allIds.length === 0) return;
    await firestore().collection('meetings').doc(meetingId).update({
      mutedUsers: firestore.FieldValue.arrayUnion(...allIds),
    });
  }, [meetingId]);

  const unmuteAll = useCallback(async (allIds: string[]) => {
    if (!meetingId || allIds.length === 0) return;
    await firestore().collection('meetings').doc(meetingId).update({
      mutedUsers: firestore.FieldValue.arrayRemove(...allIds),
    });
  }, [meetingId]);

  const removeUser = useCallback(async (targetId: string) => {
    if (!meetingId) return;
    await firestore().collection('meetings').doc(meetingId).update({
      participants:  firestore.FieldValue.arrayRemove(targetId),
      joinedMembers: firestore.FieldValue.arrayRemove(targetId),
      mutedUsers:    firestore.FieldValue.arrayRemove(targetId),
      kickedUsers:   firestore.FieldValue.arrayUnion(targetId),
    });
  }, [meetingId]);

  const addParticipants = useCallback(async (userIds: string[]) => {
    if (!meetingId || userIds.length === 0) return;
    await firestore().collection('meetings').doc(meetingId).update({
      participants: firestore.FieldValue.arrayUnion(...userIds),
    });
  }, [meetingId]);

  // ── Minutes / recordings ──────────────────────────────────────────────────
  const saveMinutes = useCallback(async (text: string) => {
    if (!meetingId) return;
    await firestore().collection('meetings').doc(meetingId).update({
      minutes: text,
      minutesGeneratedAt: firestore.FieldValue.serverTimestamp(),
    });
  }, [meetingId]);

  const addRecording = useCallback(async (r: { url: string; durationMs: number }) => {
    if (!meetingId) return;
    await firestore()
      .collection('meetings').doc(meetingId)
      .collection('recordings')
      .add({
        url: r.url,
        durationMs: r.durationMs,
        createdAt: firestore.FieldValue.serverTimestamp(),
      });
  }, [meetingId]);

  const endMeeting = useCallback(async () => {
    if (!meetingId) return;
    await firestore().collection('meetings').doc(meetingId).update({
      isActive: false,
      endedAt: firestore.FieldValue.serverTimestamp(),
    });
  }, [meetingId]);

  return {
    room, loading, exists,
    join, leave,
    muteUser, unmuteUser, muteAll, unmuteAll,
    removeUser, addParticipants,
    saveMinutes, addRecording, endMeeting,
  };
}