-- Up Migration
-- Slice 8: backend homes for the remaining pre-migration (Firebase) features.
-- Everything is additive; existing rows are backfilled where a new column needs
-- a sensible value.
--
--   1. Meetings: scheduled start/end, type, reminders, live recording flag
--   2. Meeting recordings (+ per-recording AI minutes status)
--   3. Meeting chat system messages (minutes / recap posts)
--   4. Business profile fields (industry, address, hours, auto-responder,
--      catalog items + collections) — replaces the JSON-in-`catalog` stopgap
--   5. Chat labels (synced across the owner's devices)
--   6. Per-user "clear chat" cutoff
--   7. Group past members
--   8. Synced contacts (companion devices read the owner's phone book)
--   9. Push tokens tied to a device (so removing a companion stops its pushes)

-- ─── 1. Meetings scheduling ───────────────────────────────────────────────────
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS starts_at timestamptz;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS ends_at   timestamptz;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS type      text NOT NULL DEFAULT 'online';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS reminders int[] NOT NULL DEFAULT '{60,30,15,10}';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS is_recording boolean NOT NULL DEFAULT false;
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_type_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_type_check CHECK (type IN ('online', 'in-person'));
-- Backfill meetings created before scheduling existed.
UPDATE meetings SET starts_at = created_at WHERE starts_at IS NULL;
UPDATE meetings SET ends_at = starts_at + interval '1 hour' WHERE ends_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_meetings_starts ON meetings(starts_at);

-- ─── 2. Meeting recordings ────────────────────────────────────────────────────
CREATE TABLE meeting_recordings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id  uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  object_key  text NOT NULL,
  duration_ms int  NOT NULL DEFAULT 0,
  created_by  text REFERENCES users(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'uploaded'
                CHECK (status IN ('uploaded', 'processing', 'done', 'failed')),
  minutes     text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_meeting_recordings_meeting ON meeting_recordings(meeting_id, created_at);

-- ─── 3. Meeting chat system messages ──────────────────────────────────────────
ALTER TABLE meeting_messages ADD COLUMN IF NOT EXISTS sender_name text;
ALTER TABLE meeting_messages ADD COLUMN IF NOT EXISTS is_system   boolean NOT NULL DEFAULT false;

-- ─── 4. Business profile ──────────────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS industry               text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address                jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_schedule          jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone               text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_responder_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_responder_message text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS catalog_items          jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS catalog_collections    jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ─── 5. Chat labels ───────────────────────────────────────────────────────────
CREATE TABLE chat_labels (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      text NOT NULL,
  member_ids text[] NOT NULL DEFAULT '{}',
  group_ids  text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_labels_owner ON chat_labels(owner_id, created_at);

-- ─── 6. Per-user clear-chat cutoff ────────────────────────────────────────────
ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS cleared_at timestamptz;

-- ─── 7. Group past members ────────────────────────────────────────────────────
CREATE TABLE chat_past_members (
  chat_id      uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name text,
  left_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);

-- ─── 8. Synced contacts ───────────────────────────────────────────────────────
CREATE TABLE synced_contacts (
  owner_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone             text NOT NULL,
  display_name      text NOT NULL,
  user_id           text,
  is_saved          boolean NOT NULL DEFAULT false,
  avatar_object_key text,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, phone)
);

-- ─── 9. Push tokens per device ────────────────────────────────────────────────
ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS device_id text;
CREATE INDEX IF NOT EXISTS idx_push_tokens_device ON push_tokens(user_id, device_id);

-- Down Migration
DROP INDEX IF EXISTS idx_push_tokens_device;
ALTER TABLE push_tokens DROP COLUMN IF EXISTS device_id;

DROP TABLE IF EXISTS synced_contacts;
DROP TABLE IF EXISTS chat_past_members;
ALTER TABLE chat_members DROP COLUMN IF EXISTS cleared_at;
DROP TABLE IF EXISTS chat_labels;

ALTER TABLE users DROP COLUMN IF EXISTS catalog_collections;
ALTER TABLE users DROP COLUMN IF EXISTS catalog_items;
ALTER TABLE users DROP COLUMN IF EXISTS auto_responder_message;
ALTER TABLE users DROP COLUMN IF EXISTS auto_responder_enabled;
ALTER TABLE users DROP COLUMN IF EXISTS timezone;
ALTER TABLE users DROP COLUMN IF EXISTS work_schedule;
ALTER TABLE users DROP COLUMN IF EXISTS address;
ALTER TABLE users DROP COLUMN IF EXISTS industry;

ALTER TABLE meeting_messages DROP COLUMN IF EXISTS is_system;
ALTER TABLE meeting_messages DROP COLUMN IF EXISTS sender_name;

DROP TABLE IF EXISTS meeting_recordings;

DROP INDEX IF EXISTS idx_meetings_starts;
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_type_check;
ALTER TABLE meetings DROP COLUMN IF EXISTS is_recording;
ALTER TABLE meetings DROP COLUMN IF EXISTS reminders;
ALTER TABLE meetings DROP COLUMN IF EXISTS type;
ALTER TABLE meetings DROP COLUMN IF EXISTS ends_at;
ALTER TABLE meetings DROP COLUMN IF EXISTS starts_at;
