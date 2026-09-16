// Thin OpenRouter client (OpenAI-compatible chat completions). One key, many
// model lineages. Uses global fetch (Node 22+), no SDK dependency.
//
// Each call has a request timeout and retries transient failures (timeout,
// network error, HTTP 408/429/5xx) with backoff, so one blip does not fail a
// reviewer for the whole run. Token/cost usage is accumulated so the CLI can log
// what a run spent against the OpenRouter balance.

import { OPENROUTER_BASE, settings } from './config';
import { fetchWithTimeout, isRetriableStatus, sleep } from './http';

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  /** Ask the provider for a JSON object response when it supports it. */
  json?: boolean;
}

const REQUEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;
/** Backoff before attempt N+1 (index 0 = wait before the 2nd attempt). */
const BACKOFF_MS = [500, 1_500];

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  return key;
}

// ---- usage accounting -------------------------------------------------------

export interface ModelUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** USD, when OpenRouter reports it; 0 otherwise. */
  cost: number;
}

export interface UsageTotals extends ModelUsage {
  byModel: Record<string, ModelUsage>;
}

function emptyUsage(): ModelUsage {
  return { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0 };
}

export const usage: UsageTotals = { ...emptyUsage(), byModel: {} };

export function resetUsage(): void {
  const fresh = emptyUsage();
  Object.assign(usage, fresh);
  usage.byModel = {};
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

function recordUsage(model: string, u: RawUsage | undefined): void {
  const prompt = u?.prompt_tokens ?? 0;
  const completion = u?.completion_tokens ?? 0;
  const total = u?.total_tokens ?? prompt + completion;
  const cost = typeof u?.cost === 'number' ? u.cost : 0;
  const target = (usage.byModel[model] ??= emptyUsage());
  for (const bucket of [usage, target]) {
    bucket.calls += 1;
    bucket.promptTokens += prompt;
    bucket.completionTokens += completion;
    bucket.totalTokens += total;
    bucket.cost += cost;
  }
}

// ---- reasoning-model budgeting ----------------------------------------------

/**
 * True for OpenAI reasoning lineages (o1/o3/o4 series, GPT-5 series). These
 * spend hidden reasoning tokens out of the SAME `max_tokens` pool as the visible
 * answer; a tight cap makes reasoning exhaust the budget and the model returns
 * `finish_reason:"length"` with empty content (still billed). Matches the id
 * segment after the provider prefix, so `openai/gpt-5-mini`, `openai/o3-mini`,
 * and `openai/o1` match while `openai/gpt-4o` does not.
 */
export function isReasoningModel(model: string): boolean {
  return /(^|\/)(gpt-5|o[1-4])(-|$)/i.test(model);
}

/**
 * The request-level `max_tokens` to send. For a reasoning model, widen the
 * caller's visible-output budget to at least `reasoningOutputTokens` and add
 * `maxReasoningTokens` of headroom so hidden reasoning cannot starve the answer.
 * Effort is left at the provider default — GPT-5 is effort-only and OpenRouter
 * would turn any reasoning cap into an effort tier, so we set none.
 */
function requestMaxTokens(model: string, requested: number): number {
  if (!isReasoningModel(model)) return requested;
  const visible = Math.max(requested, settings.limits.reasoningOutputTokens);
  return visible + settings.limits.maxReasoningTokens;
}

// ---- the call ---------------------------------------------------------------

export async function chat(opts: ChatOptions): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: opts.temperature ?? 0.2,
    max_tokens: requestMaxTokens(opts.model, opts.maxTokens),
    // Ask OpenRouter to include token counts and cost in the response.
    usage: { include: true },
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
  };
  if (opts.json) body['response_format'] = { type: 'json_object' };

  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      // Optional attribution headers OpenRouter recommends.
      'HTTP-Referer': 'https://github.com/NimbleEngineer21/pr-review-ci',
      'X-Title': 'pr-review-ci',
    },
    body: JSON.stringify(body),
  };

  let lastError = '';
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const isLast = attempt === MAX_ATTEMPTS - 1;

    let res: Response;
    try {
      res = await fetchWithTimeout(`${OPENROUTER_BASE}/chat/completions`, init, REQUEST_TIMEOUT_MS);
    } catch (err) {
      // Timeout (abort) or network error — retriable.
      lastError = err instanceof Error ? err.message : String(err);
      if (isLast) throw new Error(`OpenRouter ${opts.model} request failed: ${lastError}`);
      await sleep(BACKOFF_MS[attempt] ?? 1_500);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      lastError = `HTTP ${res.status}: ${text.slice(0, 500)}`;
      if (isRetriableStatus(res.status) && !isLast) {
        await sleep(BACKOFF_MS[attempt] ?? 1_500);
        continue;
      }
      throw new Error(`OpenRouter ${opts.model} ${lastError}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: RawUsage;
    };
    recordUsage(opts.model, data.usage);
    const content = data.choices?.[0]?.message?.content;
    // An empty body is not retriable — the call succeeded, the model gave nothing.
    if (!content) throw new Error(`OpenRouter ${opts.model} returned no content`);
    return content;
  }

  // Unreachable: the loop returns or throws on the last attempt.
  throw new Error(`OpenRouter ${opts.model} failed: ${lastError}`);
}

/**
 * Extract a JSON value from a model response that may wrap it in prose or a
 * ```json fence. Returns the parsed value or throws.
 */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1]! : text;
  // Find the first balanced JSON object or array.
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found in model response');
  const open = candidate[start]!;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1)) as T;
    }
  }
  throw new Error('unbalanced JSON in model response');
}
