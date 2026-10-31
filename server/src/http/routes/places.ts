import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { getEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

/**
 * Place search proxy for the in-person meeting venue picker. The provider key
 * stays on the server (never shipped in the app). When GOOGLE_PLACES_API_KEY is
 * set we use the Google Places API (New); otherwise we fall back to OpenStreetMap
 * Nominatim, which also returns real, existing places and needs no key.
 *
 * Both providers are normalized to the same shape so the client is agnostic:
 *   { placeId, name, address, lat, lng }   (lat/lng may be null for Google
 *   autocomplete suggestions — the client then calls /places/details).
 */
export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
}

const NOMINATIM_UA = 'ChitChatBusiness/1.0 (meeting venue search)';

// Small in-memory cache so a debounced typeahead doesn't hammer the provider
// (and respects Nominatim's fair-use policy). Keyed by the normalized query.
const cache = new Map<string, { at: number; results: PlaceResult[] }>();
const CACHE_TTL_MS = 60_000;

function cached(key: string): PlaceResult[] | null {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.results;
  return null;
}

async function googleAutocomplete(input: string, key: string, sessionToken?: string): Promise<PlaceResult[]> {
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({ input, ...(sessionToken ? { sessionToken } : {}) }),
  });
  if (!res.ok) throw new Error(`Google autocomplete HTTP ${res.status}`);
  const data = (await res.json()) as {
    suggestions?: {
      placePrediction?: {
        placeId?: string;
        text?: { text?: string };
        structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
      };
    }[];
  };
  return (data.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
    .map((p) => ({
      placeId: p.placeId!,
      name: p.structuredFormat?.mainText?.text ?? p.text?.text ?? 'Unknown place',
      address: p.structuredFormat?.secondaryText?.text ?? p.text?.text ?? '',
      lat: null,
      lng: null,
    }));
}

async function googleDetails(placeId: string, key: string, sessionToken?: string): Promise<PlaceResult | null> {
  const url = new URL(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`);
  if (sessionToken) url.searchParams.set('sessionToken', sessionToken);
  const res = await fetch(url.toString(), {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'id,displayName,formattedAddress,location' },
  });
  if (!res.ok) throw new Error(`Google details HTTP ${res.status}`);
  const d = (await res.json()) as {
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  };
  return {
    placeId: d.id ?? placeId,
    name: d.displayName?.text ?? 'Unknown place',
    address: d.formattedAddress ?? '',
    lat: d.location?.latitude ?? null,
    lng: d.location?.longitude ?? null,
  };
}

async function nominatimSearch(input: string): Promise<PlaceResult[]> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', input);
  url.searchParams.set('format', 'json');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('limit', '6');
  const res = await fetch(url.toString(), { headers: { 'User-Agent': NOMINATIM_UA } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = (await res.json()) as {
    place_id?: number | string;
    display_name?: string;
    name?: string;
    lat?: string;
    lon?: string;
  }[];
  return (data ?? []).map((r) => {
    const display = r.display_name ?? '';
    const primary = r.name && r.name.trim() ? r.name : display.split(',')[0];
    return {
      placeId: `osm:${r.place_id ?? ''}`,
      name: primary || 'Unknown place',
      address: display,
      lat: r.lat != null ? Number(r.lat) : null,
      lng: r.lon != null ? Number(r.lon) : null,
    };
  });
}

export async function registerPlacesRoutes(app: FastifyInstance): Promise<void> {
  // GET /places/autocomplete?q=&sessionToken= — venue typeahead.
  app.get<{ Querystring: { q?: string; sessionToken?: string } }>(
    '/places/autocomplete',
    { preHandler: requireAuth },
    async (request) => {
      const q = (request.query.q ?? '').trim();
      if (q.length < 2) return { results: [] as PlaceResult[] };
      const key = getEnv().GOOGLE_PLACES_API_KEY;
      const cacheKey = `${key ? 'g' : 'n'}:${q.toLowerCase()}`;
      const hit = cached(cacheKey);
      if (hit) return { results: hit };
      try {
        const results = key
          ? await googleAutocomplete(q, key, request.query.sessionToken)
          : await nominatimSearch(q);
        cache.set(cacheKey, { at: Date.now(), results });
        return { results };
      } catch (err) {
        logger.warn({ err }, 'places autocomplete failed');
        // Degrade gracefully — an empty list just shows "no matches".
        return { results: [] as PlaceResult[] };
      }
    },
  );

  // GET /places/details?placeId=&sessionToken= — resolve a Google suggestion to
  // coordinates. Nominatim suggestions already carry lat/lng, so the client only
  // calls this for Google-sourced place ids.
  app.get<{ Querystring: { placeId?: string; sessionToken?: string } }>(
    '/places/details',
    { preHandler: requireAuth },
    async (request) => {
      const placeId = (request.query.placeId ?? '').trim();
      if (!placeId) return { place: null as PlaceResult | null };
      const key = getEnv().GOOGLE_PLACES_API_KEY;
      if (!key || placeId.startsWith('osm:')) return { place: null as PlaceResult | null };
      try {
        const place = await googleDetails(placeId, key, request.query.sessionToken);
        return { place };
      } catch (err) {
        logger.warn({ err }, 'place details failed');
        return { place: null as PlaceResult | null };
      }
    },
  );
}
