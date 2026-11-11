/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * OpenAI Responses API in background mode. A plan with web search takes a few
 * minutes, far longer than a Netlify function may run, so one function starts
 * the job and returns its id, and the browser checks on it through /api/job.
 * The key lives only in the OPENAI_API_KEY env var and never reaches the browser.
 */

const API = 'https://api.openai.com/v1';
export const MODEL = process.env.OPENAI_MODEL || 'gpt-5';
// How hard gpt-5 models think: low keeps a plan to a few minutes.
const REASONING_EFFORT = process.env.REASONING_EFFORT || 'low';
const WEB_SEARCH = (process.env.WEB_SEARCH ?? 'true').toLowerCase() !== 'false';
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES || 15);
// A ceiling on what one job may write (reasoning included), so a single request can't run up the bill.
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS || 40000);

export class OpenAIError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request(method: string, path: string, body?: unknown) {
  const res = await fetch(API + path, {
    signal: AbortSignal.timeout(8000),
    method,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: { message: text } };
  }
  if (!res.ok) throw new OpenAIError(res.status, data?.error?.message || `HTTP ${res.status}`);
  return data;
}

/** Starts a background job and returns its response id. `maxSearches` caps web searches for quick lookups. */
export async function startJob(instructions: string, input: string, opts: { maxSearches?: number; uid?: string | null } = {}): Promise<string> {
  // The job remembers who started it, so only they can read or cancel it.
  const base: Record<string, unknown> = { model: MODEL, instructions, input, background: true, ...(opts.uid ? { metadata: { uid: opts.uid } } : {}) };
  // Optional speed limits; dropped one by one if this model or account rejects them.
  const extras: Record<string, unknown> = { max_output_tokens: MAX_OUTPUT_TOKENS };
  if (MODEL.startsWith('gpt-5') || /^o\d/.test(MODEL)) extras.reasoning = { effort: REASONING_EFFORT };
  if (WEB_SEARCH) extras.max_tool_calls = Math.min(MAX_SEARCHES, opts.maxSearches ?? MAX_SEARCHES);
  const toolOptions: (unknown[] | null)[] = WEB_SEARCH
    ? [[{ type: 'web_search' }], [{ type: 'web_search_preview' }], null]
    : [null];

  let last: OpenAIError | null = null;
  for (const tools of toolOptions) {
    for (;;) {
      const payload: Record<string, unknown> = { ...base, ...extras };
      if (tools) payload.tools = tools;
      else delete payload.max_tool_calls;
      try {
        const data = await request('POST', '/responses', payload);
        return data.id as string;
      } catch (e) {
        if (!(e instanceof OpenAIError)) throw e;
        last = e;
        const rejected = Object.keys(extras).find((k) => e.status === 400 && e.message.includes(k));
        if (!rejected) break;
        delete extras[rejected];
      }
    }
    // A 400 that mentions the tool means this model/account lacks it: try the next option.
    if (!(tools && last && last.status === 400 && last.message.toLowerCase().includes('tool'))) break;
  }
  throw last ?? new OpenAIError(500, 'Could not start the job.');
}

export const getJob = (id: string) => request('GET', `/responses/${id}`);
export const cancelJob = (id: string) => request('POST', `/responses/${id}/cancel`, {});

/** Pulls the reply text and any web citations out of a finished response. */
export function readOutput(data: any): { text: string; cited: { title: string; url: string }[] } {
  let text = '';
  const cited: { title: string; url: string }[] = [];
  for (const item of data?.output ?? []) {
    if (item?.type !== 'message') continue;
    for (const part of item.content ?? []) {
      if (part?.type !== 'output_text') continue;
      text += part.text ?? '';
      for (const ann of part.annotations ?? []) {
        if (ann?.type === 'url_citation' && ann.url) cited.push({ title: ann.title || ann.url, url: ann.url });
      }
    }
  }
  return { text, cited };
}

export function extractJson(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error("The AI reply wasn't in the expected format. Try again.");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("The AI reply wasn't in the expected format. Try again.");
  }
}

const CITE_IN_PARENS = /\s*\(\[[^\]]*\]\([^)]*\)\)/g;
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;

/** Strips markdown citations the model sometimes leaves inside text fields. */
export function cleanText<T>(obj: T): T {
  if (typeof obj === 'string') return obj.replace(CITE_IN_PARENS, '').replace(MD_LINK, '$1').trim() as T;
  if (Array.isArray(obj)) return obj.map(cleanText) as T;
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, k === 'url' ? v : cleanText(v)])
    ) as T;
  }
  return obj;
}

const tidyUrl = (url: string) => {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (k.startsWith('utm_')) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
};

export function mergeSources(listed: unknown, cited: { title: string; url: string }[], limit = 15) {
  const out: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const s of [...(Array.isArray(listed) ? listed : []), ...cited] as any[]) {
    if (!s || typeof s !== 'object' || !s.url) continue;
    const url = tidyUrl(String(s.url));
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: String(s.title || url), url });
  }
  return out.slice(0, limit);
}
