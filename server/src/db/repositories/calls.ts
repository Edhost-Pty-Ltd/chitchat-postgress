import { query } from '../pool.js';
import { encodeCursor, decodeCursor, clampLimit } from '../../domain/cursor.js';

export type CallType = 'audio' | 'video';
export type CallStatus =
  | 'ringing'
  | 'accepted'
  | 'connected'
  | 'ended'
  | 'rejected'
  | 'missed'
  | 'busy'
  | 'failed';

export interface CallParticipant {
  userId: string;
  displayName: string;
  photoUrl: string | null;
}

export interface CreateCallInput {
  callId: string;
  callerId: string;
  calleeId: string;
  callerInfo: CallParticipant;
  calleeInfo: CallParticipant;
  type: CallType;
}

export async function createCall(input: CreateCallInput): Promise<void> {
  await query(
    `INSERT INTO calls (id, caller_id, callee_id, caller_info, callee_info, type, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'ringing')
     ON CONFLICT (id) DO NOTHING`,
    [
      input.callId,
      input.callerId,
      input.calleeId,
      JSON.stringify(input.callerInfo),
      JSON.stringify(input.calleeInfo),
      input.type,
    ],
  );
}

export interface CallRow {
  id: string;
  caller_id: string;
  callee_id: string;
  caller_info: CallParticipant;
  callee_info: CallParticipant;
  type: CallType;
  status: CallStatus;
  start_time: Date | null;
  end_time: Date | null;
  duration_sec: number | null;
}

export async function getCall(callId: string): Promise<CallRow | null> {
  const res = await query<CallRow>('SELECT * FROM calls WHERE id = $1', [callId]);
  return res.rows[0] ?? null;
}

/** True when userId is the caller or callee of the call (Req 8.7). */
export async function isParticipant(callId: string, userId: string): Promise<boolean> {
  const res = await query(
    'SELECT 1 FROM calls WHERE id = $1 AND (caller_id = $2 OR callee_id = $2)',
    [callId, userId],
  );
  return res.rowCount! > 0;
}

export async function updateCallStatus(
  callId: string,
  status: CallStatus,
  durationSec?: number | null,
): Promise<void> {
  const setStart = status === 'connected' || status === 'accepted';
  const setEnd = status === 'ended' || status === 'rejected' || status === 'missed' || status === 'failed';
  await query(
    `UPDATE calls SET
       status = $2,
       start_time = CASE WHEN $3 AND start_time IS NULL THEN now() ELSE start_time END,
       end_time = CASE WHEN $4 THEN now() ELSE end_time END,
       duration_sec = COALESCE($5, duration_sec),
       updated_at = now()
     WHERE id = $1`,
    [callId, status, setStart, setEnd, durationSec ?? null],
  );
}

export async function addCallHistory(entry: {
  userId: string;
  callId: string;
  otherParty: CallParticipant;
  type: CallType;
  direction: 'incoming' | 'outgoing';
  status: 'completed' | 'missed' | 'rejected' | 'busy' | 'failed';
  durationSec: number | null;
}): Promise<void> {
  await query(
    `INSERT INTO call_history (user_id, call_id, other_party, type, direction, status, duration_sec)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, call_id) DO UPDATE SET
       status = EXCLUDED.status, duration_sec = EXCLUDED.duration_sec`,
    [
      entry.userId,
      entry.callId,
      JSON.stringify(entry.otherParty),
      entry.type,
      entry.direction,
      entry.status,
      entry.durationSec,
    ],
  );
}

export interface HistoryItem {
  callId: string;
  otherParty: CallParticipant;
  type: CallType;
  direction: 'incoming' | 'outgoing';
  status: string;
  durationSec: number | null;
  timestamp: string;
}

export async function listCallHistory(
  userId: string,
  opts: { cursor?: string; limit?: number },
): Promise<{ items: HistoryItem[]; nextCursor: string | null }> {
  const limit = clampLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);
  const params: unknown[] = [userId];
  let keyset = '';
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    keyset = 'AND (created_at, call_id) < ($2::timestamptz, $3::text)';
  }
  const res = await query<{
    call_id: string;
    other_party: CallParticipant;
    type: CallType;
    direction: 'incoming' | 'outgoing';
    status: string;
    duration_sec: number | null;
    created_at: Date;
  }>(
    `SELECT call_id, other_party, type, direction, status, duration_sec, created_at
       FROM call_history WHERE user_id = $1 ${keyset}
      ORDER BY created_at DESC, call_id DESC
      LIMIT ${limit + 1}`,
    params,
  );
  const hasMore = res.rows.length > limit;
  const rows = hasMore ? res.rows.slice(0, limit) : res.rows;
  const items = rows.map((r) => ({
    callId: r.call_id,
    otherParty: r.other_party,
    type: r.type,
    direction: r.direction,
    status: r.status,
    durationSec: r.duration_sec,
    timestamp: r.created_at.toISOString(),
  }));
  const last = rows[rows.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.call_id })
        : null,
  };
}

export async function clearCallHistory(userId: string): Promise<void> {
  await query('DELETE FROM call_history WHERE user_id = $1', [userId]);
}
