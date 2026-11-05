/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Booking reminders: turns a trip's deadlines (the plan's "Book by" list, car
 * check, FASTag top-up, the leave-home checklist and the trip itself) into
 * calendar events. One calendar file (.ics) adds them all with alerts the day
 * before and on the day; a Google Calendar link per reminder covers Android
 * phones, whose Google Calendar app can't open calendar files.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { type SavedTrip, addDays, arr, endDateOf, fmtDate, todayStr } from './tripkit';

export interface Reminder {
  id: string;
  title: string;
  date: string; // YYYY-MM-DD; all-day
  endDate?: string; // last day, for events longer than a day
  details: string;
  past: boolean;
}

const isDate = (s?: string) => Boolean(s && /^\d{4}-\d{2}-\d{2}$/.test(s));

/** Everything worth a calendar reminder for this trip, in date order. */
export function remindersFor(trip: SavedTrip): Reminder[] {
  const { plan: p, form: f } = trip;
  const name = p.title || f.destination;
  const start = f.startDate;
  const today = todayStr();
  const list: Omit<Reminder, 'past'>[] = [];

  for (const b of arr(p.bookBy)) {
    if (!b.item || !isDate(b.deadline)) continue;
    list.push({
      id: `book-${b.item}-${b.deadline}`,
      title: `Book: ${b.item}`,
      date: b.deadline!,
      details: [
        `For ${name}.`,
        b.opens && b.opens !== 'now' && isDate(b.opens) ? `Booking opens ${fmtDate(b.opens)}.` : '',
        b.where ? `Where: ${b.where}.` : '',
        b.note || '',
      ].filter(Boolean).join(' '),
    });
  }

  if (isDate(start)) {
    const driving = Boolean(p.roadTrip && typeof p.roadTrip === 'object' && arr(p.roadTrip.legs).length) || /road trip/i.test(f.mode || '');
    if (driving) {
      list.push({ id: 'car-check', title: 'Get the car checked for the trip', date: addDays(start, -7),
        details: `Before ${name}: tyres and spare, brakes, oil, coolant, wipers, AC.` });
      list.push({ id: 'fastag', title: 'Top up FASTag and check car papers', date: addDays(start, -2),
        details: `Before ${name}: FASTag balance; RC, insurance and PUC valid; download offline maps.` });
    }
    list.push({ id: 'leave-home', title: 'Leave-home checklist tonight', date: addDays(start, -1),
      details: `Tomorrow: ${name}. Run the leave-home checklist in IntelliTrip's Toolkit tab (gas, water, locks, chargers).` });
    list.push({ id: 'trip', title: `Trip: ${name}`, date: start, endDate: endDateOf(f),
      details: `${f.fromLocation} → ${f.destination}. ${p.summary || ''}`.trim() });
  }

  const seen = new Set<string>();
  return list
    .filter((r) => (seen.has(r.title + r.date) ? false : (seen.add(r.title + r.date), true)))
    .map((r) => ({ ...r, past: r.date < today }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// --- calendar file (RFC 5545) ---

const icsDate = (iso: string) => iso.replace(/-/g, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 bytes are folded onto continuation lines that start with a space.
function fold(line: string): string {
  const bytes = new TextEncoder();
  const out: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (bytes.encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function toIcs(reminders: Reminder[], trip: SavedTrip): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//IntelliTrip//Trip reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const r of reminders) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${trip.id}-${r.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 60)}-${icsDate(r.date)}@intellitrip`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(r.date)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(r.endDate || r.date, 1))}`,
      `SUMMARY:${icsText(r.title)}`,
      `DESCRIPTION:${icsText(r.details)}`,
      'TRANSP:TRANSPARENT',
      // All-day events start at midnight: -15h is 9 am the day before, +9h is 9 am on the day.
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(r.title)}`, 'TRIGGER:-PT15H', 'END:VALARM',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(r.title)}`, 'TRIGGER:PT9H', 'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export const googleCalendarLink = (r: Reminder) =>
  'https://calendar.google.com/calendar/render?action=TEMPLATE' +
  `&text=${encodeURIComponent(r.title)}` +
  `&dates=${icsDate(r.date)}/${icsDate(addDays(r.endDate || r.date, 1))}` +
  `&details=${encodeURIComponent(r.details)}`;

const fileName = (trip: SavedTrip) =>
  `${(trip.plan.title || trip.form.destination || 'trip').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'trip'}-reminders.ics`;

function downloadIcs(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- UI ---

export function RemindersSheet({ trip, onClose }: { trip: SavedTrip; onClose: () => void }) {
  const all = useMemo(() => remindersFor(trip), [trip]);
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(all.map((r) => [r.id, !r.past])));
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const chosen = all.filter((r) => picked[r.id]);

  return (
    <div className="tk-modal-bg" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tk-modal card" role="dialog" aria-modal="true" aria-labelledby="rem-title">
        <div className="tk-modal-head">
          <h3 id="rem-title" className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">event</span>Calendar reminders</h3>
          <button className="btn-icon-bg" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
        {all.length === 0 ? (
          <p className="tk-dim">This trip has no start date or deadlines to remind you about.</p>
        ) : (
          <>
            <div className="tk-reminders">
              {all.map((r) => (
                <div key={r.id} className={`tk-reminder ${r.past ? 'past' : ''}`}>
                  <label className="tk-check">
                    <input type="checkbox" checked={!!picked[r.id]} onChange={(e) => setPicked({ ...picked, [r.id]: e.target.checked })} />
                    <span>
                      <strong>{r.title}</strong>
                      <span className="tk-dim tk-mono"> · {fmtDate(r.date)}{r.endDate && r.endDate !== r.date ? ` – ${fmtDate(r.endDate)}` : ''}{r.past ? ' (passed)' : ''}</span>
                    </span>
                  </label>
                  <a className="tk-gcal" href={googleCalendarLink(r)} target="_blank" rel="noopener noreferrer" title="Add this one to Google Calendar">
                    <span className="material-symbols-outlined" aria-hidden="true">calendar_add_on</span>Google
                  </a>
                </div>
              ))}
            </div>
            <div className="tk-row">
              <button className="btn-accent" disabled={!chosen.length}
                onClick={() => { downloadIcs(toIcs(chosen, trip), fileName(trip)); setNote('Calendar file saved. Open it to add the reminders to your calendar.'); }}>
                Add {chosen.length} to calendar (.ics)
              </button>
            </div>
            {note && <p className="tk-small tk-ok" role="status">{note}</p>}
            <p className="tk-dim tk-small">
              The calendar file alerts you at 9 am the day before and on the day. iPhone: tap the file and choose Add All.
              Android with the Google Calendar app: use the Google link next to each reminder instead.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export function RemindersCard({ trip, onOpen }: { trip: SavedTrip; onOpen: () => void }) {
  const upcoming = remindersFor(trip).filter((r) => !r.past);
  const next = upcoming[0];
  return (
    <div className="card info-card">
      <h3>Reminders</h3>
      {next ? (
        <p className="tk-small">Next: <strong>{next.title}</strong> by {fmtDate(next.date)}{upcoming.length > 1 ? `, and ${upcoming.length - 1} more` : ''}.</p>
      ) : (
        <p className="tk-dim tk-small">No upcoming deadlines for this trip.</p>
      )}
      <button className="btn-secondary tk-share-btn" onClick={onOpen} disabled={!upcoming.length}>
        <span className="material-symbols-outlined" aria-hidden="true">event</span>Add to calendar
      </button>
    </div>
  );
}
