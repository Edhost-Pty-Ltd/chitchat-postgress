/** Standard API error with an HTTP status and a machine-readable code. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const Errors = {
  unauthorized: (code: string, message: string) => new ApiError(401, code, message),
  forbidden: (message = 'Forbidden') => new ApiError(403, 'FORBIDDEN', message),
  notFound: (message = 'Not found') => new ApiError(404, 'NOT_FOUND', message),
  conflict: (message = 'Conflict') => new ApiError(409, 'CONFLICT', message),
  payloadTooLarge: (message = 'Payload too large') =>
    new ApiError(413, 'PAYLOAD_TOO_LARGE', message),
  tooManyRequests: (message = 'Too many requests') =>
    new ApiError(429, 'RATE_LIMITED', message),
  badRequest: (message = 'Bad request', details?: unknown) =>
    new ApiError(400, 'BAD_REQUEST', message, details),
};
