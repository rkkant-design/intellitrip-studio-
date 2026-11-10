/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Change part of a trip: pick the whole trip or one day, say what should
 * change, and the AI redoes only that. The result is merged into the saved
 * trip, the old version is kept so the change can be undone, and the map check
 * runs again on the new plan.
 */

import React, { useEffect, useState } from 'react';
import { type DayPlan, type FormState, type Leg, type Plan, type SavedTrip, arr, mmss } from './tripkit';

export type Scope = 'all' | number;

export interface PendingChange {
  jobId: string;
  tripId: string;
  scope: Scope;
  change: string;
  startedAt: number;
  form?: FormState; // new trip details, when the person edited them
}

export const PENDING_CHANGE_KEY = 'intellitrip_pending_change';
const MAX_HISTORY = 5;

const QUICK = [
  'Make it cheaper',
  'More relaxed, fewer stops',
  'More hidden gems',
  'Fewer hours in the car',
  'Leave later, around 9 am',
  'Better vegetarian food stops',
];

export const scopeLabel = (s: Scope) => (s === 'all' ? 'the whole trip' : `Day ${s}`);

// Requests that change where they start, the dates or who is going affect every day, not one.
export const TRIP_WIDE = /\b(start(ing)?\s+(from|point|at)|leav(e|ing)\s+from|depart(ing|ure)?\s+from|instead of [a-z]+ as|from [a-z]+ instead|different (start|date)|(change|move|shift) (the )?(dates?|start)|one more (day|night)|extra (day|night)|(add|remove) (a|one) (day|night)|nights?\b.*\b(instead|more|fewer|less)|(adults?|children|kids|people|travell?ers)\b.*\b(instead|now|more|fewer))\b/i;

/** Fields of the trip details shown in the Change sheet, with what the AI is told they mean. */
const DETAIL_FIELDS: (keyof FormState)[] = ['fromLocation', 'startDate', 'duration', 'adults', 'children', 'mode', 'maxDrive'];

export const detailsChanged = (a: FormState, b: FormState) => DETAIL_FIELDS.some((k) => String(a[k] ?? '') !== String(b[k] ?? ''));

/** The AI asked for the whole trip to be redone instead of one day. */
export const needsWholeTrip = (result: any) => Boolean(result?.needsWholeTrip);

/** Puts the AI's answer into the trip, keeping the previous version for Undo. */
export function applyChange(trip: SavedTrip, scope: Scope, change: string, result: any, newForm?: FormState): SavedTrip {
  const old = trip.plan;
  // New trip details: the ones the person edited, plus any the AI says the request itself changed.
  let form: FormState = { ...trip.form, ...(newForm || {}) };
  const d = result?.tripDetails;
  if (scope === 'all' && d && typeof d === 'object') {
    if (typeof d.fromLocation === 'string' && d.fromLocation.trim()) form = { ...form, fromLocation: d.fromLocation.trim() };
    if (typeof d.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.startDate)) form = { ...form, startDate: d.startDate };
    if (Number(d.nights) >= 1 && Number(d.nights) <= 30) form = { ...form, duration: Number(d.nights) };
    if (Number(d.adults) >= 1) form = { ...form, adults: Number(d.adults) };
    if (Number(d.children) >= 0 && d.children !== null && d.children !== undefined) form = { ...form, children: Number(d.children) };
  }
  let plan: Plan;
  if (scope === 'all') {
    const { changeNote: _note, tripDetails: _details, needsWholeTrip: _whole, ...rest } = result || {};
    if (!Array.isArray(rest.days) || !rest.days.length) throw new Error("The AI's answer was missing the days. Please try again.");
    plan = rest as Plan;
  } else {
    const day = result?.day as DayPlan | undefined;
    if (!day || typeof day !== 'object') throw new Error("The AI's answer was missing the day. Please try again.");
    const fixedDay: DayPlan = { ...day, day: scope };
    plan = { ...old, days: arr(old.days).map((d) => (d.day === scope ? fixedDay : d)) };
    const leg = result?.leg as Leg | null | undefined;
    if (leg && typeof leg === 'object' && plan.roadTrip && typeof plan.roadTrip === 'object') {
      const legs = arr(plan.roadTrip.legs);
      const fixedLeg = { ...leg, day: scope };
      const at = legs.findIndex((l) => l.day === scope);
      plan = { ...plan, roadTrip: { ...plan.roadTrip, legs: at >= 0 ? legs.map((l, i) => (i === at ? fixedLeg : l)) : [...legs, fixedLeg] } };
    }
    if (Array.isArray(result?.budget) && result.budget.length) plan = { ...plan, budget: result.budget };
  }
  const at = new Date().toISOString();
  return {
    ...trip,
    plan,
    form,
    checks: null, // places changed, so the map check runs again
    history: [{ plan: old, form: trip.form, checks: trip.checks ?? null, change, scope, at }, ...arr(trip.history)].slice(0, MAX_HISTORY),
    lastChange: { note: String(result?.changeNote || `Updated ${scopeLabel(scope)}.`), change, scope, at },
  };
}

/** Goes back to the version before the latest change. */
export function undoChange(trip: SavedTrip): SavedTrip {
  const [prev, ...rest] = arr(trip.history);
  if (!prev) return trip;
  return { ...trip, plan: prev.plan, form: prev.form ?? trip.form, checks: prev.checks ?? null, history: rest, lastChange: null };
}

export function ChangeBanner({
  trip, pending, seconds, onUndo, onDismiss,
}: { trip: SavedTrip; pending: PendingChange | null; seconds: number; onUndo: () => void; onDismiss: () => void }) {
  if (pending && pending.tripId === trip.id) {
    return (
      <div className="card tk-card tk-change-banner" role="status" aria-live="polite">
        <div className="tk-loading">
          <span className="spinner tk-spinner" />
          <span>
            Updating {scopeLabel(pending.scope)}{pending.change ? <>: “{pending.change}”</> : pending.form ? ` for the new trip details (from ${pending.form.fromLocation})` : ''}
            {' · '}<span className="tk-mono">{mmss(seconds)}</span>
          </span>
        </div>
        <p className="tk-dim tk-small">
          {pending.scope === 'all'
            ? 'Usually 2–5 minutes, as every day is rewritten. You can leave this page.'
            : 'Usually 1–3 minutes. The rest of the trip stays as it is. You can leave this page.'}
        </p>
      </div>
    );
  }
  const last = trip.lastChange;
  if (!last) return null;
  return (
    <div className="card tk-card tk-change-banner done">
      <div className="tk-row tk-change-row">
        <span className="material-symbols-outlined" aria-hidden="true">auto_fix_high</span>
        <span className="tk-grow"><strong>{last.scope === 'all' ? 'Trip updated' : `Day ${last.scope} updated`}:</strong> {last.note}</span>
      </div>
      <div className="tk-row">
        {arr(trip.history).length > 0 && <button className="btn-secondary" onClick={onUndo}>Undo</button>}
        <button className="btn-secondary" onClick={onDismiss}>OK</button>
      </div>
    </div>
  );
}

export function ChangeSheet({
  trip, initialScope, onSubmit, onClose,
}: {
  trip: SavedTrip;
  initialScope: Scope;
  onSubmit: (scope: Scope, change: string, newForm: FormState | null) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<Scope>(initialScope);
  const [text, setText] = useState('');
  const [form, setForm] = useState<FormState>(trip.form);
  const [showDetails, setShowDetails] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const editedDetails = detailsChanged(trip.form, form);
  const typedTripWide = scope !== 'all' && TRIP_WIDE.test(text);
  // Anything that changes where they start, the dates or who is going replans every day.
  const effectiveScope: Scope = editedDetails || typedTripWide ? 'all' : scope;
  const set = (k: keyof FormState, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const addQuick = (q: string) => setText((t) => (t.trim() ? `${t.trim().replace(/[.,;]$/, '')}; ${q.toLowerCase()}` : q));
  const canSubmit = Boolean(text.trim()) || editedDetails;
  const submit = () => canSubmit && onSubmit(effectiveScope, text.trim(), editedDetails ? form : null);
  const plural = (n: unknown, one: string, many: string) => (Number(n) === 1 ? one : many);

  return (
    <div className="tk-modal-bg" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tk-modal card" role="dialog" aria-modal="true" aria-labelledby="change-title">
        <div className="tk-modal-head">
          <h3 id="change-title" className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">edit_note</span>Change this trip</h3>
          <button className="btn-icon-bg" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>

        <button type="button" className="tk-details-toggle" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}>
          <span className="material-symbols-outlined" aria-hidden="true">{showDetails ? 'expand_less' : 'expand_more'}</span>
          <span className="tk-grow">
            Trip details: from {form.fromLocation || '?'}, {form.duration} {plural(form.duration, 'night', 'nights')}, {form.adults} {plural(form.adults, 'adult', 'adults')}
            {Number(form.children) ? `, ${form.children} ${plural(form.children, 'child', 'children')}` : ''}
          </span>
          {editedDetails && <span className="tk-chip warn">Changed</span>}
        </button>
        {showDetails && (
          <div className="tk-details-grid">
            <div className="field"><label htmlFor="cd-from">Starting from</label>
              <input id="cd-from" value={form.fromLocation} onChange={(e) => set('fromLocation', e.target.value)} /></div>
            <div className="field"><label htmlFor="cd-start">Start date</label>
              <input id="cd-start" type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} /></div>
            <div className="field"><label htmlFor="cd-nights">Nights</label>
              <input id="cd-nights" type="number" min={1} max={30} value={form.duration} onChange={(e) => set('duration', e.target.value)} /></div>
            <div className="field"><label htmlFor="cd-adults">Adults</label>
              <input id="cd-adults" type="number" min={1} value={form.adults} onChange={(e) => set('adults', e.target.value)} /></div>
            <div className="field"><label htmlFor="cd-children">Children</label>
              <input id="cd-children" type="number" min={0} value={form.children} onChange={(e) => set('children', e.target.value)} /></div>
            <div className="field"><label htmlFor="cd-mode">How you are travelling</label>
              <select id="cd-mode" value={form.mode} onChange={(e) => set('mode', e.target.value)}>
                <option>Road trip in our own car</option>
                <option>Road trip with a hired cab and driver</option>
                <option>Compare road, train and flight</option>
              </select></div>
            <div className="field"><label htmlFor="cd-drive">Most driving a day</label>
              <select id="cd-drive" value={form.maxDrive} onChange={(e) => set('maxDrive', e.target.value)}>
                {['3 hours', '5 hours', '7 hours', '9 hours'].map((o) => <option key={o}>{o}</option>)}
              </select></div>
          </div>
        )}

        <div className="field">
          <label htmlFor="change-scope">What to change</label>
          <select id="change-scope" value={String(effectiveScope)} disabled={effectiveScope === 'all' && scope !== 'all'}
            onChange={(e) => setScope(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            {arr(trip.plan.days).map((d) => <option key={d.day} value={d.day}>Day {d.day}{d.title ? ` — ${d.title}` : ''}</option>)}
            <option value="all">The whole trip</option>
          </select>
          <span className="tk-dim tk-small">
            {editedDetails
              ? 'New trip details replan every day, every drive and the budget. Takes a few minutes.'
              : typedTripWide
              ? 'That changes where you start, the dates or who is going, so the whole trip will be replanned.'
              : effectiveScope === 'all'
              ? 'Rewrites every day. Takes a few minutes.'
              : 'Only this day changes, plus its drive and the budget if needed. Faster.'}
          </span>
        </div>
        <div className="tk-chips" aria-label="Quick changes">
          {QUICK.map((q) => <button key={q} type="button" className="tk-chip-btn" onClick={() => addQuick(q)}>{q}</button>)}
        </div>
        <div className="field">
          <label htmlFor="change-text">{editedDetails ? 'Anything else to change? (optional)' : 'What should change?'}</label>
          <textarea id="change-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={600}
            placeholder="e.g. Add a temple visit in the morning, skip the boating, lunch somewhere with a view…" />
        </div>
        <div className="tk-row">
          <button className="btn-accent" onClick={submit} disabled={!canSubmit}>
            {editedDetails ? 'Replan with new details' : `Update ${scopeLabel(effectiveScope)}`}
          </button>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
