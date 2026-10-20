import { query } from '../pool.js';

/**
 * Create the user row on first authenticated contact, keyed by firebase uid
 * (Req 2.6). Idempotent: later calls only backfill a phone number if it was
 * previously null, and never overwrite profile fields.
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
    ...rowToBusiness(row),
  };
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
