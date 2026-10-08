import { describe, it, expect, vi } from 'vitest';
import { dispatchMessagePush, type PushMessageJob } from './dispatcher.js';

// Feature: firebase-to-sockets-redis-postgres-migration, Property 12:
// Push recipient set and DeviceNotRegistered token cleanup (Req 6.1-6.4).

const job: PushMessageJob = {
  chatId: 'chat-1',
  messageId: 'msg-1',
  senderId: 'sender',
  title: 'Alice',
  body: 'hello',
};

describe('dispatchMessagePush', () => {
  it('sends one push per recipient token with the correct payload', async () => {
    const sendExpo = vi.fn(async (messages: unknown[]) =>
      messages.map(() => ({ status: 'ok' as const })),
    );
    const result = await dispatchMessagePush(job, {
      recipients: async () => ['bob', 'carol'],
      tokens: async () => [
        { userId: 'bob', token: 'tok-bob' },
        { userId: 'carol', token: 'tok-carol' },
      ],
      sendExpo,
    });

    expect(result.sent).toBe(2);
    const sent = sendExpo.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      to: 'tok-bob',
      categoryId: 'chat_message',
      data: { chatId: 'chat-1', senderId: 'sender', type: 'message' },
    });
  });

  it('sends nothing when there are no recipients', async () => {
    const sendExpo = vi.fn(async () => []);
    const result = await dispatchMessagePush(job, {
      recipients: async () => [],
      tokens: async () => [],
      sendExpo,
    });
    expect(result.sent).toBe(0);
    expect(sendExpo).not.toHaveBeenCalled();
  });

  it('removes tokens reported DeviceNotRegistered (Req 6.4)', async () => {
    const removed: string[] = [];
    const result = await dispatchMessagePush(job, {
      recipients: async () => ['bob', 'carol'],
      tokens: async () => [
        { userId: 'bob', token: 'tok-bob' },
        { userId: 'carol', token: 'tok-carol' },
      ],
      sendExpo: async () => [
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'ok' },
      ],
      removeToken: async (t) => void removed.push(t),
    });
    expect(result.removedTokens).toBe(1);
    expect(removed).toEqual(['tok-bob']);
  });

  it('propagates send failures so the queue can retry (Req 6.5)', async () => {
    await expect(
      dispatchMessagePush(job, {
        recipients: async () => ['bob'],
        tokens: async () => [{ userId: 'bob', token: 'tok' }],
        sendExpo: async () => {
          throw new Error('network');
        },
      }),
    ).rejects.toThrow('network');
  });
});
