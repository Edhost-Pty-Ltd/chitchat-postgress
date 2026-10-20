import { query } from '../pool.js';

/** Register (or refresh) an Expo push token for a user (Req 4.7). */
export async function addPushToken(
  userId: string,
  token: string,
  platform: string | null,
): Promise<void> {
  await query(
    `INSERT INTO push_tokens (user_id, token, platform)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, token) DO UPDATE SET platform = EXCLUDED.platform`,
    [userId, token, platform],
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
