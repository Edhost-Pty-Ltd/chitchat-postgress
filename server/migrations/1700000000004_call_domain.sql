-- Up Migration
-- Slice 4: calls, call history, meetings (Req 8.4, 8.9, 8.14).
-- WebRTC offer/answer/ICE are NOT stored here — they are relayed as Socket.IO
-- events and briefly buffered in Redis (Req 8.1, 8.2, 8.8).

CREATE TABLE calls (
  id            text PRIMARY KEY,       -- keeps the ${caller}_${callee}_${ts} scheme
  caller_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caller_info   jsonb NOT NULL,
  callee_info   jsonb NOT NULL,
  type          text NOT NULL CHECK (type IN ('audio', 'video')),
  status        text NOT NULL,
  start_time    timestamptz,
  end_time      timestamptz,
  duration_sec  int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_calls_callee_status ON calls(callee_id, status);
CREATE INDEX idx_calls_updated ON calls(updated_at);

-- Per-user call history (Req 8.9, 8.11).
CREATE TABLE call_history (
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  call_id      text NOT NULL,
  other_party  jsonb NOT NULL,
  type         text NOT NULL CHECK (type IN ('audio', 'video')),
  direction    text NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  status       text NOT NULL CHECK (status IN ('completed', 'missed', 'rejected', 'busy', 'failed')),
  duration_sec int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, call_id)
);
CREATE INDEX idx_call_history_user_time ON call_history(user_id, created_at DESC);

-- Meetings (Req 8.14).
CREATE TABLE meetings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title                text NOT NULL DEFAULT 'Meeting',
  organizer_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_active            boolean NOT NULL DEFAULT true,
  ended_at             timestamptz,
  minutes              text,
  minutes_generated_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meeting_participants (
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'participant',
  is_muted   boolean NOT NULL DEFAULT false,
  is_kicked  boolean NOT NULL DEFAULT false,
  joined     boolean NOT NULL DEFAULT false,
  joined_at  timestamptz,
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE meeting_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id       uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  sender_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text             text,
  media_object_key text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_meeting_messages_meeting ON meeting_messages(meeting_id, created_at);

-- Down Migration
DROP TABLE IF EXISTS meeting_messages;
DROP TABLE IF EXISTS meeting_participants;
DROP TABLE IF EXISTS meetings;
DROP TABLE IF EXISTS call_history;
DROP TABLE IF EXISTS calls;
