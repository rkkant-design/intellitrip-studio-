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
import { connectLambda, getStore } from '@netlify/blobs';

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
  if (recent.length >= limitPerMin) {
    hitStore.set(key, recent);
    return true;
  }
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
  // Local addresses count only when the server itself is local (development), never in production.
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
  return reqHost === host || (local.test(reqHost) && local.test(host)) || extraAllowed.includes(reqHost);
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
  const fb = (payload as any).firebase || {};
  if (fb.sign_in_provider === 'anonymous') throw new Error('Anonymous sign-in is not allowed');
  // Optional: only these Google accounts may use the AI (comma-separated emails in ALLOWED_EMAILS).
  const allowed = (process.env.ALLOWED_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String((payload as any).email || '').toLowerCase())) throw new Error('Not on the allowed list');
  return payload.sub;
};

// Who made each request, for tying AI jobs to the person who started them.
export const callerOf = new WeakMap<object, string | null>();

// --- Daily AI allowance per person ---
// Each plan, change, packing list or notices check is one AI job. The count lives in Netlify Blobs,
// so it holds across server instances (the per-minute limit above does not). If the store can't be
// reached the request still goes through, with the per-minute limit as the only brake.
const DAILY_JOBS = Number(process.env.DAILY_AI_JOBS || 25);
async function useDailyAllowance(event: HandlerEvent, uid: string): Promise<boolean> {
  try {
    connectLambda(event as any);
    const store = getStore('ai-usage');
    const key = `${new Date().toISOString().slice(0, 10)}/${uid}`;
    const used = Number((await store.get(key)) || 0);
    if (used >= DAILY_JOBS) return false;
    await store.set(key, String(used + 1));
    return true;
  } catch (err) {
    console.warn('Daily allowance store unavailable:', (err as Error).message);
    return true;
  }
}

/** The request body as an object, or null when it isn't JSON of the right shape. */
export const parseBody = <T,>(event: HandlerEvent): T | null => {
  try {
    const v = JSON.parse(event.body || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null;
  } catch {
    return null;
  }
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
  callerOf.set(event, uid);
  if (isRateLimited(`${bucket}:${uid || clientIp(event)}`, limitPerMin)) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.' });
  }
  if (bucket === 'start' && uid && !(await useDailyAllowance(event, uid))) {
    return json(429, { error: `You've reached today's limit of ${DAILY_JOBS} AI requests. It resets at midnight (UTC).` });
  }
  if (!process.env.OPENAI_API_KEY) {
    return json(500, { error: 'Server is not configured. Missing OPENAI_API_KEY.' });
  }
  return null;
};
