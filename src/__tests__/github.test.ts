import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postReview, type PullContext, type InlineComment } from '../github';

const ctx: PullContext = {
  owner: 'o',
  repo: 'r',
  number: 6,
  title: 't',
  body: '',
  files: [],
};

const comment: InlineComment = { path: 'src/x.ts', line: 3, body: 'bug' };

function res(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => vi.stubEnv('GITHUB_TOKEN', 'test-token'));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('postReview', () => {
  it('does not POST a review when there are no inline comments', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await postReview(ctx, 'body', []);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries a transient 422 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(res(422, { message: 'An internal error occurred, please try again.' }))
      .mockResolvedValueOnce(res(200));
    vi.stubGlobal('fetch', fetchMock);

    await postReview(ctx, 'body', [comment]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting retries so the caller can log it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(res(422, { message: 'internal error' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(postReview(ctx, 'body', [comment])).rejects.toThrow(/422/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
