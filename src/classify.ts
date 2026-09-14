// Phase 2 smart classifier. A cheap model looks at the deterministic metrics
// plus a compact diff digest and chooses which staff personas add the most
// value for THIS PR, with a specific focus each. Deterministic metrics are the
// seed so the model never guesses size; it only refines persona + focus.

import { settings } from './config';
import { chat, extractJson } from './openrouter';
import { PERSONAS, type PersonaId } from './personas';
import { ALL_PERSONAS, reviewerCount, type PersonaChoice } from './policy';
import type { Metrics } from './metrics';

/** Compact, cheap-to-tokenize view of the change for the classifier. */
export function buildDigest(metrics: Metrics): string {
  const lines: string[] = [];
  for (const f of metrics.files) {
    const heads = (f.patch ?? '')
      .split('\n')
      .filter((l) => l.startsWith('@@'))
      .slice(0, 3)
      .join(' ');
    lines.push(`- ${f.path} (+${f.additions}/-${f.deletions}) ${heads}`.trim());
  }
  return lines.join('\n').slice(0, 8000);
}

function catalog(): string {
  return ALL_PERSONAS.map((id) => `- ${id}: ${PERSONAS[id].title}`).join('\n');
}

const SYSTEM = `You route a pull request to the most valuable staff-level reviewers.
You are given deterministic metrics (already correct — do not second-guess size) and a digest of the change.
Choose the reviewer personas that add the most value for THIS specific PR, and give each a one-sentence, PR-specific focus.
Pick the smallest set that covers the real risk. Do not add a persona whose lens the diff does not exercise.

Return ONLY this JSON:
{"reviewers":[{"persona":"security","focus":"Check the new token-claim path for IDOR and missing rate limits."}]}
- persona must be one of the catalog ids.
- 1 to MAXREVIEWERS reviewers.`;

/**
 * Returns persona choices, or null on any failure so the caller falls back to
 * the deterministic plan.
 */
export async function classifyPlan(metrics: Metrics): Promise<PersonaChoice[] | null> {
  const suggested = Math.min(reviewerCount(metrics.bucket), settings.limits.maxReviewers);
  const user = [
    `Persona catalog:\n${catalog()}`,
    '',
    `Metrics: bucket=${metrics.bucket}; codeChurn=${metrics.codeChurn}; overlays=[${metrics.overlays.join(', ')}]`,
    `Deterministic suggestion: about ${suggested} reviewer(s). You may adjust between 1 and ${settings.limits.maxReviewers}.`,
    '',
    `Change digest:\n${buildDigest(metrics)}`,
  ].join('\n');

  try {
    const raw = await chat({
      model: settings.models.classifier,
      system: SYSTEM.replace('MAXREVIEWERS', String(settings.limits.maxReviewers)),
      user,
      maxTokens: 700,
      json: true,
    });
    const parsed = extractJson<{ reviewers?: unknown }>(raw);
    if (!Array.isArray(parsed.reviewers)) return null;

    const valid = new Set<PersonaId>(ALL_PERSONAS);
    const choices: PersonaChoice[] = [];
    for (const item of parsed.reviewers) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as Record<string, unknown>;
      const persona = o['persona'];
      if (typeof persona !== 'string' || !valid.has(persona as PersonaId)) continue;
      choices.push({
        persona: persona as PersonaId,
        focus: typeof o['focus'] === 'string' ? o['focus'] : undefined,
      });
    }
    return choices.length ? choices.slice(0, settings.limits.maxReviewers) : null;
  } catch {
    return null;
  }
}
