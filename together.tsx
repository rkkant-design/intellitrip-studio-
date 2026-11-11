/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Plan together: invite family to a trip with a link. Everyone who joins sees
 * changes live and can tick packing, mark Today's stops done and log spends.
 */

import React, { useState } from 'react';
import type { SavedTrip } from './tripkit';
import { inviteLink } from './sync';

export function TogetherSection({ trip, uid, onShare, onReset, onLeave }: {
  trip: SavedTrip;
  uid?: string; // signed in with Google
  onShare: () => Promise<unknown>;
  onReset: (removeUid?: string) => Promise<unknown>;
  onLeave: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const s = trip.share;
  const owner = Boolean(s && uid && s.owner === uid);
  const link = inviteLink(trip);
  const title = trip.plan.title || trip.form.destination;
  const message = `Join our trip "${title}" on IntelliTrip, so we can plan, pack and track spends together:\n${link}`;

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e: any) {
      setNote(e?.message || 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setNote('Link copied.');
    } catch {
      setNote('Copy was blocked; long-press the link to copy it.');
    }
  };

  return (
    <div className="tk-together">
      <h4 className="tk-sub"><span className="material-symbols-outlined" aria-hidden="true">group</span>Plan together</h4>
      {!uid ? (
        <p className="tk-small tk-dim">Sign in with Google to invite family to this trip. Everyone who joins sees changes live and can tick packing and log spends.</p>
      ) : !s ? (
        <>
          <p className="tk-small">Invite family with a link. They sign in with Google and see this trip live: changes, packing ticks, Today's stops and spends all sync between your phones.</p>
          <button className="btn-secondary" disabled={busy} onClick={() => run(onShare)}>
            <span className="material-symbols-outlined" aria-hidden="true">group_add</span>{busy ? 'Setting up…' : 'Invite family to plan together'}
          </button>
        </>
      ) : (
        <>
          <ul className="tk-members">
            {s.members.map((m) => (
              <li key={m}>
                <span className="material-symbols-outlined" aria-hidden="true">person</span>
                <span className="tk-grow">{s.names?.[m] || 'Family member'}{m === uid ? ' (you)' : ''}</span>
                {m === s.owner && <span className="tk-chip util">Started it</span>}
                {owner && m !== uid && (confirm === m ? (
                  <button className="btn-secondary tk-danger" disabled={busy} onClick={() => run(() => onReset(m), 'Removed. The old invite link no longer works.')}>Remove</button>
                ) : (
                  <button className="btn-icon-bg" aria-label={`Remove ${s.names?.[m] || 'member'}`} onClick={() => setConfirm(m)}>
                    <span className="material-symbols-outlined" aria-hidden="true">person_remove</span>
                  </button>
                ))}
              </li>
            ))}
          </ul>
          {link && (
            <>
              <div className="tk-invite-link tk-mono tk-small">{link}</div>
              <div className="tk-row">
                <a className="btn-accent tk-wa" target="_blank" rel="noopener noreferrer" href={`https://api.whatsapp.com/send?text=${encodeURIComponent(message)}`}>
                  <span className="material-symbols-outlined" aria-hidden="true">chat</span>Send invite
                </a>
                <button className="btn-secondary" onClick={copy}>Copy link</button>
                {owner && <button className="btn-secondary" disabled={busy} onClick={() => run(() => onReset(), 'New link made. The old one no longer works.')}>New link</button>}
              </div>
            </>
          )}
          <p className="tk-dim tk-small">Anyone with the link can join after signing in, so send it only to family. {owner ? 'Make a new link to stop the old one working.' : ''}</p>
          {!owner && (confirm === 'leave' ? (
            <button className="btn-secondary tk-danger" onClick={onLeave}>Tap again to leave this trip</button>
          ) : (
            <button className="btn-secondary tk-link-btn" onClick={() => setConfirm('leave')}>Leave this trip</button>
          ))}
        </>
      )}
      {note && <p className="tk-small tk-ok" role="status">{note}</p>}
    </div>
  );
}
