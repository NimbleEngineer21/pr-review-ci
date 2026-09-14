// Turns metrics into a review plan: which persona reviews, on which model, at
// what effort. Diversity is the selection rule — each persona runs on a
// different model lineage. Phase 1 is deterministic; Phase 2 lets a cheap
// classifier refine persona choice and focus.

import { MODELS, MODEL_POOL, CHEAP_POOL, LIMITS } from './config';
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
  if (override === 'high') return LIMITS.maxReviewers;
  switch (bucket) {
    case 'docs-only':
    case 'tests-only':
    case 'small':
      return 1;
    case 'medium':
      return 2;
    case 'large':
      return LIMITS.maxReviewers;
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
  const seen = new Set<PersonaId>();
  const deduped = choices.filter((c) => (seen.has(c.persona) ? false : (seen.add(c.persona), true)));
  const pool = effort === 'low' ? CHEAP_POOL : MODEL_POOL;

  const reviewers: PlanEntry[] = deduped.slice(0, LIMITS.maxReviewers).map((c, i) => ({
    id: c.persona,
    persona: c.persona,
    model: pool[i % pool.length]!,
    effort,
    focus: (c.focus ?? '').trim() || fallbackFocus,
  }));

  return { bucket, reviewers, synthModel: MODELS.synth };
}

/** Deterministic plan — the classifier's seed and its fallback. */
export function buildPlan(metrics: Metrics, effortOverride?: Effort): Plan {
  const count = Math.min(reviewerCount(metrics.bucket, effortOverride), LIMITS.maxReviewers);
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
