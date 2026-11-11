/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Trip map: each day's real road (from the map check) in its own colour, with
 * pins for the stay, food stops, sights and hidden gems that were found on the
 * map. Tap a pin for directions. Uses the same public Mapbox token as before;
 * it needs a connection, so offline the rest of the app carries on without it.
 */

import React, { Suspense, lazy } from 'react';
import { placeKey, placesWithKind } from './placecheck';
import { type SavedTrip, arr } from './tripkit';
import { SafeArea } from './safety';

const LiveMap = lazy(() => import('./tripmap-live'));


export const DAY_COLORS = ['#0F766E', '#B45309', '#2453FF', '#BE185D', '#7C3AED', '#C2410C', '#0E7490', '#4D7C0F'];
export const dayColor = (day: number) => DAY_COLORS[(Math.max(1, day) - 1) % DAY_COLORS.length];

export type PinKind = 'stay' | 'food' | 'sight' | 'gem';
export interface Pin { key: string; name: string; kind: PinKind; day: number | null; lat: number; lon: number; query: string; ola?: boolean }
export interface Road { day: number; path: [number, number][]; from?: string; to?: string; km: number }

export const PIN_ICON: Record<PinKind, string> = { stay: 'hotel', food: 'restaurant', sight: 'photo_camera', gem: 'star' };
export const PIN_LABEL: Record<PinKind, string> = { stay: 'Stay', food: 'Food', sight: 'Sight', gem: 'Hidden gem' };

/** Google Maps directions to a place from wherever the phone is: exact spot when the map check found it. */
export const navigateUrl = (p: { lat?: number; lon?: number; query?: string; name?: string }) =>
  'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' +
  encodeURIComponent(p.lat !== undefined && p.lon !== undefined ? `${p.lat},${p.lon}` : p.query || p.name || '');

/** The roads and pins a trip can show, from its saved map check. */
export function mapData(trip: SavedTrip): { roads: Road[]; pins: Pin[] } {
  const c = trip.checks;
  const rt = trip.plan.roadTrip && typeof trip.plan.roadTrip === 'object' ? trip.plan.roadTrip : null;
  const legs = arr(rt?.legs);
  const roads: Road[] = [];
  legs.forEach((leg, i) => {
    const real = c?.legs[String(i)];
    if (real?.path && real.path.length > 1) roads.push({ day: leg.day ?? i + 1, path: real.path, from: leg.from, to: leg.to, km: real.km });
  });

  // Which day each place belongs to.
  const dayOf = new Map<string, number>();
  const gems = new Set<string>();
  legs.forEach((leg, i) => arr(leg.stops).forEach((s) => {
    dayOf.set(placeKey(s), leg.day ?? i + 1);
    if (s.hiddenGem) gems.add(placeKey(s));
  }));
  for (const d of arr(trip.plan.days)) {
    for (const a of arr(d.activities)) if (!dayOf.has(placeKey(a))) dayOf.set(placeKey(a), d.day);
    for (const g of arr(d.hiddenGems)) {
      if (!dayOf.has(placeKey(g))) dayOf.set(placeKey(g), d.day);
      gems.add(placeKey(g));
    }
  }

  const pins: Pin[] = [];
  for (const { p, kind } of placesWithKind(trip.plan)) {
    const check = c?.places[placeKey(p)];
    if (check?.status !== 'found' || check.lat === undefined || check.lon === undefined) continue;
    const k = placeKey(p);
    pins.push({
      key: k, name: p.name || check.matched || '', lat: check.lat, lon: check.lon, query: p.mapsQuery || p.name || '',
      kind: kind === 'stay' ? 'stay' : gems.has(k) ? 'gem' : kind === 'food' ? 'food' : 'sight',
      day: kind === 'stay' ? null : dayOf.get(k) ?? null,
      ...(check.source === 'Ola Maps' ? { ola: true } : {}),
    });
  }
  return { roads, pins };
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

export type MapProps = {
  trip: SavedTrip;
  day?: 'all' | number;
  traffic?: boolean;
  compact?: boolean;
  bare?: boolean;
};

/** The trip map, with a safety net: if the map can't start, the rest of the page carries on. */
export function TripMap(props: MapProps) {
  return (
    <SafeArea name="Trip map" fallback={<MapUnavailable compact={props.compact} />}>
      <Suspense fallback={<MapLoading compact={props.compact} />}>
        <LiveMap {...props} />
      </Suspense>
    </SafeArea>
  );
}

function MapLoading({ compact }: { compact?: boolean }) {
  return (
    <div className={`card tk-card tm-card ${compact ? 'compact' : ''}`}>
      <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">map</span>{compact ? 'Map' : 'Trip Map'}</h3>
      <div className="tm-map tm-loading" aria-hidden="true" />
    </div>
  );
}

function MapUnavailable({ compact }: { compact?: boolean }) {
  return (
    <div className={`card tk-card tm-card ${compact ? 'compact' : ''}`}>
      <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">map</span>{compact ? 'Map' : 'Trip Map'}</h3>
      <p className="tk-dim tk-small">The map can't run in this browser. Your plan, stops and Navigate buttons all still work; try opening IntelliTrip in Chrome or Safari to see the map.</p>
    </div>
  );
}

/**
 * A static drawing of a day's road from the saved map check: no map library, no network, no WebGL.
 * Used on the home page, where it must always work and load fast.
 */
export function RouteSketch({ trip, day = 1, label }: { trip: SavedTrip; day?: number; label: string }) {
  const roads = mapData(trip).roads.filter((r) => r.day === day);
  const path = roads.flatMap((r) => r.path);
  const W = 600;
  const H = 230;
  if (path.length < 2) {
    return <div className="tm-sketch tm-sketch-empty" role="img" aria-label={label}><span className="material-symbols-outlined" aria-hidden="true">route</span></div>;
  }
  const lats = path.map((p) => p[1]);
  const lons = path.map((p) => p[0]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const xs = lons.map((x) => x * kx);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...lats), Math.max(...lats)];
  const pad = 46;
  const scale = Math.min((W - pad * 2) / Math.max(x1 - x0, 1e-6), (H - pad * 2) / Math.max(y1 - y0, 1e-6));
  const ox = (W - (x1 - x0) * scale) / 2;
  const oy = (H - (y1 - y0) * scale) / 2;
  const pt = ([lon, lat]: [number, number]) => [ox + (lon * kx - x0) * scale, oy + (y1 - lat) * scale];
  const d = path.map((p, i) => `${i ? 'L' : 'M'}${pt(p)[0].toFixed(1)} ${pt(p)[1].toFixed(1)}`).join(' ');
  const start = pt(path[0]);
  const end = pt(path[path.length - 1]);
  const townOf = (s?: string) => (s || '').split(/[,(]/)[0].trim();
  const from = townOf(roads[0].from);
  const to = townOf(roads[roads.length - 1].to);
  const anchor = (x: number) => (x > W * 0.65 ? 'end' : x < W * 0.35 ? 'start' : 'middle');
  return (
    <svg className="tm-sketch" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid slice">
      <rect width={W} height={H} fill="#E8EFE6" />
      <path d={`M0 ${H * 0.72} C${W * 0.2} ${H * 0.6} ${W * 0.4} ${H * 0.86} ${W * 0.62} ${H * 0.74} S${W * 0.9} ${H * 0.8} ${W} ${H * 0.7} L${W} ${H} L0 ${H}Z`} fill="#D9E6D4" />
      <path d={d} fill="none" stroke="#fff" strokeWidth="9" strokeLinecap="round" strokeLinejoin="round" />
      <path d={d} fill="none" stroke={dayColor(day)} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={start[0]} cy={start[1]} r="7" fill="#15202B" stroke="#fff" strokeWidth="2.5" />
      <circle cx={end[0]} cy={end[1]} r="8" fill={dayColor(day)} stroke="#fff" strokeWidth="2.5" />
      {from && <text x={start[0]} y={start[1] - 14} textAnchor={anchor(start[0])} className="tm-sketch-label">{from}</text>}
      {to && <text x={end[0]} y={end[1] + 26} textAnchor={anchor(end[0])} className="tm-sketch-label">{to}</text>}
    </svg>
  );
}
