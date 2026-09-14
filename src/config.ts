// Model roster and tunables. All non-Claude on purpose: the maintainer already
// reviews with Claude in-session, so the CI panel exists to add OTHER lineages.
// IDs are OpenRouter model ids, verified live at build time. Edit here to tune.

export const MODELS = {
  // Cheap, reliable instruction-follower for the size/goal classifier (Phase 2).
  classifier: 'openai/gpt-5-nano',
  // Strong-but-affordable reasoner that merges every reviewer into one review.
  synth: 'openai/gpt-5-mini',
  // Single-reviewer picks for the cheap buckets.
  docs: 'google/gemini-2.5-flash',
  tests: 'qwen/qwen3-coder-30b-a3b-instruct',
  // Diverse panel pool — one strong model per training lineage.
  openai: 'openai/gpt-5-mini',
  deepseek: 'deepseek/deepseek-v4.1-flash',
  llama: 'meta-llama/llama-3.3-70b-instruct',
  qwen: 'qwen/qwen3-coder-30b-a3b-instruct',
  gemini: 'google/gemini-2.5-flash',
  mistral: 'mistralai/mistral-small-3.2-24b-instruct',
} as const;

// Model pools for persona assignment. Ordered strongest-first for review work.
// One persona per lineage keeps the panel diverse.
export const MODEL_POOL: string[] = [
  MODELS.openai,
  MODELS.deepseek,
  MODELS.llama,
  MODELS.qwen,
  MODELS.gemini,
  MODELS.mistral,
];
export const CHEAP_POOL: string[] = [MODELS.gemini, MODELS.qwen, MODELS.mistral];

// Hard caps so a runaway diff can never run up the bill.
export const LIMITS = {
  // Max characters of diff text sent to any single reviewer.
  maxDiffChars: 120_000,
  // Max reviewers in a panel regardless of policy.
  maxReviewers: 3,
  // Per-reviewer output token cap.
  maxOutputTokens: 4_000,
  // Synthesizer output token cap.
  maxSynthTokens: 4_000,
};

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const GITHUB_API = 'https://api.github.com';

// Marker so re-runs update the same summary comment instead of stacking.
export const SUMMARY_MARKER = '<!-- pr-review-ci:summary -->';
