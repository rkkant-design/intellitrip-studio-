/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Trip Wallet: a fuel estimate from the trip's real driving distance and the
 * car's mileage, plus a quick expense log compared with the plan's budget.
 * No AI involved: it works offline and is saved with the trip.
 */

import React, { useMemo, useState } from 'react';
import {
  type Expense, type Profile, type SavedTrip, type Wallet, arr, formatINR, fuelUnits, todayStr, addDays,
} from './tripkit';

export const CATEGORIES = ['Fuel', 'Tolls', 'Food', 'Stay', 'Tickets', 'Shopping', 'Local travel', 'Other'];

// Which spending categories a plan budget line covers, from its wording.
const BUDGET_MATCH: [RegExp, string[]][] = [
  [/fuel|petrol|diesel|toll/i, ['Fuel', 'Tolls']],
  [/stay|hotel|accommodation|resort|homestay|lodg/i, ['Stay']],
  [/food|meal|dining|eat/i, ['Food']],
  [/ticket|entry|entrance|activit|boat|darshan/i, ['Tickets']],
  [/local|transport|parking|taxi|cab|auto/i, ['Local travel']],
  [/shop|souvenir/i, ['Shopping']],
];

/** A new expense added to a trip (newest first). `by` is who logged it, on trips shared with family. */
export function withExpense(trip: SavedTrip, e: Omit<Expense, 'id' | 'at'>): SavedTrip {
  const w: Wallet = trip.wallet || {};
  const expense: Expense = { ...e, id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString() };
  return { ...trip, wallet: { ...w, expenses: [expense, ...arr(w.expenses)] } };
}

const num = (v: unknown) => {
  const n = parseFloat(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Total driving distance: the map check's real km per drive where available, else the plan's own. */
export function drivingKm(trip: SavedTrip): { km: number; fromMap: boolean } {
  const legs = arr(trip.plan.roadTrip && typeof trip.plan.roadTrip === 'object' ? trip.plan.roadTrip.legs : []);
  let km = 0;
  let fromMap = legs.length > 0;
  legs.forEach((leg, i) => {
    const real = trip.checks?.legs[String(i)];
    if (real) km += real.km;
    else {
      km += num(leg.distanceKm);
      fromMap = false;
    }
  });
  return { km: Math.round(km), fromMap };
}

/** Planned amount per spending category, and the plan's total (buffers count only in the total). */
export function plannedByCategory(trip: SavedTrip) {
  const planned: Record<string, number> = {};
  let total = 0;
  for (const b of arr(trip.plan.budget)) {
    const amount = num(b.amountInr);
    total += amount;
    const match = BUDGET_MATCH.find(([re]) => re.test(String(b.item || '')));
    if (!match) continue;
    // A line like "Fuel & tolls" is shown under its first category.
    planned[match[1][0]] = (planned[match[1][0]] || 0) + amount;
  }
  return { planned, total };
}

export const tripDays = (trip: SavedTrip) => Math.max(1, arr(trip.plan.days).length || Number(trip.form.duration) + 1 || 1);

/** The trip day for today's date, or day 1 before the trip and the last day after it. */
export const defaultDay = (trip: SavedTrip) => {
  const start = trip.form.startDate;
  if (!start) return 1;
  const today = todayStr();
  for (let d = 1; d <= tripDays(trip); d++) if (addDays(start, d - 1) === today) return d;
  return today > start ? tripDays(trip) : 1;
};

export function WalletCard({ trip, profile, onChange, by }: { trip: SavedTrip; profile: Profile; onChange: (t: SavedTrip) => void; by?: string }) {
  const w: Wallet = trip.wallet || {};
  const fuelType = w.fuelType || profile.fuelType || 'Petrol';
  const units = fuelUnits(fuelType);
  const mileageText = w.mileage ?? profile.mileage ?? '';
  const priceText = w.fuelPrice ?? profile.fuelPrice ?? '';
  const extraText = w.extraKm ?? '';
  const mileage = num(mileageText);
  const price = num(priceText);
  const extraKm = num(extraText);
  const { km, fromMap } = drivingKm(trip);
  const totalKm = km + extraKm;
  const fuelQty = mileage > 0 ? totalKm / mileage : 0;
  const fuelCost = fuelQty * price;

  const expenses = arr(w.expenses);
  const { planned, total: plannedTotal } = useMemo(() => plannedByCategory(trip), [trip]);
  const spentBy: Record<string, number> = {};
  for (const e of expenses) spentBy[e.category] = (spentBy[e.category] || 0) + e.amount;
  const spent = expenses.reduce((s, e) => s + e.amount, 0);
  const left = plannedTotal - spent;

  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Food');
  const [day, setDay] = useState(() => defaultDay(trip));
  const [note, setNote] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const setWallet = (patch: Partial<Wallet>) => onChange({ ...trip, wallet: { ...w, ...patch } });
  const add = () => {
    const value = num(amount);
    if (!value) return;
    onChange(withExpense(trip, { amount: Math.round(value), category, day, note: note.trim() || undefined, by }));
    setAmount('');
    setNote('');
  };
  const remove = (id: string) => {
    setWallet({ expenses: expenses.filter((e) => e.id !== id) });
    setConfirmId(null);
  };

  // Plans budget "Fuel & tolls" as one line, so tolls are compared together with fuel.
  const rows = [
    { label: 'Fuel & tolls', planned: planned.Fuel || 0, spent: (spentBy.Fuel || 0) + (spentBy.Tolls || 0) },
    ...CATEGORIES.filter((c) => c !== 'Fuel' && c !== 'Tolls').map((c) => ({ label: c, planned: planned[c] || 0, spent: spentBy[c] || 0 })),
  ].filter((r) => r.planned || r.spent);
  const days = Array.from({ length: tripDays(trip) }, (_, i) => i + 1);

  return (
    <div className="card tk-card tk-wallet">
      <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">account_balance_wallet</span>Trip Wallet</h3>

      <h4 className="tk-sub">Fuel estimate</h4>
      {km > 0 ? (
        <p>
          <strong className="tk-mono">{totalKm.toLocaleString('en-IN')} km</strong> of driving
          {mileage > 0 ? (
            <> ÷ {mileage} {units.mileage} = <strong className="tk-mono">{fuelQty.toFixed(1)} {units.unit === 'litre' ? 'L' : units.unit}</strong>
              {price > 0 && <> → about <strong className="tk-ok-text tk-mono">{formatINR(fuelCost)}</strong></>}</>
          ) : ' — add your car\'s mileage below to estimate fuel.'}
          <span className="tk-dim tk-small"> ({fromMap ? 'real road distances from the map check' : "the plan's own distances"}{extraKm ? `, plus ${extraKm} km local driving` : ''})</span>
        </p>
      ) : (
        <p className="tk-dim">This plan has no drives, so there's no fuel to estimate.</p>
      )}
      {km > 0 && planned.Fuel ? (
        <p className="tk-small tk-dim">The plan budgets {formatINR(planned.Fuel)} for fuel and tolls{fuelCost && price ? `; fuel alone is about ${formatINR(fuelCost)}` : ''}.</p>
      ) : null}
      <div className="tk-wallet-fuel">
        <div className="field">
          <label htmlFor="w-fuel">Fuel</label>
          <select id="w-fuel" value={fuelType} onChange={(e) => setWallet({ fuelType: e.target.value })}>
            {['Petrol', 'Diesel', 'CNG', 'Electric'].map((o) => <option key={o}>{o}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="w-mileage">{units.mileage}</label>
          <input id="w-mileage" inputMode="decimal" value={mileageText} placeholder="e.g. 15"
            onChange={(e) => setWallet({ mileage: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="w-price">₹ per {units.unit}</label>
          <input id="w-price" inputMode="decimal" value={priceText} placeholder="e.g. 102"
            onChange={(e) => setWallet({ fuelPrice: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="w-extra">Local driving (km)</label>
          <input id="w-extra" inputMode="numeric" value={extraText} placeholder="0"
            onChange={(e) => setWallet({ extraKm: e.target.value })} />
        </div>
      </div>

      <h4 className="tk-sub">Spending</h4>
      <div className="tk-wallet-total">
        <span><strong className="tk-mono">{formatINR(spent)}</strong> spent{plannedTotal ? <> of <span className="tk-mono">{formatINR(plannedTotal)}</span> planned</> : ''}</span>
        {plannedTotal > 0 && (
          <span className={`tk-mono ${left < 0 ? 'tk-over' : 'tk-ok-text'}`}>{left < 0 ? `${formatINR(-left)} over` : `${formatINR(left)} left`}</span>
        )}
      </div>
      {plannedTotal > 0 && (
        <div className="tk-progress"><i className={left < 0 ? 'over' : ''} style={{ width: `${Math.min(100, (spent / plannedTotal) * 100)}%` }} /></div>
      )}

      <div className="tk-wallet-add">
        <div className="field">
          <label htmlFor="w-amount">Amount (₹)</label>
          <input id="w-amount" inputMode="decimal" value={amount} placeholder="e.g. 450"
            onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        </div>
        <div className="field">
          <label htmlFor="w-day">Day</label>
          <select id="w-day" value={day} onChange={(e) => setDay(Number(e.target.value))}>
            {days.map((d) => <option key={d} value={d}>Day {d}</option>)}
          </select>
        </div>
        <div className="field tk-wallet-note">
          <label htmlFor="w-note">Note (optional)</label>
          <input id="w-note" value={note} placeholder="e.g. Lunch at A2B" onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()} />
        </div>
      </div>
      <div className="tk-chips" role="radiogroup" aria-label="Category">
        {CATEGORIES.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={category === c}
            className={`tk-chip-btn ${category === c ? 'on' : ''}`} onClick={() => setCategory(c)}>{c}</button>
        ))}
      </div>
      <div><button className="btn-accent" onClick={add} disabled={!num(amount)}>Add expense</button></div>

      {rows.length > 0 && (
        <div className="tk-table-wrap">
          <table className="tk-table">
            <thead><tr><th>Category</th><th className="num">Planned</th><th className="num">Spent</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="num">{r.planned ? formatINR(r.planned) : '—'}</td>
                  <td className={`num ${r.planned && r.spent > r.planned ? 'tk-over' : ''}`}>{formatINR(r.spent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {expenses.length > 0 ? (
        <div className="tk-expenses">
          {days.filter((d) => expenses.some((e) => e.day === d)).map((d) => (
            <div key={d}>
              <div className="tk-expense-day">
                <span>Day {d}</span>
                <span className="tk-mono">{formatINR(expenses.filter((e) => e.day === d).reduce((s, e) => s + e.amount, 0))}</span>
              </div>
              {expenses.filter((e) => e.day === d).map((e) => (
                <div key={e.id} className="tk-expense">
                  <span className="tk-chip util">{e.category}</span>
                  <span className="tk-grow">{e.note || ''}{e.by && trip.share ? <span className="tk-dim"> · {e.by}</span> : null}</span>
                  <span className="tk-mono">{formatINR(e.amount)}</span>
                  {confirmId === e.id ? (
                    <button className="btn-secondary tk-danger" onClick={() => remove(e.id)}>Delete</button>
                  ) : (
                    <button className="btn-icon-bg" aria-label={`Delete ${e.category} ${formatINR(e.amount)}`} onClick={() => setConfirmId(e.id)}>
                      <span className="material-symbols-outlined" aria-hidden="true">delete</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <p className="tk-dim tk-small">Log spends as you go: pick a category, type the amount, tap Add. Everything stays with this trip.</p>
      )}
    </div>
  );
}
