import { describe, it, expect } from 'vitest';
import { buildSummaryMarkdown } from '../render';
import type { Finding, ReviewerResult, Synthesis } from '../findings';
import type { Plan } from '../policy';

const plan: Plan = { bucket: 'large', reviewers: [], synthModel: 'openai/gpt-5-mini' };
const synth: Synthesis = { summary: 'ok', verdict: 'MERGE', findings: [] };

function finding(): Finding {
  return { path: 'src/x.ts', line: 1, severity: 'high', category: 'security', title: 't', body: 'b' };
}

describe('buildSummaryMarkdown panel status', () => {
  it('distinguishes error, reviewed-no-findings, and reviewed-with-findings', () => {
    const reviewers: ReviewerResult[] = [
      {
        id: 'security',
        title: 'Staff Security Engineer',
        model: 'openai/gpt-5-mini',
        findings: [],
        error: 'OpenRouter openai/gpt-5-mini returned no content',
      },
      { id: 'cloudflare', title: 'Staff Cloudflare Engineer', model: 'deepseek/deepseek-v4.1-flash', findings: [] },
      { id: 'web-ui', title: 'Staff Frontend Engineer', model: 'meta-llama/llama-3.3-70b-instruct', findings: [finding(), finding()] },
    ];

    const md = buildSummaryMarkdown(plan, reviewers, synth);

    // The errored seat reads as a failure to review, not as "no findings".
    expect(md).toContain('Staff Security Engineer');
    expect(md).toMatch(/error — did not review/);
    expect(md).toContain('returned no content');
    // A healthy silent seat is explicitly "no findings".
    expect(md).toMatch(/Staff Cloudflare Engineer.*✅ reviewed — no findings/);
    // A contributing seat reports its count.
    expect(md).toMatch(/Staff Frontend Engineer.*✅ reviewed — 2 findings/);
    // The error state must not be phrasable as the empty state.
    const errorLine = md.split('\n').find((l) => l.includes('Staff Security Engineer'))!;
    expect(errorLine).not.toContain('no findings');
  });
});
