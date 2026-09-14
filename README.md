# pr-review-ci

On-demand, multi-model pull-request reviewer for GitHub Actions. A panel of
several models (GPT, DeepSeek, Llama, Qwen, Gemini, Mistral) reviews a PR
through [OpenRouter](https://openrouter.ai), and their views are **combined into
one review** — high-value findings inline, plus a top-level comment ending in a
**MERGE / COMMENT / BLOCK** recommendation.

It runs only when you ask — a slash command or a label — not on every push. One
OpenRouter key drives the whole panel. The review posts as a comment; it never
auto-approves or requests changes.

See [`docs/plan.md`](docs/plan.md) for the full design.

## How it works

1. **Gather.** Read the PR diff, files, and metadata.
2. **Bucket.** Deterministic metrics classify the PR by size and kind.
3. **Plan.** A cheap classifier model picks which personas to run and a per-PR
   focus for each.
4. **Fan out.** Each reviewer persona runs on a **different model lineage** and
   returns structured findings.
5. **Cluster.** Findings are grouped deterministically across models — agreement
   between lineages raises confidence, lone findings are demoted.
6. **Synthesize.** One model merges the clusters into a single review: inline
   comments on the highest-value findings, plus a top-level `MERGE`, `COMMENT`,
   or `BLOCK` verdict.

Re-running replaces its own comments in place — the summary is upserted and the
prior run's inline comments are deleted, both matched by hidden markers.

## Why a non-Claude panel

The models here are deliberately drawn from lineages other than Claude. The
value of a review panel is disagreement: a single model family shares blind
spots, so a second Claude reviewer mostly agrees with the first. Mixing GPT,
DeepSeek, Llama, Qwen, Gemini, and Mistral surfaces findings any one family
would miss. Swap the roster for any models OpenRouter serves — the panel is just
a list (see below).

## How it picks reviewers

Each reviewer is a staff-level **persona** with its own checklist
([`src/personas.ts`](src/personas.ts)): correctness, security, performance,
web-ui/accessibility, qa, data-architect, cloudflare, simplicity, docs. The
planner picks personas by what the PR touches and runs each on a different model
lineage.

| PR size / kind         | Personas (count)                     |
| ---------------------- | ------------------------------------ |
| docs-only              | docs (1)                             |
| tests-only             | qa (1)                               |
| small (<50 code lines) | correctness / top overlay persona (1) |
| medium (50–300)        | top 2 personas (2)                   |
| large (>300)           | top 3 personas (3)                   |

Path-based overlays add specialists: `migrations/` pulls in the data-architect;
worker/D1/KV/R2 pulls in the Cloudflare expert; auth/crypto/PII pulls in
security; UI files pull in web-ui. Default model ids are in
[`src/config.ts`](src/config.ts).

## Quick start

You need an OpenRouter API key ([openrouter.ai/keys](https://openrouter.ai/keys))
with credit on it. The whole panel bills to that one key.

### 1. Add the key as a repo secret

Add `OPENROUTER_API_KEY` to every repo that calls the reviewer:

```bash
gh secret set OPENROUTER_API_KEY --repo <owner>/<repo>
```

(On an organization you can set it once as an org secret and share it with the
repos that need it instead.)

### 2. Add a caller workflow

Reference this action's reusable workflow from your repo. Two triggers, use
either or both.

**`.github/workflows/pr-review-command.yml`** — comment `/review`, `/review low`,
or `/review high` on a PR:

```yaml
name: PR Review (command)
on:
  issue_comment:
    types: [created]

jobs:
  review:
    if: >
      github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '/review')
    uses: NimbleEngineer21/pr-review-ci/.github/workflows/review.yml@main
    with:
      pr_number: ${{ github.event.issue.number }}
      effort: >-
        ${{ contains(github.event.comment.body, 'high') && 'high'
        || (contains(github.event.comment.body, 'low') && 'low' || '') }}
    secrets: inherit
```

**`.github/workflows/pr-review-label.yml`** — add the label `ai-review`
(auto effort) or `ai-review-deep` (high) to a PR:

```yaml
name: PR Review (label)
on:
  pull_request:
    types: [labeled]

jobs:
  review:
    if: >
      github.event.label.name == 'ai-review' ||
      github.event.label.name == 'ai-review-deep'
    uses: NimbleEngineer21/pr-review-ci/.github/workflows/review.yml@main
    with:
      pr_number: ${{ github.event.pull_request.number }}
      effort: ${{ github.event.label.name == 'ai-review-deep' && 'high' || '' }}
    secrets: inherit
```

Create the labels once per repo:

```bash
gh label create ai-review      --repo <owner>/<repo> --color 1f6feb --description "Run the multi-model PR review"
gh label create ai-review-deep --repo <owner>/<repo> --color 8250df --description "Run the full high-effort panel"
```

### 3. (Private action only) allow cross-repo use

If your fork of this repo is **private**, grant the caller repos access:
its Settings → Actions → General → **Access** → allow the repos (or the whole
owner) that call it. A public action needs no such grant.

Pin callers to a tag (`@v1`) instead of `@main` once you cut a release, for
stability.

## Per-repo tuning (optional)

Drop a `.github/pr-review.json` in the caller repo to override defaults. Every
field is optional; unknown or malformed fields are ignored. It is fetched from
the caller's default branch.

```json
{
  "models": {
    "classifier": "openai/gpt-5-nano",
    "synth": "openai/gpt-5-mini",
    "pool": ["openai/gpt-5-mini", "deepseek/deepseek-v4.1-flash", "meta-llama/llama-3.3-70b-instruct"],
    "cheapPool": ["google/gemini-2.5-flash", "qwen/qwen3-coder-30b-a3b-instruct"]
  },
  "limits": { "maxReviewers": 3, "maxDiffChars": 120000 },
  "thresholds": { "small": 50, "medium": 300 },
  "disabledPersonas": ["cloudflare"]
}
```

Use it to swap the model roster per repo, cap the panel size, retune the size
buckets, or drop a persona a repo doesn't need (e.g. `cloudflare` on a
non-Workers repo).

## Local development

```bash
npm ci
npm test          # metrics, policy, diff-line mapping, config, clustering
npm run typecheck
```

Run against a real PR locally:

```bash
GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
GITHUB_TOKEN=... OPENROUTER_API_KEY=... EFFORT=low \
npm run review
```

## Notes

- The review posts `event: COMMENT` — it recommends, it never auto-approves or
  requests changes. The final call stays with a human.
- No secrets live in this repo. Keys stay in each caller repo's secrets and reach
  the reusable workflow via `secrets: inherit`.
- Costs scale with panel size and diff length. Use `effort: low`, a smaller
  `pool`, or `maxReviewers` / `maxDiffChars` to hold spend down.
