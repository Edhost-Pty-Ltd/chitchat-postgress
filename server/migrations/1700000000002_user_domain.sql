-- Up Migration
-- Slice 1: profile fields on users, plus privacy_settings, blocked_users and
-- push_tokens (Req 4.1, 4.7, 4.9, 4.11).

-- Business/profile fields mirrored from the Firestore user doc.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS catalog text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS operational_hours text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'business';

-- Privacy settings, one row per user (Req 4.9). Enum-like values validated at
-- the app layer: 'Everyone' | 'Contacts' | 'Nobody'.
CREATE TABLE privacy_settings (
  user_id               text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen             text NOT NULL DEFAULT 'Contacts',
  profile_photo         text NOT NULL DEFAULT 'Contacts',
  status_visibility     text NOT NULL DEFAULT 'Everyone',
  groups                text NOT NULL DEFAULT 'Contacts',
  calls                 text NOT NULL DEFAULT 'Contacts',
  read_receipts         boolean NOT NULL DEFAULT true,
  disappearing_messages boolean NOT NULL DEFAULT true,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Blocked users: (blocker, blocked) pairs (Req 4.11, 4.13).
CREATE TABLE blocked_users (
  blocker_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name       text,
  photo_object_key   text,
  phone              text,
  last_seen_at_block timestamptz,
  blocked_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX idx_blocked_users_blocked ON blocked_users(blocked_id);

-- Expo push tokens, multiple per user (Req 4.7, 4.8).
CREATE TABLE push_tokens (
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token      text NOT NULL,
  platform   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token)
);
CREATE INDEX idx_push_tokens_user ON push_tokens(user_id);

-- Down Migration
DROP TABLE IF EXISTS push_tokens;
DROP TABLE IF EXISTS blocked_users;
DROP TABLE IF EXISTS privacy_settings;
ALTER TABLE users DROP COLUMN IF EXISTS account_type;
ALTER TABLE users DROP COLUMN IF EXISTS operational_hours;
ALTER TABLE users DROP COLUMN IF EXISTS catalog;
ALTER TABLE users DROP COLUMN IF EXISTS website;
ALTER TABLE users DROP COLUMN IF EXISTS email;
