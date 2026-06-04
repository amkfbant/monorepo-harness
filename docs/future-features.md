# Future features

Ideas recorded for later implementation. Each entry is a sketch, not an approved
design — run it through brainstorming → spec → plan when picked up.

## Copilot PR review integration

**Idea:** Let `harness pr create` optionally request a GitHub Copilot code
review on the PR it opens, so an approved run can be handed to Copilot for an
automated second-pass review on GitHub.

**Why:** The harness already produces approved runs and opens (draft) PRs via
`gh`. Adding a Copilot reviewer request closes the loop to "PR is up and a
review is already in flight" with no extra manual step.

**How (sketch):**
- GitHub CLI supports this since 2026-03: `gh pr create --reviewer @copilot` and
  `gh pr edit <pr> --add-reviewer @copilot` (bot reviewer `@copilot`).
- Wire it into `src/core/pr-creator.ts` / `src/core/gh-pr-publisher.ts`: add an
  opt-in flag (e.g. `harness pr create --copilot-review`) that passes
  `--reviewer @copilot` to the publisher (or issues the `gh pr edit
  --add-reviewer` follow-up after the PR is created).
- Consider the orchestrator: a `closeAndPr` that also requests Copilot review
  would make the autonomous loop produce a PR with a review already requested.

**Prerequisites / caveats:**
- The repo/org must have Copilot code review enabled, on a plan that includes it.
- Keep it opt-in (a flag), not default — it triggers an external, billable
  review and posts bot comments on the PR.
- Third-party `gh` extensions exist (`k1LoW/gh-copilot-review`,
  `ChrisCarini/gh-copilot-review`) with duplicate-prevention / wait-for-completion;
  evaluate vs. a thin native `--reviewer @copilot` call.

**Status:** deferred — wiring is straightforward, but a 2026-06 experiment
(throwaway PRs against `monorepo-harness` and `mini-commerce`) never produced an
actual review: Copilot returned "encountered an error and was unable to review
this pull request" on every re-request, even after enabling automatic Copilot
code review on the account. Judged to be an account/GitHub-side issue rather than
repo-specific, so it is excluded from the current `GOAL.md` and parked here until
Copilot review works end-to-end. Pick it up once a manual `gh pr edit
--add-reviewer @copilot` yields a real review.

## Codex session continuation (conversation resume)

**Idea:** Let the harness optionally keep a codex *session* (conversation /
rollout) across multiple invocations of the same logical task, instead of always
running single-shot. A rerun-after-review, or a multi-turn refinement, could
resume the prior codex conversation rather than rebuilding a fresh prompt.

**Why considered:** Today every codex call is single-shot and stateless — the
runner hardcodes `--ephemeral` (`src/codex/codex-cli-runner.ts`), so no session
state is persisted in `CODEX_HOME`, and no session/conversation id is parsed or
stored. Context is carried *only* via prompt injection: rerun re-injects
`required_changes` (`src/core/rerun.ts`), knowledge context is appended as a
`<knowledge>` block (`src/codex/prompt-builder.ts`), and lineage is tracked
harness-side (`parentRunId` / `rootRunId` / `rerunAttempt`). A session could, in
principle, preserve intermediate reasoning that re-injection drops, and be
cheaper on long multi-turn refinements.

**Why it is NOT in scope (the tension):** Statelessness is a deliberate part of
the safety model (`GOAL_RULES.md` §G, `docs/specs/workflow.md`), not a gap:
- **Reproducibility** — a run is fully determined by `prompt + policy +
  worktree`; there is no hidden conversational state to drift.
- **Auditability** — policy verification is purely after-the-fact `git diff`;
  nothing accumulates on the codex side that the harness cannot see.
- **Don't trust LLM-side state** — resuming a session means trusting context the
  harness no longer owns; the harness must remain the single source of truth for
  state transitions.

**How (sketch, if ever pursued):**
- Drop `--ephemeral` for an opt-in session-backed runner; capture codex's
  session/rollout id from its output and persist it (new DB column on the run).
- Add a `resume` path in `CodexExecRunner` implementations that re-attaches to a
  stored session id instead of building a fresh prompt.
- Reconcile with the safety model: bound which surfaces may use sessions (likely
  *not* the reviewer agent, which must stay read-only and stateless), and keep
  policy verification on `git diff` regardless of session state.

**Prerequisites / caveats:**
- Requires the installed codex CLI to expose stable session-resume semantics;
  verify the exact flags/behaviour for the pinned codex version before relying on
  them.
- Likely needs a spike first to confirm sessions actually beat prompt injection
  for our workloads, and that resume can coexist with reproducibility/audit.

**Status:** idea only — not designed or scheduled; recorded 2026-06 during
`GOAL.md` planning.
