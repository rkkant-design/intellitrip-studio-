/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * POST /api/pack: starts a packing list for a planned trip as an OpenAI
 * background job and returns its id. The browser checks on it through /api/job.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { guard, json } from '../shared/guard';
import { OpenAIError, startJob } from '../shared/openai';
import { PACK_SCHEMA, SYSTEM_PROMPT, tripContext, type TripRequest } from '../shared/prompts';

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const blocked = await guard(event, 'start', Number(process.env.RATE_LIMIT_PER_MIN || 10));
  if (blocked) return blocked;

  let req: TripRequest & { planSummary?: string };
  try {
    req = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request body.' });
  }
  if (!String(req.destination || '').trim()) return json(400, { error: 'Missing trip details.' });

  try {
    const summary = String(req.planSummary || '').slice(0, 1500);
    const jobId = await startJob(SYSTEM_PROMPT, tripContext(req) + '\nPlan summary: ' + summary + '\n\n' + PACK_SCHEMA);
    return json(200, { jobId });
  } catch (err) {
    console.error('Packing list start failed:', err);
    const status = err instanceof OpenAIError ? err.status : 500;
    return json(status === 429 ? 429 : 502, {
      error: status === 429
        ? 'The AI account is out of credits or busy. Check OpenAI billing, or try again in a moment.'
        : "Couldn't start the packing list. Please try again.",
    });
  }
};

export { handler };
