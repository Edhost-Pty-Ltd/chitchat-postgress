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
