-- Up Migration
-- Repair accounts that were already report-gated before generation-bound
-- receipts existed, then make the state invariant enforceable by Postgres.

UPDATE users
   SET verification_generation = gen_random_uuid()
 WHERE requires_verification = true
   AND verification_generation IS NULL;

ALTER TABLE users
  ADD CONSTRAINT users_required_verification_has_generation
  CHECK (requires_verification = false OR verification_generation IS NOT NULL);

-- Down Migration
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_required_verification_has_generation;
