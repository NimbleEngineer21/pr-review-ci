// Turns metrics into a review plan: which persona reviews, on which model, at
// what effort. Diversity is the selection rule — each persona runs on a
// different model lineage. Phase 1 is deterministic; Phase 2 lets a cheap
// classifier refine persona choice and focus.

import { settings } from './config';
import type { Effort } from './findings';
import type { Bucket, Metrics } from './metrics';
import type { PersonaId } from './personas';

export interface PlanEntry {
  /** Reviewer id (the persona id) — also used for agreement attribution. */
  id: PersonaId;
  persona: PersonaId;
  model: string;
  effort: Effort;
  /** Extra focus appended from path overlays, e.g. migration safety. */
  focus: string;
}

export interface Plan {
  bucket: Bucket;
  reviewers: PlanEntry[];
  synthModel: string;
}

// Higher priority personas win a slot first when the panel is capped.
const PRIORITY: Record<PersonaId, number> = {
  security: 95,
  'data-architect': 90,
  cloudflare: 85,
  'web-ui': 80,
  correctness: 70,
  qa: 60,
  performance: 55,
  simplicity: 45,
  docs: 30,
};

const OVERLAY_PERSONA: Record<string, PersonaId> = {
  security: 'security',
  migrations: 'data-architect',
  cloudflare: 'cloudflare',
  frontend: 'web-ui',
};

const OVERLAY_FOCUS: Record<string, string> = {
  migrations: 'This PR changes SQL migrations — weigh migration safety heavily.',
  security: 'This PR touches security-sensitive code — assume hostile input.',
  cloudflare: 'This PR touches Cloudflare Worker code — weigh Workers pitfalls.',
  frontend: 'This PR touches UI — weigh accessibility and client-side races.',
  ci: 'This PR changes CI workflows — weigh permissions and untrusted-input injection.',
};

// Fit-based model assignment. Each persona lists model LINEAGE prefixes in
// preference order; the assembler matches them against whatever pool the repo
// actually runs, keeping every seat on a distinct lineage. This replaces the old
// positional `pool[i % len]`, which always put the priciest reasoning model
// (openai/gpt-5-mini, pool index 0) on the security seat and drew a weak model
// for web-ui by accident of array order. Prefixes, not full ids, so a repo that
// swaps its roster still routes sensibly. Anything unmatched falls back to the
// next unused pool model, so diversity holds even for an exotic pool.
const MODEL_PREFERENCE: Record<PersonaId, string[]> = {
  security: ['openai/', 'deepseek/', 'qwen/'],
  correctness: ['deepseek/', 'openai/', 'qwen/'],
  'data-architect': ['openai/', 'deepseek/', 'qwen/'],
  cloudflare: ['deepseek/', 'qwen/', 'openai/'],
  'web-ui': ['google/', 'openai/', 'qwen/'],
  performance: ['deepseek/', 'qwen/', 'openai/'],
  qa: ['qwen/', 'deepseek/', 'google/'],
  simplicity: ['google/', 'qwen/', 'mistralai/'],
  docs: ['google/', 'qwen/', 'mistralai/'],
};

/**
 * Assign a distinct model to each persona, honoring per-persona lineage
 * preference and falling back to the next unused pool model. Personas are
 * expected in priority order, so the highest-value seats pick first. If the pool
 * is smaller than the panel, the last seats reuse models (rare; pool >= panel by
 * default).
 */
export function assignModels(personas: PersonaId[], pool: string[]): string[] {
  const used = new Set<string>();
  const take = (model: string): string => {
    used.add(model);
    return model;
  };
  const out: string[] = [];
  for (const persona of personas) {
    const prefs = MODEL_PREFERENCE[persona] ?? [];
    let chosen: string | undefined;
    for (const prefix of prefs) {
      chosen = pool.find((m) => m.startsWith(prefix) && !used.has(m));
      if (chosen) break;
    }
    // No preferred lineage free — take the next unused pool model to stay diverse.
    chosen ??= pool.find((m) => !used.has(m));
    // Pool exhausted (more personas than models) — reuse from the top.
    chosen ??= pool[out.length % pool.length];
    out.push(take(chosen!));
  }
  return out;
}

export const ALL_PERSONAS: PersonaId[] = [
  'correctness',
  'security',
  'performance',
  'web-ui',
  'qa',
  'data-architect',
  'cloudflare',
  'simplicity',
  'docs',
];

export function reviewerCount(bucket: Bucket, override?: Effort): number {
  if (override === 'low') return 1;
  if (override === 'high') return settings.limits.maxReviewers;
  switch (bucket) {
    case 'docs-only':
    case 'tests-only':
    case 'small':
      return 1;
    case 'medium':
      return 2;
    case 'large':
      return settings.limits.maxReviewers;
  }
}

export function bucketEffort(bucket: Bucket): Effort {
  switch (bucket) {
    case 'docs-only':
    case 'tests-only':
      return 'low';
    case 'small':
    case 'medium':
      return 'medium';
    case 'large':
      return 'high';
  }
}

/** Ordered, deduped persona candidates for this PR, highest priority first. */
function selectPersonas(metrics: Metrics): PersonaId[] {
  if (metrics.bucket === 'docs-only') return ['docs'];
  if (metrics.bucket === 'tests-only') return ['qa'];

  const wanted = new Set<PersonaId>(['correctness']);
  for (const o of metrics.overlays) {
    const p = OVERLAY_PERSONA[o];
    if (p) wanted.add(p);
  }
  // Fillers so a plain code PR still gets complementary lenses.
  for (const p of ['qa', 'performance', 'simplicity'] as PersonaId[]) wanted.add(p);

  return [...wanted].sort((a, b) => PRIORITY[b] - PRIORITY[a]);
}

export function focusFor(metrics: Metrics): string {
  const notes = metrics.overlays
    .map((o) => OVERLAY_FOCUS[o])
    .filter((n): n is string => Boolean(n));
  return notes.join(' ');
}

export interface PersonaChoice {
  persona: PersonaId;
  focus?: string;
}

/**
 * Map chosen personas onto distinct model lineages. Shared by the deterministic
 * planner and the LLM classifier so both produce the same shape.
 */
export function assemblePlan(
  choices: PersonaChoice[],
  bucket: Bucket,
  effort: Effort,
  fallbackFocus: string,
): Plan {
  const disabled = new Set<PersonaId>(settings.disabledPersonas);
  const seen = new Set<PersonaId>();
  const deduped = choices.filter((c) =>
    disabled.has(c.persona) || seen.has(c.persona) ? false : (seen.add(c.persona), true),
  );
  const pool = effort === 'low' ? settings.models.cheapPool : settings.models.pool;

  const chosen = deduped.slice(0, settings.limits.maxReviewers);
  const models = assignModels(
    chosen.map((c) => c.persona),
    pool,
  );
  const reviewers: PlanEntry[] = chosen.map((c, i) => ({
    id: c.persona,
    persona: c.persona,
    model: models[i]!,
    effort,
    focus: (c.focus ?? '').trim() || fallbackFocus,
  }));

  return { bucket, reviewers, synthModel: settings.models.synth };
}

export interface RunBudget {
  /** Reviewer seats to keep (highest-priority first). */
  seats: number;
  /** Effective diff-char cap for this run. */
  maxDiffChars: number;
  /** Human-readable trims applied, for the log. Empty when the run fit as-is. */
  actions: string[];
}

/** Rough char→token ratio for a code diff. Over-estimates slightly, on purpose. */
const CHARS_PER_TOKEN = 4;
/** Never shrink a reviewer's diff below this — less context is not worth running. */
const DIFF_FLOOR_CHARS = 20_000;

/**
 * Keep a run under `budgetTokens` of total input. First shrink the diff cap so
 * the current seats fit (down to a floor), then drop the lowest-priority seat
 * until it fits or one seat remains. Pure: the caller applies the result. The
 * estimate uses the full diff per seat, so it is an upper bound — a specialist's
 * lens-scoped diff (see reviewer.ts) is smaller, so the guard errs toward cheaper.
 */
export function planRunBudget(
  seatCount: number,
  diffChars: number,
  budgetTokens: number,
  currentMaxDiffChars: number,
): RunBudget {
  let seats = Math.max(1, seatCount);
  let cap = currentMaxDiffChars;
  const actions: string[] = [];
  const estTokens = () => Math.ceil(Math.min(diffChars, cap) / CHARS_PER_TOKEN) * seats;

  if (estTokens() <= budgetTokens) return { seats, maxDiffChars: cap, actions };

  const needCap = Math.floor((budgetTokens / seats) * CHARS_PER_TOKEN);
  if (needCap < cap) {
    cap = Math.max(needCap, DIFF_FLOOR_CHARS);
    actions.push(`shrank diff cap to ${cap} chars`);
  }
  while (estTokens() > budgetTokens && seats > 1) {
    seats -= 1;
    actions.push(`dropped lowest-priority reviewer (now ${seats})`);
  }
  return { seats, maxDiffChars: cap, actions };
}

/** Deterministic plan — the classifier's seed and its fallback. */
export function buildPlan(metrics: Metrics, effortOverride?: Effort): Plan {
  const count = Math.min(reviewerCount(metrics.bucket, effortOverride), settings.limits.maxReviewers);
  const effort =
    effortOverride === 'low' || effortOverride === 'high'
      ? effortOverride
      : bucketEffort(metrics.bucket);

  const personas = selectPersonas(metrics)
    .slice(0, count)
    .map((persona) => ({ persona }));

  return assemblePlan(personas, metrics.bucket, effort, focusFor(metrics));
}

export { selectPersonas };
