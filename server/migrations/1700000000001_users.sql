-- Up Migration
-- Users table. The id is the Firebase uid (text), so Firebase Auth remains the
-- identity source while all user data lives in Postgres (Req 2.6, 4.1).
-- Slice 1 extends this with privacy_settings, blocked_users and push_tokens.

CREATE TABLE users (
  id                 text PRIMARY KEY,
  phone_number       text UNIQUE,
  display_name       text,
  about              text,
  avatar_object_key  text,
  last_seen          timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS users;
