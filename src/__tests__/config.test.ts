import { describe, it, expect, afterEach } from 'vitest';
import { applyConfig, resetSettings, settings, DEFAULT_SETTINGS } from '../config';
import { computeMetrics, type ChangedFile } from '../metrics';
import { buildPlan } from '../policy';

const f = (path: string, additions = 10, deletions = 0): ChangedFile => ({
  path,
  additions,
  deletions,
  status: 'modified',
});

afterEach(() => resetSettings());

describe('applyConfig', () => {
  it('ignores a non-object and keeps defaults', () => {
    applyConfig(null);
    expect(settings.limits.maxReviewers).toBe(DEFAULT_SETTINGS.limits.maxReviewers);
  });

  it('overrides known limits and models only', () => {
    applyConfig({
      limits: { maxReviewers: 2, bogus: 9 },
      models: { synth: 'openai/gpt-5.1', pool: ['a/b', 'c/d'] },
    });
    expect(settings.limits.maxReviewers).toBe(2);
    expect(settings.models.synth).toBe('openai/gpt-5.1');
    expect(settings.models.pool).toEqual(['a/b', 'c/d']);
  });

  it('overrides the reasoning token knobs', () => {
    applyConfig({ limits: { reasoningOutputTokens: 8_000, maxReasoningTokens: 32_000 } });
    expect(settings.limits.reasoningOutputTokens).toBe(8_000);
    expect(settings.limits.maxReasoningTokens).toBe(32_000);
  });

  it('rejects bad values (non-positive, wrong type)', () => {
    applyConfig({ limits: { maxReviewers: -3, maxDiffChars: 'lots' } });
    expect(settings.limits.maxReviewers).toBe(DEFAULT_SETTINGS.limits.maxReviewers);
    expect(settings.limits.maxDiffChars).toBe(DEFAULT_SETTINGS.limits.maxDiffChars);
  });

  it('threshold override changes bucketing', () => {
    applyConfig({ thresholds: { small: 10, medium: 20 } });
    // 15 churn is now "medium" instead of "small"
    expect(computeMetrics([f('src/a.ts', 15, 0)]).bucket).toBe('medium');
  });

  it('maxReviewers override caps the panel', () => {
    applyConfig({ limits: { maxReviewers: 1 } });
    const plan = buildPlan(computeMetrics([f('src/worker/auth.ts', 500, 100)]), 'high');
    expect(plan.reviewers).toHaveLength(1);
  });

  it('disabledPersonas removes a lens', () => {
    applyConfig({ disabledPersonas: ['security'] });
    const plan = buildPlan(computeMetrics([f('src/worker/auth.ts', 200, 50)]));
    expect(plan.reviewers.map((r) => r.persona)).not.toContain('security');
  });
});
