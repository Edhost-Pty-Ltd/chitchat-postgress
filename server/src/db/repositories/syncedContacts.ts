import { withTransaction, query } from '../pool.js';

/**
 * The primary device's phone-book contacts, synced so a companion device (which
 * has no access to the owner's phone book) can show the same contact list.
 * Mirrors the old Firestore users/{ownerUid}/syncedContacts collection.
 */
export interface SyncedContact {
  phone: string;
  displayName: string;
  userId: string | null;
  isSaved: boolean;
  avatarObjectKey: string | null;
}

export async function listSyncedContacts(ownerId: string): Promise<SyncedContact[]> {
  const res = await query<{
    phone: string;
    display_name: string;
    user_id: string | null;
    is_saved: boolean;
    avatar_object_key: string | null;
  }>(
    `SELECT phone, display_name, user_id, is_saved, avatar_object_key
       FROM synced_contacts WHERE owner_id = $1 ORDER BY lower(display_name)`,
    [ownerId],
  );
  return res.rows.map((r) => ({
    phone: r.phone,
    displayName: r.display_name,
    userId: r.user_id,
    isSaved: r.is_saved,
    avatarObjectKey: r.avatar_object_key,
  }));
}

/** Replace the owner's synced contact list with the given snapshot. */
export async function replaceSyncedContacts(
  ownerId: string,
  contacts: SyncedContact[],
): Promise<number> {
  return withTransaction(async (client) => {
    await client.query('DELETE FROM synced_contacts WHERE owner_id = $1', [ownerId]);
    const seen = new Set<string>();
    let n = 0;
    for (const c of contacts) {
      if (!c.phone || seen.has(c.phone)) continue;
      seen.add(c.phone);
      await client.query(
        `INSERT INTO synced_contacts (owner_id, phone, display_name, user_id, is_saved, avatar_object_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ownerId, c.phone, c.displayName || c.phone, c.userId, !!c.isSaved, c.avatarObjectKey],
      );
      n += 1;
    }
    return n;
  });
}
