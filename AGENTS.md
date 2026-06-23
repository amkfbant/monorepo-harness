# Agent Operating Rules

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

## Ops vs dev mode

These rules govern *operating* the harness against a real target monorepo (ops
mode). In ops mode the harness source (`src/`) is a pinned, immutable release
tag and is **read-only** — do not edit it here; if a code change is needed,
raise it in the dev clone. The authoritative definition of the two modes and how
to tell them apart lives in [`CLAUDE.md`](./CLAUDE.md) ("モード（dev / ops）").
When operating in ops mode, follow [`CLAUDE.md`](./CLAUDE.md) as the governing
mode and procedure document.
