-- Up Migration
-- Slice 5: statuses (24h TTL), status views, visibility lists, broadcasts (Req 9).

CREATE TABLE statuses (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name         text,
  user_phone           text,
  media_object_key     text,
  thumbnail_object_key text,
  media_type           text NOT NULL CHECK (media_type IN ('image', 'video', 'text')),
  caption              text,
  background_color     text,
  text_color           text,
  duration_ms          int,
  visibility           text NOT NULL DEFAULT 'everyone'
                         CHECK (visibility IN ('everyone', 'contacts', 'except', 'only')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL
);
CREATE INDEX idx_statuses_expires ON statuses(expires_at);
CREATE INDEX idx_statuses_user_created ON statuses(user_id, created_at DESC);

-- Per-status excluded ('except') / selected ('only') user lists.
CREATE TABLE status_visibility_users (
  status_id uuid NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  user_id   text NOT NULL,
  mode      text NOT NULL CHECK (mode IN ('except', 'only')),
  PRIMARY KEY (status_id, user_id, mode)
);

CREATE TABLE status_views (
  status_id uuid NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
  viewer_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (status_id, viewer_id)
);

CREATE TABLE broadcast_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  last_message text
);
CREATE INDEX idx_broadcast_lists_owner ON broadcast_lists(owner_id, created_at DESC);

CREATE TABLE broadcast_recipients (
  list_id uuid NOT NULL REFERENCES broadcast_lists(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (list_id, user_id)
);

-- Down Migration
DROP TABLE IF EXISTS broadcast_recipients;
DROP TABLE IF EXISTS broadcast_lists;
DROP TABLE IF EXISTS status_views;
DROP TABLE IF EXISTS status_visibility_users;
DROP TABLE IF EXISTS statuses;
