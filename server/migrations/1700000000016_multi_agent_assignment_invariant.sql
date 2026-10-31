-- Up Migration
-- An agent can be active/provisioned in only one business at a time. Owners are
-- intentionally excluded: the application-level provisioning code separately
-- rejects attaching an owner as another business's agent.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_business_agent_assignment
  ON business_agents (agent_user_id)
  WHERE membership_role = 'agent'
    AND membership_status IN ('provisioned', 'active');

-- Down Migration
DROP INDEX IF EXISTS uniq_active_business_agent_assignment;
