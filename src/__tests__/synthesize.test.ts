import { describe, it, expect } from 'vitest';
import { synthesize, reinjectCritical } from '../synthesize';
import type { MergedFinding, ReviewerResult } from '../findings';
import type { Cluster } from '../cluster';

// A reviewer that ran clean (no findings) vs one that failed. The empty-cluster
// path in synthesize() never calls the model, so these need no network stub.
const ran = (id: string): ReviewerResult => ({ id, title: id, model: 'm', findings: [] });
const failed = (id: string): ReviewerResult => ({
  id,
  title: id,
  model: 'm',
  findings: [],
  error: 'HTTP 401',
});
const eligible = () => true;

describe('synthesize with no surviving clusters', () => {
  it('does NOT emit MERGE when every reviewer failed', async () => {
    const s = await synthesize([failed('security'), failed('correctness')], 'synth', eligible);
    expect(s.verdict).not.toBe('MERGE');
    expect(s.verdict).toBe('COMMENT');
    expect(s.findings).toHaveLength(0);
    expect(s.summary).toMatch(/could not run/i);
    expect(s.summary).toMatch(/not.*approval/i);
    // Names the failed reviewers so the log points at the cause.
    expect(s.summary).toMatch(/security/);
    expect(s.summary).toMatch(/correctness/);
  });

  it('emits MERGE when at least one reviewer ran clean, noting the failure', async () => {
    const s = await synthesize([ran('correctness'), failed('security')], 'synth', eligible);
    expect(s.verdict).toBe('MERGE');
    expect(s.summary).toMatch(/no issues found/i);
    expect(s.summary).toMatch(/security/);
  });

  it('emits a plain MERGE when the whole panel ran clean', async () => {
    const s = await synthesize([ran('correctness'), ran('security')], 'synth', eligible);
    expect(s.verdict).toBe('MERGE');
    expect(s.summary).toMatch(/no issues found/i);
    expect(s.summary).not.toMatch(/failed/i);
  });
});

const cluster = (over: Partial<Cluster>): Cluster => ({
  path: 'src/x.ts',
  line: 10,
  severity: 'high',
  category: 'security',
  title: 'IDOR on the claim path',
  bodies: ['acts on another user id'],
  agreedBy: ['security'],
  ...over,
});

describe('reinjectCritical (rule D safety net)', () => {
  it('re-adds a high-severity security cluster the synthesizer dropped', () => {
    const out = reinjectCritical([], [cluster({})]);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toMatch(/one reviewer/i);
    expect(out[0]!.severity).toBe('high');
  });

  it('leaves a cluster alone when a synth finding already covers it', () => {
    const covered: MergedFinding = {
      path: 'src/x.ts',
      line: 11,
      severity: 'high',
      category: 'security',
      title: 'kept',
      body: 'b',
      agreedBy: [],
      inline: false,
    };
    expect(reinjectCritical([covered], [cluster({})])).toHaveLength(1);
  });

  it('does not re-add a low-severity or non-critical cluster', () => {
    expect(reinjectCritical([], [cluster({ severity: 'nit' })])).toHaveLength(0);
    expect(
      reinjectCritical([], [cluster({ category: 'style', title: 'naming', bodies: ['rename'] })]),
    ).toHaveLength(0);
  });
});
