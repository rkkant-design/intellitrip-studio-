/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * POST /api/plan: starts a trip plan as an OpenAI background job and returns
 * its id at once. The browser then checks on it through /api/job.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { callerOf, guard, json, parseBody } from '../shared/guard';
import { OpenAIError, startJob } from '../shared/openai';
import { PLAN_SCHEMA, SYSTEM_PROMPT, tripContext, type TripRequest } from '../shared/prompts';

const handler: Handler = async (event: HandlerEvent) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
  const blocked = await guard(event, 'start', Number(process.env.RATE_LIMIT_PER_MIN || 10));
  if (blocked) return blocked;

  const parsed = parseBody<TripRequest>(event);
  if (!parsed) return json(400, { error: 'Invalid request body.' });
  const req: TripRequest = parsed;
  if (!String(req.destination || '').trim() || !String(req.fromLocation || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(req.startDate || ''))) {
    return json(400, { error: 'Please fill in where you start, where you are going, and the start date.' });
  }
  if (!(Number(req.duration) >= 1)) return json(400, { error: 'Please enter at least 1 night.' });

  try {
    const jobId = await startJob(SYSTEM_PROMPT, tripContext(req) + '\n\n' + PLAN_SCHEMA, { uid: callerOf.get(event) });
    return json(200, { jobId });
  } catch (err) {
    console.error('Plan start failed:', err);
    const status = err instanceof OpenAIError ? err.status : 500;
    return json(status === 429 ? 429 : 502, {
      error: status === 429
        ? 'The AI account is out of credits or busy. Check OpenAI billing, or try again in a moment.'
        : "Couldn't start the plan. Please try again.",
    });
  }
};

export { handler };
