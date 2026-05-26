# Agent Operating Rules

## Goal Convergence

Do not continue fixing newly discovered issues indefinitely.

For goal-mode work:

1. Start or identify a goal session before beginning an iterative implementation/review loop.
2. Read the goal scope, close conditions, and iteration budget.
3. Use harness/MCP read tools first, then dry-run tools before guarded mutation tools.
4. After each review cycle, record findings in the goal session.
5. Classify each finding as `in_scope`, `out_of_scope`, `duplicate`, or `unknown`.
6. Fix only in-scope P1 findings within the iteration budget by default.
   Open in-scope P0 findings require escalation before more automated work.
7. Defer out-of-scope findings to backlog/follow-up instead of expanding the current goal.
8. Run `harness goal check-convergence <goal-id>` after each review cycle.
9. Stop automatic fixing when convergence is `escalate`, `diverging`, `budget_exhausted`, or `needs_classification`.
10. Close the goal once the original close conditions are satisfied and no open in-scope blockers remain.

Never bypass MCP `confirmation_required` by running an equivalent shell command directly.
