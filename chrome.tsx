/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The app's frame: the logo, who is signed in (avatar and name on every screen
 * size, with an account menu), and the main tabs (along the top on a laptop,
 * a bottom bar on a phone, where a thumb reaches them).
 */

import React, { useEffect, useRef, useState } from 'react';

export const Logo = ({ small = false }: { small?: boolean }) => (
  <span className={`it-logo ${small ? 'small' : ''}`}>
    <span className="it-logo-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
        <path d="M4 19c4-1 5-6 8-7s5 1 8-6" />
        <circle cx="4" cy="19" r="1.6" fill="#fff" stroke="none" />
        <circle cx="20" cy="6" r="1.6" fill="#fff" stroke="none" />
      </svg>
    </span>
    <span className="it-logo-word">IntelliTrip</span>
  </span>
);

export interface AccountUser { name: string; email?: string; photo?: string; uid?: string }

const initial = (name: string) => (name.trim()[0] || '?').toUpperCase();

export function Avatar({ user, size = 36 }: { user: AccountUser; size?: number }) {
  const [broken, setBroken] = useState(false);
  return user.photo && !broken ? (
    <img className="it-avatar" src={user.photo} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
  ) : (
    <span className="it-avatar" style={{ width: size, height: size }} aria-hidden="true">{initial(user.name)}</span>
  );
}

export function AccountMenu({ user, syncLabel, syncState, onLogout }: {
  user: AccountUser;
  syncLabel: string;
  syncState: string; // off | connecting | saving | synced | offline | error
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const first = user.name.split(/\s+/)[0] || user.name;
  return (
    <div className="it-account" ref={box}>
      <button className="it-account-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
        aria-label={`Signed in as ${user.name}${syncLabel ? `, ${syncLabel}` : ''}. Account menu`}>
        <span className="it-account-name">{first}</span>
        <span className="it-avatar-wrap">
          <Avatar user={user} />
          {syncState !== 'off' && <i className={`it-sync-dot ${syncState}`} aria-hidden="true" />}
        </span>
      </button>
      {open && (
        <div className="it-account-menu card" role="menu">
          <div className="it-account-who">
            <Avatar user={user} size={44} />
            <div>
              <strong>{user.name}</strong>
              {user.email && <span>{user.email}</span>}
            </div>
          </div>
          <p className={`it-account-sync ${syncState}`}>
            <span className="material-symbols-outlined" aria-hidden="true">{syncState === 'off' ? 'phone_android' : syncState === 'error' ? 'cloud_off' : 'cloud_done'}</span>
            {syncState === 'off' ? 'Trips are saved on this device only.' : syncLabel || 'Trips sync to your Google account.'}
          </p>
          <button className="btn-secondary it-signout" role="menuitem" onClick={() => { setOpen(false); onLogout(); }}>
            <span className="material-symbols-outlined" aria-hidden="true">logout</span>Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export type TabId = 'planner' | 'today' | 'archives' | 'toolkit';
const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: 'planner', label: 'Plan', icon: 'add_road' },
  { id: 'today', label: 'Today', icon: 'navigation' },
  { id: 'archives', label: 'My trips', icon: 'luggage' },
  { id: 'toolkit', label: 'Toolkit', icon: 'handyman' },
];

export function MainTabs({ active, onSelect, todayLive }: { active: TabId; onSelect: (t: TabId) => void; todayLive: boolean }) {
  return (
    <nav className="it-tabs" aria-label="Main">
      {TABS.map((t) => (
        <button key={t.id} className={active === t.id ? 'active' : ''} aria-current={active === t.id ? 'page' : undefined} onClick={() => onSelect(t.id)}>
          <span className="it-tab-icon">
            <span className="material-symbols-outlined" aria-hidden="true">{t.icon}</span>
            {t.id === 'today' && todayLive && <i className="it-live-dot" aria-hidden="true" />}
          </span>
          <span className="it-tab-label">{t.label}</span>
          {t.id === 'today' && todayLive && <span className="sr-only">(a trip is on today)</span>}
        </button>
      ))}
    </nav>
  );
}
