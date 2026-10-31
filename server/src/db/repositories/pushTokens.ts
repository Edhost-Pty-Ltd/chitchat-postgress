import { query } from '../pool.js';

/**
 * Register (or refresh) an Expo push token for a user (Req 4.7). `deviceId`
 * ties the token to a linked device so removing a companion also drops the
 * tokens it registered.
 */
export async function addPushToken(
  userId: string,
  token: string,
  platform: string | null,
  deviceId: string | null = null,
): Promise<void> {
  // A push token identifies one physical device, which belongs to exactly one
  // user at a time — whoever is currently signed in on it. Clear the token from
  // any previous owner first, so a notification meant for them is never
  // delivered to this device after a different account signs in (otherwise the
  // sender, who used this device earlier, keeps receiving the recipient's push).
  await query('DELETE FROM push_tokens WHERE token = $1 AND user_id <> $2', [token, userId]);
  await query(
    `INSERT INTO push_tokens (user_id, token, platform, device_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, token) DO UPDATE
       SET platform = EXCLUDED.platform,
           device_id = COALESCE(EXCLUDED.device_id, push_tokens.device_id)`,
    [userId, token, platform, deviceId],
  );
}

/** Remove a device's push token on sign-out (Req 4.8). */
export async function removePushToken(userId: string, token: string): Promise<void> {
  await query('DELETE FROM push_tokens WHERE user_id = $1 AND token = $2', [userId, token]);
}

/** All push tokens for a user (used by the Push_Dispatcher in Slice 2). */
export async function getPushTokens(userId: string): Promise<string[]> {
  const res = await query<{ token: string }>(
    'SELECT token FROM push_tokens WHERE user_id = $1',
    [userId],
  );
  return res.rows.map((r) => r.token);
}
