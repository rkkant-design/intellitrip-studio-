/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * POST /api/revise: changes part of an existing plan ("redo day 2", "make it
 * cheaper") as an OpenAI background job and returns its id. The browser checks
 * on it through /api/job and merges the result into the saved trip.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { guard, json } from '../shared/guard';
import { OpenAIError, startJob } from '../shared/openai';
import { detailChanges, reviseInput, SYSTEM_PROMPT, type ReviseScope, type TripRequest } from '../shared/prompts';

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const blocked = await guard(event, 'start', Number(process.env.RATE_LIMIT_PER_MIN || 10));
  if (blocked) return blocked;

  // `previous` holds the trip details before this change, when the person edited them.
  let body: TripRequest & { plan?: unknown; scope?: ReviseScope; change?: string; previous?: TripRequest };
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid request body.' });
  }
  const change = String(body.change || '').trim();
  const plan = body.plan;
  const detailsChanged = detailChanges(body.previous, body).length > 0;
  // A change to the trip details always replans the whole trip.
  const scope: ReviseScope = body.scope === 'all' || detailsChanged ? 'all' : Number(body.scope);
  if (!change && !detailsChanged) return json(400, { error: 'Please say what should change.' });
  if (!plan || typeof plan !== 'object' || !Array.isArray((plan as any).days)) return json(400, { error: 'Missing the current plan.' });
  if (scope !== 'all' && !(plan as any).days.some((d: any) => d?.day === scope)) return json(400, { error: 'That day is not in the plan.' });
  if (JSON.stringify(plan).length > 200_000) return json(400, { error: 'This plan is too large to change.' });

  try {
    const jobId = await startJob(SYSTEM_PROMPT, reviseInput(body, plan, scope, change, body.previous));
    return json(200, { jobId });
  } catch (err) {
    console.error('Revise start failed:', err);
    const status = err instanceof OpenAIError ? err.status : 500;
    return json(status === 429 ? 429 : 502, {
      error: status === 429
        ? 'The AI account is out of credits or busy. Check OpenAI billing, or try again in a moment.'
        : "Couldn't start the change. Please try again.",
    });
  }
};

export { handler };
