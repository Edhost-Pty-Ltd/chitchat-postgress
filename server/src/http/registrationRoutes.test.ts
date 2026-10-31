import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls, testEnv } from '../test/devStack.js';

// Face-gated self registration. A phone-verified session has no users row
// until POST /me/register presents Django's signed face-enrollment receipt.
// Auth is stubbed: "token:<uid>:<phone>" authenticates as <uid> with <phone>,
// and (like the real verifier) never creates a row.
const SECRET = 'r'.repeat(48);
let available = false;
let app: FastifyInstance | undefined;

async function reset(): Promise<void> {
  const client = new Client({ connectionString: devStackUrls.DATABASE_URL });
  await client.connect();
  try {
    await client.query('TRUNCATE privacy_settings, users CASCADE');
  } finally {
    await client.end();
  }
}

function mintReceipt(
  sub: string,
  opts: { purpose?: string; iat?: number; exp?: number; secret?: string } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sub,
    purpose: opts.purpose ?? 'self_registration_face_enrollment',
    jti: randomUUID(),
    iat: opts.iat ?? now,
    exp: opts.exp ?? now + 120,
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(body, 'ascii').digest('base64url');
  return `${body}.${sig}`;
}

beforeAll(async () => {
  available = await devStackAvailable();
  if (!available) return;
  Object.assign(process.env, testEnv());
  process.env.DATABASE_URL = devStackUrls.DATABASE_URL;
  process.env.FACE_VERIFICATION_RECEIPT_SECRET = SECRET;

  const verifier = await import('../auth/verifier.js');
  vi.spyOn(verifier, 'verifyToken').mockImplementation(async (token) => {
    const m = /^token:([^:]+):?(.*)$/.exec(typeof token === 'string' ? token : '');
    if (!m) throw new verifier.AuthError('AUTH_TOKEN_INVALID', 'bad token');
    return { userId: m[1], firebaseUid: m[1], phoneNumber: m[2] || null };
  });

  const { buildServer } = await import('./server.js');
  app = await buildServer();
});

beforeEach(async () => {
  if (available) await reset();
});

afterAll(async () => {
  if (app) await app.close();
  const { closePool } = await import('../db/pool.js');
  const { closeRedis } = await import('../redis/client.js');
  await closePool();
  await closeRedis();
});

const auth = (uid: string, phone = '+27820000001') => ({
  authorization: `Bearer token:${uid}:${phone}`,
});

function register(uid: string, receipt: string, displayName = 'Acme Traders', phone?: string) {
  return app!.inject({
    method: 'POST',
    url: '/me/register',
    headers: auth(uid, phone),
    payload: { receipt, profile: { displayName, email: 'owner@acme.test' } },
  });
}

const skip = () => !available || !app;

describe('face-gated self registration', () => {
  it('treats a phone-verified session without a row as unregistered', async () => {
    if (skip()) return;
    const me = await app!.inject({ method: 'GET', url: '/me', headers: auth('newbie') });
    expect(me.statusCode).toBe(404);

    const privacy = await app!.inject({ method: 'GET', url: '/me/privacy', headers: auth('newbie') });
    expect(privacy.statusCode).toBe(403);
    expect(privacy.json().error.code).toBe('REGISTRATION_REQUIRED');
  });

  it('refuses registration without a valid receipt for this user', async () => {
    if (skip()) return;
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      'not-a-receipt-at-all-xxxxxxxx',
      mintReceipt('someone-else'),
      mintReceipt('newbie', { secret: 'w'.repeat(48) }),
      mintReceipt('newbie', { purpose: 'reported_user_reverification' }),
      mintReceipt('newbie', { iat: now - 600, exp: now - 60 }),
    ];
    for (const receipt of bad) {
      const res = await register('newbie', receipt);
      expect(res.statusCode).toBe(403);
    }
    const me = await app!.inject({ method: 'GET', url: '/me', headers: auth('newbie') });
    expect(me.statusCode).toBe(404);
  });

  it('creates the account from a valid receipt, using the phone from the token', async () => {
    if (skip()) return;
    const res = await register('newbie', mintReceipt('newbie'), 'Acme Traders', '+27820000001');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe('newbie');
    expect(body.displayName).toBe('Acme Traders');
    expect(body.phoneNumber).toBe('+27820000001');
    expect(body.alreadyRegistered).toBe(false);

    const me = await app!.inject({ method: 'GET', url: '/me', headers: auth('newbie') });
    expect(me.statusCode).toBe(200);
    const privacy = await app!.inject({ method: 'GET', url: '/me/privacy', headers: auth('newbie') });
    expect(privacy.statusCode).toBe(200);
  });

  it('is idempotent: a retry returns the same account without overwriting it', async () => {
    if (skip()) return;
    expect((await register('newbie', mintReceipt('newbie'))).statusCode).toBe(201);
    const retry = await register('newbie', mintReceipt('newbie'), 'Different Name');
    expect(retry.statusCode).toBe(200);
    expect(retry.json().alreadyRegistered).toBe(true);
    expect(retry.json().displayName).toBe('Acme Traders');
  });

  it('rejects a phone number that another account already owns', async () => {
    if (skip()) return;
    expect((await register('first', mintReceipt('first'), 'First', '+27820000005')).statusCode).toBe(201);
    const second = await register('second', mintReceipt('second'), 'Second', '+27820000005');
    expect(second.statusCode).toBe(409);
  });

  it('requires a display name', async () => {
    if (skip()) return;
    const res = await register('newbie', mintReceipt('newbie'), '   ');
    expect(res.statusCode).toBe(400);
  });
});
