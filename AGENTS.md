# Agent Operating Rules

## Ops vs dev mode

These rules govern *operating* the harness against a real target monorepo (ops
mode). In ops mode the harness source (`src/`) is a pinned, immutable release
tag and is **read-only** — do not edit it here; if a code change is needed,
raise it in the dev clone. The authoritative definition of the two modes and how
to tell them apart lives in [`CLAUDE.md`](./CLAUDE.md) ("モード（dev / ops）").
When operating in ops mode, follow [`CLAUDE.md`](./CLAUDE.md) as the governing
mode and procedure document.

## Hitch Convergence

Do not continue fixing newly discovered issues indefinitely.

For hitch-mode work:

1. Start or identify a hitch session before beginning an iterative implementation/review loop.
2. Read the hitch scope, close conditions, and iteration budget.
3. Use harness/MCP read tools first, then dry-run tools before guarded mutation tools.
4. After each review cycle, record findings in the hitch session.
5. Classify each finding as `in_scope`, `out_of_scope`, `duplicate`, or `unknown`.
6. Fix only in-scope P1 findings within the iteration budget by default.
   Open in-scope P0 findings require escalation before more automated work.
7. Defer out-of-scope findings to backlog/follow-up instead of expanding the current hitch.
8. Run `harness hitch check-convergence <hitch-id>` after each review cycle.
9. Stop automatic fixing when convergence is `escalate`, `diverging`, `budget_exhausted`, or `needs_classification`.
10. Close the hitch once the original close conditions are satisfied and no open in-scope blockers remain.

Never bypass MCP `confirmation_required` by running an equivalent shell command directly.

## Spec-review layer (ratified phases)

When turning a ratified phase into a hitch, pass through the spec↔hitch consistency
gate. Operating rules live in [`GOAL_RULES.md`](./GOAL_RULES.md) §J; the authoritative
spec is [`docs/specs/spec-review-layer.md`](./docs/specs/spec-review-layer.md).

- `phase start-hitch` / `phase link-hitch` require the hitch spec to be identical to or a
  tightening of the phase's **current** spec (widen scope with `--allow-scope-widen`; loosen
  close conditions with `--allow-gate-loosen`). Unratified phases skip the gate (ratify is opt-in).
- Distinguish auto-verify close-condition kinds (currently `command` / `finding_policy` /
  `review_consensus` / `facet_red_test` / `evidence_attached`) from ask_human external-evidence
  kinds (`manual` / `artifact_exists` / `operation_status` / `db_doctor`). The canonical kind list
  is `HITCH_CLOSE_CONDITION_KINDS` (`src/hitch/types.ts`) / [`docs/specs/hitch-convergence.md`](./docs/specs/hitch-convergence.md);
  this list is a snapshot. Do not let an auto-verify intent land as an external-evidence kind.
- Editing a spec after ratify surfaces a specHash drift warning plus an ask_human diagnostic in
  convergence; it never blocks auto-close on its own.
