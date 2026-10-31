import { query, withTransaction } from '../pool.js';

export type MeetingType = 'online' | 'in-person';

export interface MeetingLocation {
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  placeId: string | null;
}

export interface MeetingState {
  id: string;
  title: string;
  organizerId: string;
  isActive: boolean;
  isRecording: boolean;
  endedAt: string | null;
  createdAt: string;
  startsAt: string;
  endsAt: string;
  type: MeetingType;
  /** Physical place for in-person meetings; null for virtual. */
  location: MeetingLocation | null;
  reminders: number[];
  minutes: string | null;
  minutesGeneratedAt: string | null;
  /** Invited participants (organizer included), excluding removed users. */
  participants: string[];
  /** Currently in the meeting room. */
  joinedMembers: string[];
  /** Ever joined (attendance). */
  attendees: string[];
  mutedUsers: string[];
  kickedUsers: string[];
  recordingCount: number;
}

interface MeetingRow {
  id: string;
  title: string;
  organizer_id: string;
  is_active: boolean;
  is_recording: boolean;
  ended_at: Date | null;
  created_at: Date;
  starts_at: Date | null;
  ends_at: Date | null;
  type: MeetingType;
  reminders: number[] | null;
  minutes: string | null;
  minutes_generated_at: Date | null;
  location_name: string | null;
  location_address: string | null;
  location_lat: number | null;
  location_lng: number | null;
  location_place_id: string | null;
}

interface ParticipantRow {
  meeting_id: string;
  user_id: string;
  is_muted: boolean;
  is_kicked: boolean;
  joined: boolean;
  joined_at: Date | null;
}

function buildState(row: MeetingRow, parts: ParticipantRow[], recordingCount: number): MeetingState {
  const startsAt = row.starts_at ?? row.created_at;
  const endsAt = row.ends_at ?? new Date(startsAt.getTime() + 60 * 60 * 1000);
  const active = parts.filter((p) => !p.is_kicked);
  return {
    id: row.id,
    title: row.title,
    organizerId: row.organizer_id,
    isActive: row.is_active,
    isRecording: row.is_recording,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    type: row.type ?? 'online',
    location:
      row.location_name || row.location_address || row.location_lat != null
        ? {
            name: row.location_name,
            address: row.location_address,
            lat: row.location_lat,
            lng: row.location_lng,
            placeId: row.location_place_id,
          }
        : null,
    reminders: row.reminders ?? [60, 30, 15, 10],
    minutes: row.minutes,
    minutesGeneratedAt: row.minutes_generated_at ? row.minutes_generated_at.toISOString() : null,
    participants: active.map((p) => p.user_id),
    joinedMembers: active.filter((p) => p.joined).map((p) => p.user_id),
    attendees: parts.filter((p) => p.joined_at !== null).map((p) => p.user_id),
    mutedUsers: active.filter((p) => p.is_muted).map((p) => p.user_id),
    kickedUsers: parts.filter((p) => p.is_kicked).map((p) => p.user_id),
    recordingCount,
  };
}

export interface CreateMeetingInput {
  title: string;
  participants: string[];
  startsAt?: Date | null;
  endsAt?: Date | null;
  type?: MeetingType;
  reminders?: number[];
  location?: MeetingLocation | null;
}

/**
 * Create a meeting with the caller as organizer. Unknown participant ids are
 * skipped (instead of failing the whole create on the users FK). Returns the id
 * and the participant ids that were actually added (organizer included).
 */
export async function createMeeting(
  organizerId: string,
  input: CreateMeetingInput,
): Promise<{ meetingId: string; participants: string[] }> {
  const startsAt = input.startsAt ?? new Date();
  const endsAt = input.endsAt ?? new Date(startsAt.getTime() + 60 * 60 * 1000);
  const loc = input.type === 'in-person' ? input.location ?? null : null;
  return withTransaction(async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO meetings
         (title, organizer_id, starts_at, ends_at, type, reminders,
          location_name, location_address, location_lat, location_lng, location_place_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        input.title,
        organizerId,
        startsAt,
        endsAt,
        input.type ?? 'online',
        input.reminders ?? [60, 30, 15, 10],
        loc?.name ?? null,
        loc?.address ?? null,
        loc?.lat ?? null,
        loc?.lng ?? null,
        loc?.placeId ?? null,
      ],
    );
    const meetingId = res.rows[0].id;
    const ids = Array.from(new Set([organizerId, ...input.participants]));
    const added = await client.query<{ user_id: string }>(
      `INSERT INTO meeting_participants (meeting_id, user_id, role)
       SELECT $1, u.id, CASE WHEN u.id = $2 THEN 'organizer' ELSE 'participant' END
         FROM users u WHERE u.id = ANY($3::text[])
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [meetingId, organizerId, ids],
    );
    return { meetingId, participants: added.rows.map((r) => r.user_id) };
  });
}

export async function getMeeting(meetingId: string): Promise<MeetingState | null> {
  const m = await query<MeetingRow>('SELECT * FROM meetings WHERE id = $1', [meetingId]);
  if (!m.rows[0]) return null;
  const [parts, recs] = await Promise.all([
    query<ParticipantRow>(
      `SELECT meeting_id, user_id, is_muted, is_kicked, joined, joined_at
         FROM meeting_participants WHERE meeting_id = $1`,
      [meetingId],
    ),
    query<{ n: string }>('SELECT count(*)::text AS n FROM meeting_recordings WHERE meeting_id = $1', [
      meetingId,
    ]),
  ]);
  return buildState(m.rows[0], parts.rows, Number(recs.rows[0]?.n ?? 0));
}

/** Is the user an invited (and not removed) participant? */
export async function isMeetingParticipant(meetingId: string, userId: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM meeting_participants
      WHERE meeting_id = $1 AND user_id = $2 AND is_kicked = false`,
    [meetingId, userId],
  );
  return res.rowCount! > 0;
}

/** Current participant ids (excluding removed users) — used to fan out events. */
export async function meetingParticipantIds(meetingId: string): Promise<string[]> {
  const res = await query<{ user_id: string }>(
    'SELECT user_id FROM meeting_participants WHERE meeting_id = $1 AND is_kicked = false',
    [meetingId],
  );
  return res.rows.map((r) => r.user_id);
}

/**
 * Track presence. Joining also marks the meeting active again, like the old
 * Firestore join (`isActive: true`).
 */
export async function setMeetingJoined(
  meetingId: string,
  userId: string,
  joined: boolean,
): Promise<void> {
  await query(
    `UPDATE meeting_participants
       SET joined = $3, joined_at = CASE WHEN $3 THEN COALESCE(joined_at, now()) ELSE joined_at END
     WHERE meeting_id = $1 AND user_id = $2 AND is_kicked = false`,
    [meetingId, userId, joined],
  );
  if (joined) {
    await query('UPDATE meetings SET is_active = true WHERE id = $1', [meetingId]);
  }
}

/** Add participants (existing users only). Returns the ids that were newly added. */
export async function addMeetingParticipants(meetingId: string, userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const res = await query<{ user_id: string }>(
    `INSERT INTO meeting_participants (meeting_id, user_id, role)
     SELECT $1, u.id, 'participant' FROM users u WHERE u.id = ANY($2::text[])
     ON CONFLICT (meeting_id, user_id) DO UPDATE SET is_kicked = false
       WHERE meeting_participants.is_kicked = true
     RETURNING user_id`,
    [meetingId, Array.from(new Set(userIds))],
  );
  return res.rows.map((r) => r.user_id);
}

export async function setParticipantMuted(
  meetingId: string,
  userId: string,
  muted: boolean,
): Promise<void> {
  await query(
    'UPDATE meeting_participants SET is_muted = $3 WHERE meeting_id = $1 AND user_id = $2',
    [meetingId, userId, muted],
  );
}

/** Remove a participant from the meeting (old removeUser → kickedUsers). */
export async function kickParticipant(meetingId: string, userId: string): Promise<void> {
  await query(
    `UPDATE meeting_participants SET is_kicked = true, joined = false, is_muted = false
      WHERE meeting_id = $1 AND user_id = $2 AND role <> 'organizer'`,
    [meetingId, userId],
  );
}

export async function setMeetingRecording(meetingId: string, isRecording: boolean): Promise<void> {
  await query('UPDATE meetings SET is_recording = $2 WHERE id = $1', [meetingId, isRecording]);
}

export async function setMeetingMinutes(meetingId: string, minutes: string): Promise<void> {
  await query('UPDATE meetings SET minutes = $2, minutes_generated_at = now() WHERE id = $1', [
    meetingId,
    minutes,
  ]);
}

export interface MeetingMessage {
  id: string;
  meetingId: string;
  senderId: string;
  senderName: string | null;
  isSystem: boolean;
  text: string | null;
  mediaObjectKey: string | null;
  createdAt: string;
}

export async function addMeetingMessage(
  meetingId: string,
  senderId: string,
  text: string | null,
  mediaObjectKey: string | null,
  opts: { senderName?: string | null; isSystem?: boolean } = {},
): Promise<{ id: string; createdAt: string }> {
  const res = await query<{ id: string; created_at: Date }>(
    `INSERT INTO meeting_messages (meeting_id, sender_id, text, media_object_key, sender_name, is_system)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [meetingId, senderId, text, mediaObjectKey, opts.senderName ?? null, !!opts.isSystem],
  );
  return { id: res.rows[0].id, createdAt: res.rows[0].created_at.toISOString() };
}

/** All messages for a meeting in ascending order (oldest first). */
export async function getMeetingMessages(meetingId: string): Promise<MeetingMessage[]> {
  const res = await query<{
    id: string;
    meeting_id: string;
    sender_id: string;
    sender_name: string | null;
    is_system: boolean;
    text: string | null;
    media_object_key: string | null;
    created_at: Date;
  }>(
    `SELECT id, meeting_id, sender_id, sender_name, is_system, text, media_object_key, created_at
       FROM meeting_messages
      WHERE meeting_id = $1
      ORDER BY created_at ASC`,
    [meetingId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    meetingId: r.meeting_id,
    senderId: r.sender_id,
    senderName: r.sender_name,
    isSystem: r.is_system,
    text: r.text,
    mediaObjectKey: r.media_object_key,
    createdAt: r.created_at.toISOString(),
  }));
}

export type MeetingListItem = MeetingState & { participantCount: number; hasRecordings: boolean };

/** All meetings the user is invited to, ordered by start time (like the old list). */
export async function listMeetings(userId: string): Promise<MeetingListItem[]> {
  const m = await query<MeetingRow>(
    `SELECT m.*
       FROM meetings m
       JOIN meeting_participants p
         ON p.meeting_id = m.id AND p.user_id = $1 AND p.is_kicked = false
      ORDER BY COALESCE(m.starts_at, m.created_at) ASC`,
    [userId],
  );
  if (m.rows.length === 0) return [];
  const ids = m.rows.map((r) => r.id);
  const [parts, recs] = await Promise.all([
    query<ParticipantRow>(
      `SELECT meeting_id, user_id, is_muted, is_kicked, joined, joined_at
         FROM meeting_participants WHERE meeting_id = ANY($1::uuid[])`,
      [ids],
    ),
    query<{ meeting_id: string; n: string }>(
      `SELECT meeting_id, count(*)::text AS n FROM meeting_recordings
        WHERE meeting_id = ANY($1::uuid[]) GROUP BY meeting_id`,
      [ids],
    ),
  ]);
  const partsBy = new Map<string, ParticipantRow[]>();
  for (const p of parts.rows) {
    const list = partsBy.get(p.meeting_id) ?? [];
    list.push(p);
    partsBy.set(p.meeting_id, list);
  }
  const recsBy = new Map(recs.rows.map((r) => [r.meeting_id, Number(r.n)]));
  return m.rows.map((row) => {
    const state = buildState(row, partsBy.get(row.id) ?? [], recsBy.get(row.id) ?? 0);
    return {
      ...state,
      participantCount: state.participants.length,
      hasRecordings: state.recordingCount > 0,
    };
  });
}

/** End a meeting — sets is_active=false, stops the recording flag, records ended_at. */
export async function endMeetingById(meetingId: string): Promise<void> {
  await query(
    `UPDATE meetings SET is_active = false, is_recording = false, ended_at = now() WHERE id = $1`,
    [meetingId],
  );
  await query('UPDATE meeting_participants SET joined = false WHERE meeting_id = $1', [meetingId]);
}

// ─── Recordings ──────────────────────────────────────────────────────────────

export type RecordingStatus = 'uploaded' | 'processing' | 'done' | 'failed';

export interface MeetingRecording {
  id: string;
  meetingId: string;
  objectKey: string;
  durationMs: number;
  createdBy: string | null;
  status: RecordingStatus;
  minutes: string | null;
  error: string | null;
  createdAt: string;
}

interface RecordingRow {
  id: string;
  meeting_id: string;
  object_key: string;
  duration_ms: number;
  created_by: string | null;
  status: RecordingStatus;
  minutes: string | null;
  error: string | null;
  created_at: Date;
}

function toRecording(r: RecordingRow): MeetingRecording {
  return {
    id: r.id,
    meetingId: r.meeting_id,
    objectKey: r.object_key,
    durationMs: r.duration_ms,
    createdBy: r.created_by,
    status: r.status,
    minutes: r.minutes,
    error: r.error,
    createdAt: r.created_at.toISOString(),
  };
}

export async function addMeetingRecording(
  meetingId: string,
  createdBy: string,
  objectKey: string,
  durationMs: number,
): Promise<MeetingRecording> {
  const res = await query<RecordingRow>(
    `INSERT INTO meeting_recordings (meeting_id, created_by, object_key, duration_ms)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [meetingId, createdBy, objectKey, Math.max(0, Math.round(durationMs))],
  );
  return toRecording(res.rows[0]);
}

export async function listMeetingRecordings(meetingId: string): Promise<MeetingRecording[]> {
  const res = await query<RecordingRow>(
    'SELECT * FROM meeting_recordings WHERE meeting_id = $1 ORDER BY created_at ASC',
    [meetingId],
  );
  return res.rows.map(toRecording);
}

export async function getMeetingRecording(recordingId: string): Promise<MeetingRecording | null> {
  const res = await query<RecordingRow>('SELECT * FROM meeting_recordings WHERE id = $1', [
    recordingId,
  ]);
  return res.rows[0] ? toRecording(res.rows[0]) : null;
}

export async function setRecordingStatus(
  recordingId: string,
  status: RecordingStatus,
  extra: { minutes?: string | null; error?: string | null } = {},
): Promise<void> {
  await query(
    `UPDATE meeting_recordings
        SET status = $2,
            minutes = COALESCE($3, minutes),
            error = $4
      WHERE id = $1`,
    [recordingId, status, extra.minutes ?? null, extra.error ?? null],
  );
}
