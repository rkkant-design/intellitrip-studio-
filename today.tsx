/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Today mode: the one screen to keep open on the road. Today's drive and plan
 * as a timeline, a big "Navigate to next stop" button, road-rule warnings for
 * today, quick expense entry and today's map. Everything except the map and
 * live weather works offline, because the trip is saved on the phone.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { placeKey, routeStops } from './placecheck';
import { LEVEL_LABEL, assess, firstTime, fmt, legStart } from './roadcheck';
import { TripMap, dayColor, navigateUrl } from './tripmap';
import { type Leg, type SavedTrip, addDays, arr, formatINR, todayStr } from './tripkit';
import { CATEGORIES, tripDays, withExpense } from './wallet';

export interface TodayItem {
  key: string;
  name: string;
  kind: 'leave' | 'stop' | 'arrive' | 'activity';
  time: number | null; // minutes after midnight, when the plan says
  sort: number;
  note?: string;
  lat?: number;
  lon?: number;
  query?: string;
}

/** The trip day for a date, or null when the date is outside the trip. */
export function dayOnDate(trip: SavedTrip, date = todayStr()): number | null {
  const start = trip.form.startDate;
  if (!start) return null;
  for (let d = 1; d <= tripDays(trip); d++) if (addDays(start, d - 1) === date) return d;
  return null;
}

/** The trip happening today, if any (the earliest-starting one when two overlap). */
export function tripToday(trips: SavedTrip[]): SavedTrip | null {
  return [...trips].filter((t) => dayOnDate(t) !== null).sort((a, b) => a.form.startDate.localeCompare(b.form.startDate))[0] || null;
}

const legsOn = (trip: SavedTrip, day: number): { leg: Leg; index: number }[] => {
  const rt = trip.plan.roadTrip && typeof trip.plan.roadTrip === 'object' ? trip.plan.roadTrip : null;
  return arr(rt?.legs).map((leg, index) => ({ leg, index })).filter(({ leg, index }) => (leg.day ?? index + 1) === day);
};

/** Today's drive and plan in order: timed things by time, untimed ones after what comes before them. */
export function itemsFor(trip: SavedTrip, day: number): TodayItem[] {
  const checks = trip.checks;
  const at = (q?: string, name?: string) => {
    const c = checks?.places[placeKey({ name, mapsQuery: q })];
    return c?.status === 'found' ? { lat: c.lat, lon: c.lon } : {};
  };
  const lists: TodayItem[][] = [];

  for (const { leg, index } of legsOn(trip, day)) {
    const { min } = legStart(trip, leg, index);
    const list: TodayItem[] = [];
    list.push({ key: `leg${index}-leave`, name: `Leave ${leg.from || 'for the drive'}`, kind: 'leave', time: min, sort: min, note: [leg.route, leg.driveTime].filter(Boolean).join(' · ') });
    let last = min;
    for (const s of routeStops(leg.stops, checks)) {
      const t = firstTime(s.at);
      last = t !== null && t >= last ? t : last + 1;
      list.push({ key: `stop-${placeKey(s)}`, name: s.name || '', kind: 'stop', time: t, sort: last, note: [s.type, s.note].filter(Boolean).join(' · '), query: s.mapsQuery || s.name, ...at(s.mapsQuery, s.name) });
    }
    if (leg.to) {
      last += 1;
      const real = checks?.legs[String(index)];
      list.push({ key: `leg${index}-arrive`, name: `Reach ${leg.to}`, kind: 'arrive', time: null, sort: real ? Math.max(last, min + real.hours * 60) : last, query: leg.to });
    }
    lists.push(list);
  }

  const d = arr(trip.plan.days).find((x) => x.day === day);
  const seen = new Set(lists.flat().map((i) => i.key));
  let last = -1;
  const acts: TodayItem[] = [];
  arr(d?.activities).forEach((a, i) => {
    const key = a.mapsQuery ? `stop-${placeKey(a)}` : `act${i}`;
    if (seen.has(key)) return;
    const t = firstTime(a.time);
    last = t !== null ? t : last + 1;
    acts.push({
      key, name: a.name || a.description || `Activity ${i + 1}`, kind: 'activity', time: t, sort: last,
      note: a.name ? a.description : undefined, query: a.mapsQuery, ...(a.mapsQuery ? at(a.mapsQuery, a.name) : {}),
    });
  });
  lists.push(acts);
  return lists.flat().sort((a, b) => a.sort - b.sort);
}

const ICON: Record<TodayItem['kind'], string> = { leave: 'directions_car', stop: 'pin_drop', arrive: 'flag', activity: 'event' };
const QUICK = CATEGORIES.filter((c) => ['Fuel', 'Tolls', 'Food', 'Tickets', 'Stay', 'Other'].includes(c));

export function TodayView({ trip, onChange, by, weatherSlot, onOpenPlan }: {
  trip: SavedTrip;
  onChange: (t: SavedTrip) => void;
  by?: string;
  weatherSlot?: (place: string) => React.ReactNode;
  onOpenPlan: () => void;
}) {
  const total = tripDays(trip);
  const liveDay = dayOnDate(trip);
  const [day, setDay] = useState(() => liveDay ?? 1);
  useEffect(() => setDay(dayOnDate(trip) ?? 1), [trip.id]);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const items = useMemo(() => itemsFor(trip, day), [trip.plan, trip.checks, day]);
  const done = trip.today || {};
  const isDone = (i: TodayItem) => Boolean(done[`${day}|${i.key}`]);
  const toggle = (i: TodayItem) => {
    const next = { ...done };
    const k = `${day}|${i.key}`;
    if (next[k]) delete next[k];
    else next[k] = true;
    onChange({ ...trip, today: next });
  };

  // Next: after the last thing ticked off; with nothing ticked yet today, the first thing still
  // ahead on the clock (an hour's grace). Either way, it can be ticked or skipped by hand.
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const open = items.filter((i) => !isDone(i));
  const lastDone = items.reduce((at, i, k) => (isDone(i) ? k : at), -1);
  const next = lastDone >= 0
    ? items.slice(lastDone + 1).find((i) => !isDone(i)) || null
    : (day === liveDay ? open.find((i) => i.sort >= nowMin - 60) : null) || open[0] || null;
  const nextNav = next && next.kind === 'leave'
    ? items.slice(items.indexOf(next) + 1).find((i) => !isDone(i) && i.kind !== 'leave') || null
    : next;
  const skipped = nextNav ? 0 : open.length;

  const legs = legsOn(trip, day);
  const findings = assess(trip).filter((f) => f.day === day && f.level !== 'ok');
  const plan = arr(trip.plan.days).find((x) => x.day === day);
  const date = trip.form.startDate ? addDays(trip.form.startDate, day - 1) : '';
  const place = legs.length ? legs[legs.length - 1].leg.to || trip.form.destination : trip.form.destination;

  // The rest of today's drive in one Google Maps route.
  const driveUrl = (() => {
    if (!legs.length) return null;
    const { leg } = legs[legs.length - 1];
    const stops = items.filter((i) => i.kind === 'stop' && !isDone(i)).map((i) => (i.lat !== undefined ? `${i.lat},${i.lon}` : i.query || i.name));
    if (!leg.to) return null;
    return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(leg.to) +
      (stops.length ? '&waypoints=' + encodeURIComponent(stops.slice(0, 9).join('|')) : '');
  })();

  // Quick expense.
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Food');
  const [added, setAdded] = useState<string | null>(null);
  const spentToday = arr(trip.wallet?.expenses).filter((e) => e.day === day).reduce((s, e) => s + e.amount, 0);
  const addSpend = () => {
    const value = Math.round(parseFloat(amount.replace(/[^\d.]/g, '')) || 0);
    if (!value) return;
    onChange(withExpense(trip, { amount: value, category, day, by }));
    setAmount('');
    setAdded(`${formatINR(value)} for ${category.toLowerCase()} added to day ${day}.`);
    setTimeout(() => setAdded(null), 2500);
  };

  return (
    <div className="today animate-fade-in">
      <div className="today-head">
        <button className="btn-icon-bg" aria-label="Previous day" disabled={day <= 1} onClick={() => setDay(day - 1)}>
          <span className="material-symbols-outlined" aria-hidden="true">chevron_left</span>
        </button>
        <div className="today-title">
          <span className="day-num" style={{ background: dayColor(day) }}>Day {day} of {total}</span>
          <h2>{plan?.title || trip.plan.title || trip.form.destination}</h2>
          <p className="tk-dim tk-small">
            {date ? new Date(date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' }) : ''}
            {day === liveDay ? ' · today' : liveDay === null ? ' · preview' : ''} · {trip.plan.title || trip.form.destination}
          </p>
        </div>
        <button className="btn-icon-bg" aria-label="Next day" disabled={day >= total} onClick={() => setDay(day + 1)}>
          <span className="material-symbols-outlined" aria-hidden="true">chevron_right</span>
        </button>
      </div>

      {findings.map((f, i) => (
        <div key={i} className={`tk-rule ${f.level} today-rule`}>
          <div className="tk-stop-head">
            <span className={`tk-chip rule-${f.level}`}>{LEVEL_LABEL[f.level]}</span>
            <strong>{f.rule.name}</strong>
          </div>
          {f.leaveBy ? <div><strong>Leave by {f.leaveBy}</strong> to clear it before it shuts.</div> : <div className="tk-small">{f.detail}</div>}
          {f.rule.link && <a className="tk-gcal" href={f.rule.link.url} target="_blank" rel="noopener noreferrer">{f.rule.link.label}</a>}
        </div>
      ))}

      <div className="card today-next">
        {nextNav ? (
          <>
            <span className="tk-dim tk-small">{next && next.kind === 'leave' ? `First: ${next.name}${next.time !== null ? ` at ${fmt(next.time)}` : ''}. Then` : 'Next stop'}</span>
            <strong className="today-next-name">{nextNav.name}</strong>
            {nextNav.note && <span className="tk-small tk-dim">{nextNav.note}</span>}
            <div className="tk-row">
              <a className="btn-accent today-go" href={navigateUrl(nextNav)} target="_blank" rel="noopener noreferrer">
                <span className="material-symbols-outlined" aria-hidden="true">navigation</span>Navigate
              </a>
              <button className="btn-secondary" onClick={() => toggle(nextNav)}>
                <span className="material-symbols-outlined" aria-hidden="true">check</span>Done
              </button>
            </div>
            {driveUrl && <a className="tk-place tk-small" href={driveUrl} target="_blank" rel="noopener noreferrer">Open the rest of today's drive in Google Maps</a>}
          </>
        ) : items.length ? (
          <>
            <strong className="today-next-name">All done for day {day}</strong>
            <span className="tk-dim tk-small">
              {skipped ? `${skipped} earlier ${skipped === 1 ? 'stop wasn\'t' : 'stops weren\'t'} ticked; their Navigate buttons are below if you still want to go. ` : 'Rest well. '}
              {day < total ? 'Tomorrow\'s plan is one tap away.' : 'That\'s the trip!'}
            </span>
          </>
        ) : (
          <><strong className="today-next-name">A free day</strong><span className="tk-dim tk-small">The plan has nothing timed for day {day}. {plan?.narrative || ''}</span></>
        )}
      </div>

      <div className="today-grid">
        <div className="card tk-card today-timeline">
          <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">schedule</span>Day plan</h3>
          {items.length === 0 && <p className="tk-dim tk-small">Nothing listed for this day.</p>}
          <ol className="today-list">
            {items.map((i) => (
              <li key={i.key} className={`today-item ${isDone(i) ? 'done' : ''} ${nextNav && i.key === nextNav.key ? 'next' : ''}`}>
                <button className="today-tick" role="checkbox" aria-checked={isDone(i)} aria-label={`${i.name}: ${isDone(i) ? 'done' : 'not done'}`} onClick={() => toggle(i)}>
                  <span className="material-symbols-outlined" aria-hidden="true">{isDone(i) ? 'check_circle' : ICON[i.kind]}</span>
                </button>
                <div className="today-item-text">
                  <span className="tk-mono tk-small today-time">{i.time !== null ? fmt(i.time) : ''}</span>
                  <strong>{i.name}</strong>
                  {i.note && <span className="tk-small tk-dim">{i.note}</span>}
                </div>
                {i.kind !== 'leave' && (i.query || i.lat !== undefined) && (
                  <a className="btn-icon-bg" href={navigateUrl(i)} target="_blank" rel="noopener noreferrer" aria-label={`Navigate to ${i.name}`}>
                    <span className="material-symbols-outlined" aria-hidden="true">navigation</span>
                  </a>
                )}
              </li>
            ))}
          </ol>
          {(plan?.food || plan?.stay) && (
            <div className="tk-small today-extra">
              {plan?.food && <div><strong>Food:</strong> {plan.food}</div>}
              {plan?.stay && <div><strong>Stay:</strong> {plan.stay}</div>}
            </div>
          )}
          {arr(plan?.hiddenGems).length > 0 && (
            <>
              <h4 className="tk-sub">Hidden gems today</h4>
              {arr(plan?.hiddenGems).map((g, k) => (
                <div key={k} className="today-gem">
                  <span className="material-symbols-outlined" aria-hidden="true">star</span>
                  <div className="tk-grow"><strong>{g.name}</strong>{g.why && <span className="tk-small tk-dim"> — {g.why}</span>}</div>
                  {g.mapsQuery && (
                    <a className="btn-icon-bg" href={navigateUrl({ query: g.mapsQuery, ...(() => { const c = trip.checks?.places[placeKey(g)]; return c?.status === 'found' ? { lat: c.lat, lon: c.lon } : {}; })() })}
                      target="_blank" rel="noopener noreferrer" aria-label={`Navigate to ${g.name}`}>
                      <span className="material-symbols-outlined" aria-hidden="true">navigation</span>
                    </a>
                  )}
                </div>
              ))}
            </>
          )}
          {arr(plan?.liveAlerts).length > 0 && (
            <>
              <h4 className="tk-sub">Heads-ups</h4>
              <ul className="tk-list tk-small">
                {arr(plan?.liveAlerts).map((a, k) => <li key={k}>{a.description}{a.alternativeSuggestion ? ` — ${a.alternativeSuggestion}` : ''}</li>)}
              </ul>
            </>
          )}
        </div>

        <div className="today-side">
          <div className="card tk-card today-spend">
            <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">payments</span>Quick spend</h3>
            <div className="today-spend-row">
              <input aria-label="Amount in rupees" inputMode="decimal" placeholder="₹ amount" value={amount}
                onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addSpend()} />
              <button className="btn-accent" onClick={addSpend} disabled={!parseFloat(amount)}>Add</button>
            </div>
            <div className="tk-chips" role="radiogroup" aria-label="Category">
              {QUICK.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={category === c} className={`tk-chip-btn ${category === c ? 'on' : ''}`} onClick={() => setCategory(c)}>{c}</button>
              ))}
            </div>
            <p className="tk-small">{added ? <span className="tk-ok-text" role="status">{added}</span> : <>Spent on day {day}: <strong className="tk-mono">{formatINR(spentToday)}</strong></>}</p>
            <button className="btn-secondary tk-link-btn" onClick={onOpenPlan}>Full plan, packing and wallet</button>
          </div>
          {weatherSlot?.(place)}
        </div>
      </div>

      <TripMap trip={trip} day={day} traffic compact />
      <p className="tk-dim tk-small tk-center">Works offline: the plan, ticks and spends are saved on this phone{trip.share ? ' and reach your family when you have signal' : ''}. Maps and navigation need signal.</p>
    </div>
  );
}
