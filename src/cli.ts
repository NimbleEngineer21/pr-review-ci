// Entry point run by the GitHub Action. Orchestrates the pipeline:
// gather -> metrics -> plan -> fan-out reviewers -> synthesize -> post once.

import type { Effort } from './findings';
import { applyConfig } from './config';
import { computeMetrics } from './metrics';
import { planReview } from './planner';
import { runReviewer } from './reviewer';
import { synthesize } from './synthesize';
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
  const removed = await deletePriorInlineComments(ctx);
  if (removed) console.log(`Cleared ${removed} inline comment(s) from a prior run.`);
  await postReview(ctx, `See the summary comment for the ${synth.verdict} recommendation.`, inline);
  await upsertSummaryComment(ctx, summary);
  console.log(`Posted ${inline.length} inline comment(s) and the summary.`);
  console.log('::endgroup::');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
