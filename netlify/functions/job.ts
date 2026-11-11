/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * GET  /api/job?id=resp_...  reports on a plan or packing job; once it is done,
 *                            returns the cleaned result.
 * POST /api/job?id=resp_...&cancel=1  stops a job nobody is waiting for any more.
 *
 * Only the person who started a job can read or cancel it. Jobs remember their
 * owner in OpenAI metadata; jobs from before that existed carry none and stay open.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { callerOf, guard, json } from '../shared/guard';
import { cancelJob, cleanText, extractJson, getJob, mergeSources, OpenAIError, readOutput } from '../shared/openai';

const handler: Handler = async (event: HandlerEvent) => {
  // The browser checks every few seconds, so this bucket allows far more calls than starting a job does.
  const blocked = await guard(event, 'poll', 60);
  if (blocked) return blocked;
  const uid = callerOf.get(event) || null;

  const id = event.queryStringParameters?.id || '';
  if (!/^resp_[A-Za-z0-9]{10,100}$/.test(id)) return json(400, { error: 'Unknown job.' });
  const cancelling = event.httpMethod === 'POST' && Boolean(event.queryStringParameters?.cancel);
  if (!cancelling && event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed.' });

  let data: any;
  try {
    data = await getJob(id);
  } catch (err) {
    if (err instanceof OpenAIError && err.status === 404) {
      return json(200, { status: 'error', error: 'This plan is no longer available. Try again.' });
    }
    // Couldn't reach the AI just now (a network blip, a slow reply): the browser simply asks again.
    console.error('Job check failed:', err);
    return json(502, { error: 'Could not reach the AI just now.' });
  }

  const owner = data?.metadata?.uid;
  if (uid && owner && owner !== uid) return json(404, { error: 'Unknown job.' });

  if (cancelling) {
    await cancelJob(id).catch(() => undefined);
    return json(200, { status: 'cancelled' });
  }

  const status: string = data?.status;
  if (status === 'queued' || status === 'in_progress') return json(200, { status: 'running' });
  if (status === 'failed') {
    console.error('Job failed:', data?.error);
    return json(200, { status: 'error', error: "The AI couldn't finish this one. Please try again." });
  }
  if (status === 'cancelled') return json(200, { status: 'error', error: 'This plan was cancelled. Try again.' });
  if (status === 'incomplete') {
    console.error('Job incomplete:', data?.incomplete_details);
    const tooLong = data?.incomplete_details?.reason === 'max_output_tokens';
    return json(200, { status: 'error', error: tooLong ? 'The plan came out too long to finish. Try fewer nights, or try again.' : 'The AI stopped before finishing. Please try again.' });
  }

  try {
    const { text, cited } = readOutput(data);
    const parsed = extractJson(text);
    const listed = parsed.sources;
    const result = cleanText(parsed);
    if ('days' in result || 'summary' in result) result.sources = mergeSources(listed, cited);
    return json(200, { status: 'done', result });
  } catch (err) {
    // The job finished but its answer couldn't be read: asking again won't help.
    console.error('Job result unreadable:', err);
    return json(200, { status: 'error', error: "The AI reply wasn't in the expected format. Try again." });
  }
};

export { handler };
