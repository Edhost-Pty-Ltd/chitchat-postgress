-- Up Migration
-- A person may have one active/provisioned business context, whether they are
-- owner, admin, or agent. This matches dashboard selection and prevents a
-- provisioned agent from bypassing assignment policy by creating a new business.

DROP INDEX IF EXISTS uniq_active_business_agent_assignment;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_business_membership
  ON business_agents (agent_user_id)
  WHERE membership_status IN ('provisioned', 'active');

-- Down Migration
DROP INDEX IF EXISTS uniq_active_business_membership;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_business_agent_assignment
  ON business_agents (agent_user_id)
  WHERE membership_role = 'agent'
    AND membership_status IN ('provisioned', 'active');
