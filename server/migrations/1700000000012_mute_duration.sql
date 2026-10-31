-- Up Migration
-- Mute duration: a chat mute can now expire. `muted_until` is the instant the
-- mute lapses (NULL = muted forever / "Always"). The push dispatcher and the
-- muted-chats listing treat a row whose `muted_until` is in the past as no
-- longer muted, so notifications resume automatically without a client call.

ALTER TABLE chat_mutes ADD COLUMN IF NOT EXISTS muted_until timestamptz;

-- Down Migration
ALTER TABLE chat_mutes DROP COLUMN IF EXISTS muted_until;
