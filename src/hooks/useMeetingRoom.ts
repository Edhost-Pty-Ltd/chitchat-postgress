// ─── useMeetingRoom ───────────────────────────────────────────────────────────
// Loads a meeting and exposes real-time room state plus all the mutating
// operations the organizer needs (mute, kick, mute all, add). Backed by the
// REST API + Socket.IO meeting:* events (the replacement for the old Firestore
// meeting-doc / recordings-subcollection snapshots).

import { useState, useEffect, useCallback } from 'react';
import {
  endpoints,
  type MeetingStateDTO,
  type MeetingRecordingDTO,
} from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export interface RecordingMeta {
  id: string;
  /** Short-lived playback URL. */
  url: string;
  durationMs: number;
  createdAt: Date;
  /** uploaded → processing → done | failed (server-side AI minutes). */
  status: MeetingRecordingDTO['status'];
  minutes: string | null;
}

export interface MeetingRoomState {
  participants: string[];
  joinedMembers: string[];
  mutedUsers: string[];
  kickedUsers: string[];
  isActive: boolean;
  isRecording: boolean;
  endedAt: Date | null;
  /** Scheduled start / end (drives the in-call countdown). */
  startsAt: Date | null;
  endsAt: Date | null;
  minutes: string | null;
  minutesGeneratedAt: Date | null;
  recordings: RecordingMeta[];
  title: string;
  organizerId: string;
}

const EMPTY: MeetingRoomState = {
  participants: [], joinedMembers: [], mutedUsers: [], kickedUsers: [],
  isActive: false, isRecording: false, endedAt: null, startsAt: null, endsAt: null,
  minutes: null, minutesGeneratedAt: null, recordings: [], title: '', organizerId: '',
};

// meeting:updated reasons after which the recordings list (status / minutes)
// may have changed.
const RECORDING_REASONS = new Set(['recording-added', 'recording-processing', 'recording-failed', 'minutes']);

const toDate = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function mapState(s: MeetingStateDTO): Omit<MeetingRoomState, 'recordings'> {
  return {
    participants:       s.participants  ?? [],
    joinedMembers:      s.joinedMembers ?? [],
    mutedUsers:         s.mutedUsers    ?? [],
    kickedUsers:        s.kickedUsers   ?? [],
    isActive:           !!s.isActive,
    isRecording:        !!s.isRecording,
    endedAt:            toDate(s.endedAt),
    startsAt:           toDate(s.startsAt),
    endsAt:             toDate(s.endsAt),
    minutes:            s.minutes ?? null,
    minutesGeneratedAt: toDate(s.minutesGeneratedAt),
    title:              s.title || 'Meeting',
    organizerId:        s.organizerId ?? '',
  };
}

function mapRecording(r: MeetingRecordingDTO): RecordingMeta {
  return {
    id:         r.id,
    url:        r.url ?? '',
    durationMs: r.durationMs ?? 0,
    createdAt:  toDate(r.createdAt) ?? new Date(),
    status:     r.status,
    minutes:    r.minutes ?? null,
  };
}

export function useMeetingRoom(meetingId: string | null) {
  const [room, setRoom]       = useState<MeetingRoomState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [exists, setExists]   = useState(false);

  // ── Load + live updates ─────────────────────────────────────────────────
  useEffect(() => {
    if (!meetingId) { setLoading(false); return; }

    let active = true;
    setLoading(true);

    const applyState = (s: MeetingStateDTO) => {
      setRoom((prev) => ({ ...prev, ...mapState(s) }));
      setExists(true);
      setLoading(false);
    };

    const loadState = async () => {
      try {
        const res = await endpoints.getMeeting(meetingId);
        if (!active) return;
        if (res.ok) {
          applyState(res.data.state);
          return;
        }
        if (res.error.kind === 'api' && res.error.status === 404) {
          setRoom(EMPTY);
          setExists(false);
        } else {
          console.warn('[useMeetingRoom] load failed:', res.error.message);
        }
      } catch (err) {
        console.error('[useMeetingRoom] load error:', err);
      }
      if (active) setLoading(false);
    };

    const loadRecordings = async () => {
      try {
        const res = await endpoints.listMeetingRecordings(meetingId);
        if (!active) return;
        if (!res.ok) {
          console.warn('[useMeetingRoom] recordings load failed:', res.error.message);
          return;
        }
        const recs = res.data.recordings
          .map(mapRecording)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        setRoom((prev) => ({ ...prev, recordings: recs }));
      } catch (err) {
        console.warn('[useMeetingRoom] recordings load error:', err);
      }
    };

    // Load straight away; connect the socket in parallel so live events flow.
    void loadState();
    void loadRecordings();
    socketClient.connect().catch((err) => console.warn('[useMeetingRoom] socket connect failed:', err));

    const forThisMeeting = (payload: unknown) =>
      (payload as { meetingId?: string } | null)?.meetingId === meetingId;

    const unsubs = [
      // Sent to every participant's user room on any change (joined, left,
      // participants, minutes, recording-*, ended, …) with the latest state.
      socketClient.subscribe('meeting:updated', (payload) => {
        if (!active || !forThisMeeting(payload)) return;
        const p = payload as { reason?: string; state?: MeetingStateDTO | null };
        if (p.state) applyState(p.state);
        else void loadState();
        if (p.reason && RECORDING_REASONS.has(p.reason)) void loadRecordings();
      }),
      // Sent to the meeting room on join / leave / mute / kick.
      socketClient.subscribe('meeting:participants', (payload) => {
        if (!active || !forThisMeeting(payload)) return;
        const p = payload as { state?: MeetingStateDTO | null };
        if (p.state) applyState(p.state);
        else void loadState();
      }),
      socketClient.subscribe('meeting:ended', (payload) => {
        if (!active || !forThisMeeting(payload)) return;
        setRoom((prev) => ({
          ...prev,
          isActive: false,
          isRecording: false,
          endedAt: prev.endedAt ?? new Date(),
          joinedMembers: [],
        }));
        void loadState();
      }),
      // Organizer toggled the "being recorded" flag.
      socketClient.subscribe('meeting:recording', (payload) => {
        if (!active || !forThisMeeting(payload)) return;
        const p = payload as { isRecording?: boolean };
        setRoom((prev) => ({ ...prev, isRecording: !!p.isRecording }));
      }),
    ];

    return () => {
      active = false;
      unsubs.forEach((u) => u());
    };
  }, [meetingId]);

  // ── Presence ──────────────────────────────────────────────────────────────
  const join = useCallback(async (userId: string) => {
    if (!meetingId || !userId) return;
    // setActiveMeeting emits meeting:join right away (when the socket exists)
    // and re-joins the room after every reconnect. The server then marks the
    // meeting active and pushes the fresh state via meeting:participants.
    socketClient.setActiveMeeting(meetingId);
    // Optimistic local update
    setRoom((prev) => ({
      ...prev,
      joinedMembers: prev.joinedMembers.includes(userId)
        ? prev.joinedMembers
        : [...prev.joinedMembers, userId],
      isActive: true,
    }));
  }, [meetingId]);

  const leave = useCallback(async (userId: string) => {
    if (!meetingId || !userId) return;
    // Stop re-joining on reconnect, then tell the server we left.
    socketClient.setActiveMeeting(null);
    socketClient.emit('meeting:leave', { meetingId });
    setRoom((prev) => ({
      ...prev,
      joinedMembers: prev.joinedMembers.filter((id) => id !== userId),
    }));
  }, [meetingId]);

  // ── Organizer actions ─────────────────────────────────────────────────────
  // Optimistic local updates; the server confirms with meeting:participants /
  // meeting:updated and notifies the target (meeting:muted / meeting:kicked).
  const muteUser = useCallback(async (targetId: string) => {
    if (!meetingId) return;
    socketClient.emit('meeting:mute', { meetingId, targetId });
    setRoom((prev) => ({
      ...prev,
      mutedUsers: prev.mutedUsers.includes(targetId)
        ? prev.mutedUsers
        : [...prev.mutedUsers, targetId],
    }));
  }, [meetingId]);

  const unmuteUser = useCallback(async (targetId: string) => {
    if (!meetingId) return;
    socketClient.emit('meeting:unmute', { meetingId, targetId });
    setRoom((prev) => ({
      ...prev,
      mutedUsers: prev.mutedUsers.filter((id) => id !== targetId),
    }));
  }, [meetingId]);

  const muteAll = useCallback(async (allIds: string[]) => {
    if (!meetingId || allIds.length === 0) return;
    allIds.forEach((targetId) => socketClient.emit('meeting:mute', { meetingId, targetId }));
    setRoom((prev) => ({
      ...prev,
      mutedUsers: Array.from(new Set([...prev.mutedUsers, ...allIds])),
    }));
  }, [meetingId]);

  const unmuteAll = useCallback(async (allIds: string[]) => {
    if (!meetingId || allIds.length === 0) return;
    allIds.forEach((targetId) => socketClient.emit('meeting:unmute', { meetingId, targetId }));
    setRoom((prev) => ({
      ...prev,
      mutedUsers: prev.mutedUsers.filter((id) => !allIds.includes(id)),
    }));
  }, [meetingId]);

  const removeUser = useCallback(async (targetId: string) => {
    if (!meetingId) return;
    socketClient.emit('meeting:kick', { meetingId, targetId });
    setRoom((prev) => ({
      ...prev,
      participants:  prev.participants.filter((id) => id !== targetId),
      joinedMembers: prev.joinedMembers.filter((id) => id !== targetId),
      mutedUsers:    prev.mutedUsers.filter((id) => id !== targetId),
      kickedUsers:   prev.kickedUsers.includes(targetId)
        ? prev.kickedUsers
        : [...prev.kickedUsers, targetId],
    }));
  }, [meetingId]);

  /** Organizer adds people; the server invites them (chat message + push). */
  const addParticipants = useCallback(async (userIds: string[], organizerName?: string | null) => {
    if (!meetingId || userIds.length === 0) return;
    const res = await endpoints.addMeetingParticipants(meetingId, userIds, organizerName ?? null);
    if (!res.ok) throw new Error(res.error.message);
    const added = res.data.added;
    if (added.length > 0) {
      setRoom((prev) => ({
        ...prev,
        participants: Array.from(new Set([...prev.participants, ...added])),
        kickedUsers:  prev.kickedUsers.filter((id) => !added.includes(id)),
      }));
    }
  }, [meetingId]);

  // ── Minutes / recordings ──────────────────────────────────────────────────
  const saveMinutes = useCallback(async (text: string) => {
    if (!meetingId) return;
    const res = await endpoints.saveMeetingMinutes(meetingId, text);
    if (!res.ok) throw new Error(res.error.message);
    setRoom((prev) => ({ ...prev, minutes: text, minutesGeneratedAt: new Date() }));
  }, [meetingId]);

  /**
   * Register an uploaded recording (media object key). The server generates
   * the AI minutes in the background (`summarizing`), posts them to the meeting
   * chat and emits meeting:updated (reason 'minutes') when they're ready.
   */
  const addRecording = useCallback(async (
    r: { objectKey: string; durationMs: number },
  ): Promise<{ recording: RecordingMeta; summarizing: boolean }> => {
    if (!meetingId) throw new Error('No meeting');
    const res = await endpoints.addMeetingRecording(meetingId, {
      objectKey: r.objectKey,
      durationMs: r.durationMs,
    });
    if (!res.ok) throw new Error(res.error.message);
    const recording = mapRecording(res.data.recording);
    setRoom((prev) => ({
      ...prev,
      recordings: prev.recordings.some((x) => x.id === recording.id)
        ? prev.recordings
        : [...prev.recordings, recording],
    }));
    return { recording, summarizing: res.data.summarizing };
  }, [meetingId]);

  const endMeeting = useCallback(async () => {
    if (!meetingId) return;
    const res = await endpoints.endMeeting(meetingId);
    if (!res.ok) throw new Error(res.error.message);
    setRoom((prev) => ({ ...prev, isActive: false, isRecording: false, endedAt: new Date() }));
  }, [meetingId]);

  /** Organizer: toggle the "This meeting is being recorded" flag for everyone. */
  const setRecordingState = useCallback(async (recording: boolean) => {
    if (!meetingId) return;
    setRoom((prev) => ({ ...prev, isRecording: recording }));
    const res = await endpoints.setMeetingRecordingState(meetingId, recording);
    if (!res.ok) throw new Error(res.error.message);
  }, [meetingId]);

  return {
    room, loading, exists,
    join, leave,
    muteUser, unmuteUser, muteAll, unmuteAll,
    removeUser, addParticipants,
    saveMinutes, addRecording, endMeeting, setRecordingState,
  };
}
