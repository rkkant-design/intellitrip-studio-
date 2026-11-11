/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Trip map: each day's real road (from the map check) in its own colour, with
 * pins for the stay, food stops, sights and hidden gems that were found on the
 * map. Tap a pin for directions. Uses the same public Mapbox token as before;
 * it needs a connection, so offline the rest of the app carries on without it.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { placeKey, placesWithKind } from './placecheck';
import { type SavedTrip, arr } from './tripkit';

const MAPBOX_TOKEN = (import.meta as any).env?.VITE_MAPBOX_TOKEN as string | undefined;

export const DAY_COLORS = ['#58a6ff', '#f2cc60', '#3fb950', '#f778ba', '#a371f7', '#ff9f43', '#39c5cf', '#ff6b6b'];
export const dayColor = (day: number) => DAY_COLORS[(Math.max(1, day) - 1) % DAY_COLORS.length];

export type PinKind = 'stay' | 'food' | 'sight' | 'gem';
export interface Pin { key: string; name: string; kind: PinKind; day: number | null; lat: number; lon: number; query: string }
export interface Road { day: number; path: [number, number][]; from?: string; to?: string; km: number }

const PIN_ICON: Record<PinKind, string> = { stay: 'hotel', food: 'restaurant', sight: 'photo_camera', gem: 'star' };
const PIN_LABEL: Record<PinKind, string> = { stay: 'Stay', food: 'Food', sight: 'Sight', gem: 'Hidden gem' };

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
    });
  }
  return { roads, pins };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

export function TripMap({ trip, day = 'all', traffic = false, compact = false }: {
  trip: SavedTrip;
  day?: 'all' | number;
  traffic?: boolean;
  compact?: boolean;
}) {
  const { roads, pins } = useMemo(() => mapData(trip), [trip.checks, trip.plan]);
  const [shown, setShown] = useState<'all' | number>(day);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const [withTraffic, setWithTraffic] = useState(traffic);
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markers = useRef<mapboxgl.Marker[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => setShown(day), [day]);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const days = useMemo(() => [...new Set([...roads.map((r) => r.day), ...pins.flatMap((p) => (p.day ? [p.day] : []))])].sort((a, b) => a - b), [roads, pins]);
  const hasContent = roads.length > 0 || pins.length > 0;

  // Create the map once there's something to draw.
  useEffect(() => {
    if (!MAPBOX_TOKEN || !online || !hasContent || !box.current || map.current) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    const m = new mapboxgl.Map({
      container: box.current,
      style: 'mapbox://styles/mapbox/dark-v11',
      center: [78.5, 11],
      zoom: 6,
      attributionControl: true,
      cooperativeGestures: compact,
    });
    m.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new mapboxgl.GeolocateControl({ trackUserLocation: true, showUserHeading: true }), 'top-right');
    m.on('load', () => {
      m.addSource('roads', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'roads-casing', type: 'line', source: 'roads', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#0a0c10', 'line-width': 7, 'line-opacity': 0.8 } });
      m.addLayer({ id: 'roads', type: 'line', source: 'roads', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4 } });
      setReady(true);
    });
    map.current = m;
    return () => {
      markers.current.forEach((mk) => mk.remove());
      markers.current = [];
      m.remove();
      map.current = null;
      setReady(false);
    };
  }, [online, hasContent, compact]);

  // Live traffic on the roads, when asked for.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    if (withTraffic && !m.getSource('traffic')) {
      m.addSource('traffic', { type: 'vector', url: 'mapbox://mapbox.mapbox-traffic-v1' });
      m.addLayer({
        id: 'traffic', type: 'line', source: 'traffic', 'source-layer': 'traffic',
        paint: {
          'line-width': 2,
          'line-color': ['match', ['get', 'congestion'], 'low', '#3fb950', 'moderate', '#f2cc60', 'heavy', '#f85149', 'severe', '#b62324', '#8b949e'],
        },
      }, 'roads-casing');
    } else if (!withTraffic && m.getSource('traffic')) {
      m.removeLayer('traffic');
      m.removeSource('traffic');
    }
  }, [withTraffic, ready]);

  // Draw the chosen day (or all days) and fit the view to it.
  useEffect(() => {
    const m = map.current;
    if (!m || !ready) return;
    const roadsNow = roads.filter((r) => shown === 'all' || r.day === shown);
    const pinsNow = pins.filter((p) => shown === 'all' || p.day === shown || p.kind === 'stay');
    (m.getSource('roads') as mapboxgl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: roadsNow.map((r) => ({ type: 'Feature', properties: { color: dayColor(r.day) }, geometry: { type: 'LineString', coordinates: r.path } })),
    });
    markers.current.forEach((mk) => mk.remove());
    markers.current = pinsNow.map((p) => {
      const el = document.createElement('div');
      el.className = `tm-pin ${p.kind}`;
      el.style.setProperty('--pin', p.day ? dayColor(p.day) : '#a371f7');
      el.innerHTML = `<span class="material-symbols-outlined" aria-hidden="true">${PIN_ICON[p.kind]}</span>`;
      el.setAttribute('aria-label', `${PIN_LABEL[p.kind]}: ${p.name}`);
      const popup = new mapboxgl.Popup({ offset: 16, closeButton: false, className: 'tm-popup' }).setHTML(
        `<strong>${esc(p.name)}</strong><span>${PIN_LABEL[p.kind]}${p.day ? ` · Day ${p.day}` : ''}</span>` +
        `<a href="${esc(navigateUrl(p))}" target="_blank" rel="noopener noreferrer">Navigate</a>`
      );
      return new mapboxgl.Marker({ element: el }).setLngLat([p.lon, p.lat]).setPopup(popup).addTo(m);
    });
    const pts: [number, number][] = [...roadsNow.flatMap((r) => r.path), ...pinsNow.map((p) => [p.lon, p.lat] as [number, number])];
    if (pts.length) {
      const b = new mapboxgl.LngLatBounds(pts[0], pts[0]);
      for (const pt of pts) b.extend(pt);
      m.fitBounds(b, { padding: compact ? 30 : 50, maxZoom: 13, duration: 600 });
    }
  }, [ready, shown, roads, pins, compact]);

  const roadKm = roads.filter((r) => shown === 'all' || r.day === shown).reduce((s, r) => s + r.km, 0);

  return (
    <div className={`card tk-card tm-card ${compact ? 'compact' : ''}`}>
      <div className="tm-head">
        <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">map</span>{compact ? 'Map' : 'Trip Map'}</h3>
        {hasContent && MAPBOX_TOKEN && online && (
          <label className="tk-check tm-traffic"><input type="checkbox" checked={withTraffic} onChange={(e) => setWithTraffic(e.target.checked)} /><span>Live traffic</span></label>
        )}
      </div>
      {!compact && days.length > 1 && (
        <div className="tk-chips" role="radiogroup" aria-label="Day to show">
          <button type="button" role="radio" aria-checked={shown === 'all'} className={`tk-chip-btn ${shown === 'all' ? 'on' : ''}`} onClick={() => setShown('all')}>All days</button>
          {days.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={shown === d} className={`tk-chip-btn ${shown === d ? 'on' : ''}`} onClick={() => setShown(d)}>
              <i className="tm-swatch" style={{ background: dayColor(d) }} />Day {d}
            </button>
          ))}
        </div>
      )}
      {!hasContent ? (
        <p className="tk-dim tk-small">{trip.checks ? 'No places or roads from this plan could be placed on the map.' : 'The map fills in once the map check has run.'}</p>
      ) : !MAPBOX_TOKEN ? (
        <p className="tk-dim tk-small">The map isn't set up here (no Mapbox token).</p>
      ) : !online ? (
        <p className="tk-dim tk-small">You're offline, so the map can't load. Your plan, timeline and wallet still work; Navigate buttons open Google Maps when you have signal.</p>
      ) : (
        <>
          <div ref={box} className="tm-map" />
          <div className="tm-legend tk-small tk-dim" aria-hidden="true">
            {(['stay', 'food', 'sight', 'gem'] as PinKind[]).filter((k) => pins.some((p) => p.kind === k)).map((k) => (
              <span key={k}><span className="material-symbols-outlined">{PIN_ICON[k]}</span>{PIN_LABEL[k]}</span>
            ))}
            {roadKm > 0 && <span className="tk-mono">{roadKm.toLocaleString('en-IN')} km of road</span>}
          </div>
        </>
      )}
    </div>
  );
}
