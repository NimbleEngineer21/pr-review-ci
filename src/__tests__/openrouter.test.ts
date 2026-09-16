import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chat, usage, resetUsage, isReasoningModel } from '../openrouter';
import { settings } from '../config';

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

describe('reasoning-model token budgeting', () => {
  function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it('classifies OpenAI reasoning lineages, not gpt-4o or other providers', () => {
    expect(isReasoningModel('openai/gpt-5-mini')).toBe(true);
    expect(isReasoningModel('openai/gpt-5-nano')).toBe(true);
    expect(isReasoningModel('openai/o3-mini')).toBe(true);
    expect(isReasoningModel('openai/o1')).toBe(true);
    expect(isReasoningModel('openai/gpt-4o')).toBe(false);
    expect(isReasoningModel('deepseek/deepseek-v4.1-flash')).toBe(false);
    expect(isReasoningModel('meta-llama/llama-3.3-70b-instruct')).toBe(false);
  });

  it('widens max_tokens to the visible floor plus reasoning headroom and sends no reasoning field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('ok')));
    vi.stubGlobal('fetch', fetchMock);

    await chat({ model: 'openai/gpt-5-mini', system: 's', user: 'u', maxTokens: 4_000 });

    const body = sentBody(fetchMock);
    const expected =
      Math.max(4_000, settings.limits.reasoningOutputTokens) + settings.limits.maxReasoningTokens;
    expect(body['max_tokens']).toBe(expected);
    expect(body['reasoning']).toBeUndefined();
  });

  it('honors a caller budget already above the reasoning floor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('ok')));
    vi.stubGlobal('fetch', fetchMock);

    const big = settings.limits.reasoningOutputTokens + 5_000;
    await chat({ model: 'openai/gpt-5-mini', system: 's', user: 'u', maxTokens: big });

    expect(sentBody(fetchMock)['max_tokens']).toBe(big + settings.limits.maxReasoningTokens);
  });

  it('passes a non-reasoning model budget through unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(completion('ok')));
    vi.stubGlobal('fetch', fetchMock);

    await chat({ model: 'deepseek/deepseek-v4.1-flash', system: 's', user: 'u', maxTokens: 4_000 });

    expect(sentBody(fetchMock)['max_tokens']).toBe(4_000);
  });
});
