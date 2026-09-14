// Merges every reviewer's findings into ONE review. Deterministic pre-clustering
// makes agreement explicit and compact; a strong model then keeps the real
// issues, sets final severity/verdict, and writes the summary. If that call
// fails we post the deterministic cluster merge, so a review always lands.

import { settings } from './config';
import type { MergedFinding, ReviewerResult, Severity, Synthesis, Verdict } from './findings';
import { SEVERITY_RANK } from './findings';
import { chat, extractJson } from './openrouter';
import { clusterFindings, type Cluster } from './cluster';

const SEVERITIES: Severity[] = ['blocker', 'high', 'medium', 'nit'];
const VERDICTS: Verdict[] = ['MERGE', 'COMMENT', 'BLOCK'];

const SYSTEM = `You are the lead reviewer. Multiple staff engineers reviewed one pull request and their findings are already clustered by issue. "agreedBy" lists the reviewers who raised each cluster — agreement across independent models is strong signal; rank those higher.
Your job:
- Keep the real, defensible issues. Drop noise, contradicted claims, and anything without a concrete problem.
- Do NOT invent issues that are not in the clusters.
- Set a final severity per issue and one overall verdict:
  - "BLOCK" only for a confirmed correctness, security, or data-loss defect.
  - "COMMENT" for non-blocking issues worth addressing.
  - "MERGE" if nothing material survives.

Return ONLY this JSON:
{"summary":"2-5 sentence markdown summary","verdict":"MERGE|COMMENT|BLOCK","findings":[{"path":"src/x.ts","line":42,"severity":"high","category":"security","title":"...","body":"the issue, the trigger, and the fix","agreedBy":["security","qa"]}]}`;

export interface Eligible {
  (path: string, line: number | null): boolean;
}

export async function synthesize(
  reviewers: ReviewerResult[],
  synthModel: string,
  isEligible: Eligible,
): Promise<Synthesis> {
  const clusters = clusterFindings(reviewers);

  if (clusters.length === 0) {
    const errored = reviewers.filter((r) => r.error);
    const note = errored.length
      ? ` (${errored.length} reviewer(s) failed: ${errored.map((r) => r.id).join(', ')})`
      : '';
    return { summary: `No issues found by the panel${note}.`, verdict: 'MERGE', findings: [] };
  }

  try {
    const compact = clusters.map((c) => ({
      path: c.path,
      line: c.line,
      severity: c.severity,
      category: c.category,
      title: c.title,
      body: c.bodies.join(' | '),
      agreedBy: c.agreedBy,
    }));
    const out = extractJson<{ summary?: unknown; verdict?: unknown; findings?: unknown }>(
      await chat({
        model: synthModel,
        system: SYSTEM,
        user: `Clustered findings (JSON):\n${JSON.stringify(compact)}`,
        maxTokens: settings.limits.maxSynthTokens,
        json: true,
      }),
    );
    return finalize(
      typeof out.summary === 'string' ? out.summary : 'Review complete.',
      VERDICTS.includes(out.verdict as Verdict) ? (out.verdict as Verdict) : 'COMMENT',
      normalizeMerged(out.findings),
      isEligible,
    );
  } catch {
    return fallbackMerge(clusters, isEligible);
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

function fallbackMerge(clusters: Cluster[], isEligible: Eligible): Synthesis {
  const findings: MergedFinding[] = clusters.map((c) => ({
    path: c.path,
    line: c.line,
    severity: c.severity,
    category: c.category,
    title: c.title,
    body: c.bodies.join(' | '),
    agreedBy: c.agreedBy,
    inline: false,
  }));
  const top = findings.reduce((m, f) => Math.max(m, SEVERITY_RANK[f.severity]), 0);
  const verdict: Verdict =
    top >= SEVERITY_RANK.blocker ? 'BLOCK' : top > SEVERITY_RANK.nit ? 'COMMENT' : 'MERGE';
  const summary = `Synthesis model unavailable; showing a deterministic merge of ${findings.length} clustered finding(s).`;
  return finalize(summary, verdict, findings, isEligible);
}
