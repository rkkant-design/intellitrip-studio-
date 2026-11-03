/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Checks a plan against real map data, in the browser:
 *  - every specifically named place (stops, food, hidden gems, activities, the
 *    stay) is looked up on OpenStreetMap via Photon. It only counts as found when
 *    its distinctive name matches, it is the right kind of place (a food stop must
 *    be somewhere to eat, a stay somewhere to sleep) and it is near the expected
 *    town. Vague entries such as "Check-in and unwind" are skipped, not guessed;
 *  - every driving leg gets a real road distance and driving time from Mapbox
 *    (the public token the traffic map already uses), or the public OSRM router
 *    when no token is configured.
 * These are free services with fair-use limits, so lookups are few, spaced out
 * and saved with the trip so they run once.
 */

import type { Place, Plan } from './tripkit';

export interface PlaceCheck {
  // skipped: too vague to look up; unchecked: the map service didn't answer.
  status: 'found' | 'notfound' | 'skipped' | 'unchecked';
  lat?: number;
  lon?: number;
  matched?: string; // the name on the map
  where?: string; // the town or district on the map
}

export interface LegCheck {
  km: number;
  hours: number;
  source: 'Mapbox' | 'OpenStreetMap';
}

export interface Checks {
  at: string;
  places: Record<string, PlaceCheck>;
  legs: Record<string, LegCheck | null>;
  routeSource?: string;
}

type Kind = 'food' | 'stay' | 'sight';

const MAPBOX_TOKEN = (import.meta as any).env?.VITE_MAPBOX_TOKEN as string | undefined;

export const placeKey = (p: Place) => `${p.name || ''}|${p.mapsQuery || ''}`;

// --- name matching ---

// Words that say what kind of place it is, or what you do there, rather than which place it is.
const GENERIC = new Set([
  'a', 'ac', 'and', 'area', 'as', 'at', 'bakers', 'bakery', 'bhavan', 'bhavans', 'boating', 'branch', 'breakfast',
  'bus', 'bypass', 'c', 'cafe', 'center', 'centre', 'check', 'coffee', 'dam', 'dinner', 'drive', 'edge', 'estate',
  'evening', 'falls', 'farm', 'forest', 'from', 'garden', 'gardens', 'gate', 'hill', 'hills', 'home', 'homestay',
  'hotel', 'hotels', 'house', 'in', 'inn', 'junction', 'kovil', 'koil', 'lake', 'local', 'lodge', 'lunch', 'meal',
  'meals', 'mess', 'morning', 'museum', 'near', 'new', 'nh', 'of', 'old', 'option', 'out', 'outlet', 'park',
  'parking', 'path', 'photo', 'photos', 'point', 'pure', 'quick', 'restaurant', 'restaurants', 'resort', 'resorts',
  'ride', 'road', 'shop', 'short', 'shri', 'spot', 'sree', 'sri', 'stall', 'start', 'stay', 'stop', 'stroll',
  'sunrise', 'sunset', 'tea', 'temple', 'the', 'tiffin', 'to', 'top', 'trail', 'unwind', 'veg', 'vegetarian', 'view',
  'viewpoint', 'village', 'visit', 'walk', 'waterfall', 'arulmigu', 'tamil', 'nadu', 'kerala', 'karnataka', 'india',
]);

const tokens = (s: string) =>
  s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

// Close spellings count as the same word: Shenbaganur / Shembaganur, Aariyas / Aariyaas.
const sameWord = (a: string, b: string) => {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return Math.max(a.length, b.length) - (i + j) <= 2;
};

/** The words that identify this particular place: no generic words, no town or state names. */
export const distinctiveWords = (name: string, ignore: string[] = []) => {
  const skip = ignore.flatMap(tokens);
  return tokens(name).filter((t) => t.length > 2 && !GENERIC.has(t) && !skip.some((s) => sameWord(s, t)));
};

/**
 * Whether a map name is the same place as the wanted name: the longest distinctive
 * word must appear, and at least half of the shorter name's distinctive words.
 */
export const namesMatch = (wanted: string[], candidateName: string) => {
  if (!wanted.length) return false;
  const c = tokens(candidateName);
  const key = [...wanted].sort((a, b) => b.length - a.length)[0];
  if (!c.some((y) => sameWord(key, y))) return false;
  const shared = wanted.filter((x) => c.some((y) => sameWord(x, y))).length;
  const cDistinct = c.filter((t) => t.length > 2 && !GENERIC.has(t)).length || 1;
  return shared / Math.min(wanted.length, cDistinct) >= 0.5;
};

// --- kinds of place ---

const FOOD = new Set(['restaurant', 'cafe', 'fast_food', 'food_court', 'bakery', 'ice_cream', 'confectionery', 'hotel', 'guest_house', 'resort', 'pastry']);
const STAY = new Set(['hotel', 'guest_house', 'resort', 'chalet', 'hostel', 'motel', 'apartment', 'camp_site', 'bed_and_breakfast']);
// Things a plan never means by a stop, gem or meal.
const NEVER_KEYS = new Set(['highway', 'boundary', 'railway', 'power', 'office', 'healthcare', 'landuse', 'building']);
const NEVER_VALUES = new Set([
  'clinic', 'dentist', 'doctors', 'hospital', 'pharmacy', 'bus_stop', 'bus_station', 'school', 'college', 'university',
  'bank', 'atm', 'police', 'post_office', 'toilets', 'residential', 'fuel', 'car_repair', 'kindergarten', 'townhall',
  'stream', 'canal', 'drain', 'ditch',
]);

const kindFits = (kind: Kind, osmKey: string, osmValue: string) => {
  if (NEVER_KEYS.has(osmKey) || NEVER_VALUES.has(osmValue)) return false;
  if (kind === 'food') return FOOD.has(osmValue);
  if (kind === 'stay') return STAY.has(osmValue) || osmValue === 'resort';
  return true;
};

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

// --- lookups ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Counts answered lookups in the current run, so an unreachable service isn't mistaken for "not on the map".
const stats = { answered: 0 };

/** JSON from a free map service, or null when it didn't answer. Backs off when told to slow down. */
async function getJson(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        stats.answered++;
        return await res.json();
      }
      if (res.status !== 429 && res.status < 500) return null;
    } catch {
      /* network blip: try again */
    }
    await sleep(1500 * 2 ** attempt);
  }
  return null;
}

// Towns must lie roughly between the start and the destination. Free geocoders
// "correct" small town names to far-away places (Peerumedu became Peelamedu, Coimbatore).
let inCorridor: (p: Point) => boolean = () => true;

const nameLike = (query: string, got: string) => tokens(query).some((a) => tokens(got).some((b) => sameWord(a, b)));

interface Point { lat: number; lon: number; name?: string }

const townCache = new Map<string, Point | null>();

// Plans sometimes write towns as "Tiruchirappalli (Trichy) — stay near the bypass": keep the town itself.
const townOnly = (name: string) => name.split(/[,(/—–]| - /)[0].trim();

/** Coordinates of a town or city, from Open-Meteo's geocoder, then OpenStreetMap. */
export async function findTown(name: string): Promise<Point | null> {
  const first = townOnly(name);
  const key = first.toLowerCase();
  if (!key) return null;
  if (townCache.has(key)) return townCache.get(key)!;
  let point: Point | null = null;
  const om = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(first)}&count=10&language=en&format=json`);
  for (const r of om?.results || []) {
    const cand = { lat: r.latitude, lon: r.longitude, name: r.name };
    if (r.country_code === 'IN' && nameLike(first, r.name) && inCorridor(cand)) { point = cand; break; }
  }
  if (!point) {
    const ph = await getJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(first)}&limit=5&osm_tag=place`);
    for (const f of ph?.features || []) {
      const cand = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name: f.properties?.name };
      if (nameLike(first, String(cand.name || '')) && inCorridor(cand)) { point = cand; break; }
    }
  }
  townCache.set(key, point);
  return point;
}

/** Looks one place up on OpenStreetMap. */
async function findPlace(p: Place, kind: Kind, region: Point | null, ignore: string[]): Promise<PlaceCheck> {
  const name = (p.name || '').trim();
  const parts = (p.mapsQuery || '').split(',').map((s) => s.trim()).filter(Boolean);
  const town = parts.length > 1 ? parts[1] : '';
  const wanted = distinctiveWords(name, [...parts.slice(1), ...ignore]);
  // Nothing that identifies a particular place ("Check-in and unwind", "Veg lunch at Kumily"): don't guess.
  if (!wanted.length) return { status: 'skipped' };

  const townPoint = town ? await findTown(town) : null;
  const anchor = townPoint || region;
  const maxKm = townPoint ? 30 : 150;
  // Last try: just the distinctive name near the right area, for when a town in the query pulls up roads instead.
  const queries = [p.mapsQuery, town ? `${wanted.join(' ')} ${town}` : '', wanted.join(' ')]
    .filter((q, i, all): q is string => Boolean(q) && all.indexOf(q) === i);

  let answered = 0;
  for (const q of queries) {
    const bias = anchor ? `&lat=${anchor.lat}&lon=${anchor.lon}` : '';
    const data = await getJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8${bias}`);
    await sleep(350);
    if (data) answered++;
    for (const f of data?.features || []) {
      const props = f.properties || {};
      const cand = String(props.name || '');
      if (!cand || !namesMatch(wanted, cand)) continue;
      if (!kindFits(kind, String(props.osm_key || ''), String(props.osm_value || ''))) continue;
      const point = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
      if (anchor && km(anchor, point) > maxKm) continue;
      return {
        status: 'found', ...point, matched: cand,
        where: [props.city || props.town || props.village || props.county, props.state].filter(Boolean).join(', '),
      };
    }
  }
  return { status: answered ? 'notfound' : 'unchecked' };
}

/** Road distance and pure driving time through the given points, in order. */
async function routeThrough(points: Point[]): Promise<LegCheck | null> {
  if (points.length < 2) return null;
  const coords = points.slice(0, 25).map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  if (MAPBOX_TOKEN) {
    const d = await getJson(`https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?overview=false&access_token=${MAPBOX_TOKEN}`);
    const r = d?.routes?.[0];
    if (r) return { km: Math.round(r.distance / 1000), hours: Math.round((r.duration / 3600) * 10) / 10, source: 'Mapbox' };
  }
  const o = await getJson(`https://router.project-osrm.org/route/v1/driving/${coords}?overview=false`);
  const r = o?.routes?.[0];
  return r ? { km: Math.round(r.distance / 1000), hours: Math.round((r.duration / 3600) * 10) / 10, source: 'OpenStreetMap' } : null;
}

const arr = <T,>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);

const looksLikeFood = (s?: string) => /\bfood\b/i.test(s || '');

/** Every named place in a plan, once each, with the kind of place it should be. */
export function placesWithKind(plan: Plan): { p: Place; kind: Kind }[] {
  const rt = plan.roadTrip && typeof plan.roadTrip === 'object' ? plan.roadTrip : null;
  const all: { p: Place; kind: Kind }[] = [
    ...(plan.accommodation?.name ? [{ p: plan.accommodation, kind: 'stay' as Kind }] : []),
    ...arr(rt?.legs).flatMap((l) => arr(l.stops).map((s) => ({ p: s as Place, kind: (looksLikeFood(s.type) ? 'food' : 'sight') as Kind }))),
    ...arr(rt?.foodStops).map((f) => ({ p: f as Place, kind: 'food' as Kind })),
    ...arr(plan.days).flatMap((d) => [...arr(d.activities), ...arr(d.hiddenGems)].map((x) => ({ p: x as Place, kind: 'sight' as Kind }))),
  ].filter(({ p }) => p && p.name && p.mapsQuery);
  const seen = new Set<string>();
  return all.filter(({ p }) => (seen.has(placeKey(p)) ? false : (seen.add(placeKey(p)), true)));
}

export const placesIn = (plan: Plan): Place[] => placesWithKind(plan).map(({ p }) => p);

/** Runs the whole check. Reports progress as (done, total). */
export async function checkPlan(
  plan: Plan,
  from: string,
  destination: string,
  onProgress?: (done: number, total: number) => void
): Promise<Checks> {
  const places = placesWithKind(plan);
  const legs = arr(plan.roadTrip && typeof plan.roadTrip === 'object' ? plan.roadTrip.legs : []);
  const total = places.length + legs.length;
  let done = 0;
  const tick = () => onProgress?.(++done, total);
  onProgress?.(0, total);

  stats.answered = 0;
  townCache.clear();
  inCorridor = () => true;
  const fromPt = await findTown(from);
  const destPt = await findTown(destination);
  if (fromPt && destPt) {
    const span = km(fromPt, destPt);
    inCorridor = (p) => km(fromPt, p) + km(p, destPt) <= span * 1.5 + 80;
  }
  const region = destPt || fromPt;
  const ignore = [townOnly(from), townOnly(destination)];
  const results: Record<string, PlaceCheck> = {};
  // One lookup at a time keeps us well inside Photon's fair use.
  for (const item of places) {
    results[placeKey(item.p)] = await findPlace(item.p, item.kind, region, ignore);
    tick();
  }

  if (places.length && stats.answered === 0) throw new Error('The map service did not answer.');

  const legChecks: Record<string, LegCheck | null> = {};
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const start = leg.from ? await findTown(leg.from) : null;
    const end = leg.to ? await findTown(leg.to) : null;
    if (!start || !end) {
      legChecks[String(i)] = null;
      tick();
      continue;
    }
    // Route through the stops that were found, skipping any that would drag the drive far off course.
    const direct = km(start, end);
    const via = arr(leg.stops)
      .map((s) => results[placeKey(s)])
      .filter((c): c is PlaceCheck => c?.status === 'found' && c.lat !== undefined)
      .map((c) => ({ lat: c.lat!, lon: c.lon! }))
      .filter((pt) => km(start, pt) + km(pt, end) <= direct * 1.4 + 25);
    legChecks[String(i)] = await routeThrough([start, ...via, end]);
    tick();
  }

  return {
    at: new Date().toISOString(),
    places: results,
    legs: legChecks,
    routeSource: Object.values(legChecks).find(Boolean)?.source,
  };
}
