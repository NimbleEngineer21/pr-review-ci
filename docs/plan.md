# pr-review-ci — plan

On-demand, multi-model pull-request reviewer shared across the maintainer's
repos. It replaces Copilot PR review. It runs only when asked, not on every push.

## Goal

- Add review views the maintainer does not already get. The maintainer reviews
  with Claude in-session, so this panel uses **only non-Claude models** for
  different training lineages.
- One provider, one key: **OpenRouter** (`OPENROUTER_API_KEY`).
- Optional per PR. Triggered by a slash command or a label.
- Combine every model's view **before** posting. Surface the high-value findings
  inline and one synthesized top-level comment with a MERGE/COMMENT/BLOCK
  verdict. Nits are grouped, not dropped.

## Design

Pipeline (one testable Node/TypeScript CLI, run by a composite action):

1. **Gather** — read the PR diff + metadata via the GitHub API.
2. **Metrics** — deterministic size bucket + path overlays. No LLM, no network.
   - Buckets: `docs-only`, `tests-only`, `small` (<50 code lines), `medium`
     (50–300), `large` (>300).
   - Overlays: `migrations`, `security` (worker/auth/crypto/PII), `ci`.
3. **Plan** — bucket + overlays → which models review, at what effort, with what
   goal. Deterministic in Phase 1; a cheap classifier refines goals in Phase 2.
   Diversity is the selection rule.
4. **Reviewers** — each planned model gets the diff + its goal and returns
   structured findings JSON. Reviewers never post.
5. **Synthesize** — a strong non-Claude model merges all findings: dedupe,
   record model agreement, rank, pick the verdict. Deterministic fallback if the
   call fails, so a review always posts.
6. **Post once** — a single GitHub review: inline comments for high-value
   findings on changed lines; a top-level summary comment (upserted by marker so
   re-runs replace it) with the verdict, off-diff findings, and grouped nits.

### Reviewer personas

Each reviewer is a staff-level specialist with its own checklist
(`src/personas.ts`): correctness, security, performance, web-ui/accessibility,
qa, data-architect, cloudflare, simplicity, docs. The planner selects personas
by what the PR touches (priority: security > data-architect > cloudflare >
web-ui > correctness > qa > performance > simplicity) and assigns each a
**different model lineage** so the panel is diverse.

Prompt technique sources:
- Confidence discipline (be thorough on real bugs, certain-or-silent on nits)
  adapted from Qodo PR-Agent's reviewer prompt.
- The diff is annotated with new-file line numbers so findings anchor to real
  inline positions.
- Cloudflare persona mirrors Cloudflare's own Workers best-practices doc; the
  web-ui persona mirrors WCAG 2.1 AA.
- Cross-model agreement (not few-shot examples) is the noise lever, matching
  Greptile's finding that prompt few-shot made nit-noise worse.

### Default routing policy

| Bucket     | Personas (each on a distinct model)                | Count |
| ---------- | -------------------------------------------------- | ----- |
| docs-only  | docs                                               | 1     |
| tests-only | qa                                                 | 1     |
| small      | correctness (+ highest-priority overlay persona)   | 1     |
| medium     | top 2 personas by priority                         | 2     |
| large      | top 3 personas by priority                         | 3     |

Overlays force in the relevant specialist: `migrations`→data-architect,
worker/D1/KV/R2→cloudflare, auth/crypto/PII→security, UI files→web-ui.
Overrides: `/review low` = one cheap pass; `/review high` = full 3-persona
panel. Model ids live in `src/config.ts` (verified live on OpenRouter at build).

### Cost

OpenRouter is pass-through priced (their fee is ~5.5% on credit top-ups). A
review costs roughly $0.004–0.04 per model. Hard caps: max 3 reviewers, diff
truncated at 120k chars, output token caps.

## Phases

- **Phase 1 (this repo now):** gather → deterministic plan → diverse reviewer
  fan-out → LLM synthesis (with deterministic fallback) → one combined review.
  Unit tests for metrics, policy, and diff-line mapping.
- **Phase 2:** cheap-LLM classifier that confirms the bucket and assigns
  per-reviewer goals; richer cross-model dedupe; externalized `policy.json`.
- **Phase 3:** wire the caller repos (lake-cherokee-website, almanaut) with the
  slash-command and label trigger workflows; replace stale inline comments in
  place on re-run; nits polish.

## Wiring a repo (Phase 3)

1. Add `OPENROUTER_API_KEY` as a repo secret (no org secrets — personal account).
2. In `pr-review-ci` → Settings → Actions → General → Access: allow use from
   repositories owned by the account.
3. Add two thin caller workflows (slash command + label) — see the README.

## Open decisions / future

- AWS Bedrock backend (AWS billing; Claude + Llama + Mistral + Nova; no OpenAI or
  Gemini) is a possible future alternative to OpenRouter. Not built.
- Approvals/blocking: the review posts `event: COMMENT` only. It recommends; it
  never auto-approves or requests changes.
