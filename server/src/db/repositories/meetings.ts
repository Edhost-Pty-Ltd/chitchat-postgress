import { query, withTransaction } from '../pool.js';

export interface MeetingState {
  id: string;
  title: string;
  organizerId: string;
  isActive: boolean;
  endedAt: string | null;
  minutes: string | null;
  minutesGeneratedAt: string | null;
  participants: string[];
  joinedMembers: string[];
  mutedUsers: string[];
  kickedUsers: string[];
}

export async function createMeeting(
  organizerId: string,
  title: string,
  participantIds: string[],
): Promise<string> {
  const members = Array.from(new Set([organizerId, ...participantIds]));
  return withTransaction(async (client) => {
    const res = await client.query<{ id: string }>(
      'INSERT INTO meetings (title, organizer_id) VALUES ($1, $2) RETURNING id',
      [title, organizerId],
    );
    const meetingId = res.rows[0].id;
    for (const uid of members) {
      await client.query(
        `INSERT INTO meeting_participants (meeting_id, user_id, role)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [meetingId, uid, uid === organizerId ? 'organizer' : 'participant'],
      );
    }
    return meetingId;
  });
}

export async function getMeeting(meetingId: string): Promise<MeetingState | null> {
  const m = await query<{
    id: string;
    title: string;
    organizer_id: string;
    is_active: boolean;
    ended_at: Date | null;
    minutes: string | null;
    minutes_generated_at: Date | null;
  }>('SELECT * FROM meetings WHERE id = $1', [meetingId]);
  if (!m.rows[0]) return null;
  const row = m.rows[0];

  const parts = await query<{
    user_id: string;
    is_muted: boolean;
    is_kicked: boolean;
    joined: boolean;
  }>('SELECT user_id, is_muted, is_kicked, joined FROM meeting_participants WHERE meeting_id = $1', [
    meetingId,
  ]);

  return {
    id: row.id,
    title: row.title,
    organizerId: row.organizer_id,
    isActive: row.is_active,
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    minutes: row.minutes,
    minutesGeneratedAt: row.minutes_generated_at ? row.minutes_generated_at.toISOString() : null,
    participants: parts.rows.map((p) => p.user_id),
    joinedMembers: parts.rows.filter((p) => p.joined).map((p) => p.user_id),
    mutedUsers: parts.rows.filter((p) => p.is_muted).map((p) => p.user_id),
    kickedUsers: parts.rows.filter((p) => p.is_kicked).map((p) => p.user_id),
  };
}

export async function isMeetingParticipant(meetingId: string, userId: string): Promise<boolean> {
  const res = await query(
    'SELECT 1 FROM meeting_participants WHERE meeting_id = $1 AND user_id = $2',
    [meetingId, userId],
  );
  return res.rowCount! > 0;
}

export async function setMeetingJoined(
  meetingId: string,
  userId: string,
  joined: boolean,
): Promise<void> {
  await query(
    `UPDATE meeting_participants
       SET joined = $3, joined_at = CASE WHEN $3 THEN now() ELSE joined_at END
     WHERE meeting_id = $1 AND user_id = $2`,
    [meetingId, userId, joined],
  );
}

export async function addMeetingMessage(
  meetingId: string,
  senderId: string,
  text: string | null,
  mediaObjectKey: string | null,
): Promise<{ id: string; createdAt: string }> {
  const res = await query<{ id: string; created_at: Date }>(
    `INSERT INTO meeting_messages (meeting_id, sender_id, text, media_object_key)
     VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
    [meetingId, senderId, text, mediaObjectKey],
  );
  return { id: res.rows[0].id, createdAt: res.rows[0].created_at.toISOString() };
}

export interface MeetingListItem {
  id: string;
  title: string;
  organizerId: string;
  isActive: boolean;
  endedAt: string | null;
  createdAt: string;
  participantCount: number;
}

/** All meetings the user participates in, newest first. */
export async function listMeetings(userId: string): Promise<MeetingListItem[]> {
  const res = await query<{
    id: string;
    title: string;
    organizer_id: string;
    is_active: boolean;
    ended_at: Date | null;
    created_at: Date;
    participant_count: string;
  }>(
    `SELECT m.id, m.title, m.organizer_id, m.is_active, m.ended_at, m.created_at,
            COUNT(p2.user_id)::text AS participant_count
       FROM meetings m
       JOIN meeting_participants p ON p.meeting_id = m.id AND p.user_id = $1
       JOIN meeting_participants p2 ON p2.meeting_id = m.id
      GROUP BY m.id
      ORDER BY m.created_at DESC`,
    [userId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    title: r.title,
    organizerId: r.organizer_id,
    isActive: r.is_active,
    endedAt: r.ended_at ? r.ended_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    participantCount: Number(r.participant_count),
  }));
}

export interface MeetingMessage {
  id: string;
  meetingId: string;
  senderId: string;
  text: string | null;
  mediaObjectKey: string | null;
  createdAt: string;
}

/** All messages for a meeting in ascending order (oldest first). */
export async function getMeetingMessages(meetingId: string): Promise<MeetingMessage[]> {
  const res = await query<{
    id: string;
    meeting_id: string;
    sender_id: string;
    text: string | null;
    media_object_key: string | null;
    created_at: Date;
  }>(
    `SELECT id, meeting_id, sender_id, text, media_object_key, created_at
       FROM meeting_messages
      WHERE meeting_id = $1
      ORDER BY created_at ASC`,
    [meetingId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    meetingId: r.meeting_id,
    senderId: r.sender_id,
    text: r.text,
    mediaObjectKey: r.media_object_key,
    createdAt: r.created_at.toISOString(),
  }));
}

/** End a meeting — sets is_active=false and records ended_at. */
export async function endMeetingById(meetingId: string): Promise<void> {
  await query(
    `UPDATE meetings SET is_active = false, ended_at = now() WHERE id = $1`,
    [meetingId],
  );
}
