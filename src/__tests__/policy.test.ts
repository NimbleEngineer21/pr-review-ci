import { describe, it, expect } from 'vitest';
import { computeMetrics, type ChangedFile } from '../metrics';
import { buildPlan, assignModels, planRunBudget } from '../policy';
import type { PersonaId } from '../personas';

const f = (path: string, additions = 10, deletions = 0): ChangedFile => ({
  path,
  additions,
  deletions,
  status: 'modified',
});

describe('buildPlan', () => {
  it('single docs persona for docs-only', () => {
    const plan = buildPlan(computeMetrics([f('docs/x.md', 40)]));
    expect(plan.reviewers).toHaveLength(1);
    expect(plan.reviewers[0]!.persona).toBe('docs');
  });

  it('qa persona for tests-only', () => {
    const plan = buildPlan(computeMetrics([f('src/a.test.ts', 40)]));
    expect(plan.reviewers[0]!.persona).toBe('qa');
  });

  it('two diverse reviewers for medium', () => {
    const plan = buildPlan(computeMetrics([f('src/a.ts', 120, 60)]));
    expect(plan.reviewers).toHaveLength(2);
    const models = plan.reviewers.map((r) => r.model);
    expect(new Set(models).size).toBe(2); // distinct lineages
    const personas = plan.reviewers.map((r) => r.persona);
    expect(new Set(personas).size).toBe(2); // distinct lenses
  });

  it('three reviewers for large', () => {
    expect(buildPlan(computeMetrics([f('src/a.ts', 400, 100)])).reviewers).toHaveLength(3);
  });

  it('security-touching PR gets the security persona first', () => {
    const plan = buildPlan(computeMetrics([f('src/worker/auth.ts', 120, 40)]));
    expect(plan.reviewers.map((r) => r.persona)).toContain('security');
    expect(plan.reviewers[0]!.persona).toBe('security'); // highest priority
  });

  it('migrations PR gets the data-architect persona', () => {
    const plan = buildPlan(computeMetrics([f('migrations/x.sql', 120, 0), f('src/a.ts', 40, 0)]));
    expect(plan.reviewers.map((r) => r.persona)).toContain('data-architect');
    const focus = plan.reviewers[0]!.focus;
    expect(focus).toMatch(/migration/i);
  });

  it('effort=low forces one cheap reviewer regardless of size', () => {
    const plan = buildPlan(computeMetrics([f('src/a.ts', 400, 100)]), 'low');
    expect(plan.reviewers).toHaveLength(1);
    expect(plan.reviewers[0]!.effort).toBe('low');
  });

  it('effort=high forces the full panel on a small PR', () => {
    const plan = buildPlan(computeMetrics([f('src/a.ts', 10, 5)]), 'high');
    expect(plan.reviewers).toHaveLength(3);
    expect(plan.reviewers.every((r) => r.effort === 'high')).toBe(true);
  });

  it('never exceeds three reviewers', () => {
    const plan = buildPlan(computeMetrics([f('src/worker/auth.ts', 900, 200)]), 'high');
    expect(plan.reviewers.length).toBeLessThanOrEqual(3);
  });

  it('routes security to the reasoning model by fit, not by array position', () => {
    const plan = buildPlan(computeMetrics([f('src/worker/auth.ts', 400, 100)]), 'high');
    const sec = plan.reviewers.find((r) => r.persona === 'security');
    expect(sec!.model).toMatch(/^openai\//);
    // web-ui, when present, must not draw the reasoning seat (kept for security).
    const ui = plan.reviewers.find((r) => r.persona === 'web-ui');
    if (ui) expect(ui.model).not.toMatch(/^openai\//);
  });
});

const POOL = [
  'openai/gpt-5-mini',
  'deepseek/deepseek-v4.1-flash',
  'qwen/qwen3-coder-30b-a3b-instruct',
  'google/gemini-2.5-flash',
];

describe('assignModels', () => {
  it('gives each persona its preferred lineage and keeps lineages distinct', () => {
    const personas: PersonaId[] = ['security', 'web-ui', 'performance'];
    const models = assignModels(personas, POOL);
    expect(models[0]).toMatch(/^openai\//); // security -> reasoning
    expect(models[1]).toMatch(/^google\//); // web-ui -> gemini
    expect(models[2]).toMatch(/^deepseek\//); // performance -> deepseek
    expect(new Set(models).size).toBe(3);
  });

  it('falls back to an unused model when no preferred lineage is free', () => {
    // A tiny pool with only openai forces the non-preferred fallback path.
    const models = assignModels(['security', 'correctness'], ['openai/gpt-5-mini', 'qwen/q']);
    expect(new Set(models).size).toBe(2);
    expect(models).toContain('openai/gpt-5-mini');
    expect(models).toContain('qwen/q');
  });
});

describe('planRunBudget', () => {
  it('does not trim a run that fits the budget', () => {
    const b = planRunBudget(3, 40_000, 150_000, 120_000);
    expect(b.seats).toBe(3);
    expect(b.actions).toHaveLength(0);
  });

  it('shrinks the diff cap before dropping a seat', () => {
    // 3 seats * 120k chars / 4 = 90k tokens; budget 60k forces a shrink first.
    const b = planRunBudget(3, 120_000, 60_000, 120_000);
    expect(b.actions[0]).toMatch(/shrank diff cap/);
    expect(b.maxDiffChars).toBeLessThan(120_000);
    expect(b.seats).toBe(3);
  });

  it('drops the lowest-priority seat when the floor is not enough', () => {
    // Tiny budget: even at the 20k-char floor, 3 seats * 5k tokens = 15k > 8k.
    const b = planRunBudget(3, 200_000, 8_000, 120_000);
    expect(b.actions.some((a) => /dropped lowest-priority/.test(a))).toBe(true);
    expect(b.seats).toBeLessThan(3);
    expect(b.seats).toBeGreaterThanOrEqual(1);
  });
});
