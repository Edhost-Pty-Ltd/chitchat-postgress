-- Add edit tracking columns to the messages table.
-- edited       : boolean flag the client uses to show the "edited" indicator.
-- edited_at    : timestamp of the last edit (NULL means never edited).
-- Only text-type messages can be edited; the constraint is enforced in the
-- route handler, not at the DB level, so we keep the schema flexible.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS edited    boolean                  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS edited_at timestamp with time zone          DEFAULT NULL;
