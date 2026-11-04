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
import { type DayPlan, type Leg, type Plan, type SavedTrip, arr, mmss } from './tripkit';

export type Scope = 'all' | number;

export interface PendingChange {
  jobId: string;
  tripId: string;
  scope: Scope;
  change: string;
  startedAt: number;
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

/** Puts the AI's answer into the trip, keeping the previous version for Undo. */
export function applyChange(trip: SavedTrip, scope: Scope, change: string, result: any): SavedTrip {
  const old = trip.plan;
  let plan: Plan;
  if (scope === 'all') {
    const { changeNote: _note, ...rest } = result || {};
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
    checks: null, // places changed, so the map check runs again
    history: [{ plan: old, checks: trip.checks ?? null, change, scope, at }, ...arr(trip.history)].slice(0, MAX_HISTORY),
    lastChange: { note: String(result?.changeNote || `Updated ${scopeLabel(scope)}.`), change, scope, at },
  };
}

/** Goes back to the version before the latest change. */
export function undoChange(trip: SavedTrip): SavedTrip {
  const [prev, ...rest] = arr(trip.history);
  if (!prev) return trip;
  return { ...trip, plan: prev.plan, checks: prev.checks ?? null, history: rest, lastChange: null };
}

export function ChangeBanner({
  trip, pending, seconds, onUndo, onDismiss,
}: { trip: SavedTrip; pending: PendingChange | null; seconds: number; onUndo: () => void; onDismiss: () => void }) {
  if (pending && pending.tripId === trip.id) {
    return (
      <div className="card tk-card tk-change-banner" role="status" aria-live="polite">
        <div className="tk-loading">
          <span className="spinner tk-spinner" />
          <span>Updating {scopeLabel(pending.scope)}: “{pending.change}” · <span className="tk-mono">{mmss(seconds)}</span></span>
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
}: { trip: SavedTrip; initialScope: Scope; onSubmit: (scope: Scope, change: string) => void; onClose: () => void }) {
  const [scope, setScope] = useState<Scope>(initialScope);
  const [text, setText] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const addQuick = (q: string) => setText((t) => (t.trim() ? `${t.trim().replace(/[.,;]$/, '')}; ${q.toLowerCase()}` : q));
  const submit = () => text.trim() && onSubmit(scope, text.trim());

  return (
    <div className="tk-modal-bg" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tk-modal card" role="dialog" aria-modal="true" aria-labelledby="change-title">
        <div className="tk-modal-head">
          <h3 id="change-title" className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">edit_note</span>Change this trip</h3>
          <button className="btn-icon-bg" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
        <div className="field">
          <label htmlFor="change-scope">What to change</label>
          <select id="change-scope" value={String(scope)} onChange={(e) => setScope(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
            {arr(trip.plan.days).map((d) => <option key={d.day} value={d.day}>Day {d.day}{d.title ? ` — ${d.title}` : ''}</option>)}
            <option value="all">The whole trip</option>
          </select>
          <span className="tk-dim tk-small">{scope === 'all' ? 'Rewrites every day. Takes a few minutes.' : 'Only this day changes, plus its drive and the budget if needed. Faster.'}</span>
        </div>
        <div className="tk-chips" aria-label="Quick changes">
          {QUICK.map((q) => <button key={q} type="button" className="tk-chip-btn" onClick={() => addQuick(q)}>{q}</button>)}
        </div>
        <div className="field">
          <label htmlFor="change-text">What should change?</label>
          <textarea id="change-text" value={text} onChange={(e) => setText(e.target.value)} maxLength={600}
            placeholder="e.g. Add a temple visit in the morning, skip the boating, lunch somewhere with a view…" />
        </div>
        <div className="tk-row">
          <button className="btn-accent" onClick={submit} disabled={!text.trim()}>Update {scopeLabel(scope)}</button>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
