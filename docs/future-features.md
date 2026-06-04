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

**Status:** idea only — not designed or scheduled.
