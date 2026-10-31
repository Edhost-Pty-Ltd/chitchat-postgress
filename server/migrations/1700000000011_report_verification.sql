-- Up Migration
-- Contact moderation: a user can report another user. A reported user is put
-- behind a "requires verification" gate on their own device until they verify.
-- `reported_by` remembers who reported them so that, on verification, the
-- reporter can be notified that the person is now verified.

ALTER TABLE users ADD COLUMN IF NOT EXISTS requires_verification boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reported_by text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reported_at timestamptz;

-- Down Migration
ALTER TABLE users DROP COLUMN IF EXISTS reported_at;
ALTER TABLE users DROP COLUMN IF EXISTS reported_by;
ALTER TABLE users DROP COLUMN IF EXISTS requires_verification;
