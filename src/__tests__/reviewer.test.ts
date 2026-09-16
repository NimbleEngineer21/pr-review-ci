import { describe, it, expect } from 'vitest';
import { buildDiffText } from '../reviewer';
import type { PullContext } from '../github';

function ctxOf(): PullContext {
  return {
    owner: 'o',
    repo: 'r',
    number: 1,
    title: 't',
    body: '',
    files: [
      {
        path: 'src/worker/auth.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n keep\n+AUTHCONTENT',
      },
      {
        path: 'src/styles/theme.css',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n keep\n+CSSCONTENT',
      },
    ],
  };
}

describe('buildDiffText lens scoping', () => {
  it('gives a specialist its lens files in full and a digest of the rest', () => {
    const out = buildDiffText(ctxOf(), 'security');
    expect(out).toContain('AUTHCONTENT'); // security lens file, in full
    expect(out).not.toContain('CSSCONTENT'); // other file is only digested
    expect(out).toContain('context digest');
    expect(out).toContain('src/styles/theme.css'); // named in the digest
  });

  it('gives a generalist the whole diff with no digest section', () => {
    const out = buildDiffText(ctxOf(), 'correctness');
    expect(out).toContain('AUTHCONTENT');
    expect(out).toContain('CSSCONTENT');
    expect(out).not.toContain('context digest');
  });

  it('falls back to the full diff when a specialist lens matches no file', () => {
    const ctx = ctxOf();
    ctx.files = [ctx.files[1]!]; // only the css file; security lens matches nothing
    const out = buildDiffText(ctx, 'security');
    expect(out).toContain('CSSCONTENT');
    expect(out).not.toContain('context digest');
  });
});
