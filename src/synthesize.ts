// Merges every reviewer's findings into ONE review. Dedupes, records which
// models agreed, ranks, and picks the verdict. Uses a strong model, with a
// deterministic fallback if that call fails so we always post something.

import { LIMITS } from './config';
import type { MergedFinding, ReviewerResult, Severity, Synthesis, Verdict } from './findings';
import { SEVERITY_RANK } from './findings';
import { chat, extractJson } from './openrouter';

const SEVERITIES: Severity[] = ['blocker', 'high', 'medium', 'nit'];
const VERDICTS: Verdict[] = ['MERGE', 'COMMENT', 'BLOCK'];

const SYSTEM = `You are the lead reviewer. Several models reviewed one pull request independently.
Merge their findings into a single, de-duplicated review.
Rules:
- Combine findings that describe the same issue into one; list every reviewer id that raised it in "agreedBy". Agreement across models is strong signal — rank those higher.
- Drop duplicates, contradicted claims, and low-value noise. Keep genuine nits but mark them severity "nit".
- Do not invent issues no reviewer raised.
- Choose one overall verdict:
  - "BLOCK" only if there is a confirmed correctness, security, or data-loss defect.
  - "COMMENT" for non-blocking issues worth addressing.
  - "MERGE" if nothing material survives.

Return ONLY this JSON:
{"summary":"2-5 sentence markdown summary of the review","verdict":"MERGE|COMMENT|BLOCK","findings":[{"path":"src/x.ts","line":42,"severity":"high","category":"correctness","title":"...","body":"...","agreedBy":["openai","deepseek"]}]}`;

export interface Eligible {
  (path: string, line: number | null): boolean;
}

export async function synthesize(
  reviewers: ReviewerResult[],
  synthModel: string,
  isEligible: Eligible,
): Promise<Synthesis> {
  const raw = reviewers.flatMap((r) =>
    r.findings.map((f) => ({ reviewer: r.id, model: r.model, ...f })),
  );

  // Nothing to merge — short-circuit to a clean MERGE.
  if (raw.length === 0) {
    const errored = reviewers.filter((r) => r.error);
    const note = errored.length
      ? ` (${errored.length} reviewer(s) failed: ${errored.map((r) => r.id).join(', ')})`
      : '';
    return {
      summary: `No issues found by the panel${note}.`,
      verdict: 'MERGE',
      findings: [],
    };
  }

  try {
    const user = `Reviewer findings (JSON):\n${JSON.stringify(raw)}`;
    const out = extractJson<{
      summary?: unknown;
      verdict?: unknown;
      findings?: unknown;
    }>(await chat({ model: synthModel, system: SYSTEM, user, maxTokens: LIMITS.maxSynthTokens, json: true }));
    return finalize(
      typeof out.summary === 'string' ? out.summary : 'Review complete.',
      VERDICTS.includes(out.verdict as Verdict) ? (out.verdict as Verdict) : 'COMMENT',
      normalizeMerged(out.findings),
      isEligible,
    );
  } catch {
    // Deterministic fallback: dedupe by path+line+title, verdict from severity.
    return fallbackMerge(raw, isEligible);
  }
}

function finalize(
  summary: string,
  verdict: Verdict,
  findings: MergedFinding[],
  isEligible: Eligible,
): Synthesis {
  const withInline = findings.map((f) => ({
    ...f,
    inline: f.severity !== 'nit' && isEligible(f.path, f.line),
  }));
  withInline.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return { summary, verdict, findings: withInline };
}

function normalizeMerged(input: unknown): MergedFinding[] {
  if (!Array.isArray(input)) return [];
  const out: MergedFinding[] = [];
  for (const item of input) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const path = typeof o['path'] === 'string' ? o['path'] : '';
    const title = typeof o['title'] === 'string' ? o['title'] : '';
    if (!path || !title) continue;
    const severity: Severity = SEVERITIES.includes(o['severity'] as Severity)
      ? (o['severity'] as Severity)
      : 'medium';
    const lineRaw = o['line'];
    const line = typeof lineRaw === 'number' && Number.isFinite(lineRaw) ? Math.trunc(lineRaw) : null;
    const agreedBy = Array.isArray(o['agreedBy'])
      ? (o['agreedBy'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    out.push({
      path,
      line,
      severity,
      category: typeof o['category'] === 'string' ? o['category'] : 'general',
      title: title.slice(0, 120),
      body: typeof o['body'] === 'string' ? o['body'] : '',
      agreedBy,
      inline: false,
    });
  }
  return out;
}

function fallbackMerge(
  raw: Array<{ reviewer: string } & { path: string; line: number | null; severity: Severity; category: string; title: string; body: string }>,
  isEligible: Eligible,
): Synthesis {
  const byKey = new Map<string, MergedFinding>();
  for (const f of raw) {
    const key = `${f.path}:${f.line ?? 'x'}:${f.title.toLowerCase().slice(0, 40)}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.agreedBy.includes(f.reviewer)) existing.agreedBy.push(f.reviewer);
      if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) existing.severity = f.severity;
    } else {
      byKey.set(key, {
        path: f.path,
        line: f.line,
        severity: f.severity,
        category: f.category,
        title: f.title,
        body: f.body,
        agreedBy: [f.reviewer],
        inline: false,
      });
    }
  }
  const findings = [...byKey.values()];
  const top = findings.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity]), 0);
  const verdict: Verdict = top >= SEVERITY_RANK.blocker ? 'BLOCK' : top > SEVERITY_RANK.nit ? 'COMMENT' : 'MERGE';
  const summary = `Synthesis model unavailable; showing a deterministic merge of ${findings.length} finding(s) from the panel.`;
  return finalize(summary, verdict, findings, isEligible);
}
