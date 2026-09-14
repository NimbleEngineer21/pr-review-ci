import { describe, it, expect } from 'vitest';
import { commentableLines, buildCommentableIndex, isInlineEligible } from '../diffmap';

// A patch that inserts two lines and keeps context. New-file lines start at 10.
const patch = [
  '@@ -10,3 +10,5 @@ function x() {',
  ' const a = 1;', // context -> new line 10
  '+const b = 2;', // added   -> new line 11
  '+const c = 3;', // added   -> new line 12
  ' const d = 4;', // context -> new line 13
  '-const old = 5;', // removed -> does not advance new line
  ' return a;', // context -> new line 14
].join('\n');

describe('commentableLines', () => {
  it('collects added and context lines on the new side', () => {
    const lines = commentableLines(patch);
    expect([...lines].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14]);
  });

  it('removed lines are not commentable', () => {
    // new-file line 5 (the old removed line) is absent
    expect(commentableLines(patch).has(5)).toBe(false);
  });

  it('handles a missing patch', () => {
    expect(commentableLines(undefined).size).toBe(0);
  });

  it('tracks a second hunk offset', () => {
    const two = [
      '@@ -1,1 +1,2 @@',
      ' a',
      '+b',
      '@@ -50,1 +51,2 @@',
      ' x',
      '+y',
    ].join('\n');
    const lines = commentableLines(two);
    expect(lines.has(51)).toBe(true);
    expect(lines.has(52)).toBe(true);
  });
});

describe('isInlineEligible', () => {
  const index = buildCommentableIndex([{ path: 'src/x.ts', patch }]);

  it('true for a changed line', () => {
    expect(isInlineEligible(index, 'src/x.ts', 11)).toBe(true);
  });

  it('false for a line outside the diff', () => {
    expect(isInlineEligible(index, 'src/x.ts', 999)).toBe(false);
  });

  it('false for an unknown file or null line', () => {
    expect(isInlineEligible(index, 'other.ts', 11)).toBe(false);
    expect(isInlineEligible(index, 'src/x.ts', null)).toBe(false);
  });
});
