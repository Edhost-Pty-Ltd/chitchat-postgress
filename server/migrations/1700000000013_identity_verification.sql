-- Up Migration
-- Canonical identity status for the report → facial re-verification flow.
--
-- `identity_verified` is the only public signal. Reporter ids, report rows, and
-- verification generations are owner/server-only. Every accepted report gets a
-- fresh generation; a facial proof can clear only the generation it was issued
-- for, so a newer report cannot be erased by an older in-flight verification.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS identity_verified boolean NOT NULL DEFAULT true;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz DEFAULT now();
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS verification_generation uuid;

-- Preserve the existing report gate when this migration lands.
UPDATE users
   SET identity_verified = NOT requires_verification,
       identity_verified_at = CASE WHEN requires_verification THEN NULL ELSE COALESCE(identity_verified_at, now()) END
 WHERE requires_verification = true OR identity_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS user_reports (
  id                      uuid PRIMARY KEY,
  reporter_id             text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id             text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verification_generation uuid NOT NULL,
  status                  text NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'resolved')),
  created_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz,
  CHECK (reporter_id <> reported_id)
);

CREATE INDEX IF NOT EXISTS idx_user_reports_target_open
  ON user_reports (reported_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_reports_reporter_target
  ON user_reports (reporter_id, reported_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_verification_generation
  ON users (verification_generation)
  WHERE requires_verification = true;

-- Down Migration
DROP INDEX IF EXISTS idx_users_verification_generation;
DROP INDEX IF EXISTS idx_user_reports_reporter_target;
DROP INDEX IF EXISTS idx_user_reports_target_open;
DROP TABLE IF EXISTS user_reports;
ALTER TABLE users DROP COLUMN IF EXISTS verification_generation;
ALTER TABLE users DROP COLUMN IF EXISTS identity_verified_at;
ALTER TABLE users DROP COLUMN IF EXISTS identity_verified;
