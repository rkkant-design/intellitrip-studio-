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
 *    When Photon is down or doesn't know the place, Ola Maps is asked instead
 *    (through our server, which holds the key), with the same checks;
 *  - every driving leg gets a real road distance and driving time from Mapbox
 *    (the public token the traffic map already uses); without a token, drives
 *    keep the plan's own distances.
 * These are free services with fair-use limits, so lookups are few, spaced out
 * and saved with the trip so they run once.
 */

import type { Place, Plan } from './tripkit';
import { ROAD_RULES } from './roadrules';

export interface PlaceCheck {
  // skipped: too vague to look up; unchecked: the map service didn't answer.
  status: 'found' | 'notfound' | 'skipped' | 'unchecked';
  lat?: number;
  lon?: number;
  matched?: string; // the name on the map
  where?: string; // the town or district on the map
  source?: 'Ola Maps'; // set when the place was found on Ola Maps rather than OpenStreetMap (credit it)
}

export interface LegCheck {
  km: number;
  hours: number;
  source: 'Mapbox' | 'OpenStreetMap';
  /** Road rules whose area this drive passes through, as fractions (0–1) of the way along it. */
  hits?: { ruleId: string; enter: number; exit: number }[];
  /** The road's shape for the trip map, as [lon, lat] pairs, thinned to keep the trip small. */
  path?: [number, number][];
}

export interface Checks {
  at: string;
  places: Record<string, PlaceCheck>;
  legs: Record<string, LegCheck | null>;
  routeSource?: string;
  direct?: LegCheck | null; // the plain road from the start to the destination, for spotting detours
  partial?: boolean; // drives measured, places still being looked up (an interrupted check runs again)
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
  'ticket', 'tickets', 'entrance', 'entry', 'counter', 'trailhead', 'base', 'arrive', 'arrival', 'halt', 'pause',
  'with', 'tour', 'boat', 'stretch', 'leg', 'checkout',
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
  // A viewpoint, temple or walk is never a restaurant or a hotel ("Selvi Koil Point" is not "Selvi Mess").
  return !FOOD.has(osmValue) && !STAY.has(osmValue);
};

// Names that say a place is somewhere to eat, whatever list the plan put it in.
const FOOD_NAME = /\b(hotel|restaurant|mess|bhavan|bhavans|cafe|café|coffee|juice|bakery|bakers|idli|tiffin|dhaba|canteen|sweets|biryani|kitchen|eatery|annapoorna|saravana)\b/i;

const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};

// Ola Maps place types: what each kind of stop may be. Ola tags roads with no type (and sometimes as a
// sight: "Suruli Falls Road"), so a sight needs a sight's type, and road names are never a stop.
const OLA_FOOD = new Set(['restaurant', 'cafe', 'food', 'bakery', 'meal_takeaway', 'meal_delivery']);
const OLA_STAY = new Set(['lodging', 'hotel', 'resort', 'guest_house', 'campground', 'rv_park']);
const OLA_SIGHT = new Set([
  'tourist_attraction', 'natural_feature', 'park', 'place_of_worship', 'hindu_temple', 'church', 'mosque', 'gurudwara',
  'museum', 'zoo', 'amusement_park', 'aquarium', 'art_gallery', 'campground', 'historical_landmark', 'monument', 'beach',
]);
const ROAD_NAME = /\b(rd|road|street|st|highway|hwy|bypass|lane|marg|salai|nagar)\.?\s*$/i;

const olaKindFits = (kind: Kind, types: string[]) => {
  if (kind === 'food') return types.some((t) => OLA_FOOD.has(t));
  if (kind === 'stay') return types.some((t) => OLA_STAY.has(t));
  return types.some((t) => OLA_SIGHT.has(t)) && !types.some((t) => OLA_FOOD.has(t) || OLA_STAY.has(t));
};

/** Stricter than namesMatch, for Ola's looser search: (nearly) every distinctive word must be there, and no road names. */
const olaNameFits = (wanted: string[], placeName: string, candidate: string) => {
  if (!namesMatch(wanted, candidate)) return false;
  const c = tokens(candidate);
  if (wanted.filter((w) => c.some((y) => sameWord(w, y))).length / wanted.length < 0.75) return false;
  return !ROAD_NAME.test(candidate.split(/[|(]/)[0].trim()) || ROAD_NAME.test(placeName);
};

/** "Suruli Falls, Suruli Falls Road, Cumbum, Tamil Nadu 625516, India" -> "Cumbum, Tamil Nadu". */
const olaWhere = (address: string) =>
  address.split(',').map((x) => x.replace(/\d{6}/, '').trim()).filter((x) => x && !/^india$/i.test(x)).slice(1).slice(-2).join(', ');

/** One answer from the backup place search. */
export interface PlaceHit { name: string; address: string; lat: number; lon: number; types: string[] }
/** Searches places near a point; null when the service didn't answer. */
export type PlaceSearch = (query: string, near: { lat: number; lon: number } | null) => Promise<PlaceHit[] | null>;

// --- lookups ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Counts answered lookups in the current run, so an unreachable service isn't mistaken for "not on the map".
const stats = { answered: 0 };
// Services that stopped answering during this run: they are skipped for the rest of it instead of
// making every remaining lookup wait out its timeouts.
const down = new Set<string>();
const PHOTON = 'photon.komoot.io';
const OLA = 'ola';
// The backup place search for this run (Ola Maps through /api/places), when the app provides one.
let backup: PlaceSearch | null = null;

/** JSON from a free map service, or null when it didn't answer. Backs off when told to slow down. */
async function getJson(url: string) {
  const host = new URL(url).host;
  if (down.has(host)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (res.ok) {
        stats.answered++;
        return await res.json();
      }
      if (res.status !== 429 && res.status < 500) return null;
    } catch {
      /* network blip: try again */
    }
    if (attempt === 0) await sleep(1500);
  }
  down.add(host);
  return null;
}

// Towns must lie roughly between the start and the destination. Free geocoders
// "correct" small town names to far-away places (Peerumedu became Peelamedu, Coimbatore).
let inCorridor: (p: Point) => boolean = () => true;
// Places (not towns) must sit close to the trip itself.
let nearRoute: (p: Point) => boolean = () => true;

// Towns with two names in common use; geocoders often know only one (Ooty is "Udhagamandalam").
const TOWN_ALIASES: string[][] = [
  ['ooty', 'udhagamandalam', 'ootacamund'], ['bengaluru', 'bangalore'], ['trichy', 'tiruchirappalli', 'tiruchi'],
  ['pondicherry', 'puducherry', 'pondy'], ['chennai', 'madras'], ['kochi', 'cochin', 'ernakulam'],
  ['kozhikode', 'calicut'], ['thiruvananthapuram', 'trivandrum'], ['mysuru', 'mysore'], ['mangaluru', 'mangalore'],
  ['thekkady', 'kumily'], ['kodaikanal', 'kodai'], ['tirunelveli', 'nellai'], ['thoothukudi', 'tuticorin'],
  ['kanyakumari', 'kanniyakumari'], ['madurai', 'mathurai'], ['coimbatore', 'kovai'], ['alappuzha', 'alleppey'],
  ['thrissur', 'trichur'], ['palakkad', 'palghat'], ['kollam', 'quilon'], ['tiruvannamalai', 'thiruvannamalai'],
];
// Exact match only: close spellings like Trichy and Trichur are different towns.
const aliasesOf = (word: string) => TOWN_ALIASES.find((g) => g.includes(word)) || [word];

const nameLike = (query: string, got: string) =>
  tokens(query).some((a) => aliasesOf(a).some((alias) => tokens(got).some((b) => sameWord(alias, b))));

interface Point { lat: number; lon: number; name?: string }

const townCache = new Map<string, Point | null>();

// Plans sometimes write towns as "Tiruchirappalli (Trichy) — stay near the bypass" or "Kumily Junction":
// keep the town itself.
const townOnly = (name: string) =>
  name.split(/[,(/—–]| - /)[0].replace(/\b(junction|jn|bypass|road|bus stand|town|city|centre|center)\b\.?/gi, ' ').replace(/\s+/g, ' ').trim();

/**
 * Coordinates of a town, hill station or area. Candidates come from Open-Meteo's geocoder and
 * OpenStreetMap; the first that has the right name and passes `fits` wins. Small places share names
 * across the state (there are two Sirumalais), so callers say where the right one must be.
 */
export async function findTown(name: string, fits: (p: Point) => boolean = inCorridor): Promise<Point | null> {
  const first = townOnly(name);
  const key = first.toLowerCase();
  if (!key) return null;
  if (townCache.has(key)) return townCache.get(key)!;
  let point: Point | null = null;
  // Try the name as written, then its other common names.
  const spellings = [first, ...aliasesOf(tokens(first)[0] || '').filter((a) => !sameWord(a, tokens(first)[0] || ''))];
  for (const spelling of spellings) {
    const om = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(spelling)}&count=10&language=en&format=json`);
    for (const r of om?.results || []) {
      const cand = { lat: r.latitude, lon: r.longitude, name: r.name };
      if (r.country_code === 'IN' && nameLike(first, r.name) && fits(cand)) { point = cand; break; }
    }
    if (point) break;
  }
  if (!point) {
    // Hill stations are often mapped as an area (a reserve forest, a hill range), not a town.
    const ph = await getJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(first)}&limit=10`);
    for (const f of ph?.features || []) {
      const props = f.properties || {};
      if (!['place', 'natural', 'boundary'].includes(String(props.osm_key))) continue;
      if (props.countrycode && props.countrycode !== 'IN') continue;
      const cand = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], name: props.name };
      if (nameLike(first, String(cand.name || '')) && fits(cand)) { point = cand; break; }
    }
  }
  townCache.set(key, point);
  return point;
}

const JOURNEY_STEP = /^(drive|arrive|depart|head|return|leave|reach|transfer|travel|set off|start)\b/i;

/** Looks one place up on OpenStreetMap, then Ola Maps. */
async function findPlace(p: Place, kind: Kind, region: Point | null, ignore: string[]): Promise<PlaceCheck> {
  const name = (p.name || '').trim();
  const parts = (p.mapsQuery || '').split(',').map((s) => s.trim()).filter(Boolean);
  const town = parts.length > 1 ? parts[1] : '';
  const wanted = distinctiveWords(name, [...parts.slice(1), ...ignore]);
  // Nothing that identifies a particular place ("Check-in and unwind", "Veg lunch at Kumily"): don't guess.
  if (!wanted.length) return { status: 'skipped' };
  // A step of the journey, not a place ("Drive Madurai → Thekkady with Theni coffee halt", "Head back to Kochi").
  if (JOURNEY_STEP.test(name)) return { status: 'skipped' };
  const townPoint = town ? await findTown(town) : null;
  const anchor = townPoint || region;
  // A single short word ("Arya") is a weak name, so it has to be right next to the town.
  const weakName = wanted.length === 1 && wanted[0].length < 5;
  const maxKm = townPoint ? (weakName ? 10 : 30) : Infinity;
  // When the town couldn't be placed (spellings differ: Peerumedu / Peermade), a match must lie near the
  // route instead, and a weak name must also have the town in its address.
  const townWords = town && !townPoint && weakName ? distinctiveWords(townOnly(town)) : [];
  // Last try: just the distinctive name near the right area, for when a town in the query pulls up roads instead.
  const queries = [p.mapsQuery, town ? `${wanted.join(' ')} ${town}` : '', wanted.join(' ')]
    .filter((q, i, all): q is string => Boolean(q) && all.indexOf(q) === i);

  let answered = 0;
  // OpenStreetMap's place search is skipped once it has stopped answering in this run.
  for (const q of down.has(PHOTON) ? [] : queries) {
    const bias = anchor ? `&lat=${anchor.lat}&lon=${anchor.lon}` : '';
    const data = await getJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8${bias}`);
    if (down.has(PHOTON)) break;
    await sleep(350);
    if (data) answered++;
    for (const f of data?.features || []) {
      const props = f.properties || {};
      const cand = String(props.name || '');
      if (!cand || !namesMatch(wanted, cand)) continue;
      if (!kindFits(kind, String(props.osm_key || ''), String(props.osm_value || ''))) continue;
      const point = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
      if (anchor && km(anchor, point) > maxKm) continue;
      if (!townPoint && !nearRoute(point)) continue;
      if (townWords.length) {
        const address = [props.city, props.town, props.village, props.district, props.county, props.locality].filter(Boolean).join(' ');
        if (!townWords.some((w) => tokens(address).some((a) => sameWord(w, a)))) continue;
      }
      return {
        status: 'found', ...point, matched: cand,
        where: [props.city || props.town || props.village || props.county, props.state].filter(Boolean).join(', '),
      };
    }
  }

  // OpenStreetMap is down or doesn't know it: ask Ola Maps, with the same name, kind and distance checks.
  if (backup && !down.has(OLA)) {
    const olaQueries = [p.mapsQuery, name.replace(/\([^)]*\)/g, ' ').trim()].filter((q, i, all): q is string => Boolean(q) && all.indexOf(q) === i);
    for (const q of olaQueries) {
      const hits = await backup(q, anchor).catch(() => null);
      if (!hits) { down.add(OLA); break; }
      answered++;
      stats.answered++;
      for (const h of hits) {
        if (!h.name || !olaNameFits(wanted, name, h.name)) continue;
        if (!olaKindFits(kind, h.types || [])) continue;
        const point = { lat: h.lat, lon: h.lon };
        if (anchor && km(anchor, point) > maxKm) continue;
        if (!townPoint && !nearRoute(point)) continue;
        if (townWords.length && !townWords.some((w) => tokens(h.address || '').some((a) => sameWord(w, a)))) continue;
        return { status: 'found', ...point, matched: h.name, where: olaWhere(h.address || ''), source: 'Ola Maps' };
      }
    }
  }
  return { status: answered ? 'notfound' : 'unchecked' };
}

/**
 * Where a road's path passes through each road rule's area, as fractions of the way along it.
 * The path is walked in steps of at most 1 km so sparse (simplified) geometry can't skip a zone.
 */
export function ruleHits(path: [number, number][]): { ruleId: string; enter: number; exit: number }[] {
  if (path.length < 2) return [];
  const pts: { lat: number; lon: number; at: number }[] = [];
  let total = 0;
  for (let i = 0; i < path.length; i++) {
    const cur = { lat: path[i][1], lon: path[i][0] };
    if (i === 0) {
      pts.push({ ...cur, at: 0 });
      continue;
    }
    const prev = { lat: path[i - 1][1], lon: path[i - 1][0] };
    const seg = km(prev, cur);
    const steps = Math.max(1, Math.ceil(seg));
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      pts.push({ lat: prev.lat + (cur.lat - prev.lat) * f, lon: prev.lon + (cur.lon - prev.lon) * f, at: total + seg * f });
    }
    total += seg;
  }
  if (!total) return [];
  const hits: { ruleId: string; enter: number; exit: number }[] = [];
  for (const rule of ROAD_RULES) {
    let enter = Infinity;
    let exit = -Infinity;
    for (const p of pts) {
      if (rule.zones.some((z) => km(z, p) <= z.km)) {
        enter = Math.min(enter, p.at);
        exit = Math.max(exit, p.at);
      }
    }
    if (enter !== Infinity) hits.push({ ruleId: rule.id, enter: Math.round((enter / total) * 1000) / 1000, exit: Math.round((exit / total) * 1000) / 1000 });
  }
  return hits;
}

/** A road path cut down to points at least ~1 km apart (at most 250), rounded to ~10 m. */
export function thinPath(path: [number, number][]): [number, number][] {
  const pts = path.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) return pts.map(([a, b]) => [Math.round(a * 1e4) / 1e4, Math.round(b * 1e4) / 1e4]);
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += km({ lat: pts[i - 1][1], lon: pts[i - 1][0] }, { lat: pts[i][1], lon: pts[i][0] });
  const step = Math.max(1, total / 250);
  const out: [number, number][] = [pts[0]];
  let since = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    since += km({ lat: pts[i - 1][1], lon: pts[i - 1][0] }, { lat: pts[i][1], lon: pts[i][0] });
    if (since >= step) { out.push(pts[i]); since = 0; }
  }
  out.push(pts[pts.length - 1]);
  return out.map(([a, b]) => [Math.round(a * 1e4) / 1e4, Math.round(b * 1e4) / 1e4]);
}

/** Road distance, pure driving time and road-rule areas crossed, through the given points in order. */
async function routeThrough(points: Point[]): Promise<LegCheck | null> {
  if (points.length < 2) return null;
  const coords = points.slice(0, 25).map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
  const shape = (r: any, source: LegCheck['source']): LegCheck => ({
    km: Math.round(r.distance / 1000),
    hours: Math.round((r.duration / 3600) * 10) / 10,
    source,
    hits: ruleHits(Array.isArray(r.geometry?.coordinates) ? r.geometry.coordinates : []),
    path: thinPath(Array.isArray(r.geometry?.coordinates) ? r.geometry.coordinates : []),
  });
  // Mapbox only: the public OSRM demo server allows only non-commercial use, so it is no longer a fallback.
  // Without Mapbox the drive simply stays unmeasured, and the plan's own distances are used.
  if (!MAPBOX_TOKEN) return null;
  const d = await getJson(`https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?overview=full&geometries=geojson&access_token=${MAPBOX_TOKEN}`);
  const r = d?.routes?.[0];
  return r ? shape(r, 'Mapbox') : null;
}

const arr = <T,>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);

// Plan entries that aren't one particular place ("Fuel top-up (optional)", "BPCL/HPCL pumps on NH183").
const PLACEHOLDER = /\b(optional|top-?up|any|pumps|stalls?|section|on nh\s?\d+)\b/i;

/** The stops worth sending to Google Maps as route waypoints: no vague entries or placeholders. */
export function routeStops<T extends Place>(stops: T[] | undefined, checks?: Checks | null): T[] {
  return arr(stops).filter((s) => s.name && !PLACEHOLDER.test(`${s.name} ${s.mapsQuery || ''}`) && checks?.places[placeKey(s)]?.status !== 'skipped');
}

const looksLikeFood = (s?: string) => /\bfood\b/i.test(s || '');

/** Every named place in a plan, once each, with the kind of place it should be. */
export function placesWithKind(plan: Plan): { p: Place; kind: Kind }[] {
  const rt = plan.roadTrip && typeof plan.roadTrip === 'object' ? plan.roadTrip : null;
  const all: { p: Place; kind: Kind }[] = [
    ...(plan.accommodation?.name ? [{ p: plan.accommodation, kind: 'stay' as Kind }] : []),
    ...arr(rt?.legs).flatMap((l) => arr(l.stops).map((s) => ({ p: s as Place, kind: (looksLikeFood(s.type) || FOOD_NAME.test(s.name || '') ? 'food' : 'sight') as Kind }))),
    ...arr(rt?.foodStops).map((f) => ({ p: f as Place, kind: 'food' as Kind })),
    ...arr(plan.days).flatMap((d) => [...arr(d.activities), ...arr(d.hiddenGems)].map((x) => ({ p: x as Place, kind: (FOOD_NAME.test(x.name || '') ? 'food' : 'sight') as Kind }))),
  ].filter(({ p }) => p && p.name && p.mapsQuery);
  const seen = new Set<string>();
  return all.filter(({ p }) => (seen.has(placeKey(p)) ? false : (seen.add(placeKey(p)), true)));
}

export const placesIn = (plan: Plan): Place[] => placesWithKind(plan).map(({ p }) => p);

/** How far the plan says a drive is: its distance, or failing that its driving time at about 75 km an hour. */
function planKm(leg?: { distanceKm?: number; driveTime?: string }): number {
  if (!leg) return 0;
  if (Number(leg.distanceKm) > 0) return Number(leg.distanceKm);
  const h = /(\d+(?:\.\d+)?)\s*(?:h|hr|hour)/i.exec(String(leg.driveTime || ''));
  return h ? Number(h[1]) * 75 : 0;
}

/**
 * Runs the whole check. Drives come first (town to town), so road lines, road-rule timing and the fuel
 * estimate are ready in seconds; `onPartial` gets that early result and updates as places are found.
 * Then each drive is measured again through the stops that were found. Reports progress as (done, total).
 */
export async function checkPlan(
  plan: Plan,
  from: string,
  destination: string,
  onProgress?: (done: number, total: number) => void,
  onPartial?: (checks: Checks) => void,
  placeSearch?: PlaceSearch
): Promise<Checks> {
  const places = placesWithKind(plan);
  const legs = arr(plan.roadTrip && typeof plan.roadTrip === 'object' ? plan.roadTrip.legs : []);
  const total = places.length + legs.length;
  let done = 0;
  const tick = () => onProgress?.(++done, total);
  onProgress?.(0, total);

  stats.answered = 0;
  down.clear();
  backup = placeSearch || null;
  townCache.clear();
  inCorridor = () => true;
  nearRoute = () => true;
  const fromPt = await findTown(from);
  // The plan's own road distance to the destination rules out namesakes far away: a place more
  // than that far in a straight line can't be the one meant.
  // With no distance given, the drive time stands in (at most ~75 km an hour): India has many towns of
  // the same name (there is a Manali in Chennai), so an unbounded lookup can pick one 2,000 km away.
  const destWords = distinctiveWords(townOnly(destination));
  const toDest = legs.find((l) => planKm(l) && destWords.some((w) => tokens(l.to || '').some((t) => sameWord(w, t))));
  const maxStraight = toDest ? planKm(toDest) * 1.15 + 15 : Infinity;
  const destPt = await findTown(destination, (p) => !fromPt || km(fromPt, p) <= maxStraight);
  if (fromPt && destPt) {
    const span = km(fromPt, destPt);
    inCorridor = (p) => km(fromPt, p) + km(p, destPt) <= span * 1.5 + 80;
    nearRoute = (p) => km(fromPt, p) + km(p, destPt) <= span * 1.2 + 30;
  }

  // 1. Drives, town to town.
  const ends: ([Point, Point] | null)[] = [];
  const legChecks: Record<string, LegCheck | null> = {};
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const start = leg.from ? await findTown(leg.from) : null;
    const end = leg.to ? await findTown(leg.to) : null;
    // A town matched far from where the plan says it is (a namesake elsewhere in India) gives a road far
    // longer than planned: leave that drive unmeasured rather than show the wrong road.
    const limit = planKm(leg) ? planKm(leg) * 2.5 + 40 : Infinity;
    const plausible = start && end && km(start, end) <= limit;
    ends[i] = plausible ? [start, end] : null;
    const measured = plausible ? await routeThrough([start, end]) : null;
    legChecks[String(i)] = measured && measured.km <= limit ? measured : null;
    tick();
  }
  const direct = fromPt && destPt ? await routeThrough([fromPt, destPt]) : null;

  const results: Record<string, PlaceCheck> = {};
  const snapshot = (partial: boolean): Checks => ({
    at: new Date().toISOString(),
    places: { ...results },
    legs: { ...legChecks },
    routeSource: Object.values(legChecks).find(Boolean)?.source,
    direct,
    ...(partial ? { partial: true } : {}),
  });
  if (legs.length) onPartial?.(snapshot(true));

  // 2. Places, one lookup at a time to stay within Photon's fair use; pins appear as they're found.
  const region = destPt || fromPt;
  const ignore = [townOnly(from), townOnly(destination)];
  for (let k = 0; k < places.length; k++) {
    const item = places[k];
    results[placeKey(item.p)] = await findPlace(item.p, item.kind, region, ignore);
    tick();
    if ((k + 1) % 6 === 0 && k + 1 < places.length) onPartial?.(snapshot(true));
  }
  if (stats.answered === 0 && !Object.values(legChecks).some(Boolean)) throw new Error('The map service did not answer.');

  // 3. Each drive again through the stops that were found, skipping any that would drag it far off course.
  for (let i = 0; i < legs.length; i++) {
    const pair = ends[i];
    if (!pair) continue;
    const [start, end] = pair;
    const straight = km(start, end);
    const via = arr(legs[i].stops)
      .map((st) => results[placeKey(st)])
      .filter((c): c is PlaceCheck => c?.status === 'found' && c.lat !== undefined)
      .map((c) => ({ lat: c.lat!, lon: c.lon! }))
      .filter((pt) => km(start, pt) + km(pt, end) <= straight * 1.25 + 20);
    if (!via.length) continue;
    const through = await routeThrough([start, ...via, end]);
    if (through) legChecks[String(i)] = through;
  }

  return snapshot(false);
}

/**
 * The drive to the destination compared with the direct road: the legs from the start up to the first one
 * that arrives there. Returns null when they are close, or when the map check couldn't measure them.
 */
export function detour(plan: Plan, checks: Checks | null | undefined, destination: string) {
  const direct = checks?.direct;
  if (!direct || !direct.km) return null;
  const legs = arr(plan.roadTrip && typeof plan.roadTrip === 'object' ? plan.roadTrip.legs : []);
  const destWords = distinctiveWords(townOnly(destination));
  let outbound = 0;
  for (let i = 0; i < legs.length; i++) {
    const real = checks?.legs[String(i)];
    if (!real) return null;
    outbound += real.km;
    if (destWords.some((w) => tokens(legs[i].to || '').some((t) => sameWord(w, t)))) {
      // Stops and short detours are expected; this flags a route that goes a long way round.
      return outbound > direct.km * 1.4 + 40 ? { outboundKm: outbound, directKm: direct.km, directHours: direct.hours } : null;
    }
  }
  return null;
}
