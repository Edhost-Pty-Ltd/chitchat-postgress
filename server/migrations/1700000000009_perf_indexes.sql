-- Up Migration
-- Performance indexes for the hot query paths (Wave 2 optimization pass).
--
-- These back ORDER BY / foreign-key lookups that previously had no supporting
-- index. They are additive and safe to re-run (IF NOT EXISTS). Not created
-- CONCURRENTLY because the migration runner wraps everything in a single
-- transaction; on a large production table, build these out-of-band with
-- CREATE INDEX CONCURRENTLY instead.

-- listChats orders a user's chats by most-recent activity:
--   ... ORDER BY c.last_message_at DESC NULLS LAST
-- Without this the planner sorts the joined rows every call.
CREATE INDEX IF NOT EXISTS idx_chats_last_message_at
  ON chats (last_message_at DESC NULLS LAST);

-- messages.sender_id is a foreign key to users(id) with ON DELETE CASCADE but
-- had no standalone index. Unindexed FKs force a full scan of messages whenever
-- a referenced user row is deleted; this indexes the cascade (and any
-- sender-scoped lookups).
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages (sender_id);

-- Down Migration
DROP INDEX IF EXISTS idx_messages_sender;
DROP INDEX IF EXISTS idx_chats_last_message_at;
