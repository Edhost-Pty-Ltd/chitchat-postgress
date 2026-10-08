import { pino, type LoggerOptions } from 'pino';

/**
 * Shared pino options (Req 1.10) with redaction of sensitive values (Req 12.6):
 * Firebase ID tokens, push tokens and presigned URLs must never appear in logs.
 * The same options are handed to Fastify so the HTTP logger shares redaction.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'headers.authorization',
      'authorization',
      '*.authorization',
      'token',
      '*.token',
      'idToken',
      '*.idToken',
      'pushToken',
      '*.pushToken',
      'uploadUrl',
      '*.uploadUrl',
      'downloadUrl',
      '*.downloadUrl',
      'presignedUrl',
      '*.presignedUrl',
    ],
    censor: '[REDACTED]',
  },
};

export const logger = pino(loggerOptions);

export type Logger = typeof logger;
