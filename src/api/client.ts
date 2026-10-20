// ─── API_Client ──────────────────────────────────────────────────────────────
// Thin fetch wrapper around the backend REST API. Attaches a fresh Firebase ID
// token to every request (Req 2.2, 2.3), returns typed results (Req 3.4), and
// distinguishes network failures from HTTP errors (Req 3.5).

import { API_URL } from '../config/env'
 
import { ApiError, NetworkError, type ApiResult } from './errors';
import {
  createFirebaseTokenSource,
  getFreshIdToken,
  type IdTokenSource,
} from './token';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON-serializable body. */
  body?: unknown;
  /** Query parameters. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Extra headers. */
  headers?: Record<string, string>;
  /** Abort signal for cancellation/timeouts. */
  signal?: AbortSignal;
}

export interface ApiClientConfig {
  baseUrl?: string;
  tokenSource?: IdTokenSource;
  /** Connectivity check; overridable for tests. Returns true when offline. */
  isOffline?: () => Promise<boolean>;
}

async function defaultIsOffline(): Promise<boolean> {
  try { 
    const { default: NetInfo } = await import('@react-native-community/netinfo');
    const state = await NetInfo.fetch(); 
    return state.isConnected === false;
  } catch {
    return false;
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly tokenSource: IdTokenSource;
  private readonly isOffline: () => Promise<boolean>;

  constructor(config: ApiClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? API_URL).replace(/\/+$/, '');
    this.tokenSource = config.tokenSource ?? createFirebaseTokenSource();
    this.isOffline = config.isOffline ?? defaultIsOffline;
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return url;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.append(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
    if (await this.isOffline()) {
      return { ok: false, error: new NetworkError('Device is offline') };
    }

    let token: string | null;
    try {
      token = await getFreshIdToken(this.tokenSource);
    } catch (err) {
      // Treat an inability to obtain a token as a network-class failure so the
      // caller can retry rather than surfacing a confusing HTTP code.
      return { ok: false, error: new NetworkError('Failed to obtain auth token', err) };
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    };

    // Default 10-second timeout. Callers can pass their own signal to override.
    const defaultController = options.signal ? null : new AbortController();
    const timeoutId = defaultController
      ? setTimeout(() => defaultController.abort(), 10_000)
      : null;
    const signal = options.signal ?? defaultController!.signal;

    let response: Response;
    try {
      response = await fetch(this.buildUrl(path, options.query), {
        method: options.method ?? 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal,
      });
    } catch (err) {
      // fetch rejects only on network-level failures (Req 3.5).
      const isTimeout = (err as any)?.name === 'AbortError';
      return {
        ok: false,
        error: new NetworkError(isTimeout ? 'Timeout' : 'Network request failed', err),
      };
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
    }

    const text = await response.text();
    const payload = text ? safeJson(text) : undefined;

    if (!response.ok) {
      const errBody = (payload as { error?: { code?: string; message?: string; details?: unknown } })
        ?.error;
      return {
        ok: false,
        error: new ApiError(
          response.status,
          errBody?.code ?? `HTTP_${response.status}`,
          errBody?.message ?? response.statusText ?? 'Request failed',
          errBody?.details,
        ),
      };
    }

    return { ok: true, data: payload as T };
  }

  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) {
    return this.request<T>(path, { ...options, method: 'GET' });
  }
  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method'>) {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }
  patch<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method'>) {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }
  put<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method'>) {
    return this.request<T>(path, { ...options, method: 'PUT', body });
  }
  delete<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Shared singleton used by hooks and screens. */
export const apiClient = new ApiClient();
