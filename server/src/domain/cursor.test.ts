import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { encodeCursor, decodeCursor, clampLimit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './cursor.js';

// Feature: firebase-to-sockets-redis-postgres-migration, Property 3 (support):
// Cursor pagination is complete and ordered — the cursor codec must round-trip
// the ordering tuple exactly, and limits must stay within bounds.

describe('cursor codec', () => {
  it('round-trips an arbitrary (createdAt, id) tuple', () => {
    fc.assert(
      fc.property(
        // Valid epoch-millis range, converted to an ISO timestamp.
        fc.integer({ min: 946684800000, max: 4102444800000 }),
        fc.uuid(),
        (millis, id) => {
          const createdAt = new Date(millis).toISOString();
          const encoded = encodeCursor({ createdAt, id });
          const decoded = decodeCursor(encoded);
          expect(decoded).toEqual({ createdAt, id });
        },
      ),
      { numRuns: 200 },
    );
  });

  it('returns null for missing or malformed cursors', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor('not-base64-$$$')).toBeNull();
    expect(decodeCursor(Buffer.from('nopipe', 'utf8').toString('base64url'))).toBeNull();
  });
});

describe('clampLimit', () => {
  it('falls back to the default for missing or non-positive values', () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampLimit(-5)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('never exceeds the maximum page size', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10000 }), (n) => {
        const limit = clampLimit(n);
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThanOrEqual(MAX_PAGE_SIZE);
      }),
      { numRuns: 100 },
    );
  });
});
