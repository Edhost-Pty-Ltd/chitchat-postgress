import { query, withTransaction } from '../pool.js';

export type Plan = 'free' | 'pro' | 'enterprise';
export type RoutingStrategy = 'round-robin' | 'least-active' | 'manual';
export type UserRole = 'customer' | 'agent' | 'admin';
export type AgentStatus = 'available' | 'busy' | 'away';

export interface Business {
  businessId: string;
  name: string;
  ownerId: string;
  agents: string[];
  plan: Plan;
  createdAt: string;
  settings: { autoAssign: boolean; routingStrategy: RoutingStrategy };
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

/** List businesses the user owns or is an agent of. */
export async function listBusinessesForUser(userId: string): Promise<Business[]> {
  const res = await query<BusinessRow>(
    `SELECT b.*, ARRAY(SELECT agent_user_id FROM business_agents a WHERE a.business_id = b.id) AS agents
       FROM businesses b
      WHERE b.owner_id = $1
         OR EXISTS (SELECT 1 FROM business_agents a WHERE a.business_id = b.id AND a.agent_user_id = $1)
      ORDER BY b.created_at DESC`,
    [userId],
  );
  return res.rows.map(rowToBusiness);
}

export async function getBusiness(businessId: string): Promise<Business | null> {
  const res = await query<BusinessRow>(
    `SELECT b.*, ARRAY(SELECT agent_user_id FROM business_agents a WHERE a.business_id = b.id) AS agents
       FROM businesses b WHERE b.id = $1`,
    [businessId],
  );
  return res.rows[0] ? rowToBusiness(res.rows[0]) : null;
}

export async function createBusiness(
  ownerId: string,
  input: { name: string; plan?: Plan; agents?: string[]; autoAssign?: boolean; routingStrategy?: RoutingStrategy },
): Promise<Business> {
  return withTransaction(async (client) => {
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
    // The owner is implicitly an admin agent of their own business.
    const agents = Array.from(new Set([ownerId, ...(input.agents ?? [])]));
    for (const a of agents) {
      await client.query(
        'INSERT INTO business_agents (business_id, agent_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, a],
      );
    }
    const created = await getBusiness(id);
    return created!;
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
  patch: { name?: string; plan?: Plan; autoAssign?: boolean; routingStrategy?: RoutingStrategy; agents?: string[] },
): Promise<Business | null> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE businesses SET
         name             = COALESCE($2, name),
         plan             = COALESCE($3, plan),
         auto_assign      = COALESCE($4, auto_assign),
         routing_strategy = COALESCE($5, routing_strategy)
       WHERE id = $1`,
      [businessId, patch.name ?? null, patch.plan ?? null, patch.autoAssign ?? null, patch.routingStrategy ?? null],
    );
    if (patch.agents !== undefined) {
      await client.query('DELETE FROM business_agents WHERE business_id = $1', [businessId]);
      for (const a of Array.from(new Set(patch.agents))) {
        await client.query(
          'INSERT INTO business_agents (business_id, agent_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [businessId, a],
        );
      }
    }
  });
  return getBusiness(businessId);
}

// ─── Agent role + live status on the users table ─────────────────────────────

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
 * Agents (including owners) of every business whose owner is a member of the
 * chat. Internal notes are visible only to these users — never to the
 * customer side of the conversation.
 */
export async function chatAgents(chatId: string): Promise<string[]> {
  const res = await query<{ agent_user_id: string }>(
    `SELECT DISTINCT a.agent_user_id
       FROM business_agents a
       JOIN businesses b    ON b.id = a.business_id
       JOIN chat_members cm ON cm.chat_id = $1 AND cm.user_id = b.owner_id`,
    [chatId],
  );
  return res.rows.map((r) => r.agent_user_id);
}

export async function isChatAgent(chatId: string, userId: string): Promise<boolean> {
  return (await chatAgents(chatId)).includes(userId);
}
