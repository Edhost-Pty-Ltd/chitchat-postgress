// Opaque cursor encoding for keyset pagination (Req 5.9, 8.11).
// A cursor packs the ordering tuple (created_at, id) so paging is stable even
// when rows share a timestamp. Pure and unit-tested (Property 3).

export interface Cursor {
  createdAt: string; // ISO timestamp
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const idx = decoded.indexOf('|');
    if (idx < 0) return null;
    const createdAt = decoded.slice(0, idx);
    const id = decoded.slice(idx + 1);
    if (!createdAt || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export const DEFAULT_PAGE_SIZE = 50; // messages (Req 5.9)
export const MAX_PAGE_SIZE = 100;

export function clampLimit(requested: number | undefined, fallback = DEFAULT_PAGE_SIZE): number {
  if (!requested || requested <= 0) return fallback;
  return Math.min(requested, MAX_PAGE_SIZE);
}
