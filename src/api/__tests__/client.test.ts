import { ApiClient } from '../client';
import { ApiError, NetworkError } from '../errors';
import type { IdTokenSource } from '../token';

// Feature: firebase-to-sockets-redis-postgres-migration, Property 27:
// API client error typing — HTTP responses yield an ApiError carrying the
// status and backend code; no connectivity yields a distinguishable
// NetworkError.

const tokenSource: IdTokenSource = {
  getExpiry: async () => Date.now() + 60 * 60 * 1000,
  getToken: async () => 'test-token',
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function clientWithFetch(
  fetchImpl: typeof fetch,
  opts: { offline?: boolean } = {},
): ApiClient {
  globalThis.fetch = fetchImpl;
  return new ApiClient({
    baseUrl: 'http://backend.test',
    tokenSource,
    isOffline: async () => opts.offline ?? false,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ApiClient', () => {
  it('returns typed data on success and attaches the bearer token', async () => {
    const fetchMock = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
      return jsonResponse(200, { id: 'u1' });
    });
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    const res = await client.get<{ id: string }>('/me');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data).toEqual({ id: 'u1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/me',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('maps a non-2xx response to an ApiError with status and code', async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse(409, { error: { code: 'CONFLICT', message: 'taken' } }),
    );
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    const res = await client.put('/me/phone', { phone: '+1' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(ApiError);
      const e = res.error as ApiError;
      expect(e.status).toBe(409);
      expect(e.code).toBe('CONFLICT');
      expect(e.kind).toBe('api');
    }
  });

  it('maps a fetch rejection to a NetworkError', async () => {
    const fetchMock = jest.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    const res = await client.get('/me');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBeInstanceOf(NetworkError);
      expect(res.error.kind).toBe('network');
    }
  });

  it('returns a NetworkError without calling fetch when offline', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(200, {}));
    const client = clientWithFetch(fetchMock as unknown as typeof fetch, { offline: true });
    const res = await client.get('/me');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBeInstanceOf(NetworkError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serializes query parameters, skipping undefined values', async () => {
    const fetchMock = jest.fn(async () => jsonResponse(200, []));
    const client = clientWithFetch(fetchMock as unknown as typeof fetch);
    await client.get('/chats/c1/messages', { query: { cursor: 'abc', limit: 50, extra: undefined } });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend.test/chats/c1/messages?cursor=abc&limit=50',
      expect.anything(),
    );
  });
});
