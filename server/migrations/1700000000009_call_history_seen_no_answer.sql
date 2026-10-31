-- Up Migration
-- Two call-history refinements:
--
-- 1. `seen` flag — lets the Calls tab badge clear when the user opens the Calls
--    screen. The badge counts unseen incoming missed calls; opening the screen
--    marks them seen so the badge drops to 0 (the rows stay in history).
--
-- 2. 'no_answer' status — an unanswered call must be attributed differently to
--    each party: the CALLER sees an outgoing "no answer" (never "missed"), while
--    only the CALLEE who didn't pick up sees it as "missed". 'no_answer' is the
--    caller-side value; the callee keeps 'missed'.

ALTER TABLE call_history ADD COLUMN seen boolean NOT NULL DEFAULT false;

ALTER TABLE call_history DROP CONSTRAINT call_history_status_check;
ALTER TABLE call_history ADD CONSTRAINT call_history_status_check
  CHECK (status IN ('completed', 'missed', 'rejected', 'busy', 'failed', 'no_answer'));

-- The badge query is "unseen missed incoming" per user; index the unseen subset.
CREATE INDEX idx_call_history_unseen ON call_history(user_id) WHERE seen = false;

-- Backfill: historical unanswered OUTGOING calls were recorded as 'missed' for
-- the caller (old behavior, carried forward by the Firebase data migration).
-- Re-attribute them to the caller-correct 'no_answer'. The callee's matching
-- incoming 'missed' rows are intentionally left unchanged.
UPDATE call_history SET status = 'no_answer' WHERE direction = 'outgoing' AND status = 'missed';

-- Down Migration
-- Fold 'no_answer' back into 'missed' before narrowing the constraint again,
-- otherwise the re-added CHECK would reject those rows.
UPDATE call_history SET status = 'missed' WHERE status = 'no_answer';
DROP INDEX IF EXISTS idx_call_history_unseen;
ALTER TABLE call_history DROP CONSTRAINT call_history_status_check;
ALTER TABLE call_history ADD CONSTRAINT call_history_status_check
  CHECK (status IN ('completed', 'missed', 'rejected', 'busy', 'failed'));
ALTER TABLE call_history DROP COLUMN seen;
