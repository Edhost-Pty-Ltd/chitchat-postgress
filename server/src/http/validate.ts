import type { z } from 'zod';
import { Errors } from './errors.js';

/**
 * Parse `data` against `schema`, throwing a 400 ApiError with details on
 * failure (Req 12.1, Property 23). Returns the typed, parsed value.
 */
export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw Errors.badRequest('Invalid request', result.error.flatten());
  }
  return result.data;
}
