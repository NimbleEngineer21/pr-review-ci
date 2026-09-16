// Entry point run by the GitHub Action. Orchestrates the pipeline:
// gather -> metrics -> plan -> fan-out reviewers -> synthesize -> post once.

import type { Effort } from './findings';
import { applyConfig, settings } from './config';
import { computeMetrics } from './metrics';
import { planReview } from './planner';
import { planRunBudget } from './policy';
import { runReviewer } from './reviewer';
import { synthesize } from './synthesize';
import { usage } from './openrouter';
import { buildCommentableIndex, isInlineEligible } from './diffmap';
import { buildInlineComments, buildSummaryMarkdown } from './render';
import {
  gatherPull,
  postReview,
  upsertSummaryComment,
  fetchRepoConfig,
  deletePriorInlineComments,
} from './github';

function parseEffort(raw: string | undefined): Effort | undefined {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'low' || v === 'medium' || v === 'high' ? v : undefined;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function main(): Promise<void> {
  const [owner, repo] = requireEnv('GITHUB_REPOSITORY').split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY must be owner/repo');
  const number = Number(requireEnv('PR_NUMBER'));
  if (!Number.isInteger(number)) throw new Error('PR_NUMBER must be an integer');
  requireEnv('OPENROUTER_API_KEY');
  requireEnv('GITHUB_TOKEN');
  const effort = parseEffort(process.env.EFFORT);

  // Optional per-repo overrides from .github/pr-review.json (default branch).
  const repoConfig = await fetchRepoConfig(owner, repo);
  applyConfig(repoConfig);
  if (repoConfig) console.log('Applied .github/pr-review.json overrides.');

  console.log(`::group::Gather PR #${number}`);
  const ctx = await gatherPull(owner, repo, number);
  console.log(`${ctx.files.length} changed file(s)`);
  console.log('::endgroup::');

  const metrics = computeMetrics(ctx.files);
  const plan = await planReview(metrics, effort);

  // Cost guard: keep total projected input under the run budget for a huge PR.
  const diffChars = ctx.files.reduce((n, f) => n + (f.patch?.length ?? 0), 0);
  const budget = planRunBudget(
    plan.reviewers.length,
    diffChars,
    settings.limits.maxRunInputTokens,
    settings.limits.maxDiffChars,
  );
  if (budget.actions.length > 0) {
    settings.limits.maxDiffChars = budget.maxDiffChars;
    plan.reviewers = plan.reviewers.slice(0, budget.seats);
    console.log(
      `Budget guard: projected input exceeded ${settings.limits.maxRunInputTokens} tokens — ${budget.actions.join('; ')}.`,
    );
  }

  console.log(
    `Plan: bucket=${metrics.bucket} overlays=[${metrics.overlays.join(',')}] ` +
      `effort=${effort ?? 'auto'} reviewers=${plan.reviewers.map((r) => `${r.persona}:${r.model}`).join(', ')}`,
  );

  console.log('::group::Reviewers');
  const results = await Promise.all(plan.reviewers.map((entry) => runReviewer(entry, ctx)));
  for (const r of results) {
    console.log(`${r.id} (${r.model}): ${r.error ? `ERROR ${r.error}` : `${r.findings.length} finding(s)`}`);
  }
  console.log('::endgroup::');

  const index = buildCommentableIndex(ctx.files);
  const synth = await synthesize(results, plan.synthModel, (path, line) =>
    isInlineEligible(index, path, line),
  );
  console.log(`Synthesis: verdict=${synth.verdict} findings=${synth.findings.length}`);

  const inline = buildInlineComments(synth);
  const summary = buildSummaryMarkdown(plan, results, synth);

  console.log('::group::Post');
  // The summary comment is the primary deliverable — it carries the verdict and
  // every finding. Post it first so it lands even if the inline pass has trouble.
  await upsertSummaryComment(ctx, summary);
  const removed = await deletePriorInlineComments(ctx);
  if (removed) console.log(`Cleared ${removed} inline comment(s) from a prior run.`);
  // Inline comments are a best-effort enhancement (the summary already lists the
  // findings). Never fail the whole run if only the inline pass fails.
  if (inline.length > 0) {
    try {
      await postReview(ctx, `See the summary comment for the ${synth.verdict} recommendation.`, inline);
      console.log(`Posted ${inline.length} inline comment(s) and the summary.`);
    } catch (err) {
      console.error(
        `Inline comments failed to post; the summary comment is up to date. ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    console.log('Posted the summary; no inline comments to attach.');
  }
  console.log('::endgroup::');

  const cost = usage.cost > 0 ? ` cost=$${usage.cost.toFixed(4)}` : '';
  console.log(`Usage: ${usage.calls} model call(s), ${usage.totalTokens} token(s)${cost}`);
  for (const [model, u] of Object.entries(usage.byModel)) {
    const c = u.cost > 0 ? ` $${u.cost.toFixed(4)}` : '';
    console.log(`  ${model}: ${u.calls} call(s), ${u.totalTokens} token(s)${c}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
