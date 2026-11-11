/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Share a trip with family: builds a WhatsApp-friendly message (the whole trip
 * or one day) that can be edited, then sent through WhatsApp, the phone's share
 * menu, or copied.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDialogFocus } from './a11y';
import { routeStops } from './placecheck';
import { type SavedTrip, addDays, arr, endDateOf, formatINR } from './tripkit';

const mapsDir = (origin: string, dest: string, stops: string[]) =>
  'https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=' + encodeURIComponent(origin) +
  '&destination=' + encodeURIComponent(dest) + (stops.length ? '&waypoints=' + encodeURIComponent(stops.join('|')) : '');

const dayDate = (iso: string) =>
  new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });

const hoursText = (h: number) => {
  const m = Math.round(h * 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

// The first sentence only: WhatsApp messages should stay skimmable.
const firstSentence = (s?: string, max = 140) => {
  const t = String(s || '').trim();
  const cut = t.split(/(?<=[.!?])\s/)[0];
  return cut.length > max ? cut.slice(0, max - 1).trimEnd() + '…' : cut;
};

/** Short place name for lists: "Hotel Arya Bhavan, Kumily" rather than the full maps query. */
const shortPlace = (name?: string) =>
  String(name || '').replace(/\s*\([^)]*\)/g, '').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();

export interface ShareOptions {
  day: 'all' | number;
  links: boolean;
}

export function buildShareText(trip: SavedTrip, opts: ShareOptions): string {
  const { plan: p, form: f } = trip;
  const rt = p.roadTrip && typeof p.roadTrip === 'object' ? p.roadTrip : null;
  const legs = arr(rt?.legs);
  const checks = trip.checks;
  const people = [`${f.adults} adult${Number(f.adults) === 1 ? '' : 's'}`, Number(f.children) ? `${f.children} child${Number(f.children) === 1 ? '' : 'ren'}` : '']
    .filter(Boolean).join(', ');
  const start = f.startDate;
  const range = start ? `${dayDate(start)} – ${dayDate(endDateOf(f))}` : '';

  const lines: string[] = [];
  lines.push(`*${p.title || f.destination}*`);
  lines.push([`${f.fromLocation} → ${f.destination}`, range, people].filter(Boolean).join(' · '));

  const days = arr(p.days).filter((d) => opts.day === 'all' || d.day === opts.day);
  if (opts.day === 'all' && p.summary) lines.push('', firstSentence(p.summary, 220));

  for (const d of days) {
    const date = d.date || (start ? addDays(start, d.day - 1) : '');
    lines.push('', `*Day ${d.day}${date ? ` · ${dayDate(date)}` : ''}*${d.title ? ` — ${d.title}` : ''}`);

    const legIndex = legs.findIndex((l) => l.day === d.day);
    const leg = legIndex >= 0 ? legs[legIndex] : null;
    if (leg && leg.from && leg.to) {
      const real = checks?.legs[String(legIndex)];
      const dist = real ? `${real.km} km · about ${hoursText(real.hours)} driving` : [leg.distanceKm ? `${leg.distanceKm} km` : '', leg.driveTime].filter(Boolean).join(' · ');
      lines.push(`🚗 ${leg.from} → ${leg.to}${dist ? ` · ${dist}` : ''}`);
      if (d.day === 1 && rt?.departAt) lines.push(`⏰ ${firstSentence(rt.departAt)}`);
      const stops = routeStops(leg.stops, checks);
      if (stops.length) lines.push(`📍 Stops: ${stops.map((s) => shortPlace(s.name)).join(' · ')}`);
    }

    for (const a of arr(d.activities)) {
      // Older imported trips have no activity names, only a description.
      const what = a.name ? shortPlace(a.name) : firstSentence(a.description, 100);
      if (what) lines.push(`• ${a.time ? `${a.time} ` : ''}${what}`);
    }
    for (const g of arr(d.hiddenGems)) {
      if (!g.name) continue;
      lines.push(`💎 Hidden gem: ${shortPlace(g.name)}${g.why ? ` — ${firstSentence(g.why, 90)}` : ''}`);
      if (opts.links && g.mapsQuery) lines.push(`   https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(g.mapsQuery)}`);
    }
    if (d.food) lines.push(`🍽️ ${firstSentence(d.food)}`);
    if (d.stay) lines.push(`🛏️ Stay: ${firstSentence(d.stay, 90)}`);
    if (opts.links && leg && leg.from && leg.to) {
      const via = routeStops(leg.stops, checks).slice(0, 8).map((s) => s.mapsQuery || s.name || '');
      lines.push(`🗺️ Route: ${mapsDir(leg.from, leg.to, via)}`);
    }
  }

  if (opts.day === 'all') {
    const stay = p.accommodation;
    if (stay?.name) lines.push('', `*Stay:* ${shortPlace(stay.name)}${stay.estimatedPricePerNight ? ` (about ${formatINR(stay.estimatedPricePerNight)}/night)` : ''}`);
    const total = arr(p.budget).reduce((s, b) => s + (Number(b.amountInr) || 0), 0);
    if (total) lines.push(`*Budget:* about ${formatINR(total)} in all`);
    const book = arr(p.bookBy).filter((b) => b.item && b.deadline).slice(0, 4);
    if (book.length) {
      lines.push('', '*Book by:*');
      for (const b of book) lines.push(`• ${firstSentence(b.item, 70)} — ${dayDate(String(b.deadline))}`);
    }
  }
  return lines.join('\n');
}

export function ShareSheet({ trip, onClose, extra }: { trip: SavedTrip; onClose: () => void; extra?: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box);
  const [day, setDay] = useState<'all' | number>('all');
  const [links, setLinks] = useState(true);
  const generated = useMemo(() => buildShareText(trip, { day, links }), [trip, day, links]);
  const [text, setText] = useState(generated);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setText(generated), [generated]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const title = trip.plan.title || trip.form.destination;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setNote('Copied. Paste it into any chat.');
    } catch {
      setNote('Copy was blocked. Select the text above and copy it by hand.');
    }
  };
  const shareNative = async () => {
    try {
      await navigator.share({ title, text });
    } catch {
      /* the person closed the share menu */
    }
  };

  return (
    <div className="tk-modal-bg" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="tk-modal card" role="dialog" aria-modal="true" aria-labelledby="share-title">
        <div className="tk-modal-head">
          <h3 id="share-title" className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">share</span>Share with family</h3>
          <button className="btn-icon-bg" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
        {extra}
        <h4 className="tk-sub"><span className="material-symbols-outlined" aria-hidden="true">chat</span>Send as a message</h4>
        <div className="tk-row">
          <div className="field tk-grow">
            <label htmlFor="share-day">What to send</label>
            <select id="share-day" value={String(day)} onChange={(e) => setDay(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
              <option value="all">Whole trip</option>
              {arr(trip.plan.days).map((d) => <option key={d.day} value={d.day}>Day {d.day}{d.title ? ` — ${d.title}` : ''}</option>)}
            </select>
          </div>
          <label className="tk-check tk-share-links"><input type="checkbox" checked={links} onChange={(e) => setLinks(e.target.checked)} /><span>Map links</span></label>
        </div>
        <div className="field">
          <label htmlFor="share-text">Message (you can edit it)</label>
          <textarea id="share-text" className="tk-share-text" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <div className="tk-row">
          <a className="btn-accent tk-wa" target="_blank" rel="noopener noreferrer"
            href={`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`}>
            <span className="material-symbols-outlined" aria-hidden="true">chat</span>WhatsApp
          </a>
          {canShare && <button className="btn-secondary" onClick={shareNative}>Share…</button>}
          <button className="btn-secondary" onClick={copy}>Copy</button>
        </div>
        {note && <p className="tk-small tk-ok" role="status">{note}</p>}
      </div>
    </div>
  );
}
