/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The signed-out pages: the home page (which leads with a real sample trip),
 * the sample trip itself (viewable without an account; no AI call, nothing
 * saved) and the parts the sign-in page shares with them.
 */

import React from 'react';
import sampleJson from './sample-trip.json';
import { Logo } from './chrome';
import { PlanView, type SavedTrip, arr, formatINR } from './tripkit';
import { RoadRulesCard, fmt } from './roadcheck';
import { RouteSketch, TripMap } from './tripmap';
import { itemsFor } from './today';

/** A real plan IntelliTrip made (Madurai → Thekkady, family of three), with its saved map check. */
export const SAMPLE = sampleJson as unknown as SavedTrip;

const firstDay = () => {
  const leg = SAMPLE.checks?.legs['0'];
  const cost = arr(SAMPLE.plan.budget).reduce((s, b) => s + (Number(b.amountInr) || 0), 0);
  const items = itemsFor(SAMPLE, 1).filter((i) => i.kind !== 'arrive').slice(0, 4);
  return { leg, cost, items };
};

export function SampleCard({ onOpen }: { onOpen: () => void }) {
  const { leg, cost, items } = firstDay();
  const day1 = arr(SAMPLE.plan.days)[0];
  return (
    <section className="it-sample card" aria-labelledby="sample-title">
      <RouteSketch trip={SAMPLE} day={1} label={`Day 1 road from ${SAMPLE.form.fromLocation} to ${SAMPLE.form.destination}`} />
      <div className="it-sample-body">
        <div className="it-sample-top">
          <span className="it-eyebrow">Sample trip</span>
          <span className="tk-dim tk-small">{Number(SAMPLE.form.duration) + 1} days · family of 3</span>
        </div>
        <h2 id="sample-title" className="it-sample-title">{SAMPLE.form.fromLocation} → {SAMPLE.form.destination}: {SAMPLE.plan.title}</h2>
        <div className="it-pills">
          {leg && <span className="it-pill">{leg.km} km on day 1</span>}
          {leg && <span className="it-pill">{Math.floor(leg.hours)}h {String(Math.round((leg.hours % 1) * 60)).padStart(2, '0')}m driving</span>}
          {cost > 0 && <span className="it-pill amber">≈ {formatINR(cost)}</span>}
          <span className="it-pill grey">Road rules checked</span>
        </div>
        <ol className="it-sample-day">
          <li className="it-sample-day-head">Day 1 · {day1?.title || 'On the road'}</li>
          {items.map((i) => (
            <li key={i.key}>
              <span className="it-dot" aria-hidden="true" />
              <span className="it-sample-time">{i.time !== null ? fmt(i.time) : ''}</span>
              <span>{i.name}</span>
            </li>
          ))}
        </ol>
        <button className="btn-secondary it-sample-open" onClick={onOpen}>Open the full sample trip</button>
      </div>
    </section>
  );
}

const PERKS: [string, string, string][] = [
  ['route', 'Routes that fit your day', 'Drives kept under your daily limit, with real road distances.'],
  ['restaurant', 'Food on the way', 'Named places to eat that match what your family eats.'],
  ['star', 'Hidden gems', 'Lesser-known stops worth the detour, each a tap away in Maps.'],
  ['traffic', 'Road rules checked', 'Forest night closures, e-passes and rain-alert bans, timed against your drive.'],
  ['navigation', 'Today mode', "On the road: the next stop, one-tap navigation and spends. Works offline."],
  ['group', 'Plan together', 'Invite family by link; ticks and spends sync between phones.'],
];

export function LandingPage({ onStart, onSample, startLabel, headExtra }: { onStart: () => void; onSample: () => void; startLabel: string; headExtra?: React.ReactNode }) {
  return (
    <div className="it-landing">
      <header className="it-public-head">
        <Logo />
        <div className="it-head-actions">
          {headExtra}
          <button className="btn-secondary" onClick={onStart}>{startLabel === 'Plan a trip' ? 'Sign in' : 'Open my trips'}</button>
        </div>
      </header>
      <main className="it-landing-main">
        <div className="it-landing-sample"><SampleCard onOpen={onSample} /></div>
        <div className="it-landing-copy">
          <h1>Plan the drive, not just the destination.</h1>
          <p className="it-lede">Road trips from your door: routes that respect your driving limit, food stops on the way, hidden gems, and a Today screen for the road.</p>
          <div className="it-cta">
            <button className="btn-primary" onClick={onStart}>{startLabel}</button>
            <button className="btn-secondary it-cta-2" onClick={onSample}>View sample trip</button>
          </div>
          <ul className="it-perks">
            {PERKS.map(([icon, title, text]) => (
              <li key={title}>
                <span className="material-symbols-outlined" aria-hidden="true">{icon}</span>
                <div><strong>{title}</strong><span>{text}</span></div>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}

/** The whole sample trip, read-only. Anything that would save or call the AI asks you to sign in. */
export function SampleView({ onBack, onStart, startLabel }: { onBack: () => void; onStart: () => void; startLabel: string }) {
  return (
    <div className="it-landing">
      <header className="it-public-head">
        <button className="btn-secondary it-back" onClick={onBack}>
          <span className="material-symbols-outlined" aria-hidden="true">arrow_back</span>Back
        </button>
        <Logo small />
        <button className="btn-primary it-head-cta" onClick={onStart}>{startLabel}</button>
      </header>
      <main className="content">
        <div className="it-sample-banner">
          <span className="material-symbols-outlined" aria-hidden="true">visibility</span>
          <span>This is a sample trip IntelliTrip planned for a family of three. Nothing here is saved; plan your own to change it, pack and track spends.</span>
        </div>
        <div className="results-header">
          <div className="title-group">
            <h2>{SAMPLE.plan.title}</h2>
            <p className="tk-route">{SAMPLE.form.fromLocation} → {SAMPLE.form.destination} · {Number(SAMPLE.form.duration) + 1} days · 2 adults, 1 child</p>
            <p>{SAMPLE.plan.summary}</p>
          </div>
        </div>
        <PlanView
          trip={SAMPLE}
          checkProgress={null}
          showMapCheck={false}
          onRecheck={onStart}
          mapSlot={<TripMap trip={SAMPLE} />}
          rulesSlot={<RoadRulesCard trip={SAMPLE} busy={null} onCheckNotices={onStart} onFix={onStart} />}
          packingSlot={null}
        />
      </main>
    </div>
  );
}
