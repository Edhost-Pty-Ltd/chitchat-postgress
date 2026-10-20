// ─── API client error types ──────────────────────────────────────────────────
// The API_Client returns a discriminated result so callers can distinguish an
// HTTP error (reached the backend, got a non-2xx) from a network error (never
// reached the backend) without inspecting messages (Req 3.4, 3.5).

/** The backend reached us and returned a non-2xx response. */
export class ApiError extends Error {
  readonly kind = 'api' as const;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** The request never completed (no connectivity, DNS, timeout, etc.). */
export class NetworkError extends Error {
  readonly kind = 'network' as const;
  // A stable code mirrors ApiError.code so callers can read `error.code` on the
  // ApiResult error union without first narrowing by `kind`.
  readonly code = 'NETWORK' as const;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** The result of an API call: either data or a typed error (Req 3.4). */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError | NetworkError };

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export function isNetworkError(e: unknown): e is NetworkError {
  return e instanceof NetworkError;
}
