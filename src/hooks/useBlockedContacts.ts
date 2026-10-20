// ─── useBlockedContacts Hook ──────────────────────────────────────────────────
import { useState, useEffect, useCallback } from 'react';
import { endpoints } from '../api/endpoints';

export interface BlockedContact {
  userId:          string;
  displayName:     string;
  photoURL:        string | null;
  phone?:          string;
  blockedAt:       Date;
  lastSeenAtBlock?: Date;
}

export function useBlockedContacts(currentUserId: string | null) {
  const [blockedContacts, setBlockedContacts] = useState<BlockedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await endpoints.listBlocks();
    if (res.ok) {
      setBlockedContacts(
        res.data.blocked.map((b) => ({
          userId:          b.userId,
          displayName:     b.displayName || 'Unknown',
          photoURL:        b.photoObjectKey,
          phone:           b.phone ?? undefined,
          blockedAt:       new Date(b.blockedAt),
          lastSeenAtBlock: b.lastSeenAtBlock ? new Date(b.lastSeenAtBlock) : undefined,
        })),
      );
    } else {
      setError(String(res.error.code));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!currentUserId) { setBlockedContacts([]); setLoading(false); return; }
    setLoading(true);
    void reload();
  }, [currentUserId, reload]);

  const blockContact = useCallback(
    async (
      userId: string, displayName: string,
      photoURL?: string | null, phone?: string,
    ): Promise<{ success: boolean; error?: string }> => {
      if (!currentUserId) return { success: false, error: 'Not authenticated' };
      try {
        const res = await endpoints.blockUser(userId, {
          displayName,
          photoObjectKey: photoURL || null,
          phone: phone || null,
        });
        if (!res.ok) return { success: false, error: String(res.error.code) };
        await reload();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
    [currentUserId, reload],
  );

  const unblockContact = useCallback(
    async (userId: string): Promise<{ success: boolean; error?: string }> => {
      if (!currentUserId) return { success: false, error: 'Not authenticated' };
      try {
        const res = await endpoints.unblockUser(userId);
        if (!res.ok) return { success: false, error: String(res.error.code) };
        await reload();
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
    [currentUserId, reload],
  );

  const isContactBlocked = useCallback(
    (userId: string) => blockedContacts.some((c) => c.userId === userId),
    [blockedContacts],
  );

  return { blockedContacts, loading, error, blockContact, unblockContact, isContactBlocked };
}
