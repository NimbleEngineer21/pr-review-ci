import { describe, it, expect } from 'vitest';
import { clusterFindings } from '../cluster';
import type { Finding, ReviewerResult } from '../findings';

const rr = (id: string, findings: Finding[]): ReviewerResult => ({
  id,
  title: id,
  model: `model/${id}`,
  findings,
});

const find = (over: Partial<Finding>): Finding => ({
  path: 'src/a.ts',
  line: 10,
  severity: 'medium',
  category: 'correctness',
  title: 'unhandled null user',
  body: 'user may be null',
  ...over,
});

describe('clusterFindings', () => {
  it('merges the same issue raised by two models and records agreement', () => {
    const clusters = clusterFindings([
      rr('security', [find({ title: 'unhandled null user', line: 10 })]),
      rr('qa', [find({ title: 'null user not handled', line: 11, severity: 'high' })]),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.agreedBy.sort()).toEqual(['qa', 'security']);
    expect(clusters[0]!.severity).toBe('high'); // max severity wins
  });

  it('keeps distinct issues separate', () => {
    const clusters = clusterFindings([
      rr('a', [find({ title: 'sql injection', category: 'security', line: 5 })]),
      rr('b', [find({ title: 'missing index', category: 'performance', line: 80 })]),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('does not merge same title on far-apart lines', () => {
    const clusters = clusterFindings([
      rr('a', [find({ line: 10 })]),
      rr('b', [find({ line: 200 })]),
    ]);
    expect(clusters).toHaveLength(2);
  });

  it('sorts by severity then agreement', () => {
    const clusters = clusterFindings([
      rr('a', [find({ title: 'nit naming', severity: 'nit', line: 3 })]),
      rr('b', [find({ title: 'data loss on write', severity: 'blocker', line: 50 })]),
    ]);
    expect(clusters[0]!.severity).toBe('blocker');
  });

  it('handles reviewers that returned nothing', () => {
    expect(clusterFindings([rr('a', []), rr('b', [])])).toEqual([]);
  });
});
