import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../pool.js';

/**
 * Legacy/test seeding helper. Production authentication no longer calls this:
 * self-registered user rows are created only by completeSelfRegistration after
 * Node verifies Django's signed face-enrollment receipt. Existing tests and
 * internal seed paths still use this idempotent helper to prepare fixtures.
 */
export async function upsertUserOnFirstContact(
  userId: string,
  phoneNumber: string | null,
): Promise<void> {
  await query(
    `INSERT INTO users (id, phone_number)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE
       SET phone_number = COALESCE(users.phone_number, EXCLUDED.phone_number)`,
    [userId, phoneNumber],
  );
}

export interface UserRow {
  id: string;
  phone_number: string | null;
  display_name: string | null;
  about: string | null;
  avatar_object_key: string | null;
  email: string | null;
  website: string | null;
  catalog: string | null;
  operational_hours: string | null;
  account_type: string;
  last_seen: Date | null;
  created_at: Date;
  industry?: string | null;
  address?: Record<string, string> | null;
  work_schedule?: Record<string, { open: string; close: string }> | null;
  timezone?: string | null;
  auto_responder_enabled?: boolean;
  auto_responder_message?: string | null;
  catalog_items?: unknown[] | null;
  catalog_collections?: unknown[] | null;
  requires_verification?: boolean;
  reported_by?: string | null;
  reported_at?: Date | null;
  identity_verified?: boolean;
  identity_verified_at?: Date | null;
  verification_generation?: string | null;
}

/** Business-profile fields shown to other users (catalog, hours, address...). */
export interface BusinessProfile {
  industry: string | null;
  address: Record<string, string> | null;
  workSchedule: Record<string, { open: string; close: string }> | null;
  timezone: string | null;
  catalogItems: unknown[];
  catalogCollections: unknown[];
}

export interface UserProfile extends BusinessProfile {
  id: string;
  phoneNumber: string | null;
  displayName: string | null;
  about: string | null;
  avatarObjectKey: string | null;
  email: string | null;
  website: string | null;
  catalog: string | null;
  operationalHours: string | null;
  accountType: string;
  autoResponderEnabled: boolean;
  autoResponderMessage: string | null;
  requiresVerification: boolean;
  /** Canonical, server-owned identity status. Never inferred from local UI. */
  identityVerified: boolean;
  identityVerifiedAt: string | null;
  /** Owner-only nonce binding a face proof to the latest report. */
  verificationGeneration: string | null;
}

export function rowToBusiness(row: UserRow): BusinessProfile {
  return {
    industry: row.industry ?? null,
    address: row.address ?? null,
    workSchedule: row.work_schedule ?? null,
    timezone: row.timezone ?? null,
    catalogItems: Array.isArray(row.catalog_items) ? row.catalog_items : [],
    catalogCollections: Array.isArray(row.catalog_collections) ? row.catalog_collections : [],
  };
}

export function rowToProfile(row: UserRow): UserProfile {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    displayName: row.display_name,
    about: row.about,
    avatarObjectKey: row.avatar_object_key,
    email: row.email,
    website: row.website,
    catalog: row.catalog,
    operationalHours: row.operational_hours,
    accountType: row.account_type,
    autoResponderEnabled: !!row.auto_responder_enabled,
    autoResponderMessage: row.auto_responder_message ?? null,
    requiresVerification: !!row.requires_verification,
    identityVerified: row.identity_verified !== false,
    identityVerifiedAt: row.identity_verified_at?.toISOString() ?? null,
    verificationGeneration: row.verification_generation ?? null,
    ...rowToBusiness(row),
  };
}

export interface ReportVerificationTransition {
  generation: string;
  duplicate: boolean;
}

/**
 * Record a report and atomically move the target to "verification required".
 *
 * A fresh generation invalidates any face proof already in flight. Repeated
 * taps by the SAME reporter within ten minutes are idempotent, preventing one
 * client from continuously rotating the nonce and making verification
 * impossible. The route separately requires the users to share a chat.
 */
export async function setRequiresVerification(
  userId: string,
  reporterId: string,
): Promise<ReportVerificationTransition> {
  const nextGeneration = randomUUID();
  const reportId = randomUUID();

  return withTransaction(async (client) => {
    const target = await client.query<{
      requires_verification: boolean;
      verification_generation: string | null;
    }>(
      `SELECT requires_verification, verification_generation
         FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!target.rows[0]) throw new Error('reported user disappeared');

    const duplicate = await client.query<{ verification_generation: string }>(
      `SELECT verification_generation
         FROM user_reports
        WHERE reporter_id = $1 AND reported_id = $2 AND status = 'open'
          AND created_at > now() - interval '10 minutes'
        ORDER BY created_at DESC LIMIT 1`,
      [reporterId, userId],
    );
    const currentGeneration = target.rows[0].verification_generation;
    if (duplicate.rows[0] && target.rows[0].requires_verification && currentGeneration) {
      return { generation: currentGeneration, duplicate: true };
    }

    await client.query(
      `INSERT INTO user_reports
         (id, reporter_id, reported_id, verification_generation)
       VALUES ($1, $2, $3, $4)`,
      [reportId, reporterId, userId, nextGeneration],
    );
    await client.query(
      `UPDATE users
          SET requires_verification = true,
              identity_verified = false,
              identity_verified_at = null,
              verification_generation = $3,
              reported_by = $2,
              reported_at = now()
        WHERE id = $1`,
      [userId, reporterId, nextGeneration],
    );
    return { generation: nextGeneration, duplicate: false };
  });
}

export interface CompleteVerificationResult {
  state: 'cleared' | 'already_verified' | 'stale' | 'not_found';
  reporterIds: string[];
  verifiedAt: string | null;
}

/**
 * Clear ONLY the exact report generation proven by Django. Row locking makes
 * report-vs-verification races deterministic: if a newer report commits first,
 * the old proof is stale; if it commits second, it immediately un-verifies the
 * account again. No client-supplied boolean can change identity status.
 */
export async function completeRequiresVerification(
  userId: string,
  generation: string,
): Promise<CompleteVerificationResult> {
  return withTransaction(async (client) => {
    const current = await client.query<{
      requires_verification: boolean;
      identity_verified: boolean;
      identity_verified_at: Date | null;
      verification_generation: string | null;
      reported_by: string | null;
    }>(
      `SELECT requires_verification, identity_verified, identity_verified_at,
              verification_generation, reported_by
         FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const row = current.rows[0];
    if (!row) return { state: 'not_found', reporterIds: [], verifiedAt: null };
    if (!row.requires_verification && row.identity_verified) {
      return {
        state: 'already_verified',
        reporterIds: [],
        verifiedAt: row.identity_verified_at?.toISOString() ?? null,
      };
    }
    if (row.verification_generation !== generation) {
      return { state: 'stale', reporterIds: [], verifiedAt: null };
    }

    const reporters = await client.query<{ reporter_id: string }>(
      `SELECT DISTINCT reporter_id
         FROM user_reports
        WHERE reported_id = $1 AND status = 'open'`,
      [userId],
    );
    const reporterIds = Array.from(
      new Set([
        ...reporters.rows.map((r) => r.reporter_id),
        ...(row.reported_by ? [row.reported_by] : []),
      ]),
    ).filter((id) => id !== userId);

    const updated = await client.query<{ identity_verified_at: Date }>(
      `UPDATE users
          SET requires_verification = false,
              identity_verified = true,
              identity_verified_at = now(),
              verification_generation = null,
              reported_by = null,
              reported_at = null
        WHERE id = $1 AND verification_generation = $2
        RETURNING identity_verified_at`,
      [userId, generation],
    );
    if (!updated.rows[0]) return { state: 'stale', reporterIds: [], verifiedAt: null };

    await client.query(
      `UPDATE user_reports
          SET status = 'resolved', resolved_at = now()
        WHERE reported_id = $1 AND status = 'open'`,
      [userId],
    );
    return {
      state: 'cleared',
      reporterIds,
      verifiedAt: updated.rows[0].identity_verified_at.toISOString(),
    };
  });
}

export async function getUserById(userId: string): Promise<UserRow | null> {
  const res = await query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
  return res.rows[0] ?? null;
}

export interface ProfilePatch {
  displayName?: string | null;
  about?: string | null;
  avatarObjectKey?: string | null;
  email?: string | null;
  website?: string | null;
  catalog?: string | null;
  operationalHours?: string | null;
  industry?: string | null;
  address?: Record<string, string> | null;
  workSchedule?: Record<string, { open: string; close: string }> | null;
  timezone?: string | null;
  autoResponderEnabled?: boolean;
  autoResponderMessage?: string | null;
  catalogItems?: unknown[];
  catalogCollections?: unknown[];
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

/** Update profile fields, leaving unspecified fields untouched (Req 4.3). */
export async function updateProfile(userId: string, patch: ProfilePatch): Promise<UserRow> {
  const res = await query<UserRow>(
    `UPDATE users SET
       display_name           = COALESCE($2, display_name),
       about                  = COALESCE($3, about),
       avatar_object_key      = COALESCE($4, avatar_object_key),
       email                  = COALESCE($5, email),
       website                = COALESCE($6, website),
       catalog                = COALESCE($7, catalog),
       operational_hours      = COALESCE($8, operational_hours),
       industry               = COALESCE($9, industry),
       address                = COALESCE($10::jsonb, address),
       work_schedule          = COALESCE($11::jsonb, work_schedule),
       timezone               = COALESCE($12, timezone),
       auto_responder_enabled = COALESCE($13, auto_responder_enabled),
       auto_responder_message = COALESCE($14, auto_responder_message),
       catalog_items          = COALESCE($15::jsonb, catalog_items),
       catalog_collections    = COALESCE($16::jsonb, catalog_collections)
     WHERE id = $1
     RETURNING *`,
    [
      userId,
      patch.displayName ?? null,
      patch.about ?? null,
      patch.avatarObjectKey ?? null,
      patch.email ?? null,
      patch.website ?? null,
      patch.catalog ?? null,
      patch.operationalHours ?? null,
      patch.industry ?? null,
      json(patch.address),
      json(patch.workSchedule),
      patch.timezone ?? null,
      patch.autoResponderEnabled ?? null,
      patch.autoResponderMessage ?? null,
      json(patch.catalogItems),
      json(patch.catalogCollections),
    ],
  );
  return res.rows[0];
}

/** True when another user already owns this phone number (Req 4.6 → 409). */
export async function phoneTakenByOther(userId: string, phoneNumber: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM users WHERE phone_number = $1 AND id <> $2', [
    phoneNumber,
    userId,
  ]);
  return res.rowCount! > 0;
}

export async function updatePhone(userId: string, phoneNumber: string): Promise<void> {
  await query('UPDATE users SET phone_number = $2 WHERE id = $1', [userId, phoneNumber]);
}

export interface MatchedUser {
  userId: string;
  phoneNumber: string | null;
  displayName: string | null;
  avatarObjectKey: string | null;
}

/**
 * Match registered users by phone number, exposing avatar only when the matched
 * user's profile-photo privacy permits it. Contact relationship is mutual-by-
 * phone here, so a matched user is treated as a contact of the requester
 * (Req 4.4, Property 13). Blocks in either direction hide the match.
 */
export async function matchContacts(
  requesterId: string,
  phones: string[],
): Promise<MatchedUser[]> {
  if (phones.length === 0) return [];
  const res = await query<{
    id: string;
    phone_number: string | null;
    display_name: string | null;
    avatar_object_key: string | null;
    profile_photo: string | null;
  }>(
    `SELECT u.id, u.phone_number, u.display_name, u.avatar_object_key,
            p.profile_photo
       FROM users u
       LEFT JOIN privacy_settings p ON p.user_id = u.id
      WHERE u.phone_number = ANY($1::text[])
        AND u.id <> $2
        AND NOT EXISTS (
          SELECT 1 FROM blocked_users b
           WHERE (b.blocker_id = $2 AND b.blocked_id = u.id)
              OR (b.blocker_id = u.id AND b.blocked_id = $2)
        )`,
    [phones, requesterId],
  );

  return res.rows.map((r) => {
    // Requester matched this user via their phone book → treat as a contact.
    const photoVisible = (r.profile_photo ?? 'Contacts') !== 'Nobody';
    return {
      userId: r.id,
      phoneNumber: r.phone_number,
      displayName: r.display_name,
      avatarObjectKey: photoVisible ? r.avatar_object_key : null,
    };
  });
}


/**
 * Account gate used by the REST and Socket.IO authorization checks.
 *  - 'unregistered': no users row. The caller passed phone OTP but has not yet
 *    completed face enrollment + liveness, so the account does not exist.
 *  - 'verification_required': a reported account awaiting a live face proof.
 *  - 'ok': full access.
 */
export type AccountGateStatus = 'unregistered' | 'verification_required' | 'ok';

export async function accountGateStatus(userId: string): Promise<AccountGateStatus> {
  const result = await query<{
    requires_verification: boolean;
    identity_verified: boolean;
  }>(
    `SELECT requires_verification, identity_verified
       FROM users WHERE id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return 'unregistered';
  return row.requires_verification || !row.identity_verified ? 'verification_required' : 'ok';
}

/**
 * Fill a missing phone number on an EXISTING row from the verified token.
 * Never inserts: rows are created only by completeSelfRegistration (after the
 * face step) or when an owner/admin provisions an agent.
 */
export async function backfillPhoneIfRegistered(
  userId: string,
  phoneNumber: string | null,
): Promise<void> {
  if (!phoneNumber) return;
  await query(
    `UPDATE users SET phone_number = $2
      WHERE id = $1 AND phone_number IS NULL
        AND NOT EXISTS (SELECT 1 FROM users other WHERE other.phone_number = $2)`,
    [userId, phoneNumber],
  );
}

export interface SelfRegistrationProfile {
  displayName: string;
  email?: string | null;
  website?: string | null;
  about?: string | null;
}

export type SelfRegistrationResult =
  | { state: 'created'; row: UserRow }
  | { state: 'already_registered'; row: UserRow }
  | { state: 'phone_taken' };

/**
 * Create the users row for a self-registered account. The route calls this
 * only after verifying Django's signed face-enrollment receipt. Idempotent per
 * uid, so a retry after a lost response returns the same account.
 */
export async function completeSelfRegistration(
  userId: string,
  phoneNumber: string,
  profile: SelfRegistrationProfile,
): Promise<SelfRegistrationResult> {
  return withTransaction(async (client) => {
    const existing = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (existing.rows[0]) return { state: 'already_registered', row: existing.rows[0] };

    const taken = await client.query('SELECT 1 FROM users WHERE phone_number = $1', [phoneNumber]);
    if (taken.rowCount) return { state: 'phone_taken' };

    const inserted = await client.query<UserRow>(
      `INSERT INTO users (id, phone_number, display_name, email, website, about)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        userId,
        phoneNumber,
        profile.displayName,
        profile.email ?? null,
        profile.website ?? null,
        profile.about ?? null,
      ],
    );
    if (inserted.rows[0]) return { state: 'created', row: inserted.rows[0] };

    // Lost a race with a concurrent request for the same uid or phone.
    const raced = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    if (raced.rows[0]) return { state: 'already_registered', row: raced.rows[0] };
    return { state: 'phone_taken' };
  });
}

/** Fast owner-status check used by HTTP and Socket.IO authorization gates. */
export async function identityVerificationRequired(userId: string): Promise<boolean> {
  const result = await query<{
    requires_verification: boolean;
    identity_verified: boolean;
  }>(
    `SELECT requires_verification, identity_verified
       FROM users WHERE id = $1`,
    [userId],
  );
  const row = result.rows[0];
  return !!row && (row.requires_verification || !row.identity_verified);
}
