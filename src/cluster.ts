// Deterministic pre-clustering of reviewer findings. Groups near-identical
// findings (same file, adjacent line, similar title) across models so agreement
// is explicit and the synthesizer gets a compact, de-duplicated input. This is
// the cheap "architecture beats prompt-tuning" lever for cutting nit noise.

import type { ReviewerResult, Severity } from './findings';
import { SEVERITY_RANK } from './findings';

export interface Cluster {
  path: string;
  line: number | null;
  severity: Severity;
  category: string;
  title: string;
  bodies: string[];
  agreedBy: string[];
}

const STOP = new Set(['the', 'a', 'an', 'is', 'to', 'of', 'in', 'on', 'and', 'or', 'for', 'this', 'that', 'with', 'without', 'missing', 'should', 'not']);

function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function similar(a: string, b: string): boolean {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return a.toLowerCase() === b.toLowerCase();
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return inter / union >= 0.5;
}

function sameSpot(aLine: number | null, bLine: number | null): boolean {
  if (aLine == null || bLine == null) return aLine === bLine;
  return Math.abs(aLine - bLine) <= 2;
}

export function clusterFindings(reviewers: ReviewerResult[]): Cluster[] {
  const clusters: Cluster[] = [];

  for (const r of reviewers) {
    for (const f of r.findings) {
      const match = clusters.find(
        (c) => c.path === f.path && sameSpot(c.line, f.line) && similar(c.title, f.title),
      );
      if (match) {
        if (!match.agreedBy.includes(r.id)) match.agreedBy.push(r.id);
        if (f.body && !match.bodies.includes(f.body)) match.bodies.push(f.body);
        if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[match.severity]) {
          match.severity = f.severity;
          match.title = f.title;
          match.category = f.category;
          // Prefer the higher-severity member's line if the cluster had none.
          if (match.line == null) match.line = f.line;
        }
      } else {
        clusters.push({
          path: f.path,
          line: f.line,
          severity: f.severity,
          category: f.category,
          title: f.title,
          bodies: f.body ? [f.body] : [],
          agreedBy: [r.id],
        });
      }
    }
  }

  clusters.sort((a, b) => {
    const bySev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySev !== 0) return bySev;
    return b.agreedBy.length - a.agreedBy.length;
  });
  return clusters;
}
