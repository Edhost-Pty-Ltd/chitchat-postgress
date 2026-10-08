-- Up Migration
-- Slice 2: chats, chat members, messages and per-recipient receipts (Req 5.1-5.3).

CREATE TABLE chats (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type                   text NOT NULL CHECK (type IN ('direct', 'group')),
  group_name             text,
  group_photo_object_key text,
  created_by             text REFERENCES users(id) ON DELETE SET NULL,
  -- For direct chats: the two member ids sorted and joined, so a pair maps to
  -- exactly one chat (mirrors getOrCreateDirectChat). NULL for group chats.
  direct_key             text UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_message_text      text,
  last_message_sender_id text,
  last_message_at        timestamptz
);

CREATE TABLE chat_members (
  chat_id               uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id               text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                  text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  unread_count          int NOT NULL DEFAULT 0,
  last_read_message_id  uuid,
  joined_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX idx_chat_members_user ON chat_members(user_id);

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id              uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id            text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id            text,
  type                 text NOT NULL CHECK (type IN
                         ('text','image','voice','video','file','location','system','catalog')),
  text                 text,
  media_object_key     text,
  thumbnail_object_key text,
  file_name            text,
  file_size            bigint,
  mime_type            text,
  duration_ms          int,
  location             jsonb,
  catalog_item         jsonb,
  reply_to             jsonb,
  subtype              text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  deleted_for_everyone boolean NOT NULL DEFAULT false,
  deleted_for          jsonb NOT NULL DEFAULT '[]'::jsonb
);
-- Idempotent send: a (chat, sender, client_id) triple maps to one message (Req 5.17).
CREATE UNIQUE INDEX uniq_messages_client_id
  ON messages(chat_id, sender_id, client_id)
  WHERE client_id IS NOT NULL;
CREATE INDEX idx_messages_chat_created ON messages(chat_id, created_at DESC);
CREATE INDEX idx_messages_expires ON messages(expires_at);

-- Per-recipient delivery/read tracking + per-recipient blocked flag (Req 5.6, 5.7, 5.10).
CREATE TABLE message_receipts (
  message_id      uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at    timestamptz,
  read_at         timestamptz,
  blocked_message boolean NOT NULL DEFAULT false,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX idx_message_receipts_user ON message_receipts(user_id);

-- Down Migration
DROP TABLE IF EXISTS message_receipts;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS chat_members;
DROP TABLE IF EXISTS chats;
