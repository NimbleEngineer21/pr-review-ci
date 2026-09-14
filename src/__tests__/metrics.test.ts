import { describe, it, expect } from 'vitest';
import { computeMetrics, isDoc, isTest, type ChangedFile } from '../metrics';

const f = (path: string, additions = 10, deletions = 0): ChangedFile => ({
  path,
  additions,
  deletions,
  status: 'modified',
});

describe('classification helpers', () => {
  it('recognizes docs', () => {
    expect(isDoc('README.md')).toBe(true);
    expect(isDoc('docs/plan.md')).toBe(true);
    expect(isDoc('content/pages/en/x.mdx')).toBe(true);
    expect(isDoc('src/app.ts')).toBe(false);
  });

  it('recognizes tests', () => {
    expect(isTest('src/foo.test.ts')).toBe(true);
    expect(isTest('src/__tests__/foo.ts')).toBe(true);
    expect(isTest('tests/foo.spec.tsx')).toBe(true);
    expect(isTest('src/foo.ts')).toBe(false);
  });
});

describe('computeMetrics buckets', () => {
  it('docs-only when every file is a doc', () => {
    const m = computeMetrics([f('README.md', 100), f('docs/x.md', 50)]);
    expect(m.bucket).toBe('docs-only');
    expect(m.codeChurn).toBe(0);
  });

  it('tests-only when every non-doc file is a test', () => {
    const m = computeMetrics([f('src/a.test.ts', 40), f('README.md', 5)]);
    expect(m.bucket).toBe('tests-only');
  });

  it('small under 50 code lines', () => {
    expect(computeMetrics([f('src/a.ts', 20, 10)]).bucket).toBe('small');
  });

  it('medium between 50 and 300', () => {
    expect(computeMetrics([f('src/a.ts', 100, 80)]).bucket).toBe('medium');
  });

  it('large over 300', () => {
    expect(computeMetrics([f('src/a.ts', 300, 60)]).bucket).toBe('large');
  });

  it('docs churn does not count toward code buckets', () => {
    const m = computeMetrics([f('docs/x.md', 500), f('src/a.ts', 10, 5)]);
    expect(m.bucket).toBe('small');
    expect(m.codeChurn).toBe(15);
  });
});

describe('overlays', () => {
  it('flags migrations, ci, security, and cloudflare paths', () => {
    const m = computeMetrics([
      f('migrations/2026.01.01_x.sql'),
      f('.github/workflows/ci.yml'),
      f('src/worker/auth.ts'), // worker dir => cloudflare, auth => security
    ]);
    expect(m.overlays.sort()).toEqual(['ci', 'cloudflare', 'migrations', 'security']);
  });

  it('flags frontend for component files', () => {
    const m = computeMetrics([f('src/components/Nav.astro', 30, 0)]);
    expect(m.overlays).toContain('frontend');
  });
});
