/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Safety nets. A part of the page that crashes (most often the map, on a phone or
 * in-app browser without WebGL) shows a short note instead of taking the whole
 * app down with it.
 */

import React from 'react';

/** Whether this browser can draw the interactive map (Mapbox needs WebGL). Checked once. */
let webgl: boolean | null = null;
export function webglOk(): boolean {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement('canvas');
    webgl = Boolean(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch {
    webgl = false;
  }
  return webgl;
}

export class SafeArea extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode; name?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`${this.props.name || 'Part of the page'} failed:`, error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** Shown when the whole app hits an error it can't recover from. Trips stay saved on the device. */
export const AppCrashed = () => (
  <div className="it-crash" role="alert">
    <h1>Something went wrong</h1>
    <p>Your trips are still saved on this device. Reload to carry on.</p>
    <button className="btn-primary" onClick={() => window.location.reload()}>Reload</button>
  </div>
);
