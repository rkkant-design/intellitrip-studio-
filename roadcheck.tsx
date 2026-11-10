/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Can we actually drive this?": checks each day's drive against known road
 * rules (forest night closures, e-passes, roads closed to tourists, rain-alert
 * bans), works out roughly when the family would reach each one, and suggests
 * a fix. A second, AI-powered check looks for current official notices for the
 * route and dates.
 */

import React from 'react';
import { type RoadRule, ROAD_RULES } from './roadrules';
import { type Leg, type SavedTrip, addDays, arr, driveHours, fmtDate, mmss } from './tripkit';

export type Level = 'blocker' | 'warning' | 'todo' | 'caution' | 'ok';

export interface Finding {
  rule: RoadRule;
  level: Level;
  day?: number;
  leg?: Leg;
  passAt?: string; // "21:40" — roughly when they reach the area
  leaveBy?: string; // latest departure that avoids a closure
  assumedStart?: boolean; // the plan didn't say when they leave
  measured: boolean; // from the real road path, not just place names
  detail: string;
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const fmt = (min: number) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

/** First clock time in a bit of plan text: "07:00", "7.30", "6 am", "leave by 5:45 pm". */
export function firstTime(text?: string): number | null {
  const s = String(text || '');
  const m = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/i.exec(s) || /\b(\d{1,2})\s*(am|pm)\b/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] && /^\d{2}$/.test(m[2]) ? Number(m[2]) : 0;
  const ap = (m[3] || (m[2] && !/^\d{2}$/.test(m[2]) ? m[2] : '') || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/** When a leg starts: the plan's departure time for day 1, else the day's first activity, else 8 am (assumed). */
function legStart(trip: SavedTrip, leg: Leg, index: number): { min: number; assumed: boolean } {
  const rt = trip.plan.roadTrip && typeof trip.plan.roadTrip === 'object' ? trip.plan.roadTrip : null;
  const dayNo = leg.day ?? index + 1;
  const day = arr(trip.plan.days).find((d) => d.day === dayNo);
  const fromDepart = dayNo === 1 ? firstTime(rt?.departAt) : null;
  if (fromDepart !== null) return { min: fromDepart, assumed: false };
  for (const a of arr(day?.activities)) {
    const t = firstTime(a.time);
    if (t !== null) return { min: t, assumed: false };
  }
  return { min: 8 * 60, assumed: true };
}

/** Whether a clock time (minutes, any day) falls inside a closure such as 21:00–06:00. */
const inClosure = (min: number, from: string, to: string) => {
  const t = ((min % 1440) + 1440) % 1440;
  const f = toMin(from);
  const e = toMin(to);
  return f > e ? t >= f || t < e : t >= f && t < e;
};

const textOf = (leg: Leg) =>
  [leg.from, leg.to, leg.route, ...arr(leg.stops).flatMap((s) => [s.name, s.mapsQuery])].filter(Boolean).join(' ').toLowerCase();

const mentions = (rule: RoadRule, text: string) => rule.keywords.some((k) => text.includes(k));

/** Every road rule this trip meets, most serious first. */
export function assess(trip: SavedTrip): Finding[] {
  const rt = trip.plan.roadTrip && typeof trip.plan.roadTrip === 'object' ? trip.plan.roadTrip : null;
  const legs = arr(rt?.legs);
  const findings: Finding[] = [];
  const seen = new Set<string>();

  legs.forEach((leg, i) => {
    const real = trip.checks?.legs[String(i)] || null;
    const hits = real?.hits;
    for (const rule of ROAD_RULES) {
      const hit = hits?.find((h) => h.ruleId === rule.id);
      // Without a measured path, fall back to place names in the plan.
      const byText = !hits && mentions(rule, textOf(leg));
      if (!hit && !byText) continue;
      const key = `${rule.id}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const { min: start, assumed } = legStart(trip, leg, i);
      // The plan's own time includes stops, so it is the better guess at when they really get there.
      const hours = Math.max(real?.hours || 0, driveHours(leg.driveTime) || 0) || real?.hours || 0;
      const base: Omit<Finding, 'level' | 'detail'> = { rule, day: leg.day ?? i + 1, leg, assumedStart: assumed, measured: Boolean(hit) };

      if (rule.kind === 'permit') {
        // A permit is needed to enter the area: not for a drive that starts inside it, and only once per trip.
        const entering = hit ? hit.enter > 0 : mentions(rule, String(leg.to || '').toLowerCase());
        if (!entering || findings.some((f) => f.rule.id === rule.id)) continue;
        findings.push({ ...base, level: 'todo', detail: rule.summary });
        continue;
      }
      if (rule.kind === 'no-tourists') {
        findings.push({ ...base, level: rule.certainty === 'standing' ? 'blocker' : 'warning', detail: rule.summary });
        continue;
      }
      if (!rule.closed || !hours) {
        findings.push({ ...base, level: rule.kind === 'on-alert' ? 'caution' : 'warning', detail: rule.summary });
        continue;
      }
      const enter = start + (hit ? hit.enter : 0) * hours * 60;
      const exit = start + (hit ? hit.exit : 1) * hours * 60;
      let closedOnTheWay = false;
      for (let t = enter; t <= exit; t += 10) if (inClosure(t, rule.closed.from, rule.closed.to)) closedOnTheWay = true;
      if (inClosure(exit, rule.closed.from, rule.closed.to)) closedOnTheWay = true;
      const passAt = hit ? fmt(enter) : undefined;
      // Latest start that clears the area half an hour before it shuts.
      const leaveByMin = toMin(rule.closed.from) - 30 - (hit ? hit.exit : 1) * hours * 60;
      const leaveBy = leaveByMin >= 4 * 60 ? fmt(leaveByMin) : undefined;

      if (rule.kind === 'on-alert') {
        findings.push({
          ...base, level: 'caution', passAt, leaveBy: closedOnTheWay ? leaveBy : undefined,
          detail: closedOnTheWay
            ? `${rule.summary} You'd be on these roads around ${passAt ?? 'the evening'}, inside the ${fmt(toMin(rule.closed.from))}–${fmt(toMin(rule.closed.to))} window if an alert is issued.`
            : rule.summary,
        });
      } else if (closedOnTheWay) {
        findings.push({
          ...base, level: rule.certainty === 'standing' ? 'blocker' : 'warning', passAt, leaveBy,
          detail: `You'd reach this stretch around ${passAt ?? 'closing time'}, when it is closed (${fmt(toMin(rule.closed.from))} to ${fmt(toMin(rule.closed.to))}).`,
        });
      } else {
        findings.push({
          ...base, level: 'ok', passAt,
          detail: `You pass around ${passAt ?? 'daytime'}, outside the ${fmt(toMin(rule.closed.from))}–${fmt(toMin(rule.closed.to))} closure.`,
        });
      }
    }
  });

  // Permits for the destination itself, even when no drive was measured into it.
  const dest = `${trip.form.destination} ${trip.plan.title || ''}`.toLowerCase();
  for (const rule of ROAD_RULES.filter((r) => r.kind === 'permit')) {
    if (!findings.some((f) => f.rule.id === rule.id) && mentions(rule, dest)) {
      findings.push({ rule, level: 'todo', measured: false, detail: rule.summary });
    }
  }

  const order: Level[] = ['blocker', 'warning', 'todo', 'caution', 'ok'];
  return findings.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level) || (a.day || 0) - (b.day || 0));
}

const LEVEL_LABEL: Record<Level, string> = {
  blocker: 'Closed when you\'d be there', warning: 'Check before you go', todo: 'Needs a permit',
  caution: 'On rain-alert days', ok: 'Fine on this plan',
};

const tripDates = (trip: SavedTrip) => {
  const s = trip.form.startDate;
  if (!s) return '';
  return `${fmtDate(s)} – ${fmtDate(addDays(s, Number(trip.form.duration) || 1))}`;
};

export function RoadRulesCard({
  trip, busy, onCheckNotices, onFix,
}: {
  trip: SavedTrip;
  busy: number | null; // seconds, while the notices check runs
  onCheckNotices: () => void;
  onFix: (day: number, text: string) => void;
}) {
  const findings = assess(trip);
  const notices = trip.notices;
  const driving = Boolean(trip.plan.roadTrip && typeof trip.plan.roadTrip === 'object' && arr(trip.plan.roadTrip.legs).length);
  if (!driving && !findings.length) return null;
  const serious = findings.filter((f) => f.level === 'blocker' || f.level === 'warning').length;

  return (
    <div className="card tk-card tk-roadrules">
      <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">traffic</span>Road Rules</h3>
      {findings.length === 0 ? (
        <p className="tk-small">None of the {ROAD_RULES.length} road rules IntelliTrip knows about (forest night closures, e-passes, rain-time ghat bans) lie on this route.</p>
      ) : (
        <p className="tk-small">
          {serious ? <strong className="tk-over">{serious} thing{serious === 1 ? '' : 's'} could stop this drive.</strong> : <strong className="tk-ok-text">Nothing on this plan is known to stop the drive.</strong>}
          {' '}Checked against the rules IntelliTrip knows about; rules change, so confirm anything marked "check".
        </p>
      )}

      {findings.map((f, i) => (
        <div key={`${f.rule.id}-${i}`} className={`tk-rule ${f.level}`}>
          <div className="tk-stop-head">
            <span className={`tk-chip rule-${f.level}`}>{LEVEL_LABEL[f.level]}</span>
            {f.day && <span className="day-num">Day {f.day}</span>}
            <strong>{f.rule.name}</strong>
          </div>
          <div className="tk-small">{f.detail}</div>
          {(f.level === 'blocker' || f.level === 'warning' || f.level === 'caution') && <div className="tk-small"><strong>What to do:</strong> {f.rule.whatToDo}</div>}
          {f.leaveBy && <div className="tk-small"><strong>Leave by {f.leaveBy}</strong> on day {f.day} to clear it in time{f.assumedStart ? ' (the plan doesn\'t give a start time, so 8 am was assumed)' : ''}.</div>}
          {f.assumedStart && !f.leaveBy && f.passAt && <div className="tk-dim tk-small">The plan doesn't give a start time for this day, so 8 am was assumed.</div>}
          {!f.measured && f.level !== 'todo' && <div className="tk-dim tk-small">Found from place names in the plan; the map check gives exact timing.</div>}
          <div className="tk-row tk-rule-links">
            {f.rule.link && <a className="tk-gcal" href={f.rule.link.url} target="_blank" rel="noopener noreferrer">{f.rule.link.label}</a>}
            {f.rule.sources.map((s) => <a key={s.url} className="tk-place tk-small" href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>)}
            <span className="tk-dim tk-small">{f.rule.certainty === 'check' ? 'Check current status · ' : ''}checked {fmtDate(f.rule.checked)}</span>
          </div>
          {(f.level === 'blocker' || f.level === 'warning') && f.day && (
            <button className="btn-secondary tk-link-btn" onClick={() => onFix(f.day!, `${f.rule.whatToDo} (${f.rule.name})`)}>Fix day {f.day} with Change</button>
          )}
        </div>
      ))}

      <h4 className="tk-sub">Latest road notices</h4>
      {busy !== null ? (
        <div className="tk-loading"><span className="spinner tk-spinner" />Searching official notices for your route and dates… {mmss(busy)}</div>
      ) : notices ? (
        <>
          <p className="tk-dim tk-small">Checked {new Date(notices.checkedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} for {tripDates(trip)}.{notices.summary ? ` ${notices.summary}` : ''}</p>
          {arr(notices.notices).length === 0 && <p className="tk-small tk-ok-text">No current closures or restrictions found for this route.</p>}
          {arr(notices.notices).map((n, i) => (
            <div key={i} className={`tk-rule ${n.severity === 'blocker' ? 'blocker' : n.severity === 'caution' ? 'caution' : 'ok'}`}>
              <div className="tk-stop-head">
                <span className={`tk-chip rule-${n.severity === 'blocker' ? 'blocker' : n.severity === 'caution' ? 'caution' : 'ok'}`}>{n.severity === 'blocker' ? 'Affects your drive' : n.severity === 'caution' ? 'Be aware' : 'For information'}</span>
                <strong>{n.title}</strong>
              </div>
              <div className="tk-small">{[n.area, n.when, n.timeWindow].filter(Boolean).join(' · ')}</div>
              {n.whatToDo && <div className="tk-small"><strong>What to do:</strong> {n.whatToDo}</div>}
              {n.sourceUrl && <a className="tk-place tk-small" href={n.sourceUrl} target="_blank" rel="noopener noreferrer">{n.sourceTitle || n.sourceUrl}</a>}
            </div>
          ))}
          <button className="btn-secondary tk-link-btn" onClick={onCheckNotices}>Check again</button>
        </>
      ) : (
        <>
          <p className="tk-dim tk-small">Search the web for current official closures, night bans, e-pass rules and rain alerts on your route for {tripDates(trip) || 'your dates'}. Best done 1–2 days before you leave. Takes about 5 minutes; you can keep using the app meanwhile.</p>
          <button className="btn-secondary tk-link-btn" onClick={onCheckNotices}>Check latest road notices</button>
        </>
      )}
    </div>
  );
}
