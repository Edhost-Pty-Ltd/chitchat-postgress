-- Up Migration
-- Slice 7: backend tables for features that live only on the app branch and had
-- no Postgres home yet. Everything here is ADDITIVE — no existing table is
-- dropped or rewritten, so no existing feature is lost.
--
-- Covers:
--   1. Polls          (in-chat poll messages + options + votes)
--   2. Orders         (in-chat cart/checkout cards)
--   3. Linked devices (companion device linking + one-time link tokens)
--   4. Chat mute      (server-side mute so push respects it)
--   5. Profile views  (counter columns on users)
--   6. Multi-agent    (businesses + agents + internal notes; schema ready for
--                      the type-only feature in src/types/index.ts)
--
-- NOTE: message delivery analytics (useMessageAnalytics) needs NO table — it is
-- an aggregate derived from messages + message_receipts and is best computed on
-- demand in a route handler.

-- ─── 1+2. Polls, Orders, Shared contacts (embedded on messages) ──────────────
-- These are message SUBTYPES: the client renders them as cards inside a chat
-- thread, exactly like the existing `catalog_item` jsonb column. So we extend
-- the `messages` type enum and add jsonb columns that mirror the client shapes
-- ({ question, options[], multiple } / { items[], total, currency } /
--  { name, phone, userId, registered, photoURL, contacts[] }).
--
-- Poll VOTES are the one piece that needs relational integrity (concurrent
-- voters must not clobber each other), so votes live in their own table keyed
-- by (message, option, voter) and are projected back into the message's
-- poll.votes map at read time.

-- Extend the message type check constraint to allow the new subtypes.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK (type IN
  ('text','image','voice','video','file','location','system','catalog','poll','order','contact'));

-- Embedded card payloads (null for non-card messages).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS poll         jsonb;  -- { question, options:[{id,text}], multiple }
ALTER TABLE messages ADD COLUMN IF NOT EXISTS order_data   jsonb;  -- { items:[{id,name,price,imageObjectKey,quantity}], total, currency }
ALTER TABLE messages ADD COLUMN IF NOT EXISTS contact_data jsonb;  -- { name, phone, userId, registered, photoObjectKey, contacts:[...] }

-- Poll votes: one row per (message, option, voter). A repeat insert is a no-op
-- (retraction handled in the repo); single-choice polls clear other options in
-- the same transaction. This replaces the fragile Firestore votes-map rewrite.
CREATE TABLE poll_votes (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  option_id  text NOT NULL,                 -- client option id ("opt0", ...)
  voter_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voted_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, option_id, voter_id)
);
CREATE INDEX idx_poll_votes_message ON poll_votes(message_id);
CREATE INDEX idx_poll_votes_voter ON poll_votes(voter_id);

-- ─── 3. Linked / companion devices ───────────────────────────────────────────
-- deviceLinkTokens  -> device_link_tokens : short-lived (10 min) one-time codes
--                      used to pair a companion device with an owner account.
-- users/{uid}/linkedDevices -> linked_devices : the devices linked to an owner.

CREATE TABLE device_link_tokens (
  id             text PRIMARY KEY,            -- requestId
  display_code   text NOT NULL,               -- 10-char human code
  requester_uid  text,                        -- anon uid of the device asking
  device_id      text NOT NULL,
  device_name    text,
  device_type    text NOT NULL DEFAULT 'phone'
                   CHECK (device_type IN ('phone', 'tablet', 'desktop', 'web')),
  os             text,
  platform       text NOT NULL DEFAULT 'android'
                   CHECK (platform IN ('ios', 'android', 'web')),
  consumed       boolean NOT NULL DEFAULT false,
  owner_uid      text REFERENCES users(id) ON DELETE CASCADE,
  consumed_by_name text,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
-- Only one live (unconsumed) token per display code.
CREATE UNIQUE INDEX uniq_device_link_tokens_live_code
  ON device_link_tokens(display_code)
  WHERE consumed = false;
CREATE INDEX idx_device_link_tokens_expires ON device_link_tokens(expires_at);

CREATE TABLE linked_devices (
  owner_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id      text NOT NULL,
  name           text NOT NULL DEFAULT 'Companion Device',
  type           text NOT NULL DEFAULT 'phone'
                   CHECK (type IN ('phone', 'tablet', 'desktop', 'web')),
  os             text NOT NULL DEFAULT '',
  platform       text NOT NULL DEFAULT 'android'
                   CHECK (platform IN ('ios', 'android', 'web')),
  linked_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, device_id)
);
CREATE INDEX idx_linked_devices_owner ON linked_devices(owner_id, linked_at);

-- ─── 4. Server-side chat mute ────────────────────────────────────────────────
-- Pins / favourites stay device-local (AsyncStorage). Mute must live server-side
-- so the push job can skip muted recipients (mirrors chats/{id}.mutedBy).

CREATE TABLE chat_mutes (
  chat_id   uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  muted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX idx_chat_mutes_user ON chat_mutes(user_id);

-- ─── 5. Profile-view tracking (columns on users) ─────────────────────────────
-- Mirrors the recordProfileView Cloud Function counters. Day-rollover + atomic
-- increment logic moves into the Express route handler.

ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_views            int  NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_views_today      int  NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_views_day_key    text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_views_updated_at timestamptz;

-- Optional de-dup / history of individual views (one row per viewer→viewed).
CREATE TABLE profile_views (
  viewed_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (viewed_id, viewer_id, viewed_at)
);
CREATE INDEX idx_profile_views_viewed ON profile_views(viewed_id, viewed_at DESC);

-- ─── 6. Multi-agent / Business (schema ready for the type-only feature) ───────
-- The Business / InternalNote / UserRole types exist in src/types/index.ts but
-- are not wired to any client code yet. These tables make the schema ready so
-- the feature can be built without another migration.

-- Role + live agent status on the existing users table.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role         text NOT NULL DEFAULT 'customer'
                   CHECK (role IN ('customer', 'agent', 'admin'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS agent_status text
                   CHECK (agent_status IN ('available', 'busy', 'away'));

CREATE TABLE businesses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  owner_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan             text NOT NULL DEFAULT 'free'
                     CHECK (plan IN ('free', 'pro', 'enterprise')),
  auto_assign      boolean NOT NULL DEFAULT false,
  routing_strategy text NOT NULL DEFAULT 'manual'
                     CHECK (routing_strategy IN ('round-robin', 'least-active', 'manual')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_businesses_owner ON businesses(owner_id);

-- Business.agents: string[] -> join table.
CREATE TABLE business_agents (
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, agent_user_id)
);
CREATE INDEX idx_business_agents_agent ON business_agents(agent_user_id);

-- Agent-only notes attached to a business chat.
CREATE TABLE internal_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id     uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  author_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  author_name text,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_internal_notes_chat ON internal_notes(chat_id, created_at);

-- Down Migration
DROP TABLE IF EXISTS internal_notes;
DROP TABLE IF EXISTS business_agents;
DROP TABLE IF EXISTS businesses;
ALTER TABLE users DROP COLUMN IF EXISTS agent_status;
ALTER TABLE users DROP COLUMN IF EXISTS role;

DROP TABLE IF EXISTS profile_views;
ALTER TABLE users DROP COLUMN IF EXISTS profile_views_updated_at;
ALTER TABLE users DROP COLUMN IF EXISTS profile_views_day_key;
ALTER TABLE users DROP COLUMN IF EXISTS profile_views_today;
ALTER TABLE users DROP COLUMN IF EXISTS profile_views;

DROP TABLE IF EXISTS chat_mutes;

DROP TABLE IF EXISTS linked_devices;
DROP TABLE IF EXISTS device_link_tokens;

DROP TABLE IF EXISTS poll_votes;
ALTER TABLE messages DROP COLUMN IF EXISTS contact_data;
ALTER TABLE messages DROP COLUMN IF EXISTS order_data;
ALTER TABLE messages DROP COLUMN IF EXISTS poll;
-- Restore the original message type constraint.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check CHECK (type IN
  ('text','image','voice','video','file','location','system','catalog'));
