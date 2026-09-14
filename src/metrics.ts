// Deterministic PR metrics: size bucket + path overlays. No LLM, no network.
// This is the reliable floor the smart classifier (Phase 2) builds on.

import { settings } from './config';

export type Bucket = 'docs-only' | 'tests-only' | 'small' | 'medium' | 'large';

export interface ChangedFile {
  path: string;
  additions: number;
  deletions: number;
  status: string;
  patch?: string;
}

export interface Metrics {
  files: ChangedFile[];
  /** additions + deletions across non-doc files. */
  codeChurn: number;
  bucket: Bucket;
  /** Risk overlays derived from touched paths, e.g. ['migrations','security']. */
  overlays: string[];
}

const DOC_RE = /(\.mdx?$)|(^|\/)docs\//i;
const CONTENT_RE = /(^|\/)content\//i;
const TEST_RE = /(\.|_|-)(test|spec)\.[jt]sx?$|(^|\/)__tests__\/|(^|\/)tests?\//i;

const OVERLAY_RULES: Array<{ overlay: string; re: RegExp }> = [
  { overlay: 'migrations', re: /(^|\/)migrations\/.*\.sql$/i },
  { overlay: 'ci', re: /(^|\/)\.github\/workflows\//i },
  {
    overlay: 'security',
    re: /auth|crypto|password|secret|token|session|pii|encrypt|login|oauth|permission/i,
  },
  {
    overlay: 'cloudflare',
    re: /(^|\/)wrangler\.(toml|json|jsonc)$|(^|\/)(src\/)?worker\/|(^|\/)functions\/|durable[-_]?object|\bd1\b|\bkv\b|\br2\b/i,
  },
  {
    overlay: 'frontend',
    re: /\.(astro|tsx|jsx|vue|svelte|css|scss)$|(^|\/)components\/|(^|\/)pages\//i,
  },
];

export function isDoc(path: string): boolean {
  return DOC_RE.test(path) || CONTENT_RE.test(path);
}

export function isTest(path: string): boolean {
  return TEST_RE.test(path);
}

export function bucketFor(files: ChangedFile[]): { bucket: Bucket; codeChurn: number } {
  if (files.length === 0) return { bucket: 'small', codeChurn: 0 };

  const allDocs = files.every((f) => isDoc(f.path));
  if (allDocs) return { bucket: 'docs-only', codeChurn: 0 };

  const nonDoc = files.filter((f) => !isDoc(f.path));
  const allTests = nonDoc.length > 0 && nonDoc.every((f) => isTest(f.path));

  const codeChurn = nonDoc.reduce((n, f) => n + f.additions + f.deletions, 0);
  if (allTests) return { bucket: 'tests-only', codeChurn };

  let bucket: Bucket;
  if (codeChurn < settings.thresholds.small) bucket = 'small';
  else if (codeChurn <= settings.thresholds.medium) bucket = 'medium';
  else bucket = 'large';
  return { bucket, codeChurn };
}

export function overlaysFor(files: ChangedFile[]): string[] {
  const hits = new Set<string>();
  for (const f of files) {
    for (const rule of OVERLAY_RULES) {
      if (rule.re.test(f.path)) hits.add(rule.overlay);
    }
  }
  return [...hits];
}

export function computeMetrics(files: ChangedFile[]): Metrics {
  const { bucket, codeChurn } = bucketFor(files);
  return { files, codeChurn, bucket, overlays: overlaysFor(files) };
}
