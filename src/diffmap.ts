// Maps a finding's line number onto the PR diff. GitHub only accepts an inline
// review comment on a line that is part of the diff (added or context on the
// RIGHT side). A finding off the diff is demoted to the summary.

/**
 * Parse a unified-diff patch (as returned by the GitHub "files" API) and return
 * the set of new-file (RIGHT side) line numbers that can carry an inline
 * comment: added ('+') and context (' ') lines.
 */
export function commentableLines(patch: string | undefined): Set<number> {
  const lines = new Set<number>();
  if (!patch) return lines;

  let newLine = 0;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      lines.add(newLine);
      newLine++;
    } else if (raw.startsWith('-')) {
      // Removed from the old file: does not advance the new-file counter.
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — ignore.
    } else {
      // Context line (leading space, or an empty line inside a hunk).
      lines.add(newLine);
      newLine++;
    }
  }
  return lines;
}

export interface CommentableIndex {
  /** path -> set of commentable new-file line numbers. */
  byPath: Map<string, Set<number>>;
}

export function buildCommentableIndex(
  files: Array<{ path: string; patch?: string }>,
): CommentableIndex {
  const byPath = new Map<string, Set<number>>();
  for (const f of files) byPath.set(f.path, commentableLines(f.patch));
  return { byPath };
}

/** Can this (path, line) carry an inline comment on the diff? */
export function isInlineEligible(
  index: CommentableIndex,
  path: string,
  line: number | null,
): boolean {
  if (line == null) return false;
  return index.byPath.get(path)?.has(line) ?? false;
}
