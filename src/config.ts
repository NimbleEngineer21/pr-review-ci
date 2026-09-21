// Runtime settings with defaults. A caller repo can override a subset via a
// committed `.github/pr-review.json` (see repoconfig.ts). All non-Claude on
// purpose: the maintainer already reviews with Claude, so this panel adds OTHER
// lineages. Model ids are OpenRouter ids, verified live at build time.

import type { PersonaId } from './personas';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const GITHUB_API = 'https://api.github.com';

// Markers so re-runs can find and replace their own comments.
export const SUMMARY_MARKER = '<!-- pr-review-ci:summary -->';
export const INLINE_MARKER = '<!-- pr-review-ci:inline -->';

export interface Settings {
  models: {
    classifier: string;
    synth: string;
    /** Diverse pool for panels; one persona per lineage, in order. */
    pool: string[];
    /** Cheaper pool used for low-effort passes. */
    cheapPool: string[];
  };
  limits: {
    maxDiffChars: number;
    maxReviewers: number;
    maxOutputTokens: number;
    maxSynthTokens: number;
    /**
     * Visible-output floor for OpenAI reasoning models (o-series, GPT-5). Their
     * hidden reasoning is billed from the same max_tokens pool as the answer, so
     * a normal cap starves the answer. The client widens the request ceiling to
     * this floor plus `maxReasoningTokens` for those models only.
     */
    reasoningOutputTokens: number;
    /** Reasoning headroom added on top of the visible floor for those models. */
    maxReasoningTokens: number;
    /**
     * Soft ceiling on TOTAL prompt (input) tokens a single run may send across
     * all reviewer seats. When the projected cost exceeds it, the run first
     * shrinks the diff, then drops its lowest-priority seat. A cost guard for a
     * pathologically large PR, not a normal-case limit.
     */
    maxRunInputTokens: number;
  };
  /** Code-churn cutoffs: < small => small; <= medium => medium; else large. */
  thresholds: { small: number; medium: number };
  /** Personas the repo never wants (e.g. drop 'cloudflare' on a non-CF repo). */
  disabledPersonas: PersonaId[];
}

export const DEFAULT_SETTINGS: Settings = {
  models: {
    classifier: 'openai/gpt-5-nano',
    synth: 'openai/gpt-5-mini',
    // One strong model per lineage, matched to personas by fit in policy.ts.
    // Weak reviewers (llama-3.3-70b, mistral-small-24b) were dropped: on a
    // 3-seat panel they mostly added noise the synthesizer had to filter.
    pool: [
      'openai/gpt-5-mini',
      'deepseek/deepseek-v4.1-flash',
      'qwen/qwen3-coder-30b-a3b-instruct',
      'google/gemini-2.5-flash',
    ],
    cheapPool: ['google/gemini-2.5-flash', 'qwen/qwen3-coder-30b-a3b-instruct'],
  },
  limits: {
    maxDiffChars: 120_000,
    maxReviewers: 3,
    maxOutputTokens: 4_000,
    maxSynthTokens: 4_000,
    reasoningOutputTokens: 12_000,
    maxReasoningTokens: 64_000,
    maxRunInputTokens: 150_000,
  },
  thresholds: { small: 50, medium: 300 },
  disabledPersonas: [],
};

function clone(s: Settings): Settings {
  return {
    models: { ...s.models, pool: [...s.models.pool], cheapPool: [...s.models.cheapPool] },
    limits: { ...s.limits },
    thresholds: { ...s.thresholds },
    disabledPersonas: [...s.disabledPersonas],
  };
}

/** Live settings, mutated by applyConfig(). Modules read from here. */
export const settings: Settings = clone(DEFAULT_SETTINGS);

export function resetSettings(): void {
  const d = clone(DEFAULT_SETTINGS);
  settings.models = d.models;
  settings.limits = d.limits;
  settings.thresholds = d.thresholds;
  settings.disabledPersonas = d.disabledPersonas;
}

/**
 * Merge a partial, untrusted config over the defaults. Only known keys with the
 * right shape are applied; anything else is ignored. Never throws.
 */
export function applyConfig(raw: unknown): void {
  resetSettings();
  if (typeof raw !== 'object' || raw === null) return;
  const o = raw as Record<string, unknown>;

  const models = o['models'];
  if (typeof models === 'object' && models !== null) {
    const m = models as Record<string, unknown>;
    if (typeof m['classifier'] === 'string') settings.models.classifier = m['classifier'];
    if (typeof m['synth'] === 'string') settings.models.synth = m['synth'];
    const pool = asStringArray(m['pool']);
    if (pool) settings.models.pool = pool;
    const cheap = asStringArray(m['cheapPool']);
    if (cheap) settings.models.cheapPool = cheap;
  }

  const limits = o['limits'];
  if (typeof limits === 'object' && limits !== null) {
    const l = limits as Record<string, unknown>;
    const keys = [
      'maxDiffChars',
      'maxReviewers',
      'maxOutputTokens',
      'maxSynthTokens',
      'reasoningOutputTokens',
      'maxReasoningTokens',
      'maxRunInputTokens',
    ] as const;
    for (const k of keys) {
      if (typeof l[k] === 'number' && Number.isFinite(l[k]) && (l[k] as number) > 0) {
        settings.limits[k] = Math.trunc(l[k] as number);
      }
    }
  }

  const thresholds = o['thresholds'];
  if (typeof thresholds === 'object' && thresholds !== null) {
    const t = thresholds as Record<string, unknown>;
    if (typeof t['small'] === 'number' && t['small'] > 0) settings.thresholds.small = Math.trunc(t['small']);
    if (typeof t['medium'] === 'number' && t['medium'] > settings.thresholds.small) {
      settings.thresholds.medium = Math.trunc(t['medium']);
    }
  }

  const disabled = asStringArray(o['disabledPersonas']);
  if (disabled) settings.disabledPersonas = disabled as PersonaId[];
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const arr = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return arr.length ? arr : null;
}
