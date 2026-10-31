import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { io as ioClient } from 'socket.io-client';
import type { Server as IOServer } from 'socket.io';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls, testEnv } from '../test/devStack.js';

// Socket.IO handshake auth test (Req 2.7, 2.8). Needs Redis for the adapter.
let available = false;
let http: HttpServer | undefined;
let io: IOServer | undefined;
let port = 0;

beforeAll(async () => {
  available = await devStackAvailable();
  if (!available) return;
  Object.assign(process.env, testEnv());

  // 'u1' is a registered account; 'u-unreg' passed OTP but has no row yet.
  const pg = new Client({ connectionString: devStackUrls.DATABASE_URL });
  await pg.connect();
  try {
    await pg.query("DELETE FROM users WHERE id = 'u-unreg'");
    await pg.query("INSERT INTO users (id) VALUES ('u1') ON CONFLICT DO NOTHING");
  } finally {
    await pg.end();
  }

  // Verify tokens without a live Firebase project: stub the verifier module.
  const verifier = await import('../auth/verifier.js');
  vi.spyOn(verifier, 'verifyToken').mockImplementation(async (token) => {
    if (token === 'good') return { userId: 'u1', firebaseUid: 'u1', phoneNumber: null };
    if (token === 'unregistered') {
      return { userId: 'u-unreg', firebaseUid: 'u-unreg', phoneNumber: '+15550009' };
    }
    throw new verifier.AuthError('AUTH_TOKEN_INVALID', 'bad token');
  });

  const { createGateway } = await import('./gateway.js');
  http = createServer();
  io = createGateway(http);
  await new Promise<void>((resolve) => http!.listen(0, resolve));
  port = (http!.address() as { port: number }).port;
});

afterAll(async () => {
  if (io) io.close();
  if (http) await new Promise<void>((r) => http!.close(() => r()));
  const { closeRedis } = await import('../redis/client.js');
  await closeRedis();
});

function connect(token: string | undefined) {
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const socket = ioClient(`http://localhost:${port}`, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
    });
    socket.on('connect', () => {
      socket.disconnect();
      resolve({ ok: true });
    });
    socket.on('connect_error', (err) => {
      socket.disconnect();
      resolve({ ok: false, error: err.message });
    });
  });
}

describe('Socket.IO handshake', () => {
  it('accepts a connection with a valid token', async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[skip] Dev_Stack not reachable; start `docker compose up -d` to run this test');
      return;
    }
    const res = await connect('good');
    expect(res.ok).toBe(true);
  });

  it('rejects a connection with a missing or invalid token', async () => {
    if (!available) return;
    expect((await connect(undefined)).ok).toBe(false);
    expect((await connect('bad')).ok).toBe(false);
  });

  it('rejects a phone-verified session that has not completed face registration', async () => {
    if (!available) return;
    const res = await connect('unregistered');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Complete registration to connect');
  });
});
