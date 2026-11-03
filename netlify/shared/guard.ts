/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Request gates shared by every AI function: same-origin check, Firebase login
 * (once FIREBASE_PROJECT_ID is set) and a best-effort per-client rate limit.
 * All of them run before any OpenAI spend.
 */

import type { HandlerEvent } from '@netlify/functions';
import { createRemoteJWKSet, jwtVerify } from 'jose';

// --- Interim abuse protection (until real auth lands) ---
// Best-effort per-client rate limit. Netlify functions are serverless, so this
// counter lives per warm instance (resets on cold start, not shared across
// concurrent instances). It blocks naive loops for free.
const WINDOW_MS = 60_000;
const hitStore: Map<string, number[]> = ((globalThis as any).__itHits ??= new Map<string, number[]>());

export const clientIp = (event: HandlerEvent): string =>
  event.headers['x-nf-client-connection-ip'] ||
  (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  'unknown';

export const isRateLimited = (key: string, limitPerMin: number): boolean => {
  const now = Date.now();
  const recent = (hitStore.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hitStore.set(key, recent);
  if (hitStore.size > 5000) {
    // Prevent unbounded growth on a long-lived instance.
    for (const [k, v] of hitStore) {
      if (!v.some((t) => now - t < WINDOW_MS)) hitStore.delete(k);
    }
  }
  return recent.length > limitPerMin;
};

// Same-origin gate: the app is browser-only, so a legitimate request always
// carries an Origin/Referer from our own site. Extra hosts via ALLOWED_ORIGINS.
const extraAllowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const isAllowedOrigin = (event: HandlerEvent): boolean => {
  const host = event.headers.host || '';
  const source = event.headers.origin || event.headers.referer || '';
  if (!source) return false;
  let reqHost = '';
  try {
    reqHost = new URL(source).host;
  } catch {
    return false;
  }
  return (
    reqHost === host ||
    reqHost.startsWith('localhost') ||
    reqHost.startsWith('127.0.0.1') ||
    extraAllowed.includes(reqHost)
  );
};

// --- Firebase ID token verification ---
// Auth is REQUIRED once FIREBASE_PROJECT_ID is set. Tokens are verified against
// Google's public keys, so no service-account secret is needed.
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const firebaseJwks = FIREBASE_PROJECT_ID
  ? createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'))
  : null;

// Returns the caller's uid, or null when auth is not required. Throws on a
// missing/invalid token when auth IS required.
export const verifyAuth = async (event: HandlerEvent): Promise<string | null> => {
  if (!FIREBASE_PROJECT_ID || !firebaseJwks) return null;
  const authz = event.headers.authorization || event.headers.Authorization || '';
  const match = /^Bearer (.+)$/.exec(authz as string);
  if (!match) throw new Error('Missing bearer token');
  const { payload } = await jwtVerify(match[1], firebaseJwks, {
    issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
    audience: FIREBASE_PROJECT_ID,
  });
  if (!payload.sub) throw new Error('Token has no subject');
  return payload.sub;
};

export const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

/** Runs every gate; returns an error response, or null when the request may proceed. */
export const guard = async (event: HandlerEvent, bucket: string, limitPerMin: number) => {
  if (!isAllowedOrigin(event)) return json(403, { error: 'Forbidden.' });
  let uid: string | null = null;
  try {
    uid = await verifyAuth(event);
  } catch {
    return json(401, { error: 'Please sign in to continue.' });
  }
  if (isRateLimited(`${bucket}:${uid || clientIp(event)}`, limitPerMin)) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return json(500, { error: 'Server is not configured. Missing OPENAI_API_KEY.' });
  }
  return null;
};
