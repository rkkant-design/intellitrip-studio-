/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Trip Kit inside IntelliTrip: the merged plan view (road trip, day cards with
 * hero moments and hidden gems, budget, booking deadlines, packing list) plus
 * the Toolkit tools (Travellers, Book by, Leave checklist) and the job runner
 * that waits on the AI. Everything is stored in this browser.
 */

import React, { useEffect, useMemo, useState } from 'react';

// --- TYPES ---

export interface FormState {
  fromLocation: string;
  destination: string;
  startDate: string;
  duration: number | '';
  adults: number;
  children: number;
  travelType: string;
  mode: string;
  maxDrive: string;
  budget: string;
  food: string;
  idealTripDescription: string;
}

export interface Place { name?: string; mapsQuery?: string }
export interface Stop extends Place { type?: string; at?: string; note?: string; hiddenGem?: boolean }
export interface Leg { day?: number; from?: string; to?: string; route?: string; distanceKm?: number; driveTime?: string; stops?: Stop[] }
export interface RoadTrip {
  recommendedRoute?: string;
  departAt?: string;
  routes?: { name?: string; via?: string; distanceKm?: number; driveTime?: string; road?: string; tolls?: string; bestFor?: string }[];
  legs?: Leg[];
  foodStops?: (Place & { where?: string; knownFor?: string; veg?: string; timing?: string })[];
  tips?: string[];
}
export interface Activity extends Place { time?: string; description?: string; heroMoment?: string }
export interface Gem extends Place { why?: string; tip?: string }
export interface LiveAlert { condition?: string; description?: string; alternativeSuggestion?: string }
export interface DayPlan {
  day: number;
  date?: string;
  title?: string;
  vibe?: string;
  narrative?: string;
  activities?: Activity[];
  food?: string;
  stay?: string;
  hiddenGems?: Gem[];
  liveAlerts?: LiveAlert[];
}
export interface Plan {
  title?: string;
  summary?: string;
  weather?: string;
  alerts?: string[];
  accommodation?: Place & { type?: string; reason?: string; estimatedPricePerNight?: number };
  roadTrip?: RoadTrip | null;
  gettingThere?: { mode?: string; option?: string; doorToDoor?: string; costInr?: string; note?: string }[];
  recommendation?: string;
  days?: DayPlan[];
  budget?: { item?: string; amountInr?: number; note?: string }[];
  bookBy?: { item?: string; opens?: string; deadline?: string; where?: string; note?: string }[];
  documents?: { item?: string; who?: string; note?: string }[];
  sources?: { title?: string; url?: string }[];
}
export interface PackItem { text: string; qty?: string; star?: boolean }
export interface Packing { groups: { name: string; items: PackItem[] }[] }

export interface SavedTrip {
  id: string;
  form: FormState;
  plan: Plan;
  vibeImage?: string | null;
  packing?: Packing | null;
  packed?: Record<string, boolean>;
  dateCreated: string;
}

export interface Profile {
  homeCity: string;
  vehicle: string;
  pace: string;
  food: string;
  budgetPerDay: string;
  alwaysCarry: string;
  travellers: { name: string; age: string; food: string; notes: string }[];
}

// --- STORAGE (this browser only) ---

export const STORAGE_KEY = 'intellitrip_v5_saved';
const PROFILE_KEY = 'intellitrip_profile';
export const PENDING_KEY = 'intellitrip_pending';

export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): boolean {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};

export const DEFAULT_PROFILE: Profile = {
  homeCity: 'Chennai', vehicle: '', pace: 'Balanced', food: '', budgetPerDay: '', alwaysCarry: '',
  travellers: [{ name: 'Kamal', age: '43', food: '', notes: '' }],
};
export const loadProfile = (): Profile => ({ ...DEFAULT_PROFILE, ...store.get<Partial<Profile>>(PROFILE_KEY, {}) });
export const saveProfile = (p: Profile) => store.set(PROFILE_KEY, p);

export const emptyForm = (profile: Profile): FormState => ({
  fromLocation: profile.homeCity || '', destination: '', startDate: '', duration: 3, adults: 2, children: 0,
  travelType: 'Family', mode: 'Road trip in our own car', maxDrive: '5 hours', budget: 'Mid-range', food: profile.food || '',
  idealTripDescription: '',
});

// --- HELPERS ---

export const arr = <T,>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
export const formatINR = (n: number | undefined | null): string => `₹${Math.round(Number(n ?? 0)).toLocaleString('en-IN')}`;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const todayStr = () => ymd(new Date());
export const addDays = (s: string, n: number) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
export const endDateOf = (f: FormState) => addDays(f.startDate, Math.max(1, Number(f.duration) || 1));
export const fmtDate = (s?: string) =>
  s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : s || '';
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
export { mmss };

const mapsSearch = (q: string) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
const mapsDir = (origin: string, dest: string, stops: string[]) =>
  'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + encodeURIComponent(origin) +
  '&destination=' + encodeURIComponent(dest) + (stops.length ? '&waypoints=' + encodeURIComponent(stops.join('|')) : '');

// Longest drive mentioned in a time such as "6h", "5h 15m", "5.5-7h" or "approx 9–10h", in hours; null when none.
export const driveHours = (s?: string): number | null => {
  let max: number | null = null;
  for (const m of String(s || '').matchAll(/(\d+(?:\.\d+)?)\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*h(?:ours?|rs?)?\s*(?:(\d{1,2})\s*m)?/gi)) {
    const h = Number(m[2] || m[1]) + (m[3] ? Number(m[3]) / 60 : 0);
    if (max === null || h > max) max = h;
  }
  return max === null ? null : Math.round(max * 10) / 10;
};

const PlaceName = ({ p, fallback }: { p: Place; fallback?: string }) =>
  p.mapsQuery ? (
    <a className="tk-place" href={mapsSearch(p.mapsQuery)} target="_blank" rel="noopener noreferrer" title="Open in Google Maps">
      {p.name || fallback || p.mapsQuery}
    </a>
  ) : (
    <strong>{p.name || fallback}</strong>
  );

const chipKind = (type?: string) => {
  const s = String(type || '').toLowerCase();
  return s.includes('food') ? 'food' : s.includes('sight') || s.includes('view') ? 'sight' : 'util';
};

// --- AI JOBS: start on the server, then check in until the result is ready ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT_S = 12 * 60;

export async function startJob(path: string, body: unknown, headers: Record<string, string>): Promise<string> {
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.jobId) throw new Error(data.error || 'Could not start. Please try again.');
  return data.jobId;
}

export async function waitForJob<T>(
  jobId: string,
  getHeaders: () => Promise<Record<string, string>>,
  startedAt: number,
  onTick?: (seconds: number) => void,
  isCancelled?: () => boolean
): Promise<T> {
  let misses = 0;
  for (;;) {
    await sleep(4000);
    if (isCancelled?.()) throw new Error('cancelled');
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const headers = await getHeaders();
    if (elapsed > MAX_WAIT_S) {
      fetch(`/api/job?id=${encodeURIComponent(jobId)}&cancel=1`, { method: 'POST', headers }).catch(() => undefined);
      throw new Error('This took more than 12 minutes, so it was stopped. Please try again.');
    }
    onTick?.(elapsed);
    let res: Response;
    try {
      res = await fetch(`/api/job?id=${encodeURIComponent(jobId)}`, { headers });
    } catch {
      if (++misses > 15) throw new Error('Lost the connection while waiting. Check your internet and try again.');
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error(data.error || 'Not allowed.');
      if (++misses > 15) throw new Error(data.error || 'Lost the connection while waiting. Please try again.');
      continue;
    }
    misses = 0;
    if (data.status === 'done') return data.result as T;
    if (data.status === 'error') throw new Error(data.error || 'Something went wrong. Please try again.');
  }
}

// --- CONVERTERS: older IntelliTrip archives and Trip Kit files ---

const nightsBetween = (a?: string, b?: string) =>
  a && b ? Math.max(1, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000)) : 1;

/** Archives saved before the merge used IntelliTrip's Gemini format. */
export function normaliseSaved(entry: any): SavedTrip | null {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.plan) return entry as SavedTrip;
  const r = entry.results;
  if (!r) return null;
  const c = r.costBreakdown || {};
  const plan: Plan = {
    title: r.tripTitle,
    summary: r.tripSummary,
    accommodation: r.accommodationRecommendation,
    budget: [
      { item: 'Stays', amountInr: c.totalAccommodation },
      { item: 'Food', amountInr: c.totalFood },
      { item: 'Misc', amountInr: c.totalMisc },
    ].filter((b) => b.amountInr),
    days: arr(r.dailyItinerary).map((d: any) => ({
      day: d.day, title: d.theme, vibe: d.vibe, narrative: d.narrative, activities: d.activities, liveAlerts: d.liveAlerts,
      hiddenGems: d.localSecret ? [{ name: 'Local secret', why: d.localSecret }] : [],
    })),
  };
  return {
    id: String(entry.id), plan, vibeImage: entry.vibeImage ?? null, dateCreated: entry.dateCreated || '',
    form: { ...emptyForm(DEFAULT_PROFILE), ...entry.form },
  };
}

/** A trip saved by the laptop Trip Kit app (data/trips/*.json). */
export function fromTripKit(t: any): SavedTrip {
  if (!t || typeof t !== 'object' || !t.destination || !Array.isArray(t.days)) throw new Error('Not a Trip Kit trip file.');
  const form: FormState = {
    ...emptyForm(DEFAULT_PROFILE),
    fromLocation: 'Chennai', destination: t.destination, startDate: t.start || '', duration: nightsBetween(t.start, t.end),
    mode: t.mode || 'Road trip in our own car', maxDrive: t.maxDrive || '5 hours', budget: t.budgetBand || 'Mid-range',
    food: t.food || '', idealTripDescription: t.notes || '', travelType: 'Family',
  };
  const plan: Plan = {
    title: t.title, summary: t.summary, weather: t.weather, alerts: t.alerts, roadTrip: t.roadTrip ?? null,
    gettingThere: t.gettingThere, recommendation: t.recommendation, budget: t.budget, bookBy: t.bookBy,
    documents: t.documents, sources: t.sources,
    days: arr(t.days).map((d: any) => ({
      day: d.day, date: d.date, title: d.title, food: d.food, stay: d.stay, hiddenGems: d.hiddenGems,
      activities: [['Morning', d.morning], ['Afternoon', d.afternoon], ['Evening', d.evening]]
        .filter(([, x]) => x)
        .map(([time, description]) => ({ time, description })),
      liveAlerts: d.planB ? [{ condition: 'Weather', description: "If the day doesn't go to plan", alternativeSuggestion: d.planB }] : [],
    })),
  };
  return {
    id: `tk-${t.id || Date.now()}`, form, plan, packing: t.packing ?? null, packed: t.packed ?? {},
    dateCreated: t.savedAt ? new Date(t.savedAt).toLocaleDateString() : new Date().toLocaleDateString(),
  };
}

// --- PLAN VIEW ---

function RoadTripCard({ rt, maxDrive }: { rt: RoadTrip; maxDrive?: string }) {
  const limit = parseFloat(maxDrive || '') || null;
  return (
    <div className="card tk-card">
      <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">directions_car</span>Road Trip</h3>
      {rt.recommendedRoute && <p><strong>Best route:</strong> {rt.recommendedRoute}</p>}
      {rt.departAt && <p className="tk-small"><strong>Leave at:</strong> {rt.departAt}</p>}

      {arr(rt.routes).length > 0 && (
        <>
          <h4 className="tk-sub">Route options</h4>
          <div className="tk-table-wrap">
            <table className="tk-table">
              <thead><tr><th>Route</th><th className="num">Km</th><th>Drive</th><th>Tolls</th></tr></thead>
              <tbody>
                {arr(rt.routes).map((r, i) => (
                  <tr key={i}>
                    <td>
                      <strong>{r.name}</strong>
                      {r.via && <div className="tk-dim">Via {r.via}</div>}
                      {r.road && <div className="tk-small">{r.road}</div>}
                      {r.bestFor && <div className="tk-dim">Best for {r.bestFor}</div>}
                    </td>
                    <td className="num">{r.distanceKm ?? ''}</td>
                    <td className="tk-mono">{r.driveTime}</td>
                    <td className="tk-small">{r.tolls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {arr(rt.legs).map((leg, i) => {
        const stops = arr(leg.stops);
        const hours = driveHours(leg.driveTime);
        const over = limit && hours && hours > limit;
        return (
          <div key={i} className="tk-leg">
            <div className="tk-leg-head">
              <span className="day-num">Day {leg.day ?? i + 1}</span>
              <strong>{leg.from} → {leg.to}</strong>
              <span className="tk-mono tk-dim">{[leg.distanceKm ? `${leg.distanceKm} km` : '', leg.driveTime].filter(Boolean).join(' · ')}</span>
              {over && <span className="tk-chip warn">Over your {limit}-hour limit</span>}
            </div>
            {over && <div className="tk-notice">This drive is about {hours} hours. Split it with an overnight stop on the way, or add a day to the trip.</div>}
            {leg.route && <div className="tk-dim">Route: {leg.route}</div>}
            {stops.length > 0 && (
              <ol className="tk-stops">
                {stops.map((s, j) => (
                  <li key={j} className={`tk-stop ${s.hiddenGem ? 'gem' : ''}`}>
                    <div className="tk-stop-head">
                      <span className={`tk-chip ${chipKind(s.type)}`}>{s.type || 'Stop'}</span>
                      {s.hiddenGem && <span className="tk-chip gem">Hidden gem</span>}
                      <PlaceName p={s} />
                    </div>
                    {s.at && <div className="tk-dim">{s.at}</div>}
                    {s.note && <div className="tk-small">{s.note}</div>}
                  </li>
                ))}
              </ol>
            )}
            {leg.from && leg.to && (
              <a className="btn-secondary tk-link-btn" target="_blank" rel="noopener noreferrer"
                href={mapsDir(leg.from, leg.to, stops.slice(0, 8).map((s) => s.mapsQuery || s.name || '').filter(Boolean))}>
                Open this drive in Google Maps
              </a>
            )}
          </div>
        );
      })}

      {arr(rt.foodStops).length > 0 && (
        <>
          <h4 className="tk-sub">Where to eat on the way</h4>
          {arr(rt.foodStops).map((f, i) => (
            <div key={i} className="tk-food-row">
              <div className="tk-stop-head">
                <PlaceName p={f} />
                {f.veg && <span className={`tk-chip ${/pure/i.test(f.veg) ? 'food' : 'util'}`}>{f.veg}</span>}
              </div>
              {f.knownFor && <span className="tk-small">Known for: {f.knownFor}</span>}
              <span className="tk-dim">{[f.where, f.timing].filter(Boolean).join(' · ')}</span>
            </div>
          ))}
        </>
      )}

      {arr(rt.tips).length > 0 && (
        <>
          <h4 className="tk-sub">Driving tips</h4>
          <ul className="tk-list">{arr(rt.tips).map((t, i) => <li key={i}>{t}</li>)}</ul>
        </>
      )}
      <p className="tk-dim tk-foot">Check opening hours before you set off. Places and timings change.</p>
    </div>
  );
}

function DayCard({ day }: { day: DayPlan }) {
  return (
    <div className="day-card card">
      <div className="day-head">
        <span className="day-num">Day {day.day}</span>
        <h3>{day.title}</h3>
        {day.vibe && <span className="tk-chip util">{day.vibe}</span>}
        {day.date && <span className="tk-dim tk-mono">{fmtDate(day.date)}</span>}
      </div>
      {day.narrative && <p className="day-narrative">{day.narrative}</p>}

      {arr(day.hiddenGems).map((g, i) => (
        <div key={i} className="local-secret">
          <span className="material-symbols-outlined" aria-hidden="true">vpn_key</span>
          <div>
            <span className="tk-gem-label">Hidden gem</span> <PlaceName p={g} fallback="Local secret" />
            {g.why && <div>{g.why}</div>}
            {g.tip && <div className="tk-dim">Tip: {g.tip}</div>}
          </div>
        </div>
      ))}

      <div className="activities">
        {arr(day.activities).map((act, i) => (
          <div key={i} className="activity-item">
            <span className="act-time">{act.time}</span>
            <div className="act-info">
              {act.name && <PlaceName p={act} />}
              {act.description && <p>{act.description}</p>}
              {act.heroMoment && <span className="hero-moment">✨ Hero Moment: {act.heroMoment}</span>}
            </div>
          </div>
        ))}
      </div>

      {(day.food || day.stay) && (
        <div className="tk-day-extras">
          {day.food && <div><span className="material-symbols-outlined" aria-hidden="true">restaurant</span>{day.food}</div>}
          {day.stay && <div><span className="material-symbols-outlined" aria-hidden="true">hotel</span>{day.stay}</div>}
        </div>
      )}
      {arr(day.liveAlerts).length > 0 && (
        <div className="tk-planb">
          {arr(day.liveAlerts).map((a, i) => (
            <div key={i}><strong>{a.condition || 'Heads-up'}:</strong> {a.description} <span className="tk-dim">Plan B: {a.alternativeSuggestion}</span></div>
          ))}
        </div>
      )}
    </div>
  );
}

function bookClass(deadline?: string) {
  if (!deadline || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return '';
  const t = todayStr();
  return deadline < t ? 'past' : deadline <= addDays(t, 7) ? 'soon' : '';
}

const BookRow = ({ item, deadline, sub }: { item?: string; deadline?: string; sub?: string }) => (
  <div className="tk-bookrow">
    <strong>{item}</strong>
    <span className={`tk-when ${bookClass(deadline)}`}>{fmtDate(deadline) || '—'}</span>
    {sub && <span className="tk-dim">{sub}</span>}
  </div>
);

export function PackingCard({
  trip, onChange, makeList, busy,
}: { trip: SavedTrip; onChange: (t: SavedTrip) => void; makeList: () => void; busy: string | null }) {
  const groups = arr(trip.packing?.groups);
  const done = trip.packed || {};
  const total = groups.reduce((s, g) => s + arr(g.items).length, 0);
  const count = Object.keys(done).length;
  const toggle = (key: string) => {
    const packed = { ...done };
    if (packed[key]) delete packed[key];
    else packed[key] = true;
    onChange({ ...trip, packed });
  };
  return (
    <div className="card tk-card">
      <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">luggage</span>Packing List</h3>
      {!groups.length ? (
        <>
          <p className="tk-dim">A checklist tuned to this trip's weather, length, travellers and car.</p>
          {busy ? <div className="tk-loading"><span className="spinner tk-spinner" />{busy}</div> : (
            <button className="btn-secondary" onClick={makeList}>Make packing list</button>
          )}
        </>
      ) : (
        <>
          <div className="tk-dim tk-mono">{count} of {total} packed</div>
          <div className="tk-progress"><i style={{ width: `${total ? (count / total) * 100 : 0}%` }} /></div>
          {groups.map((g, gi) => (
            <fieldset key={gi} className="tk-checks">
              <legend>{g.name}</legend>
              {arr(g.items).map((it, ii) => {
                const key = `${gi}:${ii}`;
                return (
                  <label key={key} className={`tk-check ${done[key] ? 'done' : ''}`}>
                    <input type="checkbox" checked={!!done[key]} onChange={() => toggle(key)} />
                    <span>{it.text}{it.qty && <span className="tk-dim"> {it.qty}</span>}{it.star && <span className="tk-star" title="Often forgotten"> ★</span>}</span>
                  </label>
                );
              })}
            </fieldset>
          ))}
          <button className="btn-secondary" onClick={() => onChange({ ...trip, packed: {} })}>Untick all</button>
        </>
      )}
    </div>
  );
}

export function PlanView({ trip, packingSlot }: { trip: SavedTrip; packingSlot: React.ReactNode }) {
  const p = trip.plan;
  const total = arr(p.budget).reduce((s, b) => s + (Number(b.amountInr) || 0), 0);
  const stay = p.accommodation;
  return (
    <div className="results-grid">
      <div className="itinerary-list">
        {(p.weather || arr(p.alerts).length > 0) && (
          <div className="card tk-card">
            <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">partly_cloudy_day</span>Weather & Alerts</h3>
            {p.weather && <p>{p.weather}</p>}
            {arr(p.alerts).length > 0 && <ul className="tk-list">{arr(p.alerts).map((a, i) => <li key={i}>{a}</li>)}</ul>}
          </div>
        )}
        {p.roadTrip && typeof p.roadTrip === 'object' && <RoadTripCard rt={p.roadTrip} maxDrive={trip.form.maxDrive} />}
        {arr(p.days).map((day, i) => <DayCard key={i} day={day} />)}
        {packingSlot}
      </div>

      <aside className="summary-sidebar tk-sidebar">
        {stay && stay.name && (
          <div className="card info-card">
            <h3>Stay Recommendation</h3>
            <div className="stay-info">
              <PlaceName p={stay} />
              {stay.type && <span className="tag">{stay.type}</span>}
              {stay.reason && <p>{stay.reason}</p>}
              {stay.estimatedPricePerNight ? <div className="cost-line">Est. {formatINR(stay.estimatedPricePerNight)}/night</div> : null}
            </div>
          </div>
        )}
        {arr(p.budget).length > 0 && (
          <div className="card budget-card">
            <h3>Budget Estimate</h3>
            {arr(p.budget).map((b, i) => (
              <div key={i} className="budget-item" title={b.note || ''}><span>{b.item}</span> <strong>{formatINR(b.amountInr)}</strong></div>
            ))}
            <div className="total-line"><span>Total</span> <strong>{formatINR(total)}</strong></div>
          </div>
        )}
        {arr(p.gettingThere).length > 0 && (
          <div className="card info-card">
            <h3>Getting There</h3>
            {arr(p.gettingThere).map((g, i) => (
              <div key={i} className="tk-food-row">
                <strong>{g.mode}: {g.option}</strong>
                <span className="tk-dim">{[g.doorToDoor, g.costInr].filter(Boolean).join(' · ')}</span>
                {g.note && <span className="tk-small">{g.note}</span>}
              </div>
            ))}
            {p.recommendation && <p className="tk-small"><strong>Recommended:</strong> {p.recommendation}</p>}
          </div>
        )}
        {arr(p.bookBy).length > 0 && (
          <div className="card info-card">
            <h3>Book By</h3>
            {arr(p.bookBy).map((b, i) => (
              <BookRow key={i} item={b.item} deadline={b.deadline}
                sub={[b.opens && b.opens !== 'now' ? `Opens ${fmtDate(b.opens)}` : 'Open now', b.where, b.note].filter(Boolean).join(' · ')} />
            ))}
          </div>
        )}
        {arr(p.documents).length > 0 && (
          <div className="card info-card">
            <h3>Documents</h3>
            <ul className="tk-list">
              {arr(p.documents).map((d, i) => (
                <li key={i}><strong>{d.item}</strong>{d.who ? ` — ${d.who}` : ''}{d.note && <div className="tk-dim">{d.note}</div>}</li>
              ))}
            </ul>
          </div>
        )}
        {arr(p.sources).length > 0 && (
          <div className="card info-card">
            <h3>Sources</h3>
            <ul className="tk-list tk-small">
              {arr(p.sources).map((s, i) => (
                <li key={i}><a className="tk-place" href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a></li>
              ))}
            </ul>
          </div>
        )}
        <p className="tk-dim tk-small">Costs are estimates. Check rules and timings on the official sites before booking.</p>
      </aside>
    </div>
  );
}

// --- TOOLKIT ---

export function TravellersCard({ profile, onSave }: { profile: Profile; onSave: (p: Profile) => void }) {
  const [p, setP] = useState<Profile>(profile);
  const [saved, setSaved] = useState(false);
  useEffect(() => setP(profile), [profile]);
  const set = (k: keyof Profile, v: string) => { setP({ ...p, [k]: v }); setSaved(false); };
  const setT = (i: number, k: string, v: string) => {
    const travellers = p.travellers.map((t, j) => (j === i ? { ...t, [k]: v } : t));
    setP({ ...p, travellers }); setSaved(false);
  };
  const field = (k: keyof Profile, label: string, placeholder = '') => (
    <div className="field">
      <label htmlFor={`p-${k}`}>{label}</label>
      <input id={`p-${k}`} value={String(p[k] ?? '')} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} />
    </div>
  );
  return (
    <div className="card tk-card">
      <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">group</span>Travellers</h3>
      <p className="tk-dim">Every plan and packing list uses this. It stays in this browser. Don't add ID or passport numbers.</p>
      <div className="grid-2">
        {field('homeCity', 'Home city (default start)', 'Chennai')}
        {field('vehicle', 'Your car', 'e.g. Hyundai Creta diesel, 5 seats')}
        <div className="field">
          <label htmlFor="p-pace">Pace</label>
          <select id="p-pace" value={p.pace} onChange={(e) => set('pace', e.target.value)}>
            {['Relaxed', 'Balanced', 'Packed'].map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
        {field('food', 'Family food preference', 'e.g. vegetarian')}
        {field('budgetPerDay', 'Budget per person per day', 'e.g. ₹3,000')}
        {field('alwaysCarry', 'Always carry', 'Regular medicines, puja items…')}
      </div>
      <h4 className="tk-sub">Who usually travels</h4>
      {p.travellers.map((t, i) => (
        <div key={i} className="tk-trav">
          <input aria-label="Name" placeholder="Name" value={t.name} onChange={(e) => setT(i, 'name', e.target.value)} />
          <input aria-label="Age" placeholder="Age" value={t.age} onChange={(e) => setT(i, 'age', e.target.value)} />
          <input aria-label="Food" placeholder="Veg, Jain…" value={t.food} onChange={(e) => setT(i, 'food', e.target.value)} />
          <input aria-label="Health or mobility" placeholder="Knee pain, motion sickness…" value={t.notes} onChange={(e) => setT(i, 'notes', e.target.value)} />
          <button className="btn-icon-bg" aria-label="Remove traveller" onClick={() => { setP({ ...p, travellers: p.travellers.filter((_, j) => j !== i) }); setSaved(false); }}>
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
      ))}
      <div className="tk-row">
        <button className="btn-secondary" onClick={() => setP({ ...p, travellers: [...p.travellers, { name: '', age: '', food: '', notes: '' }] })}>+ Add traveller</button>
        <button className="btn-accent" onClick={() => { onSave(p); setSaved(true); }}>Save</button>
        {saved && <span className="tk-ok">Saved.</span>}
      </div>
    </div>
  );
}

export function BookByCard() {
  const saved = store.get('intellitrip_bookby', { date: addDays(todayStr(), 45), arp: 60, peak: false });
  const [date, setDate] = useState<string>(saved.date);
  const [arp, setArp] = useState<number>(saved.arp);
  const [peak, setPeak] = useState<boolean>(saved.peak);
  useEffect(() => { store.set('intellitrip_bookby', { date, arp, peak }); }, [date, arp, peak]);
  const a = arp || 60;
  const rows = date ? [
    ['Train: general booking opens', addDays(date, -a), `IRCTC, 08:00 on the opening day · ${a}-day window`],
    ['Train: Tatkal (AC classes)', addDays(date, -1), 'Opens 10:00 the day before travel'],
    ['Train: Tatkal (sleeper / non-AC)', addDays(date, -1), 'Opens 11:00 the day before travel'],
    ['Flight: best fares usually until', addDays(date, -21), 'Domestic fares are usually best 3–6 weeks out; avoid the last 7 days'],
    ['Stay: book by', addDays(date, peak ? -60 : -30), peak ? 'Peak season or long weekend: book 2 months ahead, with free cancellation' : 'Book about a month ahead, with free cancellation'],
    ['Darshan / attraction tickets', addDays(date, -30), 'Many release on fixed dates; check the official site'],
    ['Road trip: get the car checked', addDays(date, -7), 'Service or quick check: tyres and spare, brakes, oil, coolant, wipers, AC'],
    ['Road trip: top up FASTag and check papers', addDays(date, -2), 'FASTag balance, RC, insurance and PUC valid; download offline maps'],
  ] : [];
  return (
    <div className="card tk-card">
      <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">event_available</span>Book By</h3>
      <p className="tk-dim">Pick your travel date to see when each booking opens and when to finish it. Works without AI.</p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="bb-date">Journey date</label>
          <input id="bb-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="bb-arp">IRCTC advance booking window (days)</label>
          <input id="bb-arp" type="number" min={1} max={180} value={arp} onChange={(e) => setArp(Number(e.target.value))} />
        </div>
      </div>
      <label className="tk-check"><input type="checkbox" checked={peak} onChange={(e) => setPeak(e.target.checked)} /><span>Peak season, festival or long weekend</span></label>
      <div>{rows.map(([item, d, sub]) => <BookRow key={item} item={item} deadline={d} sub={sub} />)}</div>
      <p className="tk-notice">Railway and airline rules change. Confirm the current window on irctc.co.in before relying on these dates.</p>
    </div>
  );
}

const LEAVE = [
  { name: 'Kitchen & utilities', items: ['Gas cylinder regulator off', 'Stove and oven off', 'Main water valve closed', 'Geyser switched off', 'Fridge cleared of things that will spoil', 'Dustbins emptied'] },
  { name: 'Power', items: ['TV, Wi-Fi router and chargers unplugged', 'AC and fans off', 'Iron and other heating appliances unplugged', 'Inverter left on (for the fridge) or switched off'] },
  { name: 'Security', items: ['Windows and balcony doors locked', 'Valuables and cash locked away', 'Spare key with a trusted neighbour or family member', 'Outside light on a timer, or a neighbour checking in'] },
  { name: 'Deliveries & people', items: ['Newspaper and milk paused', 'Help / cook / driver informed of dates', 'Plants watered, or someone asked', 'Pet care arranged'] },
  { name: 'Car (road trips)', items: ['Fuel tank full (or EV charged to 100%)', 'Tyre pressure checked, spare tyre and jack in the boot', 'FASTag balance topped up', 'RC, insurance, PUC and licence in the car (or on DigiLocker)', 'Phone mount and car charger', 'Water bottles, tissues and a waste bag in the car', 'Torch and basic tool kit'] },
  { name: 'Phone & money', items: ['Tickets and hotel bookings saved offline', 'Offline maps downloaded', 'Power bank charged', 'Card enabled for international use (if going abroad)', 'Some cash in small notes'] },
  { name: 'Getting out', items: ['Cab booked with 30-minute buffer (if not driving)', 'IDs for every traveller in hand', 'Medicines packed', 'Final walk-through done'] },
];

export function LeaveCard() {
  const [done, setDone] = useState<Record<string, boolean>>(() => store.get('intellitrip_leave', {}));
  useEffect(() => { store.set('intellitrip_leave', done); }, [done]);
  const total = useMemo(() => LEAVE.reduce((s, g) => s + g.items.length, 0), []);
  const count = Object.keys(done).length;
  return (
    <div className="card tk-card">
      <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">home</span>Leave-Home Checklist</h3>
      <p className="tk-dim">Run it the evening before. Ticks stay in this browser.</p>
      <div className="tk-dim tk-mono">{count} of {total} done</div>
      <div className="tk-progress"><i style={{ width: `${(count / total) * 100}%` }} /></div>
      {LEAVE.map((g, gi) => (
        <fieldset key={gi} className="tk-checks">
          <legend>{g.name}</legend>
          {g.items.map((text, ii) => {
            const key = `${gi}:${ii}`;
            return (
              <label key={key} className={`tk-check ${done[key] ? 'done' : ''}`}>
                <input type="checkbox" checked={!!done[key]} onChange={() => {
                  const next = { ...done };
                  if (next[key]) delete next[key]; else next[key] = true;
                  setDone(next);
                }} />
                <span>{text}</span>
              </label>
            );
          })}
        </fieldset>
      ))}
      <button className="btn-secondary" onClick={() => setDone({})}>Start fresh</button>
    </div>
  );
}
