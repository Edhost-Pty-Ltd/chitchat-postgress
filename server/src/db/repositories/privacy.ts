import { query } from '../pool.js';
import { DEFAULT_PRIVACY, type PrivacySettings, type Visibility } from '../../domain/privacy.js';

interface PrivacyRow {
  user_id: string;
  last_seen: string;
  profile_photo: string;
  status_visibility: string;
  groups: string;
  calls: string;
  read_receipts: boolean;
  disappearing_messages: boolean;
}

function rowToSettings(row: PrivacyRow): PrivacySettings {
  return {
    lastSeen: row.last_seen as Visibility,
    profilePhoto: row.profile_photo as Visibility,
    statusVisibility: row.status_visibility as Visibility,
    groups: row.groups as Visibility,
    calls: row.calls as Visibility,
    readReceipts: row.read_receipts,
    disappearingMessages: row.disappearing_messages,
  };
}

/** Read a user's privacy settings, falling back to defaults (Req 4.9). */
export async function getPrivacySettings(userId: string): Promise<PrivacySettings> {
  const res = await query<PrivacyRow>('SELECT * FROM privacy_settings WHERE user_id = $1', [
    userId,
  ]);
  return res.rows[0] ? rowToSettings(res.rows[0]) : DEFAULT_PRIVACY;
}

/** Upsert a user's full privacy settings (Req 4.10). */
export async function savePrivacySettings(
  userId: string,
  s: PrivacySettings,
): Promise<PrivacySettings> {
  const res = await query<PrivacyRow>(
    `INSERT INTO privacy_settings
       (user_id, last_seen, profile_photo, status_visibility, groups, calls,
        read_receipts, disappearing_messages, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (user_id) DO UPDATE SET
       last_seen = EXCLUDED.last_seen,
       profile_photo = EXCLUDED.profile_photo,
       status_visibility = EXCLUDED.status_visibility,
       groups = EXCLUDED.groups,
       calls = EXCLUDED.calls,
       read_receipts = EXCLUDED.read_receipts,
       disappearing_messages = EXCLUDED.disappearing_messages,
       updated_at = now()
     RETURNING *`,
    [
      userId,
      s.lastSeen,
      s.profilePhoto,
      s.statusVisibility,
      s.groups,
      s.calls,
      s.readReceipts,
      s.disappearingMessages,
    ],
  );
  return rowToSettings(res.rows[0]);
}
