// Thin OpenRouter client (OpenAI-compatible chat completions). One key, many
// model lineages. Uses global fetch (Node 22+), no SDK dependency.

import { OPENROUTER_BASE } from './config';

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  /** Ask the provider for a JSON object response when it supports it. */
  json?: boolean;
}

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY is not set');
  return key;
}

export async function chat(opts: ChatOptions): Promise<string> {
  const body: Record<string, unknown> = {
    model: opts.model,
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
  };
  if (opts.json) body['response_format'] = { type: 'json_object' };

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
      // Optional attribution headers OpenRouter recommends.
      'HTTP-Referer': 'https://github.com/NimbleEngineer21/pr-review-ci',
      'X-Title': 'pr-review-ci',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${opts.model} HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenRouter ${opts.model} returned no content`);
  return content;
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
