/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * POST /api/alerts { points: [[lat, lon], ...] }: the official disaster alerts in
 * force along a route. Alerts come from NDMA's SACHET feed (the national
 * Common Alerting Protocol system that IMD and state disaster authorities post
 * to). Each alert's area is a polygon, so the route's points are tested against
 * it; only alerts that touch the route and haven't expired come back.
 *
 * The feed lists alert ids; each alert's details and polygon are separate files,
 * so they're fetched once and kept for the life of this server instance.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { guard, json, parseBody } from '../shared/guard';

const BASE = 'https://sachet.ndma.gov.in/cap_public_website';
const FEED = `${BASE}/rss/rss_india.xml`;
const FEED_TTL_MS = 10 * 60_000;
const DEADLINE_MS = 6500; // Netlify functions must answer within 10 s; every fetch stops by then
const MAX_POINTS = 150;

interface Alert {
  id: string;
  headline: string;
  event: string;
  severity: string;
  urgency: string;
  effective: string;
  expires: string;
  area: string;
  sender: string;
  link: string;
  bbox: [number, number, number, number]; // min lat, min lon, max lat, max lon
  rings: [number, number][][];
}

type Cache = { feedAt: number; ids: string[]; alerts: Map<string, Alert | null> };
const cache: Cache = ((globalThis as any).__itAlerts ??= { feedAt: 0, ids: [], alerts: new Map() });

const get = async (url: string, deadline: number) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(300, Math.min(5000, deadline - Date.now()))) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<cap:${name}>([\\s\\S]*?)</cap:${name}>`).exec(xml);
  return m ? decode(m[1]) : '';
};

/** One alert's English details (or the first language given) and its area polygon, or null when expired or unreadable. */
async function loadAlert(id: string, deadline: number): Promise<Alert | null> {
  const xml = await get(`${BASE}/FetchXMLFile?identifier=${encodeURIComponent(id)}`, deadline);
  const infos = xml.split('<cap:info>').slice(1);
  const info = infos.find((i) => /<cap:language>en/i.test(i)) || infos[0];
  if (!info) return null;
  const expires = tag(info, 'expires');
  if (expires && Date.parse(expires) < Date.now()) return null;
  const poly = await get(`${BASE}/FetchPolygonXMLFile?identifier=${encodeURIComponent(id)}`, deadline);
  const rings: [number, number][][] = [];
  for (const m of poly.matchAll(/<polygon>([\s\S]*?)<\/polygon>/g)) {
    const pts = m[1].trim().split(/\s+/).map((p) => p.split(',').map(Number) as [number, number]).filter((p) => p.length === 2 && p.every(Number.isFinite));
    // Keep at most ~400 points per ring: plenty for testing a route against a district-sized area.
    const step = Math.max(1, Math.ceil(pts.length / 400));
    const ring = pts.filter((_, i) => i % step === 0);
    if (ring.length >= 3) rings.push(ring);
  }
  if (!rings.length) return null;
  const all = rings.flat();
  return {
    id,
    headline: tag(info, 'headline'),
    event: tag(info, 'event'),
    severity: tag(info, 'severity'),
    urgency: tag(info, 'urgency'),
    effective: tag(info, 'effective'),
    expires,
    area: tag(info, 'areaDesc'),
    sender: tag(xml, 'sender'),
    link: `${BASE}/FetchXMLFile?identifier=${encodeURIComponent(id)}`,
    bbox: [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))],
    rings,
  };
}

/** Ray casting: whether a point lies inside a ring of [lat, lon] pairs. */
function inside([lat, lon]: [number, number], ring: [number, number][]) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ai, bi] = ring[i];
    const [aj, bj] = ring[j];
    if (bi > lon !== bj > lon && lat < ((aj - ai) * (lon - bi)) / (bj - bi) + ai) hit = !hit;
  }
  return hit;
}

/** Brings the list of current alerts up to date, within the time left. Returns false if it ran out of time. */
async function refresh(deadline: number): Promise<boolean> {
  if (Date.now() - cache.feedAt > FEED_TTL_MS) {
    const rss = await get(FEED, deadline);
    cache.ids = [...rss.matchAll(/<guid[^>]*>([^<]+)<\/guid>/g)].map((m) => m[1].trim()).slice(0, 200);
    cache.feedAt = Date.now();
    for (const id of [...cache.alerts.keys()]) if (!cache.ids.includes(id)) cache.alerts.delete(id);
  }
  const todo = cache.ids.filter((id) => !cache.alerts.has(id));
  let next = 0;
  const worker = async () => {
    while (next < todo.length && Date.now() < deadline) {
      const id = todo[next++];
      try {
        cache.alerts.set(id, await loadAlert(id, deadline));
      } catch {
        /* skipped this time; tried again on the next call */
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return todo.every((id) => cache.alerts.has(id));
}

const SEVERITY = ['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'];

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const blocked = await guard(event, 'poll', 30);
  if (blocked) return blocked;
  const body = parseBody<{ points?: unknown }>(event);
  const points = (Array.isArray(body?.points) ? body!.points : [])
    .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x)))
    .slice(0, MAX_POINTS);
  if (!points.length) return json(400, { error: 'No route points.' });

  let complete = true;
  try {
    complete = await refresh(Date.now() + DEADLINE_MS);
  } catch (err) {
    console.error('Alert feed unavailable:', err);
    if (!cache.ids.length) return json(502, { error: 'The official alert service did not answer. Try again later.' });
    complete = false;
  }

  const now = Date.now();
  const found: Omit<Alert, 'rings' | 'bbox'>[] = [];
  for (const a of cache.alerts.values()) {
    if (!a || (a.expires && Date.parse(a.expires) < now)) continue;
    const [la0, lo0, la1, lo1] = a.bbox;
    const touches = points.some((p) => p[0] >= la0 - 0.02 && p[0] <= la1 + 0.02 && p[1] >= lo0 - 0.02 && p[1] <= lo1 + 0.02 && a.rings.some((r) => inside(p, r)));
    if (touches) {
      const { rings: _r, bbox: _b, ...rest } = a;
      found.push(rest);
    }
  }
  found.sort((x, y) => SEVERITY.indexOf(x.severity) - SEVERITY.indexOf(y.severity) || String(x.expires).localeCompare(String(y.expires)));
  return json(200, { alerts: found.slice(0, 20), checkedAt: new Date().toISOString(), complete, source: 'NDMA SACHET' });
};

export { handler };
