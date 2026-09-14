// Shared fetch helpers: a per-request timeout (so a hung provider can't stall
// the whole Action) and the retriable-status predicate used by the retry loops.
// Node 22+ global fetch, no dependency.

/** Fetch with an AbortController timeout. Rejects on timeout or network error. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 408, 429, and any 5xx are worth retrying; other statuses are not. */
export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
