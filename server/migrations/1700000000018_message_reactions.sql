-- Up Migration
-- Slice 18: Message reactions (emoji reactions on chat messages).
--
-- Design:
--   One row per (message, reactor). Each user can hold at most ONE active
--   emoji on a message at a time — changing your reaction upserts the row,
--   removing it deletes the row.
--
--   The projected `reactions` JSONB (emoji → [userId,...]) is computed at
--   read time from this table (same pattern as poll_votes → poll.votes).
--   We do NOT store it denormalised on the messages row so concurrent
--   reactions never clobber each other.

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id  UUID        NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     TEXT        NOT NULL,
  emoji       TEXT        NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  reacted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)  -- one active emoji per user per message
);

-- Fast lookup by message (used when projecting reactions at read time).
CREATE INDEX IF NOT EXISTS idx_message_reactions_message
  ON message_reactions (message_id);

-- Fast lookup by user (used when a user deletes their account).
CREATE INDEX IF NOT EXISTS idx_message_reactions_user
  ON message_reactions (user_id);
