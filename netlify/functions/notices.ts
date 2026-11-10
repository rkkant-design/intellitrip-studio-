/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * POST /api/notices: looks up current official road notices (closures, night
 * bans, e-pass rules, rain alerts) for a planned trip's drives and dates, as an
 * OpenAI background job with web search. The browser checks on it through /api/job.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { guard, json } from '../shared/guard';
import { OpenAIError, startJob } from '../shared/openai';
import { noticesInput, SYSTEM_PROMPT, type TripRequest } from '../shared/prompts';

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const blocked = await guard(event, 'start', Number(process.env.RATE_LIMIT_PER_MIN || 10));
  if (blocked) return blocked;

  let body: TripRequest & { plan?: unknown };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request body.' });
  }
  if (!String(body.destination || '').trim() || !body.plan || typeof body.plan !== 'object') {
    return json(400, { error: 'Missing the trip.' });
  }
  if (JSON.stringify(body.plan).length > 200_000) return json(400, { error: 'This plan is too large.' });

  try {
    // A handful of targeted searches is enough here, and keeps the check to a couple of minutes.
    const jobId = await startJob(SYSTEM_PROMPT, noticesInput(body, body.plan), { maxSearches: 6 });
    return json(200, { jobId });
  } catch (err) {
    console.error('Notices start failed:', err);
    const status = err instanceof OpenAIError ? err.status : 500;
    return json(status === 429 ? 429 : 502, {
      error: status === 429
        ? 'The AI account is out of credits or busy. Check OpenAI billing, or try again in a moment.'
        : "Couldn't start the road notices check. Please try again.",
    });
  }
};

export { handler };
