import { query, withTransaction } from '../pool.js';

export const LINK_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type DeviceType = 'phone' | 'tablet' | 'desktop' | 'web';
export type Platform = 'ios' | 'android' | 'web';

export interface LinkedDevice {
  id: string;
  name: string;
  type: DeviceType;
  os: string;
  platform: Platform;
  linkedAt: string;
  lastActiveAt: string;
}

export interface LinkTokenInput {
  requestId: string;
  displayCode: string;
  requesterUid: string | null;
  deviceId: string;
  deviceName: string | null;
  deviceType: DeviceType;
  os: string | null;
  platform: Platform;
}

export interface LinkTokenRow {
  id: string;
  display_code: string;
  requester_uid: string | null;
  device_id: string;
  device_name: string | null;
  device_type: DeviceType;
  os: string | null;
  platform: Platform;
  consumed: boolean;
  owner_uid: string | null;
  consumed_by_name: string | null;
  consumed_at: Date | null;
  created_at: Date;
  expires_at: Date;
}

// ─── Link tokens (companion pairing) ─────────────────────────────────────────

export async function createLinkToken(input: LinkTokenInput): Promise<void> {
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS);
  await query(
    `INSERT INTO device_link_tokens
       (id, display_code, requester_uid, device_id, device_name, device_type, os, platform, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.requestId,
      input.displayCode,
      input.requesterUid,
      input.deviceId,
      input.deviceName,
      input.deviceType,
      input.os,
      input.platform,
      expiresAt,
    ],
  );
}

export async function getLinkToken(requestId: string): Promise<LinkTokenRow | null> {
  const res = await query<LinkTokenRow>('SELECT * FROM device_link_tokens WHERE id = $1', [
    requestId,
  ]);
  return res.rows[0] ?? null;
}

export async function findLiveTokenByCode(displayCode: string): Promise<LinkTokenRow | null> {
  const res = await query<LinkTokenRow>(
    `SELECT * FROM device_link_tokens
      WHERE upper(display_code) = upper($1) AND consumed = false AND expires_at > now()
      LIMIT 1`,
    [displayCode],
  );
  return res.rows[0] ?? null;
}

/**
 * Claim a pending link token for an owner and register the companion device,
 * atomically. Fails (returns false) if the token is missing, already consumed,
 * or expired.
 */
export async function claimLinkToken(
  requestId: string,
  ownerUid: string,
  ownerName: string | null,
): Promise<{ ok: boolean; token?: LinkTokenRow; error?: string }> {
  return withTransaction(async (client) => {
    const res = await client.query<LinkTokenRow>(
      'SELECT * FROM device_link_tokens WHERE id = $1 FOR UPDATE',
      [requestId],
    );
    const token = res.rows[0];
    if (!token) return { ok: false, error: 'Link request not found.' };
    if (token.requester_uid && token.requester_uid === ownerUid) {
      return { ok: false, error: 'You cannot link a device to itself.' };
    }
    if (token.consumed) return { ok: false, error: 'This request has already been used.' };
    if (new Date() > token.expires_at) return { ok: false, error: 'This request has expired.' };

    await client.query(
      `UPDATE device_link_tokens
          SET consumed = true, owner_uid = $2, consumed_by_name = $3, consumed_at = now()
        WHERE id = $1`,
      [requestId, ownerUid, ownerName],
    );
    await client.query(
      `INSERT INTO linked_devices (owner_id, device_id, name, type, os, platform)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (owner_id, device_id) DO UPDATE
         SET name = EXCLUDED.name, type = EXCLUDED.type, os = EXCLUDED.os,
             platform = EXCLUDED.platform, last_active_at = now()`,
      [
        ownerUid,
        token.device_id,
        token.device_name ?? 'Companion Device',
        token.device_type,
        token.os ?? '',
        token.platform,
      ],
    );
    return { ok: true, token };
  });
}

// ─── Linked devices ──────────────────────────────────────────────────────────

export async function listLinkedDevices(ownerId: string): Promise<LinkedDevice[]> {
  const res = await query<{
    device_id: string;
    name: string;
    type: DeviceType;
    os: string;
    platform: Platform;
    linked_at: Date;
    last_active_at: Date;
  }>(
    `SELECT device_id, name, type, os, platform, linked_at, last_active_at
       FROM linked_devices WHERE owner_id = $1 ORDER BY linked_at ASC`,
    [ownerId],
  );
  return res.rows.map((r) => ({
    id: r.device_id,
    name: r.name,
    type: r.type,
    os: r.os,
    platform: r.platform,
    linkedAt: r.linked_at.toISOString(),
    lastActiveAt: r.last_active_at.toISOString(),
  }));
}

export async function registerDevice(
  ownerId: string,
  device: { deviceId: string; name: string; type: DeviceType; os: string; platform: Platform },
): Promise<void> {
  await query(
    `INSERT INTO linked_devices (owner_id, device_id, name, type, os, platform)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_id, device_id) DO UPDATE
       SET name = EXCLUDED.name, type = EXCLUDED.type, os = EXCLUDED.os,
           platform = EXCLUDED.platform, last_active_at = now()`,
    [ownerId, device.deviceId, device.name, device.type, device.os, device.platform],
  );
}

export async function touchDevice(ownerId: string, deviceId: string): Promise<void> {
  await query(
    'UPDATE linked_devices SET last_active_at = now() WHERE owner_id = $1 AND device_id = $2',
    [ownerId, deviceId],
  );
}

/**
 * Remove a linked device and the push tokens it registered, so a removed
 * companion stops receiving the owner's notifications immediately.
 */
export async function removeDevice(ownerId: string, deviceId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('DELETE FROM linked_devices WHERE owner_id = $1 AND device_id = $2', [
      ownerId,
      deviceId,
    ]);
    await client.query('DELETE FROM push_tokens WHERE user_id = $1 AND device_id = $2', [
      ownerId,
      deviceId,
    ]);
  });
}

/** Remove every linked device except `keepDeviceId` (and their push tokens). */
export async function removeOtherDevices(ownerId: string, keepDeviceId: string): Promise<string[]> {
  return withTransaction(async (client) => {
    const res = await client.query<{ device_id: string }>(
      'DELETE FROM linked_devices WHERE owner_id = $1 AND device_id <> $2 RETURNING device_id',
      [ownerId, keepDeviceId],
    );
    const removed = res.rows.map((r) => r.device_id);
    if (removed.length > 0) {
      await client.query(
        'DELETE FROM push_tokens WHERE user_id = $1 AND device_id = ANY($2::text[])',
        [ownerId, removed],
      );
    }
    return removed;
  });
}

/** Delete link requests that expired more than an hour ago (old cleanupExpiredLinkTokens). */
export async function deleteExpiredLinkTokens(): Promise<number> {
  const res = await query(
    "DELETE FROM device_link_tokens WHERE expires_at < now() - interval '1 hour'",
  );
  return res.rowCount ?? 0;
}
