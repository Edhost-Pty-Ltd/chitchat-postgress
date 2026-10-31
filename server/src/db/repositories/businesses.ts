import { query, withTransaction } from '../pool.js';
import { getUserById, type UserRow } from './users.js';

export type Plan = 'free' | 'pro' | 'enterprise';
export type RoutingStrategy = 'round-robin' | 'least-active' | 'manual';
/** Legacy global display role; never use it to authorize business actions. */
export type UserRole = 'customer' | 'agent' | 'admin';
export type AgentStatus = 'available' | 'busy' | 'away';
export type BusinessMembershipRole = 'owner' | 'admin' | 'agent';
export type BusinessMembershipStatus = 'provisioned' | 'active' | 'disabled' | 'removed';
export type AgentFaceEnrollmentStatus = 'not_started' | 'pending' | 'enrolled' | 'failed';

export interface Business {
  businessId: string;
  name: string;
  ownerId: string;
  agents: string[];
  plan: Plan;
  createdAt: string;
  settings: { autoAssign: boolean; routingStrategy: RoutingStrategy };
}

export interface BusinessAgent {
  agentId: string;
  firstName: string | null;
  surname: string | null;
  displayName: string;
  /** Returned only to the agent themselves or an active manager. */
  phoneNumber: string | null;
  role: BusinessMembershipRole;
  membershipStatus: BusinessMembershipStatus;
  agentStatus: AgentStatus | null;
  faceEnrollmentStatus: AgentFaceEnrollmentStatus;
  faceEnrolledAt: string | null;
  biometricConsentAt: string | null;
  addedAt: string;
  /**
   * Distinct client chats this agent has actively assisted with, measured by
   * authored internal notes — the only trace of an agent's involvement in a
   * specific conversation, since agents are never chat_members of the
   * owner's chats themselves. Scoped to this business only (see
   * getClientChatCounts). Defaults to 0 for call sites that don't need it
   * (the dashboard/agent-detail reads are the only ones that compute it for
   * real; everything else returns a fresh row immediately superseded by a
   * full dashboard reload).
   */
  clientCount: number;
}

export interface BusinessDashboard {
  business: Business;
  company: {
    businessName: string;
    ownerDisplayName: string | null;
    industry: string | null;
    about: string | null;
    email: string | null;
    website: string | null;
    operationalHours: string | null;
    address: Record<string, string> | null;
    workSchedule: Record<string, { open: string; close: string }> | null;
    catalogItemCount: number;
    catalogCollectionCount: number;
  };
  viewer: {
    agentId: string;
    role: BusinessMembershipRole;
    membershipStatus: BusinessMembershipStatus;
    agentStatus: AgentStatus | null;
    canManageAgents: boolean;
  };
  agents: BusinessAgent[];
  summary: {
    totalAgents: number;
    activeAgents: number;
    availableAgents: number;
    enrolledAgents: number;
    /** Distinct client chats with at least one internal note, team-wide. */
    totalClientConversations: number;
  };
}

export class BusinessAgentError extends Error {
  constructor(
    readonly code:
      | 'business_not_found'
      | 'not_business_member'
      | 'not_business_manager'
      | 'agent_not_found'
      | 'agent_already_assigned'
      | 'agent_already_registered'
      | 'agent_phone_conflict'
      | 'agent_already_enrolled'
      | 'agent_membership_inactive'
      | 'agent_identity_recovery_required'
      | 'agent_receipt_replayed',
    message: string,
  ) {
    super(message);
    this.name = 'BusinessAgentError';
  }
}

interface BusinessRow {
  id: string;
  name: string;
  owner_id: string;
  plan: Plan;
  auto_assign: boolean;
  routing_strategy: RoutingStrategy;
  created_at: Date;
  agents: string[];
}

interface MembershipRow {
  business_id: string;
  agent_user_id: string;
  membership_role: BusinessMembershipRole;
  membership_status: BusinessMembershipStatus;
  added_at: Date;
  biometric_consent_at: Date | null;
  face_enrollment_status: AgentFaceEnrollmentStatus;
  face_enrolled_at: Date | null;
  face_enrollment_receipt_jti: string | null;
  first_name: string | null;
  surname: string | null;
  display_name: string | null;
  phone_number: string | null;
  agent_status: AgentStatus | null;
}

function rowToBusiness(r: BusinessRow): Business {
  return {
    businessId: r.id,
    name: r.name,
    ownerId: r.owner_id,
    agents: r.agents ?? [],
    plan: r.plan,
    createdAt: r.created_at.toISOString(),
    settings: { autoAssign: r.auto_assign, routingStrategy: r.routing_strategy },
  };
}

function rowToAgent(row: MembershipRow, includePhone: boolean, clientCount = 0): BusinessAgent {
  const derivedName = [row.first_name, row.surname].filter(Boolean).join(' ').trim();
  return {
    agentId: row.agent_user_id,
    firstName: row.first_name,
    surname: row.surname,
    displayName: row.display_name?.trim() || derivedName || 'Team member',
    phoneNumber: includePhone ? row.phone_number : null,
    role: row.membership_role,
    membershipStatus: row.membership_status,
    agentStatus: row.agent_status,
    faceEnrollmentStatus: row.face_enrollment_status,
    faceEnrolledAt: row.face_enrolled_at?.toISOString() ?? null,
    biometricConsentAt: row.biometric_consent_at?.toISOString() ?? null,
    addedAt: row.added_at.toISOString(),
    clientCount,
  };
}

/**
 * Distinct client chats each agent has actively assisted with this
 * business, measured by authored internal notes. Agents are never
 * chat_members of the owner's own chats (sending into them requires
 * membership, which only the owner and the customer have), so an internal
 * note is the only durable signal that a specific agent engaged with a
 * specific client conversation. Joining through chat_members + businesses
 * (the same join `chatAgents` below uses) scopes this to the CURRENT
 * business, so notes left while on a previous business never inflate it.
 */
async function getClientChatCounts(
  businessId: string,
  agentIds: string[],
): Promise<Map<string, number>> {
  if (agentIds.length === 0) return new Map();
  const res = await query<{ author_id: string; count: string }>(
    `SELECT n.author_id, COUNT(DISTINCT n.chat_id)::text AS count
       FROM internal_notes n
       JOIN chat_members cm ON cm.chat_id = n.chat_id
       JOIN businesses b    ON b.owner_id = cm.user_id AND b.id = $1
      WHERE n.author_id = ANY($2::text[])
      GROUP BY n.author_id`,
    [businessId, agentIds],
  );
  return new Map(res.rows.map((r) => [r.author_id, Number(r.count)]));
}

/** Team-wide distinct client chats with at least one internal note. */
async function getBusinessClientConversationTotal(businessId: string): Promise<number> {
  const res = await query<{ count: string }>(
    `SELECT COUNT(DISTINCT n.chat_id)::text AS count
       FROM internal_notes n
       JOIN chat_members cm ON cm.chat_id = n.chat_id
       JOIN businesses b    ON b.owner_id = cm.user_id AND b.id = $1`,
    [businessId],
  );
  return Number(res.rows[0]?.count ?? '0');
}

const ACTIVE_MEMBERSHIP_SQL = "IN ('provisioned', 'active')";

async function getMembership(businessId: string, userId: string): Promise<MembershipRow | null> {
  const result = await query<MembershipRow>(
    `SELECT ba.*, u.first_name, u.surname, u.display_name, u.phone_number, u.agent_status
       FROM business_agents ba
       JOIN users u ON u.id = ba.agent_user_id
      WHERE ba.business_id = $1 AND ba.agent_user_id = $2`,
    [businessId, userId],
  );
  return result.rows[0] ?? null;
}

async function listMemberships(businessId: string): Promise<MembershipRow[]> {
  const result = await query<MembershipRow>(
    `SELECT ba.*, u.first_name, u.surname, u.display_name, u.phone_number, u.agent_status
       FROM business_agents ba
       JOIN users u ON u.id = ba.agent_user_id
      WHERE ba.business_id = $1
        AND ba.membership_status <> 'removed'
      ORDER BY CASE ba.membership_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               lower(COALESCE(u.display_name, ''))`,
    [businessId],
  );
  return result.rows;
}

async function getBusinessForUser(userId: string): Promise<{ businessId: string } | null> {
  const result = await query<{ business_id: string }>(
    `SELECT ba.business_id
       FROM business_agents ba
      WHERE ba.agent_user_id = $1
        AND ba.membership_status ${ACTIVE_MEMBERSHIP_SQL}
      ORDER BY CASE ba.membership_role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               ba.added_at ASC
      LIMIT 1`,
    [userId],
  );
  return result.rows[0] ? { businessId: result.rows[0].business_id } : null;
}

async function bootstrapBusinessForOwner(userId: string): Promise<string> {
  return withTransaction(async (client) => {
    const user = await client.query<{ display_name: string | null }>(
      'SELECT display_name FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    if (!user.rows[0]) throw new BusinessAgentError('business_not_found', 'User not found');

    // Serialize bootstrap with explicit creation: neither path may create a
    // second active business context for the same Firebase identity.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [userId]);
    const already = await client.query<{ business_id: string }>(
      `SELECT business_id FROM business_agents
        WHERE agent_user_id = $1 AND membership_status ${ACTIVE_MEMBERSHIP_SQL}
        LIMIT 1`,
      [userId],
    );
    if (already.rows[0]) return already.rows[0].business_id;

    const name = user.rows[0].display_name?.trim() || 'My Business';
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id)
       VALUES ($1, $2)
       RETURNING id`,
      [name, userId],
    );
    const businessId = inserted.rows[0].id;
    await client.query(
      `INSERT INTO business_agents (
         business_id, agent_user_id, membership_role, membership_status, added_by_user_id
       ) VALUES ($1, $2, 'owner', 'active', $2)`,
      [businessId, userId],
    );
    await client.query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
    return businessId;
  });
}

/** List businesses the user owns or is an active/provisioned agent of. */
export async function listBusinessesForUser(userId: string): Promise<Business[]> {
  const res = await query<BusinessRow>(
    `SELECT b.*, ARRAY[]::text[] AS agents
       FROM businesses b
      WHERE EXISTS (
        SELECT 1 FROM business_agents a
         WHERE a.business_id = b.id
           AND a.agent_user_id = $1
           AND a.membership_status ${ACTIVE_MEMBERSHIP_SQL}
      )
      ORDER BY b.created_at DESC`,
    [userId],
  );
  return res.rows.map(rowToBusiness);
}

export async function getBusiness(businessId: string): Promise<Business | null> {
  const res = await query<BusinessRow>(
    `SELECT b.*, ARRAY(
        SELECT agent_user_id FROM business_agents a
         WHERE a.business_id = b.id AND a.membership_status ${ACTIVE_MEMBERSHIP_SQL}
      ) AS agents
       FROM businesses b WHERE b.id = $1`,
    [businessId],
  );
  return res.rows[0] ? rowToBusiness(res.rows[0]) : null;
}

export async function createBusiness(
  ownerId: string,
  input: { name: string; plan?: Plan; autoAssign?: boolean; routingStrategy?: RoutingStrategy },
): Promise<Business> {
  return withTransaction(async (client) => {
      // Serialize owner creation too: a person may be active/provisioned in
      // exactly one business, regardless of whether their role is owner/admin/agent.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ownerId]);
      const existingMembership = await client.query<{ business_id: string }>(
        `SELECT business_id FROM business_agents
          WHERE agent_user_id = $1 AND membership_status ${ACTIVE_MEMBERSHIP_SQL}
          LIMIT 1`,
        [ownerId],
      );
      if (existingMembership.rows[0]) {
        throw new BusinessAgentError('agent_already_assigned', 'You already belong to an active business');
      }

      const res = await client.query<{ id: string }>(
      `INSERT INTO businesses (name, owner_id, plan, auto_assign, routing_strategy)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        input.name,
        ownerId,
        input.plan ?? 'free',
        input.autoAssign ?? false,
        input.routingStrategy ?? 'manual',
      ],
    );
    const id = res.rows[0].id;
    await client.query(
      `INSERT INTO business_agents (
         business_id, agent_user_id, membership_role, membership_status, added_by_user_id
       ) VALUES ($1, $2, 'owner', 'active', $2)`,
      [id, ownerId],
    );
    await client.query("UPDATE users SET role = 'admin' WHERE id = $1", [ownerId]);
    const created = await client.query<BusinessRow>(
      `SELECT b.*, ARRAY(SELECT agent_user_id FROM business_agents a WHERE a.business_id = b.id) AS agents
         FROM businesses b WHERE b.id = $1`,
      [id],
    );
    return rowToBusiness(created.rows[0]);
  });
}

export async function ownsBusiness(businessId: string, ownerId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM businesses WHERE id = $1 AND owner_id = $2', [
    businessId,
    ownerId,
  ]);
  return res.rowCount! > 0;
}

export async function updateBusiness(
  businessId: string,
  patch: { name?: string; plan?: Plan; autoAssign?: boolean; routingStrategy?: RoutingStrategy },
): Promise<Business | null> {
  await query(
    `UPDATE businesses SET
       name             = COALESCE($2, name),
       plan             = COALESCE($3, plan),
       auto_assign      = COALESCE($4, auto_assign),
       routing_strategy = COALESCE($5, routing_strategy)
     WHERE id = $1`,
    [businessId, patch.name ?? null, patch.plan ?? null, patch.autoAssign ?? null, patch.routingStrategy ?? null],
  );
  return getBusiness(businessId);
}

/** Business-scoped owner/admin check; the sole authority for agent management. */
export async function canManageBusinessAgents(businessId: string, userId: string): Promise<boolean> {
  const membership = await getMembership(businessId, userId);
  return !!membership &&
    membership.membership_status === 'active' &&
    (membership.membership_role === 'owner' || membership.membership_role === 'admin');
}

export async function getBusinessDashboardForUser(userId: string): Promise<BusinessDashboard> {
  let selected = await getBusinessForUser(userId);
  if (!selected) selected = { businessId: await bootstrapBusinessForOwner(userId) };

  const viewer = await getMembership(selected.businessId, userId);
  if (!viewer || viewer.membership_status === 'removed' || viewer.membership_status === 'disabled') {
    throw new BusinessAgentError('not_business_member', 'You are not an active business member');
  }

  const business = await getBusiness(selected.businessId);
  if (!business) throw new BusinessAgentError('business_not_found', 'Business not found');
  const owner = await getUserById(business.ownerId);
  if (!owner) throw new BusinessAgentError('business_not_found', 'Business owner not found');

  const canManageAgents =
    viewer.membership_status === 'active' &&
    (viewer.membership_role === 'owner' || viewer.membership_role === 'admin');
  const rows = await listMemberships(selected.businessId);
  const clientCounts = await getClientChatCounts(selected.businessId, rows.map((row) => row.agent_user_id));
  const allAgents = rows.map((row) =>
    rowToAgent(row, canManageAgents || row.agent_user_id === userId, clientCounts.get(row.agent_user_id) ?? 0),
  );
  // Only owners/admins receive a roster. An agent dashboard is deliberately
  // personal: it receives company context plus its own status, but not peer
  // names, enrollment states, availability, or phone metadata.
  const agents = canManageAgents
    ? allAgents
    : allAgents.filter((agent) => agent.agentId === userId);
  const staff = canManageAgents
    ? allAgents.filter((agent) => agent.role !== 'owner')
    : [];

  return {
    business: canManageAgents ? business : { ...business, agents: [] },
    company: companyFromOwner(business, owner),
    viewer: {
      agentId: userId,
      role: viewer.membership_role,
      membershipStatus: viewer.membership_status,
      agentStatus: viewer.agent_status,
      canManageAgents,
    },
    agents,
    summary: {
      totalAgents: staff.length,
      activeAgents: staff.filter((agent) => agent.membershipStatus === 'active').length,
      availableAgents: staff.filter((agent) => agent.agentStatus === 'available').length,
      enrolledAgents: staff.filter((agent) => agent.faceEnrollmentStatus === 'enrolled').length,
      totalClientConversations: await getBusinessClientConversationTotal(selected.businessId),
    },
  };
}

function companyFromOwner(business: Business, owner: UserRow): BusinessDashboard['company'] {
  return {
    businessName: business.name,
    ownerDisplayName: owner.display_name,
    industry: owner.industry ?? null,
    about: owner.about,
    email: owner.email,
    website: owner.website,
    operationalHours: owner.operational_hours,
    address: owner.address ?? null,
    workSchedule: owner.work_schedule ?? null,
    catalogItemCount: Array.isArray(owner.catalog_items) ? owner.catalog_items.length : 0,
    catalogCollectionCount: Array.isArray(owner.catalog_collections)
      ? owner.catalog_collections.length
      : 0,
  };
}

export async function getBusinessAgentForViewer(
  businessId: string,
  targetAgentId: string,
  viewerId: string,
): Promise<BusinessAgent> {
  const viewer = await getMembership(businessId, viewerId);
  if (!viewer || !['provisioned', 'active'].includes(viewer.membership_status)) {
    throw new BusinessAgentError('not_business_member', 'You are not a business member');
  }
  const canManage = viewer.membership_status === 'active' &&
    (viewer.membership_role === 'owner' || viewer.membership_role === 'admin');
  if (!canManage && targetAgentId !== viewerId) {
    throw new BusinessAgentError('not_business_manager', 'You cannot view this team member');
  }
  const target = await getMembership(businessId, targetAgentId);
  if (!target || target.membership_status === 'removed') {
    throw new BusinessAgentError('agent_not_found', 'Agent not found');
  }
  const clientCounts = await getClientChatCounts(businessId, [targetAgentId]);
  return rowToAgent(target, canManage || targetAgentId === viewerId, clientCounts.get(targetAgentId) ?? 0);
}

/**
 * Attach/provision a distinct Firebase identity as a business agent. The caller
 * has already resolved the phone through Firebase Admin; this transaction never
 * trusts a client-supplied UID and never creates a companion session.
 */
export async function provisionBusinessAgent(input: {
  businessId: string;
  managerId: string;
  agentId: string;
  phoneNumber: string;
  firstName: string;
  surname: string;
  consentConfirmedAt: Date;
}): Promise<BusinessAgent> {
  return withTransaction(async (client) => {
    const manager = await client.query<MembershipRow>(
      `SELECT ba.*, u.first_name, u.surname, u.display_name, u.phone_number, u.agent_status
         FROM business_agents ba JOIN users u ON u.id = ba.agent_user_id
        WHERE ba.business_id = $1 AND ba.agent_user_id = $2 FOR UPDATE`,
      [input.businessId, input.managerId],
    );
    const managerRow = manager.rows[0];
    if (!managerRow || managerRow.membership_status !== 'active' ||
      !['owner', 'admin'].includes(managerRow.membership_role)) {
      throw new BusinessAgentError('not_business_manager', 'Only an active business manager can add agents');
    }

    const business = await client.query<{ owner_id: string }>(
      'SELECT owner_id FROM businesses WHERE id = $1 FOR UPDATE',
      [input.businessId],
    );
    if (!business.rows[0]) throw new BusinessAgentError('business_not_found', 'Business not found');
    if (business.rows[0].owner_id === input.agentId) {
      throw new BusinessAgentError('agent_already_assigned', 'The business owner is already a member');
    }

    // Serialize all provisioning attempts for the same Firebase identity.
    // The partial unique index is the durable invariant; this advisory lock
    // gives a clean domain conflict instead of relying on a database race.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.agentId]);

    const targetIdentity = await client.query<{
      requires_verification: boolean;
      identity_verified: boolean;
    }>(
      `SELECT requires_verification, identity_verified FROM users
        WHERE id = $1 FOR UPDATE`,
      [input.agentId],
    );
    if (
      targetIdentity.rows[0] &&
      (targetIdentity.rows[0].requires_verification || !targetIdentity.rows[0].identity_verified)
    ) {
      throw new BusinessAgentError(
        'agent_identity_recovery_required',
        'A reported or unverified account cannot receive an assisted face enrollment',
      );
    }

    const phoneConflict = await client.query<{ id: string }>(
      'SELECT id FROM users WHERE phone_number = $1 AND id <> $2 FOR UPDATE',
      [input.phoneNumber, input.agentId],
    );
    if (phoneConflict.rows[0]) {
      throw new BusinessAgentError('agent_phone_conflict', 'This phone is linked to another account');
    }

    const otherBusiness = await client.query<{ business_id: string }>(
      `SELECT business_id FROM business_agents
        WHERE agent_user_id = $1
          AND business_id <> $2
          AND membership_status ${ACTIVE_MEMBERSHIP_SQL}
        LIMIT 1`,
      [input.agentId, input.businessId],
    );
    if (otherBusiness.rows[0]) {
      throw new BusinessAgentError('agent_already_assigned', 'This agent already belongs to another active business');
    }

    // The resolved Firebase uid may already be a provisioned/active member of
    // THIS SAME business (the manager re-entered a teammate's own number).
    // Without this check, the ON CONFLICT upserts below treat that as a
    // harmless no-op and return 201 as if a new agent had been created, with
    // no indication to the manager that nothing actually changed.
    const sameBusinessMembership = await client.query<{ membership_status: BusinessMembershipStatus }>(
      `SELECT membership_status FROM business_agents
        WHERE business_id = $1 AND agent_user_id = $2
        LIMIT 1`,
      [input.businessId, input.agentId],
    );
    if (
      sameBusinessMembership.rows[0] &&
      ['provisioned', 'active'].includes(sameBusinessMembership.rows[0].membership_status)
    ) {
      throw new BusinessAgentError(
        'agent_already_registered',
        'This phone number is already registered to an agent on your team',
      );
    }

    const displayName = `${input.firstName} ${input.surname}`.trim();
    await client.query(
      `INSERT INTO users (id, phone_number, display_name, first_name, surname, role)
       VALUES ($1, $2, $3, $4, $5, 'agent')
       ON CONFLICT (id) DO UPDATE SET
         phone_number = COALESCE(users.phone_number, EXCLUDED.phone_number),
         display_name = COALESCE(NULLIF(users.display_name, ''), EXCLUDED.display_name),
         first_name = COALESCE(users.first_name, EXCLUDED.first_name),
         surname = COALESCE(users.surname, EXCLUDED.surname),
         role = CASE WHEN users.role = 'admin' THEN users.role ELSE 'agent' END`,
      [input.agentId, input.phoneNumber, displayName, input.firstName, input.surname],
    );

    await client.query(
      `INSERT INTO business_agents (
         business_id, agent_user_id, membership_role, membership_status,
         added_by_user_id, biometric_consent_at, face_enrollment_status
       ) VALUES ($1, $2, 'agent', 'provisioned', $3, $4, 'pending')
       ON CONFLICT (business_id, agent_user_id) DO UPDATE SET
         membership_status = CASE
           WHEN business_agents.membership_status IN ('removed', 'disabled') THEN 'provisioned'
           ELSE business_agents.membership_status
         END,
         added_by_user_id = EXCLUDED.added_by_user_id,
         biometric_consent_at = EXCLUDED.biometric_consent_at,
         face_enrollment_status = CASE
           WHEN business_agents.face_enrollment_status = 'enrolled' THEN 'enrolled'
           ELSE 'pending'
         END`,
      [input.businessId, input.agentId, input.managerId, input.consentConfirmedAt],
    );

    const member = await client.query<MembershipRow>(
      `SELECT ba.*, u.first_name, u.surname, u.display_name, u.phone_number, u.agent_status
         FROM business_agents ba JOIN users u ON u.id = ba.agent_user_id
        WHERE ba.business_id = $1 AND ba.agent_user_id = $2`,
      [input.businessId, input.agentId],
    );
    return rowToAgent(member.rows[0], true);
  });
}

export async function canIssueAgentFaceEnrollmentGrant(
  businessId: string,
  managerId: string,
  agentId: string,
): Promise<BusinessAgent> {
  if (!(await canManageBusinessAgents(businessId, managerId))) {
    throw new BusinessAgentError('not_business_manager', 'Only a business manager can enroll an agent face');
  }
  const member = await getMembership(businessId, agentId);
  if (!member || member.membership_status === 'removed') {
    throw new BusinessAgentError('agent_not_found', 'Agent not found');
  }
  if (member.face_enrollment_status === 'enrolled') {
    throw new BusinessAgentError('agent_already_enrolled', 'This agent already has a face reference');
  }
  const identity = await query<{
    requires_verification: boolean;
    identity_verified: boolean;
  }>('SELECT requires_verification, identity_verified FROM users WHERE id = $1', [agentId]);
  if (
    identity.rows[0] &&
    (identity.rows[0].requires_verification || !identity.rows[0].identity_verified)
  ) {
    throw new BusinessAgentError(
      'agent_identity_recovery_required',
      'A reported or unverified account cannot receive an assisted face enrollment',
    );
  }
  if (!member.biometric_consent_at) {
    throw new BusinessAgentError('agent_membership_inactive', 'Biometric consent is required');
  }
  return rowToAgent(member, true);
}

export async function completeBusinessAgentFaceEnrollment(input: {
  businessId: string;
  managerId: string;
  agentId: string;
  receiptJti: string;
}): Promise<BusinessAgent> {
  return withTransaction(async (client) => {
    const manager = await client.query<MembershipRow>(
      `SELECT ba.*, u.first_name, u.surname, u.display_name, u.phone_number, u.agent_status
         FROM business_agents ba JOIN users u ON u.id = ba.agent_user_id
        WHERE ba.business_id = $1 AND ba.agent_user_id = $2 FOR UPDATE`,
      [input.businessId, input.managerId],
    );
    const managerRow = manager.rows[0];
    if (!managerRow || managerRow.membership_status !== 'active' ||
      !['owner', 'admin'].includes(managerRow.membership_role)) {
      throw new BusinessAgentError('not_business_manager', 'Only a business manager can complete enrollment');
    }

    const member = await client.query<MembershipRow>(
      `SELECT ba.*, u.first_name, u.surname, u.display_name, u.phone_number, u.agent_status
         FROM business_agents ba JOIN users u ON u.id = ba.agent_user_id
        WHERE ba.business_id = $1 AND ba.agent_user_id = $2 FOR UPDATE`,
      [input.businessId, input.agentId],
    );
    const row = member.rows[0];
    if (!row || row.membership_status === 'removed') {
      throw new BusinessAgentError('agent_not_found', 'Agent not found');
    }
    if (row.face_enrollment_receipt_jti && row.face_enrollment_receipt_jti !== input.receiptJti) {
      throw new BusinessAgentError('agent_receipt_replayed', 'Enrollment receipt was already used');
    }

    await client.query(
      `UPDATE business_agents
          SET face_enrollment_status = 'enrolled',
              face_enrolled_at = COALESCE(face_enrolled_at, now()),
              face_enrollment_receipt_jti = $3,
              membership_status = CASE
                WHEN membership_role = 'agent' AND membership_status = 'provisioned' THEN 'active'
                ELSE membership_status
              END
        WHERE business_id = $1 AND agent_user_id = $2`,
      [input.businessId, input.agentId, input.receiptJti],
    );
    const updated = await client.query<MembershipRow>(
      `SELECT ba.*, u.first_name, u.surname, u.display_name, u.phone_number, u.agent_status
         FROM business_agents ba JOIN users u ON u.id = ba.agent_user_id
        WHERE ba.business_id = $1 AND ba.agent_user_id = $2`,
      [input.businessId, input.agentId],
    );
    return rowToAgent(updated.rows[0], true);
  });
}

export async function setOwnBusinessAgentStatus(
  businessId: string,
  userId: string,
  status: AgentStatus | null,
): Promise<BusinessAgent> {
  const membership = await getMembership(businessId, userId);
  if (!membership || membership.membership_status !== 'active') {
    throw new BusinessAgentError('not_business_member', 'Finish enrollment before setting availability');
  }
  await query('UPDATE users SET agent_status = $2 WHERE id = $1', [userId, status]);
  const updated = await getMembership(businessId, userId);
  if (!updated) throw new BusinessAgentError('agent_not_found', 'Agent not found');
  return rowToAgent(updated, true);
}

// ─── Legacy global role/status fields ────────────────────────────────────────
// Retained for existing data/UI compatibility. New authorization always uses
// business_agents.membership_role and membership_status.
export async function setUserRole(userId: string, role: UserRole): Promise<void> {
  await query('UPDATE users SET role = $2 WHERE id = $1', [userId, role]);
}

export async function setAgentStatus(userId: string, status: AgentStatus | null): Promise<void> {
  await query('UPDATE users SET agent_status = $2 WHERE id = $1', [userId, status]);
}

export async function getUserRoleStatus(
  userId: string,
): Promise<{ role: UserRole; agentStatus: AgentStatus | null }> {
  const res = await query<{ role: UserRole; agent_status: AgentStatus | null }>(
    'SELECT role, agent_status FROM users WHERE id = $1',
    [userId],
  );
  const row = res.rows[0];
  return { role: row?.role ?? 'customer', agentStatus: row?.agent_status ?? null };
}

// ─── Internal (agent-only) notes on a chat ───────────────────────────────────
export interface InternalNote {
  noteId: string;
  chatId: string;
  authorId: string;
  authorName: string | null;
  text: string;
  createdAt: string;
}

export async function listInternalNotes(chatId: string): Promise<InternalNote[]> {
  const res = await query<{
    id: string;
    chat_id: string;
    author_id: string;
    author_name: string | null;
    text: string;
    created_at: Date;
  }>('SELECT * FROM internal_notes WHERE chat_id = $1 ORDER BY created_at ASC', [chatId]);
  return res.rows.map((r) => ({
    noteId: r.id,
    chatId: r.chat_id,
    authorId: r.author_id,
    authorName: r.author_name,
    text: r.text,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function addInternalNote(
  chatId: string,
  authorId: string,
  authorName: string | null,
  text: string,
): Promise<InternalNote> {
  const res = await query<{ id: string; created_at: Date }>(
    'INSERT INTO internal_notes (chat_id, author_id, author_name, text) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
    [chatId, authorId, authorName, text],
  );
  return {
    noteId: res.rows[0].id,
    chatId,
    authorId,
    authorName,
    text,
    createdAt: res.rows[0].created_at.toISOString(),
  };
}

/**
 * Active agents (including owners) of every business whose owner is a member
 * of the chat. Provisioned/removed staff never receive internal notes.
 */
export async function chatAgents(chatId: string): Promise<string[]> {
  const res = await query<{ agent_user_id: string }>(
    `SELECT DISTINCT a.agent_user_id
       FROM business_agents a
       JOIN businesses b    ON b.id = a.business_id
       JOIN chat_members cm ON cm.chat_id = $1 AND cm.user_id = b.owner_id
      WHERE a.membership_status = 'active'`,
    [chatId],
  );
  return res.rows.map((r) => r.agent_user_id);
}

export async function isChatAgent(chatId: string, userId: string): Promise<boolean> {
  return (await chatAgents(chatId)).includes(userId);
}
