/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * GET  /api/job?id=resp_...  reports on a plan or packing job; once it is done,
 *                            returns the cleaned result.
 * POST /api/job?id=resp_...&cancel=1  stops a job nobody is waiting for any more.
 */

import type { Handler, HandlerEvent } from '@netlify/functions';
import { guard, json } from '../shared/guard';
import { cancelJob, cleanText, extractJson, getJob, mergeSources, OpenAIError, readOutput } from '../shared/openai';

const handler: Handler = async (event: HandlerEvent) => {
  // The browser checks every few seconds, so this bucket allows far more calls than starting a job does.
  const blocked = await guard(event, 'poll', 60);
  if (blocked) return blocked;

  const id = event.queryStringParameters?.id || '';
  if (!/^resp_[A-Za-z0-9]{10,100}$/.test(id)) return json(400, { error: 'Unknown job.' });

  try {
    if (event.httpMethod === 'POST' && event.queryStringParameters?.cancel) {
      await cancelJob(id).catch(() => undefined);
      return json(200, { status: 'cancelled' });
    }
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed.' });

    const data = await getJob(id);
    const status: string = data?.status;
    if (status === 'queued' || status === 'in_progress') return json(200, { status: 'running' });
    if (status === 'failed') {
      return json(200, { status: 'error', error: `The AI couldn't finish: ${data?.error?.message || 'unknown error'}. Try again.` });
    }
    if (status === 'cancelled') return json(200, { status: 'error', error: 'This plan was cancelled. Try again.' });
    if (status === 'incomplete') {
      return json(200, { status: 'error', error: `The AI stopped before finishing (${data?.incomplete_details?.reason || 'unknown reason'}). Try again.` });
    }

    const { text, cited } = readOutput(data);
    const parsed = extractJson(text);
    const listed = parsed.sources;
    const result = cleanText(parsed);
    if ('days' in result || 'summary' in result) result.sources = mergeSources(listed, cited);
    return json(200, { status: 'done', result });
  } catch (err) {
    if (err instanceof OpenAIError && err.status === 404) {
      return json(200, { status: 'error', error: 'This plan is no longer available. Try again.' });
    }
    if (err instanceof OpenAIError) {
      // A failed check is not a failed plan: the browser simply asks again.
      console.error('Job check failed:', err);
      return json(502, { error: 'Could not reach the AI just now.' });
    }
    return json(200, { status: 'error', error: (err as Error).message || 'Something went wrong. Try again.' });
  }
};

export { handler };
