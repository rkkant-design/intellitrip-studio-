/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Official disaster alerts (IMD and state disaster authorities, through NDMA's
 * SACHET system) that touch the trip's roads. Alerts are short-lived, so they
 * are fetched only from two days before the trip until it ends, and refreshed
 * every 15 minutes while the trip is open.
 */

import React, { useEffect, useState } from 'react';
import { type SavedTrip, addDays, endDateOf, todayStr } from './tripkit';

export interface RouteAlert {
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
}
export interface RouteAlerts { at: string; alerts: RouteAlert[]; complete: boolean }
export type AlertsState = { status: 'off' } | { status: 'loading' } | { status: 'error'; message: string } | ({ status: 'ready' } & RouteAlerts);

/** Points along the trip's measured roads, as [lat, lon], at most 150. */
export function routePoints(trip: SavedTrip): [number, number][] {
  const paths = Object.values(trip.checks?.legs || {}).flatMap((l) => (l?.path && l.path.length > 1 ? [l.path] : []));
  const all = paths.flat();
  if (!all.length) return [];
  const step = Math.max(1, Math.ceil(all.length / 150));
  return all.filter((_, i) => i % step === 0).map(([lon, lat]) => [Math.round(lat * 1e3) / 1e3, Math.round(lon * 1e3) / 1e3]);
}

/** Whether alerts are worth checking now: from two days before the trip until its last day. */
export const alertsWindow = (trip: SavedTrip) => {
  const s = trip.form.startDate;
  if (!s) return false;
  const today = todayStr();
  return today >= addDays(s, -2) && today <= endDateOf(trip.form);
};

export function useRouteAlerts(trip: SavedTrip | null, getHeaders: () => Promise<Record<string, string>>): AlertsState {
  const [state, setState] = useState<AlertsState>({ status: 'off' });
  const points = trip ? routePoints(trip) : [];
  const key = trip && alertsWindow(trip) && points.length ? `${trip.id}:${points.length}:${points[0]}:${points[points.length - 1]}` : '';
  useEffect(() => {
    if (!key || !trip) { setState({ status: 'off' }); return; }
    let stop = false;
    const run = async () => {
      if (navigator.onLine === false) { setState({ status: 'error', message: "You're offline, so official alerts can't be checked." }); return; }
      setState((s) => (s.status === 'ready' ? s : { status: 'loading' }));
      try {
        const res = await fetch('/api/alerts', { method: 'POST', headers: await getHeaders(), body: JSON.stringify({ points }) });
        const data = await res.json().catch(() => ({}));
        if (stop) return;
        if (!res.ok) throw new Error(data.error || 'The official alert service did not answer.');
        setState({ status: 'ready', at: data.checkedAt, alerts: Array.isArray(data.alerts) ? data.alerts : [], complete: Boolean(data.complete) });
      } catch (e: any) {
        if (!stop) setState({ status: 'error', message: e?.message || 'Could not check official alerts.' });
      }
    };
    run();
    const timer = setInterval(run, 15 * 60_000);
    return () => { stop = true; clearInterval(timer); };
    // `key` stands for the trip and its route; the points are derived from them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, getHeaders]);
  return state;
}

const time = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

export function AlertsSection({ state, trip, compact = false }: { state: AlertsState; trip: SavedTrip; compact?: boolean }) {
  if (state.status === 'off') {
    if (compact) return null;
    return (
      <>
        <h4 className="tk-sub">Official alerts on your route</h4>
        <p className="tk-dim tk-small">
          {routePoints(trip).length
            ? 'Live alerts from IMD and state disaster authorities (via NDMA) appear here from two days before you leave.'
            : 'Live alerts appear here once the drives have been measured on the map.'}
        </p>
      </>
    );
  }
  return (
    <div className={compact ? 'it-alerts compact' : 'it-alerts'}>
      <h4 className="tk-sub">Official alerts on your route</h4>
      {state.status === 'loading' && <div className="tk-loading"><span className="spinner tk-spinner" />Checking IMD and state disaster alerts…</div>}
      {state.status === 'error' && <p className="tk-dim tk-small">{state.message}</p>}
      {state.status === 'ready' && (
        <>
          {state.alerts.length === 0 ? (
            <p className="tk-small tk-ok-text">No official alerts in force on your roads right now{state.complete ? '' : ' (some alerts are still loading; this refreshes every 15 minutes)'}.</p>
          ) : (
            state.alerts.map((a) => (
              <div key={a.id} className={`tk-rule ${a.severity === 'Extreme' || a.severity === 'Severe' ? 'blocker' : 'caution'}`}>
                <div className="tk-stop-head">
                  <span className={`tk-chip rule-${a.severity === 'Extreme' || a.severity === 'Severe' ? 'blocker' : 'caution'}`}>{a.severity || 'Alert'}</span>
                  <strong>{a.event || 'Alert'}</strong>
                </div>
                <div className="tk-small">{a.headline}</div>
                <div className="tk-dim tk-small">{[a.area, a.expires ? `until ${time(a.expires)}` : '', a.sender].filter(Boolean).join(' · ')}</div>
              </div>
            ))
          )}
          <p className="tk-dim tk-small">From NDMA's SACHET alert system, checked {time(state.at)}. <a className="tk-place" href="https://sachet.ndma.gov.in/" target="_blank" rel="noopener noreferrer">See all alerts</a></p>
        </>
      )}
    </div>
  );
}
