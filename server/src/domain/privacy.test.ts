import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isVisibleTo, VISIBILITY_VALUES, type Visibility } from './privacy.js';

// Feature: firebase-to-sockets-redis-postgres-migration, Property 13 (support):
// Contact matching returns only privacy-permitted data. The field-visibility
// decision is the pure core; here we verify it exhaustively/with property tests.

describe('isVisibleTo', () => {
  it('Everyone is always visible; Nobody never is', () => {
    expect(isVisibleTo('Everyone', true)).toBe(true);
    expect(isVisibleTo('Everyone', false)).toBe(true);
    expect(isVisibleTo('Nobody', true)).toBe(false);
    expect(isVisibleTo('Nobody', false)).toBe(false);
  });

  it('Contacts is visible only to contacts', () => {
    expect(isVisibleTo('Contacts', true)).toBe(true);
    expect(isVisibleTo('Contacts', false)).toBe(false);
  });

  it('property: Nobody is never visible regardless of contact status', () => {
    fc.assert(
      fc.property(fc.boolean(), (isContact) => {
        expect(isVisibleTo('Nobody', isContact)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('property: Everyone is always visible regardless of contact status', () => {
    fc.assert(
      fc.property(fc.boolean(), (isContact) => {
        expect(isVisibleTo('Everyone', isContact)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('property: a non-contact only ever sees Everyone-gated fields', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Visibility>(...(VISIBILITY_VALUES as Visibility[])),
        (setting) => {
          const visibleToStranger = isVisibleTo(setting, false);
          expect(visibleToStranger).toBe(setting === 'Everyone');
        },
      ),
      { numRuns: 100 },
    );
  });
});
