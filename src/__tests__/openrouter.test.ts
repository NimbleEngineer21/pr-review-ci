import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chat, usage, resetUsage } from '../openrouter';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function completion(content: string, u?: Record<string, number>) {
  return { choices: [{ message: { content } }], usage: u };
}

const call = () => chat({ model: 'x/y', system: 's', user: 'u', maxTokens: 100 });

beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-key');
  resetUsage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('chat: retry and usage accounting', () => {
  it('retries a transient 500 then succeeds, recording usage once', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(
        jsonResponse(
          completion('hi', {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
            cost: 0.002,
          }),
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const out = await call();

    expect(out).toBe('hi');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(usage.calls).toBe(1);
    expect(usage.totalTokens).toBe(15);
    expect(usage.cost).toBeCloseTo(0.002);
    expect(usage.byModel['x/y']?.calls).toBe(1);
    expect(usage.byModel['x/y']?.totalTokens).toBe(15);
  });

  it('does not retry a non-retriable 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(call()).rejects.toThrow(/HTTP 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(usage.calls).toBe(0);
  });

  it('retries a network error up to the attempt cap, then throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(call()).rejects.toThrow(/request failed/i);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry an empty (but successful) response body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('')));
    vi.stubGlobal('fetch', fetchMock);

    await expect(call()).rejects.toThrow(/no content/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
