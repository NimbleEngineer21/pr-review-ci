import { describe, it, expect } from 'vitest';
import { computeMetrics, type ChangedFile } from '../metrics';
import { buildPlan } from '../policy';

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
});
