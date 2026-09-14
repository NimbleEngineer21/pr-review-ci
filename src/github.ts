// GitHub REST helpers: gather the PR, and post one combined review.

import { GITHUB_API, SUMMARY_MARKER, INLINE_MARKER } from './config';
import { fetchWithTimeout } from './http';
import type { ChangedFile } from './metrics';

const GITHUB_TIMEOUT_MS = 30_000;

function token(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error('GITHUB_TOKEN is not set');
  return t;
}

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithTimeout(
    `${GITHUB_API}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    },
    GITHUB_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub ${init.method ?? 'GET'} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface PullContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  files: ChangedFile[];
}

export async function gatherPull(
  owner: string,
  repo: string,
  number: number,
): Promise<PullContext> {
  const pr = await gh<{ title: string; body: string | null }>(
    `/repos/${owner}/${repo}/pulls/${number}`,
  );

  const files: ChangedFile[] = [];
  for (let page = 1; ; page++) {
    const batch = await gh<
      Array<{ filename: string; additions: number; deletions: number; status: string; patch?: string }>
    >(`/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    for (const f of batch) {
      files.push({
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        status: f.status,
        patch: f.patch,
      });
    }
    if (batch.length < 100) break;
  }

  return { owner, repo, number, title: pr.title, body: pr.body ?? '', files };
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Fetch the caller repo's optional `.github/pr-review.json` (default branch).
 * Returns the parsed JSON, or null if absent/unreadable.
 */
export async function fetchRepoConfig(owner: string, repo: string): Promise<unknown | null> {
  try {
    const res = await gh<{ content?: string; encoding?: string }>(
      `/repos/${owner}/${repo}/contents/.github/pr-review.json`,
    );
    if (!res.content) return null;
    const text = Buffer.from(res.content, (res.encoding as BufferEncoding) ?? 'base64').toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Delete this bot's inline comments from prior runs so a re-run replaces them. */
export async function deletePriorInlineComments(ctx: PullContext): Promise<number> {
  let deleted = 0;
  for (let page = 1; ; page++) {
    const batch = await gh<Array<{ id: number; body: string }>>(
      `/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}/comments?per_page=100&page=${page}`,
    );
    for (const c of batch) {
      if (c.body?.includes(INLINE_MARKER)) {
        await gh(`/repos/${ctx.owner}/${ctx.repo}/pulls/comments/${c.id}`, { method: 'DELETE' });
        deleted++;
      }
    }
    if (batch.length < 100) break;
  }
  return deleted;
}

/**
 * Post one PR review (event COMMENT so it never auto-approves or blocks) with
 * inline comments. Invalid inline comments are dropped one at a time on 422 so
 * a single bad line can't sink the whole review.
 */
export async function postReview(
  ctx: PullContext,
  body: string,
  comments: InlineComment[],
): Promise<void> {
  const payload = (cs: InlineComment[]) => ({
    event: 'COMMENT',
    body,
    comments: cs.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
  });

  let attempt = [...comments];
  for (let tries = 0; tries < 4; tries++) {
    const res = await fetchWithTimeout(
      `${GITHUB_API}/repos/${ctx.owner}/${ctx.repo}/pulls/${ctx.number}/reviews`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload(attempt)),
      },
      GITHUB_TIMEOUT_MS,
    );
    if (res.ok) return;
    const text = await res.text().catch(() => '');
    // On a line-position error, drop inline comments and post body-only.
    if (res.status === 422 && attempt.length > 0) {
      attempt = [];
      continue;
    }
    throw new Error(`GitHub post review -> ${res.status}: ${text.slice(0, 500)}`);
  }
}

/** Upsert the top-level summary comment so re-runs replace it in place. */
export async function upsertSummaryComment(ctx: PullContext, markdown: string): Promise<void> {
  const bodyWithMarker = `${SUMMARY_MARKER}\n${markdown}`;
  const existing = await gh<Array<{ id: number; body: string }>>(
    `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments?per_page=100`,
  );
  const prior = existing.find((c) => c.body?.includes(SUMMARY_MARKER));
  if (prior) {
    await gh(`/repos/${ctx.owner}/${ctx.repo}/issues/comments/${prior.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body: bodyWithMarker }),
    });
  } else {
    await gh(`/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: bodyWithMarker }),
    });
  }
}
