import { describe, it, expect } from 'vitest';
import { synthesize } from '../synthesize';
import type { ReviewerResult } from '../findings';

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
