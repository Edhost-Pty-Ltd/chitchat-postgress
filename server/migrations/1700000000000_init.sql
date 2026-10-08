-- Up Migration
-- Baseline migration. Establishes extensions used across later slices.
-- node-pg-migrate records applied migrations in its own "pgmigrations" table,
-- so re-running `npm run migrate` applies each migration at most once (Req 1.7).

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

-- Down Migration
DROP EXTENSION IF EXISTS "pgcrypto";
