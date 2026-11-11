/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Installing IntelliTrip on the phone's home screen. Chrome on Android offers
 * the install once (often while the landing or sign-in page is showing), so the
 * offer is caught as soon as the app loads and kept for the Install buttons.
 * iPhones never make the offer: Safari's Share → Add to Home Screen does it.
 */

import React, { useEffect, useState } from 'react';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let offer: InstallEvent | null = null;
const listeners = new Set<(e: InstallEvent | null) => void>();
const tell = () => listeners.forEach((f) => f(offer));

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    offer = e as InstallEvent;
    tell();
  });
  window.addEventListener('appinstalled', () => {
    offer = null;
    tell();
  });
}

export const isInstalled = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** Chrome's install offer, when there is one. `install()` shows Chrome's own install dialog. */
export function useInstall() {
  const [e, setE] = useState<InstallEvent | null>(offer);
  useEffect(() => {
    listeners.add(setE);
    setE(offer);
    return () => { listeners.delete(setE); };
  }, []);
  const install = async () => {
    if (!e) return false;
    await e.prompt();
    const choice = await e.userChoice.catch(() => ({ outcome: 'dismissed' }));
    offer = null;
    tell();
    return choice.outcome === 'accepted';
  };
  return { canInstall: Boolean(e), install };
}

/** Toolkit card: an Install button where the browser offers it, and the steps everywhere else. */
export function InstallCard() {
  const { canInstall, install } = useInstall();
  const [done, setDone] = useState(isInstalled);
  if (done) {
    return (
      <div className="card tk-card">
        <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">install_mobile</span>Installed</h3>
        <p className="tk-small">You're using the installed app. It opens without signal; maps, navigation and AI need a connection.</p>
      </div>
    );
  }
  return (
    <div className="card tk-card">
      <h3 className="tk-h3"><span className="material-symbols-outlined" aria-hidden="true">install_mobile</span>Install on your phone</h3>
      <p className="tk-small">Put IntelliTrip on your home screen so Today mode opens straight away, even with no signal in the ghats.</p>
      {canInstall && (
        <div><button className="btn-accent" onClick={async () => setDone(await install())}>Install app</button></div>
      )}
      {isIos() ? (
        <ol className="tk-list tk-small">
          <li>Open this page in <strong>Safari</strong> (other iPhone browsers can't install it).</li>
          <li>Tap the <strong>Share</strong> button (the square with an arrow).</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</li>
        </ol>
      ) : (
        <ol className="tk-list tk-small">
          {canInstall && <li>Tap <strong>Install app</strong> above. Or, by hand:</li>}
          <li>Open this page in <strong>Chrome</strong>.</li>
          <li>Tap the <strong>⋮</strong> menu at the top right.</li>
          <li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>, then <strong>Install</strong>.</li>
        </ol>
      )}
      <p className="tk-dim tk-small">Already installed? Open IntelliTrip from its home-screen icon.</p>
    </div>
  );
}
