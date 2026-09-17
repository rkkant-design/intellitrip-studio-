/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Server-side itinerary + vibe-image generation.
 * The Gemini API key lives ONLY here (Netlify env var GEMINI_API_KEY) and is
 * never sent to the browser. The client calls POST /api/generate.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { GoogleGenAI, Type } from '@google/genai';

// Models are configurable via env so we can move between Gemini versions
// without a code change. Defaults are current GA models.
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.6-flash';
// gemini-2.5-flash-image is deprecated (shutdown 2026-10-02) -> use 3.1-flash-image.
const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

// --- Interim abuse protection (until real auth lands) ---
// Best-effort per-IP rate limit. Netlify functions are serverless, so this
// counter lives per warm instance (resets on cold start, not shared across
// concurrent instances). It blocks naive loops for free; a shared store
// (Netlify Blobs / Upstash) is the robust upgrade path once auth is in.
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN || 10);
const WINDOW_MS = 60_000;
const hitStore: Map<string, number[]> =
  ((globalThis as any).__itHits ??= new Map<string, number[]>());

const clientIp = (event: HandlerEvent): string =>
  event.headers['x-nf-client-connection-ip'] ||
  (event.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  'unknown';

const isRateLimited = (ip: string): boolean => {
  const now = Date.now();
  const recent = (hitStore.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hitStore.set(ip, recent);
  if (hitStore.size > 5000) {
    // Prevent unbounded growth on a long-lived instance.
    for (const [k, v] of hitStore) {
      if (!v.some((t) => now - t < WINDOW_MS)) hitStore.delete(k);
    }
  }
  return recent.length > RATE_LIMIT;
};

// Same-origin gate: the app is browser-only, so a legitimate request always
// carries an Origin/Referer from our own site. Reject anything else (blocks
// casual curl/bot loops and other sites calling the endpoint). Extra hosts can
// be allowed via ALLOWED_ORIGINS (comma-separated host names).
const extraAllowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const isAllowedOrigin = (event: HandlerEvent): boolean => {
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

interface GenerateRequest {
  fromLocation?: string;
  destination?: string;
  startDate?: string;
  duration?: number | string;
  adults?: number | string;
  children?: number | string;
  travelType?: string;
  idealTripDescription?: string;
}

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const itinerarySchema = {
  type: Type.OBJECT,
  properties: {
    tripTitle: { type: Type.STRING },
    tripSummary: { type: Type.STRING },
    overallTripTotalCost: { type: Type.NUMBER },
    accommodationRecommendation: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        type: { type: Type.STRING },
        reason: { type: Type.STRING },
        estimatedPricePerNight: { type: Type.NUMBER },
      },
      required: ['name', 'type', 'reason', 'estimatedPricePerNight'],
    },
    costBreakdown: {
      type: Type.OBJECT,
      properties: {
        totalAccommodation: { type: Type.NUMBER },
        totalFood: { type: Type.NUMBER },
        totalMisc: { type: Type.NUMBER },
      },
      required: ['totalAccommodation', 'totalFood', 'totalMisc'],
    },
    dailyItinerary: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          day: { type: Type.NUMBER },
          theme: { type: Type.STRING },
          vibe: { type: Type.STRING },
          narrative: { type: Type.STRING },
          localSecret: { type: Type.STRING },
          activities: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                time: { type: Type.STRING },
                name: { type: Type.STRING },
                description: { type: Type.STRING },
                heroMoment: { type: Type.STRING },
              },
              required: ['time', 'name', 'description', 'heroMoment'],
            },
          },
          liveAlerts: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                condition: {
                  type: Type.STRING,
                  enum: ['Crowded', 'Weather', 'Traffic', 'Closure'],
                },
                description: { type: Type.STRING },
                alternativeSuggestion: { type: Type.STRING },
              },
              required: ['condition', 'description', 'alternativeSuggestion'],
            },
          },
        },
        required: ['day', 'theme', 'narrative', 'localSecret', 'activities', 'liveAlerts'],
      },
    },
  },
  required: [
    'tripTitle',
    'tripSummary',
    'overallTripTotalCost',
    'accommodationRecommendation',
    'costBreakdown',
    'dailyItinerary',
  ],
};

const extractJson = (text: string) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}') + 1;
  if (start === -1 || end === 0) throw new Error('Model returned an unparseable response.');
  return JSON.parse(text.substring(start, end));
};

// Transient, worth-retrying failures: the model is temporarily overloaded.
const isTransient = (err: unknown) => {
  const m = String((err as any)?.message ?? err);
  return m.includes('"code":503') || m.includes('UNAVAILABLE') || m.includes('overloaded');
};

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 1500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1 && isTransient(err)) {
        await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  // Interim abuse protection (runs before we spend any Gemini quota).
  if (!isAllowedOrigin(event)) {
    return json(403, { error: 'Forbidden.' });
  }
  if (isRateLimited(clientIp(event))) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(500, { error: 'Server is not configured. Missing GEMINI_API_KEY.' });
  }

  let form: GenerateRequest;
  try {
    form = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request body.' });
  }

  const destination = (form.destination || '').trim();
  const fromLocation = (form.fromLocation || '').trim();
  const startDate = (form.startDate || '').trim();
  const duration = Number(form.duration) || 0;

  if (!destination || !fromLocation || !startDate || duration < 1) {
    return json(400, {
      error: 'Please provide origin, destination, a start date, and at least 1 night.',
    });
  }

  const adults = Number(form.adults) || 1;
  const children = Number(form.children) || 0;
  const travelType = form.travelType || 'Family';

  const ai = new GoogleGenAI({ apiKey });

  const systemMsg = `You are a world-class travel architect. Create a professional, cinematic itinerary.
Use INR (₹) for all costs.
Include exactly 1 "Local Secret" per day and exactly 1 "Hero Moment" per activity.
Include exactly 2 "Live Alerts" per day regarding potential crowd spikes, weather changes, traffic, or closures at recommended spots, each with a concrete alternative suggestion.
Provide exactly 1 accommodation recommendation (budget-friendly unless the traveller selected 'Luxury').
Always populate every required field, including a full costBreakdown.`;

  const userMsg = `Construct a ${duration}-day ${travelType} trip to ${destination} from ${fromLocation}.
Starting: ${startDate}. Travellers: ${adults} adults, ${children} children.
Vision: ${form.idealTripDescription || 'A memorable, well-paced trip.'}`;

  // Itinerary is required; if it fails the whole request fails.
  let itinerary;
  try {
    const response = await withRetry(() =>
      ai.models.generateContent({
        model: TEXT_MODEL,
        contents: userMsg,
        config: {
          systemInstruction: systemMsg,
          responseMimeType: 'application/json',
          responseSchema: itinerarySchema,
        },
      })
    );
    itinerary = extractJson(response.text ?? '');
  } catch (err: any) {
    console.error('Itinerary generation failed:', err);
    const overloaded = isTransient(err);
    return json(overloaded ? 503 : 502, {
      error: overloaded
        ? 'The curation engine is busy right now. Please try again in a moment.'
        : 'The curation engine could not build this itinerary. Please try again.',
    });
  }

  // The vibe image is a nice-to-have: an image failure (e.g. no image quota on
  // the free tier) must NOT discard the successfully generated itinerary.
  // Set ENABLE_VIBE_IMAGE=false to skip it entirely (avoids a wasted call when
  // your Google project has no image-generation quota / billing).
  let vibeImage: string | null = null;
  const imageEnabled = (process.env.ENABLE_VIBE_IMAGE ?? 'true').toLowerCase() !== 'false';
  if (imageEnabled) {
    try {
      const imageResponse = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents: {
          parts: [
            {
              text: `A cinematic, high-quality, breathtaking travel photograph of ${destination}. Professional landscape photography, no text, vibrant atmosphere.`,
            },
          ],
        },
        config: { imageConfig: { aspectRatio: '16:9' } },
      });

      const parts = imageResponse.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          vibeImage = `data:image/png;base64,${part.inlineData.data}`;
          break;
        }
      }
    } catch (err) {
      console.error('Vibe image generation failed (continuing without it):', err);
    }
  }

  return json(200, { itinerary, vibeImage });
};

export { handler };
