# pr-review-ci

On-demand, multi-model pull-request reviewer. A **diverse non-Claude panel**
(GPT, DeepSeek, Llama, Qwen, Gemini, Mistral) reviews a PR through OpenRouter,
and their views are **combined into one review** — high-value findings inline,
plus a top-level comment ending in a **MERGE / COMMENT / BLOCK** recommendation.

It runs only when you ask (a slash command or a label), not on every push. See
[`docs/plan.md`](docs/plan.md) for the full design.

## Why non-Claude

You already review with Claude in-session. This panel exists to add the *other*
lineages, so the CI review catches what a single model family is blind to.

## How it decides (auto)

Each reviewer is a staff-level **persona** with its own checklist
([`src/personas.ts`](src/personas.ts)): correctness, security, performance,
web-ui/accessibility, qa, data-architect, cloudflare, simplicity, docs. The
planner picks personas by what the PR touches and runs each on a **different
model lineage** for diverse views.

| PR size / kind         | Personas (count)                          |
| ---------------------- | ----------------------------------------- |
| docs-only              | docs (1)                                   |
| tests-only             | qa (1)                                      |
| small (<50 code lines) | correctness / top overlay persona (1)      |
| medium (50–300)        | top 2 personas (2)                          |
| large (>300)           | top 3 personas (3)                          |

Touching `migrations/` pulls in the data-architect; worker/D1/KV/R2 pulls in the
Cloudflare expert; auth/crypto/PII pulls in security; UI files pull in web-ui.
Model ids are in [`src/config.ts`](src/config.ts).

## Local development

```bash
npm ci
npm test          # metrics, policy, diff-line mapping
npm run typecheck
```

Run against a real PR locally:

```bash
GITHUB_REPOSITORY=owner/repo PR_NUMBER=123 \
GITHUB_TOKEN=... OPENROUTER_API_KEY=... EFFORT=low \
npm run review
```

## Wire a repo into it

### 1. Add the key as a repo secret

This is a personal (User) account, so there are no org secrets — each repo that
uses the reviewer needs its own copy:

```bash
gh secret set OPENROUTER_API_KEY --repo NimbleEngineer21/<repo>
```

### 2. Allow cross-repo use of this private action

`pr-review-ci` → Settings → Actions → General → **Access** → "Accessible from
repositories owned by NimbleEngineer21".

### 3. Add the two caller workflows

**`.github/workflows/claude-review-command.yml`** — comment `/review`,
`/review low`, or `/review high` on a PR:

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
gh label create ai-review      --repo NimbleEngineer21/<repo> --color 1f6feb --description "Run the multi-model PR review"
gh label create ai-review-deep --repo NimbleEngineer21/<repo> --color 8250df --description "Run the full high-effort panel"
```

## Notes

- The review posts `event: COMMENT` — it recommends, it never auto-approves or
  requests changes.
- Re-running updates the summary comment in place (matched by a hidden marker);
  inline comments from prior runs currently remain (Phase 3 will replace them).
- Pin callers to a tag (`@v1`) instead of `@main` once you cut one, for stability.
