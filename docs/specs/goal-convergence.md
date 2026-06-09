# Goal Convergence Controller

Phase 19 adds a DB-backed control plane for long-running coding-agent goals.
It answers whether a goal has converged, needs another bounded fix pass, should
defer new findings, or must stop for human classification/escalation.

Implementation status: Phase 19 is implemented as schema v16 plus repository,
CLI, MCP, run/review integration, and a simulated goal-loop fixture matrix.
The source of truth is `.harness/harness.sqlite`; compatibility files remain
outside this feature's authority.

## Problem

Iterative agent loops can drift:

```txt
implement -> review -> fix -> review finds unrelated work -> fix -> ...
```

The harness already records runs, review proposals, operations, backlog items,
MCP confirmations, and budgets. Phase 19 ties those primitives to one explicit
goal session so the loop has a bounded close condition.

## Core Rules

Close conditions are evaluated before opportunistic review expansion. If the
original close conditions pass and only out-of-scope, accepted-risk, escalated,
or deferred follow-up findings remain, the goal may close. Open in-scope P0/P1
findings cannot be treated as ordinary deferred work.

Goal scope is frozen at session start:

```txt
scope includes: target files/domains/operations, allowed categories, close criteria
scope excludes: unrelated refactors, future features, opportunistic cleanup
```

Every finding is classified:

```txt
in_scope
out_of_scope
duplicate
unknown
```

`unknown` findings are not auto-fixed by default. They require a classification
step or human escalation.

Review mode narrows over time:

```txt
initial -> delta -> close
```

Regression/manual reviews can be recorded explicitly, but they do not
automatically expand the goal.

Mode semantics:

```txt
initial:
  review the full frozen goal scope against close conditions

delta:
  verify the previous fixes and changed files; unrelated new findings default
  out_of_scope unless they clearly block the original close conditions

close:
  answer whether the original goal can close; do not add new scope except
  P0/security-critical findings, which escalate instead of extending the loop

regression:
  check existing safety boundaries, tests, and policy gates without expanding
  the goal
```

## Data Model

Schema v16 stores:

```txt
goal_sessions                 top-level goal scope, close conditions, policy, budget
goal_attempts                 implementation/fix/validate/close-check attempts
goal_review_cycles            review mode and finding counts per cycle
goal_findings                 deduped finding lifecycle and scope classification
goal_close_checks             latest evidence for close conditions
goal_convergence_decisions    audit trail of continue/close/escalate decisions
```

Goal sessions link outward to projects, repos, domains, backlog items, run ids,
and operation ids. The goal tables are the lifecycle authority for convergence;
they do not replace the run/review/operation tables.

## Finding Lifecycle

Findings have both a scope classification and a lifecycle status:

```txt
open -> fixed -> reopened
open -> deferred
open -> escalated
open -> accepted_risk
open -> duplicate
```

The dedup key is a deterministic hash of normalized file path, symbol,
category, and summary. Semantic clustering is not part of Phase 19.

Out-of-scope findings default to deferred follow-up. A deferred finding may
create a backlog item and stores the linked item id.

## Convergence Decisions

Evaluation is deterministic and conservative:

1. Terminal sessions stay terminal.
2. Iteration/review/rerun budgets are enforced.
3. Open in-scope P0 escalates.
4. Growing finding counts or reopened churn is `diverging`.
5. Passed fresh required close checks plus configured `closeRequires` blockers clear is `close_ready`.
6. Unknown-scope findings block automation when policy requires it.
7. Open in-scope P1 needs a fix.
8. Failed required close checks need a fix.
9. Un-deferred out-of-scope findings require `defer_followups` when policy requires deferral.
10. If the most recent coding attempt (implement/rerun) ended `failed` (e.g. a
    `failed-command` run that never reached `needs_review`), the decision is
    `needs_fix` with `fix_findings` — route to a bounded recovery rerun rather
    than to review (review on a non-`needs_review` run would throw and dead-end
    the goal). The rerun budget (step 2) terminates this as `budget_exhausted`
    if the run cannot be recovered. The recovery rerun's coder goal carries the
    failed run status so it fixes the cause instead of re-coding blind.
11. Otherwise the decision is `continue`.

Recorded close-check evidence is fresh only when it is at or after the latest
invalidating goal event: a non-close-check attempt, finding seen/fixed/deferred
transition, or completed review cycle. Stale passed evidence is treated as
pending and the next action is to record fresh close-check evidence.

Goals with no close conditions are not close-ready by default. Set
`policy.allowEmptyCloseConditions: true` only for goals where an empty close
condition list is intentional.

Decision values:

```txt
continue
needs_fix
needs_classification
close_ready
closed
diverging
budget_exhausted
escalate
cancel
```

## Default Policy

```yaml
maxIterations: 3
maxReviewCycles: 3
maxReruns: 2
maxTotalNewFindings: 12
autoFixSeverities: [P1]
autoFixOnlyInScope: true
stopOnUnknownScope: true
allowEmptyCloseConditions: false
deferOutOfScope: true
reviewModeSequence: [initial, delta, close]
```

## Operation And Review Integration

Goal-aware operation paths accept an optional `goalId` and validate that the
goal project, repo, and domain match the target run or project before recording
anything. A scoped goal cannot be linked to an unscoped run.

Goal-linked mutations are also gated by a fresh convergence evaluation. The
harness rejects implementation/review/rerun/process mutations when the goal is
`close_ready`, `needs_classification`, `diverging`, `budget_exhausted`,
`escalated`, `closed`, or `cancelled`. The gate also checks the recommended
next action: `needs_fix` with `fix_findings` permits only `run.start` and
`rerun.start`; `needs_fix` with `run_close_check` also permits `run.start` and
`rerun.start` so failed close checks can be fixed. `continue` with
`run_close_check` permits review validation (`review.auto` and
`review.process`) so close-check evidence can be generated, but still blocks
implementation mutations. `continue` with `defer_followups` blocks these
goal-linked mutations until the recommended deferral action is handled.
`review.process` confirmation requests are not created when this gate denies the
linked goal. `harness goal check-convergence` and
`harness.goal.check_convergence` record an audit decision and synchronize the
durable goal status for stop/close-ready decisions by default. Review proposal
import uses the same status synchronization after it records its convergence
decision.

Implemented links:

```txt
run.start        -> goal_attempts(attempt_type='implement')
review.auto      -> goal_attempts(attempt_type='fix-review')
rerun.start      -> goal_attempts(attempt_type='rerun')
review.process   -> goal_review_cycles + goal_findings + close checks
```

Review proposal import maps `required_changes` to P1 finding seeds, then runs
the normal frozen-scope classifier. Required changes that match the goal scope
become in-scope blockers; required changes that are outside scope or unknown
must be deferred or classified before the loop can continue safely.
`non_blocking_comments` become P2 finding seeds, and
`out_of_scope_suggestions` are forced to out-of-scope follow-ups. A negative
review decision with no required changes still creates an in-scope P1 blocker
so a rejected/changes-requested verdict cannot accidentally become
`close_ready`.
Generic reviewer advisories that only say tests/checks were not run, could not
be run in the review environment, or that command logs/output are missing are
not imported as goal findings when they appear in `non_blocking_comments`.
They are surfaced as `reviewAdvisories` on review import and copied into
`goal_close_checks.evidence.reviewerAdvisories`, so operators can see the
missing test evidence without triggering `needs_classification` or escalation.
The carve-out does not apply to `required_changes`, close-check failures, or
actual failing command evidence.

`review_consensus` close conditions are static review evidence only. A passed
`review_consensus` check records that static review consensus approved the run;
it does not prove tests executed. Goals that require tests must include normal
`kind: command` close conditions for those commands. Convergence evaluates those
command checks using the existing close-condition machinery; it does not inject
synthetic test gates and does not use reviewer self-report as state-transition
evidence.

Review-only attempts inherit the related coding iteration when they are linked
to an existing run attempt. This keeps automatic review bookkeeping from
burning the implementation iteration budget.

## CLI Contract

The CLI exposes `harness goal`:

```bash
harness goal start --title "..." --scope-file scope.yaml --close-file close.yaml
harness goal status <goal-id>
harness goal finding add <goal-id> --severity P1 --category correctness --summary "..."
harness goal finding classify <finding-id> --scope in-scope --reason "..."
harness goal finding fixed <finding-id> --note "..."
harness goal finding defer <finding-id> --backlog --reason "..."
harness goal review-cycle start <goal-id> --mode delta
harness goal close-check record <goal-id> --condition typecheck --status passed
harness goal check-convergence <goal-id> --json
harness goal close <goal-id> --summary "..."
```

CLI command close checks may record command evidence, but Phase 19 does not
make MCP run arbitrary shell commands.

## MCP Contract

MCP exposes read tools for sessions, findings, and decisions, plus guarded
mutation tools for starting goals, recording/classifying/fixing/deferring
findings, recording close checks, and evaluating convergence.

MCP goal mutations use the same permission model as other mutation tools.
Dangerous terminal operations such as forced close/cancel and scope expansion
require confirmation. MCP finding details are capped and redacted.

Goal-linked run/review tools support optional `goalId`:

```txt
harness.run.start
harness.review.auto
harness.rerun.start
harness.review.process
```

When supplied, the operation audit metadata includes both `goalId` and
`goal_id`, and the goal repository records the attempt or review-cycle result.
`review.process` imports the bound review proposal into the goal only on the
confirmed execution path.

## Fixture Matrix

`tests/unit/goal/fixture-matrix.test.ts` simulates the agent loop without
calling Codex. The matrix covers:

```txt
converging fix -> close_ready
diverging review cycles -> diverging
out-of-scope follow-up -> defer -> close_ready
unknown scope -> needs_classification -> close_ready after classification
iteration budget exhaustion -> budget_exhausted
```

Each fixture records convergence decisions and updates goal status so the test
asserts both the decision stream and the loop stop condition.

## Non-Goals

Phase 19 does not implement autonomous worker scheduling, semantic embedding
clustering, dashboard mutation UI, raw shell execution, or external issue
tracker sync.

Automatic merge is now available as an opt-in (default OFF): when
`harness goal orchestrate --auto-merge` is set, `closeAndPr` evaluates a
deterministic merge gate (close-ready ∧ consensus approved with quorum, or a
human override ∧ CI green) and merges the PR, escalating fail-closed on a
hard-blocked gate. See [`workflow.md`](./workflow.md) (auto-merge).
