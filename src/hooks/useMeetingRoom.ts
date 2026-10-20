// ─── useMeetingRoom ───────────────────────────────────────────────────────────
// Subscribes to a meeting and exposes real-time room state plus mutating
// operations. Backed by the Postgres REST API + Socket.IO meeting:* events.

import { useState, useEffect, useCallback } from 'react';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

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

  // ── Load and subscribe ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!meetingId) { setLoading(false); return; }

    let active = true;
    setLoading(true);

    const load = async () => {
      const res = await endpoints.getMeeting(meetingId);
      if (!active) return;
      if (!res.ok) { setLoading(false); return; }

      const s = res.data.state as any;
      setRoom({
        participants:       s?.participants         ?? [],
        joinedMembers:      s?.joinedMembers        ?? [],
        mutedUsers:         s?.mutedUsers           ?? [],
        kickedUsers:        s?.kickedUsers          ?? [],
        isActive:           !!s?.isActive,
        endedAt:            s?.endedAt ? new Date(s.endedAt) : null,
        minutes:            s?.minutes             ?? null,
        minutesGeneratedAt: s?.minutesGeneratedAt ? new Date(s.minutesGeneratedAt) : null,
        recordings:         [],
        title:              s?.title               ?? 'Meeting',
        organizerId:        s?.organizerId         ?? '',
      });
      setExists(true);
      setLoading(false);
    };

    void socketClient.connect().then(load).catch(() => { if (active) setLoading(false); });

    // Re-fetch when socket events indicate room state has changed
    const unsubs = [
      socketClient.subscribe('meeting:updated', () => void load()),
      socketClient.subscribe('meeting:ended',   () => void load()),
      socketClient.subscribe('meeting:joined',  () => void load()),
      socketClient.subscribe('meeting:left',    () => void load()),
    ];

    return () => {
      active = false;
      unsubs.forEach((u) => u());
    };
  }, [meetingId]);

  // ── Presence ──────────────────────────────────────────────────────────────
  const join = useCallback(async (userId: string) => {
    if (!meetingId || !userId) return;
    // Emit join to the socket room so the server tracks presence
    socketClient.emit('meeting:join', { meetingId });
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
    socketClient.emit('meeting:leave', { meetingId });
    setRoom((prev) => ({
      ...prev,
      joinedMembers: prev.joinedMembers.filter((id) => id !== userId),
    }));
  }, [meetingId]);

  // ── Organizer actions ─────────────────────────────────────────────────────
  // These optimistically update local state; the server will confirm via
  // the meeting:updated socket event or the next GET /meetings/:id refresh.
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

  const addParticipants = useCallback(async (userIds: string[]) => {
    if (!meetingId || userIds.length === 0) return;
    await endpoints.updateChat?.(meetingId, { addMembers: userIds })
      .catch(() => {});
    setRoom((prev) => ({
      ...prev,
      participants: Array.from(new Set([...prev.participants, ...userIds])),
    }));
  }, [meetingId]);

  // ── Minutes / recordings ──────────────────────────────────────────────────
  const saveMinutes = useCallback(async (text: string) => {
    if (!meetingId) return;
    // Store locally — server-side minutes storage endpoint is a future task
    setRoom((prev) => ({ ...prev, minutes: text, minutesGeneratedAt: new Date() }));
  }, [meetingId]);

  const addRecording = useCallback(async (r: { url: string; durationMs: number }) => {
    if (!meetingId) return;
    // Recordings are tracked locally (S3 upload wired in VideoCallScreen)
    const rec: RecordingMeta = {
      id: `${Date.now()}`,
      url: r.url,
      durationMs: r.durationMs,
      createdAt: new Date(),
    };
    setRoom((prev) => ({ ...prev, recordings: [...prev.recordings, rec] }));
  }, [meetingId]);

  const endMeeting = useCallback(async () => {
    if (!meetingId) return;
    await endpoints.endMeeting(meetingId);
    setRoom((prev) => ({ ...prev, isActive: false, endedAt: new Date() }));
  }, [meetingId]);

  return {
    room, loading, exists,
    join, leave,
    muteUser, unmuteUser, muteAll, unmuteAll,
    removeUser, addParticipants,
    saveMinutes, addRecording, endMeeting,
  };
}
