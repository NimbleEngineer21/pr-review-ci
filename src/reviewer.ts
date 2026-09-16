// Runs one reviewer: send the diff + goal to a model, get structured findings.
// Reviewers never post; they only return findings for the synthesizer to merge.

import { settings } from './config';
import type { Effort, Finding, ReviewerResult, Severity } from './findings';
import { chat, extractJson } from './openrouter';
import { persona, type PersonaId } from './personas';
import type { PlanEntry } from './policy';
import type { PullContext } from './github';
import { matchesOverlay, type ChangedFile } from './metrics';

// A specialist persona reviews a bounded slice of the PR. It receives its own
// files at full fidelity plus a one-line-per-file digest of the rest for
// cross-file context, instead of the whole diff. Generalist personas (not
// listed) get the full diff, because their lens spans every file. The value is
// each specialist's overlay name from metrics.ts.
const PERSONA_LENS: Partial<Record<PersonaId, string>> = {
  security: 'security',
  'data-architect': 'migrations',
  cloudflare: 'cloudflare',
  'web-ui': 'frontend',
};

const EFFORT_HINT: Record<Effort, string> = {
  low: 'Be fast. Report only clear, high-value issues. Skip style nits.',
  medium: 'Be thorough on correctness and security. Include notable nits.',
  high: 'Be exhaustive. Trace edge cases, error paths, and interactions across the diff.',
};

const SEVERITIES: Severity[] = ['blocker', 'high', 'medium', 'nit'];

/**
 * Annotate a patch with NEW-file line numbers so a model can cite the exact
 * line an inline comment must attach to. Added/context lines are prefixed with
 * their new-file number; removed lines get no number (not commentable).
 */
function annotatePatch(patch: string): string {
  const out: string[] = [];
  let newLine = 0;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      out.push(raw);
      continue;
    }
    if (raw.startsWith('+')) {
      out.push(`${String(newLine).padStart(5)} +${raw.slice(1)}`);
      newLine++;
    } else if (raw.startsWith('-')) {
      out.push(`      -${raw.slice(1)}`);
    } else if (raw.startsWith('\\')) {
      out.push(raw);
    } else {
      out.push(`${String(newLine).padStart(5)}  ${raw.slice(1)}`);
      newLine++;
    }
  }
  return out.join('\n');
}

function fullFile(f: ChangedFile): string {
  if (!f.patch) return `# ${f.path} (${f.status}, no patch available — binary or too large)`;
  return `# ${f.path} (${f.status}, +${f.additions}/-${f.deletions})\n${annotatePatch(f.patch)}`;
}

/** One line per file: path, status, churn, and the first few hunk headers. */
function digestLine(f: ChangedFile): string {
  const heads = (f.patch ?? '')
    .split('\n')
    .filter((l) => l.startsWith('@@'))
    .slice(0, 3)
    .join(' ');
  return `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions}) ${heads}`.trim();
}

function truncate(text: string): string {
  if (text.length <= settings.limits.maxDiffChars) return text;
  return `${text.slice(0, settings.limits.maxDiffChars)}\n\n[diff truncated at ${settings.limits.maxDiffChars} chars]`;
}

/**
 * The diff a given persona reviews. A specialist gets its lens files in full
 * plus a compact digest of the other files (so it keeps cross-file context
 * without paying for the full text). A generalist — or a specialist whose lens
 * matched no file — gets the whole diff.
 */
export function buildDiffText(ctx: PullContext, personaId: PersonaId): string {
  const lens = PERSONA_LENS[personaId];
  if (!lens) return truncate(ctx.files.map(fullFile).join('\n\n'));

  const inLens = ctx.files.filter((f) => matchesOverlay(f.path, lens));
  const rest = ctx.files.filter((f) => !matchesOverlay(f.path, lens));
  if (inLens.length === 0) return truncate(ctx.files.map(fullFile).join('\n\n'));

  const parts = [inLens.map(fullFile).join('\n\n')];
  if (rest.length > 0) {
    parts.push(
      `# Other changed files (context digest — not your focus, review only the files above)\n${rest
        .map(digestLine)
        .join('\n')}`,
    );
  }
  return truncate(parts.join('\n\n'));
}

// Shared output contract appended to every persona's lens. The confidence
// discipline is adapted from Qodo PR-Agent's reviewer prompt, which measurably
// cuts false positives without dropping real bugs.
const OUTPUT_CONTRACT = `Review only the code ADDED in this diff (lines prefixed with "+"). Each such line is labelled with its NEW-file line number — cite that number.

Confidence discipline (follow exactly):
- For clear bugs and security issues, be thorough. Do not skip a genuine problem just because its trigger is narrow.
- For lower-severity concerns, be certain before flagging. If you cannot explain the problem with a concrete triggering scenario, do NOT flag it.
- When confidence is limited but impact is high (data loss, security), report it and state plainly what is uncertain. Otherwise prefer silence over guessing.
- No praise, no restating the change, no style opinions the repo does not already enforce.

For each finding give the concrete trigger and a concrete fix.

Return ONLY a JSON object of this exact shape:
{"findings":[{"path":"src/x.ts","line":42,"severity":"high","category":"security","title":"short title","body":"what is wrong, the trigger, and the fix","confidence":0.8}]}
- severity is one of: blocker, high, medium, nit.
- line is the new-file line number, or null for a file/PR-level note.
- Keep title under 80 chars. Return an empty findings array if you find nothing in your focus.`;

export async function runReviewer(entry: PlanEntry, ctx: PullContext): Promise<ReviewerResult> {
  const p = persona(entry.persona);
  const system = `${p.system}\n\n${OUTPUT_CONTRACT}`;
  const user = [
    `PR: ${ctx.title}`,
    ctx.body ? `Description:\n${ctx.body.slice(0, 2000)}` : '',
    entry.focus,
    EFFORT_HINT[entry.effort],
    '',
    'Diff:',
    buildDiffText(ctx, entry.persona),
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const raw = await chat({
      model: entry.model,
      system,
      user,
      maxTokens: settings.limits.maxOutputTokens,
      json: true,
    });
    const parsed = extractJson<{ findings?: unknown }>(raw);
    const findings = normalizeFindings(parsed.findings);
    return { id: entry.id, title: p.title, model: entry.model, findings };
  } catch (err) {
    return {
      id: entry.id,
      title: p.title,
      model: entry.model,
      findings: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizeFindings(input: unknown): Finding[] {
  if (!Array.isArray(input)) return [];
  const out: Finding[] = [];
  for (const item of input) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const path = typeof o['path'] === 'string' ? o['path'] : '';
    const title = typeof o['title'] === 'string' ? o['title'] : '';
    const body = typeof o['body'] === 'string' ? o['body'] : '';
    if (!path || !title) continue;
    const severity: Severity = SEVERITIES.includes(o['severity'] as Severity)
      ? (o['severity'] as Severity)
      : 'medium';
    const lineRaw = o['line'];
    const line = typeof lineRaw === 'number' && Number.isFinite(lineRaw) ? Math.trunc(lineRaw) : null;
    const conf = typeof o['confidence'] === 'number' ? o['confidence'] : undefined;
    out.push({
      path,
      line,
      severity,
      category: typeof o['category'] === 'string' ? o['category'] : 'general',
      title: title.slice(0, 120),
      body,
      confidence: conf,
    });
  }
  return out;
}
