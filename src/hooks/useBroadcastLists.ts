// ─── useBroadcastLists ────────────────────────────────────────────────────────
import { useState, useEffect } from 'react';
import { BroadcastList } from '../types';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export function useBroadcastLists(userId: string | null) {
  const [lists,   setLists]   = useState<BroadcastList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setLists([]); setLoading(false); return; }
    setLoading(true);
    let active = true;

    const load = async () => {
      const res = await endpoints.listBroadcasts();
      if (!active) return;
      if (res.ok) {
        setLists(
          res.data.lists.map((l) => ({
            id: l.id, name: l.name, recipients: l.recipients,
            createdBy: l.createdBy, createdAt: new Date(l.createdAt),
            lastSentAt: l.lastSentAt ? new Date(l.lastSentAt) : null,
            lastMessage: l.lastMessage,
          })),
        );
      } else {
        setError(String(res.error.code));
      }
      setLoading(false);
    };

    void socketClient.connect().then(load).catch(() => load());
    return () => { active = false; };
  }, [userId]);

  return { lists, loading, error };
}

export async function createBroadcastList(
  _userId: string, name: string, recipients: string[],
): Promise<string> {
  const res = await endpoints.createBroadcast(name.trim(), recipients);
  if (!res.ok) throw new Error(`createBroadcast failed: ${res.error.message}`);
  return res.data.id;
}

export async function updateBroadcastRecipients(listId: string, recipients: string[]): Promise<void> {
  await endpoints.updateBroadcast(listId, { recipients });
}

export async function renameBroadcastList(listId: string, name: string): Promise<void> {
  await endpoints.updateBroadcast(listId, { name: name.trim() });
}

export async function deleteBroadcastList(listId: string): Promise<void> {
  await endpoints.deleteBroadcast(listId);
}

export async function recordBroadcastSend(_listId: string, _message: string): Promise<void> {
  // POST /broadcasts/:id/send records the send server-side.
}
