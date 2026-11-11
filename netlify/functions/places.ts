/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * POST /api/places { q, lat?, lon? }: looks a named place up on Ola Maps
 * (autocomplete search, biased towards the given point). Used by the map check
 * when OpenStreetMap's Photon search is down or doesn't know the place.
 * The Ola key stays here, in OLA_MAPS_API_KEY. Answers are cached for a day.
 * Results must be credited to "Ola Maps" wherever they're shown.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { guard, json, parseBody } from '../shared/guard';

const KEY = process.env.OLA_MAPS_API_KEY || '';
const DAY = 24 * 60 * 60_000;
const cache: Map<string, { at: number; hits: unknown[] }> = ((globalThis as any).__itPlaces ??= new Map());

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  if (!KEY) return json(503, { error: 'Ola Maps is not set up.' });
  const blocked = await guard(event, 'places', 120);
  if (blocked) return blocked;
  const body = parseBody<{ q?: unknown; lat?: unknown; lon?: unknown }>(event);
  const q = String(body?.q || '').trim().slice(0, 120);
  if (q.length < 2) return json(400, { error: 'Nothing to look up.' });
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);
  const near = Number.isFinite(lat) && Number.isFinite(lon) && lat > 5 && lat < 38 && lon > 67 && lon < 98 ? `${lat.toFixed(4)},${lon.toFixed(4)}` : '';

  const key = `${q.toLowerCase()}|${near}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY) return json(200, { hits: hit.hits, source: 'Ola Maps' });

  try {
    const url = `https://api.olamaps.io/places/v1/autocomplete?input=${encodeURIComponent(q)}${near ? `&location=${near}` : ''}&api_key=${encodeURIComponent(KEY)}`;
    const res = await fetch(url, { headers: { 'X-Request-Id': `it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }, signal: AbortSignal.timeout(7000) });
    if (res.status === 429) return json(429, { error: 'Ola Maps is busy. Try again later.' });
    if (!res.ok) {
      console.error('Ola Maps answered', res.status);
      return json(502, { error: 'Ola Maps did not answer.' });
    }
    const data: any = await res.json();
    const hits = (Array.isArray(data?.predictions) ? data.predictions : []).slice(0, 8).flatMap((p: any) => {
      const loc = p?.geometry?.location;
      const name = String(p?.structured_formatting?.main_text || p?.description || '').trim();
      if (!name || !Number.isFinite(loc?.lat) || !Number.isFinite(loc?.lng)) return [];
      return [{
        name,
        address: String(p?.description || '').slice(0, 200),
        lat: loc.lat,
        lon: loc.lng,
        types: Array.isArray(p?.types) ? p.types.slice(0, 6).map(String) : [],
      }];
    });
    if (cache.size > 5000) cache.clear();
    cache.set(key, { at: Date.now(), hits });
    return json(200, { hits, source: 'Ola Maps' });
  } catch (err) {
    console.error('Ola Maps lookup failed:', err);
    return json(502, { error: 'Ola Maps did not answer.' });
  }
};

export { handler };
