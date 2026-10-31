-- Up Migration
-- Multi-agent business management, agent provisioning, and audited
-- administrator-assisted biometric enrollment state.
--
-- This is intentionally additive. Agent authority is business-scoped in
-- business_agents; users.role remains a convenience/display value only and is
-- never used as the authorization source for management actions.

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS surname text;

ALTER TABLE business_agents
  ADD COLUMN IF NOT EXISTS membership_role text NOT NULL DEFAULT 'agent'
    CHECK (membership_role IN ('owner', 'admin', 'agent'));
ALTER TABLE business_agents
  ADD COLUMN IF NOT EXISTS membership_status text NOT NULL DEFAULT 'active'
    CHECK (membership_status IN ('provisioned', 'active', 'disabled', 'removed'));
ALTER TABLE business_agents
  ADD COLUMN IF NOT EXISTS added_by_user_id text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE business_agents
  ADD COLUMN IF NOT EXISTS biometric_consent_at timestamptz;
ALTER TABLE business_agents
  ADD COLUMN IF NOT EXISTS face_enrollment_status text NOT NULL DEFAULT 'not_started'
    CHECK (face_enrollment_status IN ('not_started', 'pending', 'enrolled', 'failed'));
ALTER TABLE business_agents
  ADD COLUMN IF NOT EXISTS face_enrolled_at timestamptz;
ALTER TABLE business_agents
  ADD COLUMN IF NOT EXISTS face_enrollment_receipt_jti uuid;

-- Existing company owners must always be active owner-members. This also repairs
-- early business rows that predate the membership-role columns.
INSERT INTO business_agents (
  business_id, agent_user_id, membership_role, membership_status, added_by_user_id
)
SELECT id, owner_id, 'owner', 'active', owner_id
  FROM businesses
ON CONFLICT (business_id, agent_user_id) DO UPDATE
  SET membership_role = 'owner',
      membership_status = 'active',
      added_by_user_id = COALESCE(business_agents.added_by_user_id, EXCLUDED.added_by_user_id);

UPDATE business_agents ba
   SET membership_role = CASE WHEN b.owner_id = ba.agent_user_id THEN 'owner' ELSE 'agent' END,
       membership_status = CASE
         WHEN ba.membership_status = 'removed' THEN 'removed'
         ELSE 'active'
       END
  FROM businesses b
 WHERE b.id = ba.business_id;

-- Convenience role values for existing UI. Business membership remains the
-- only source of authorization for agent-management operations.
UPDATE users u
   SET role = 'admin'
 WHERE EXISTS (SELECT 1 FROM businesses b WHERE b.owner_id = u.id);

UPDATE users u
   SET role = 'agent'
 WHERE role <> 'admin'
   AND EXISTS (
     SELECT 1 FROM business_agents ba
      WHERE ba.agent_user_id = u.id
        AND ba.membership_status IN ('provisioned', 'active')
   );

CREATE INDEX IF NOT EXISTS idx_business_agents_business_active
  ON business_agents (business_id, membership_status, membership_role);
CREATE INDEX IF NOT EXISTS idx_business_agents_agent_active
  ON business_agents (agent_user_id, membership_status);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_business_agent_face_receipt
  ON business_agents (face_enrollment_receipt_jti)
  WHERE face_enrollment_receipt_jti IS NOT NULL;

-- Down Migration
DROP INDEX IF EXISTS uniq_business_agent_face_receipt;
DROP INDEX IF EXISTS idx_business_agents_agent_active;
DROP INDEX IF EXISTS idx_business_agents_business_active;
ALTER TABLE business_agents DROP COLUMN IF EXISTS face_enrollment_receipt_jti;
ALTER TABLE business_agents DROP COLUMN IF EXISTS face_enrolled_at;
ALTER TABLE business_agents DROP COLUMN IF EXISTS face_enrollment_status;
ALTER TABLE business_agents DROP COLUMN IF EXISTS biometric_consent_at;
ALTER TABLE business_agents DROP COLUMN IF EXISTS added_by_user_id;
ALTER TABLE business_agents DROP COLUMN IF EXISTS membership_status;
ALTER TABLE business_agents DROP COLUMN IF EXISTS membership_role;
ALTER TABLE users DROP COLUMN IF EXISTS surname;
ALTER TABLE users DROP COLUMN IF EXISTS first_name;
