/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The interactive trip map (Mapbox GL). Loaded on demand by tripmap.tsx, so the
 * map library is only downloaded where a map is shown.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import { type MapProps, type PinKind, PIN_ICON, PIN_LABEL, dayColor, esc, mapData, navigateUrl } from './tripmap';
import { webglOk } from './safety';

const MAPBOX_TOKEN = (import.meta as any).env?.VITE_MAPBOX_TOKEN as string | undefined;

export default function TripMapLive({ trip, day = 'all', traffic = false, compact = false, bare = false }: MapProps) {
  const { roads, pins } = useMemo(() => mapData(trip), [trip.checks, trip.plan]);
  const [shown, setShown] = useState<'all' | number>(day);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const [withTraffic, setWithTraffic] = useState(traffic);
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markers = useRef<mapboxgl.Marker[]>([]);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(() => !webglOk());

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
    if (failed || !MAPBOX_TOKEN || !online || !hasContent || !box.current || map.current) return;
    mapboxgl.accessToken = MAPBOX_TOKEN;
    let m: mapboxgl.Map;
    try {
      m = new mapboxgl.Map({
        container: box.current,
        style: 'mapbox://styles/mapbox/outdoors-v12',
        center: [78.5, 11],
        zoom: 6,
        attributionControl: true,
        cooperativeGestures: compact || bare,
      });
    } catch (e) {
      console.warn('The map could not start:', e);
      setFailed(true);
      return;
    }
    if (!bare) {
      m.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
      m.addControl(new mapboxgl.GeolocateControl({ trackUserLocation: true, showUserHeading: true }), 'top-right');
    }
    m.on('load', () => {
      m.addSource('roads', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'roads-casing', type: 'line', source: 'roads', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.95 } });
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
  }, [online, hasContent, compact, bare, failed]);

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
      el.style.setProperty('--pin', p.day ? dayColor(p.day) : '#15202B');
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

  if (bare) {
    return hasContent && MAPBOX_TOKEN && online && !failed
      ? <div ref={box} className="tm-map tm-bare" role="region" aria-label="Map of the sample trip's first day" />
      : <div className="tm-bare tm-bare-empty" aria-hidden="true"><span className="material-symbols-outlined">map</span></div>;
  }

  return (
    <div className={`card tk-card tm-card ${compact ? 'compact' : ''}`}>
      <div className="tm-head">
        <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">map</span>{compact ? 'Map' : 'Trip Map'}</h3>
        {hasContent && MAPBOX_TOKEN && online && !failed && (
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
      ) : failed ? (
        <p className="tk-dim tk-small">The map can't run in this browser. Your plan, stops and Navigate buttons all still work; try opening IntelliTrip in Chrome or Safari to see the map.</p>
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

