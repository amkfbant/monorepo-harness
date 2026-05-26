# Goal Convergence Controller

Phase 19 adds a DB-backed control plane for long-running coding-agent goals.
It answers whether a goal has converged, needs another bounded fix pass, should
defer new findings, or must stop for human classification/escalation.

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

The latest schema stores:

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
3. Unknown-scope findings block automation when policy requires it.
4. Open in-scope P0 escalates.
5. Open in-scope P1 needs a fix.
6. Failed required close checks need a fix.
7. Passed required close checks plus no in-scope blockers is `close_ready`.
8. Growing finding counts or reopened churn is `diverging`.
9. Otherwise the decision is `continue`.

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
deferOutOfScope: true
reviewModeSequence: [initial, delta, close]
```

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
mutation tools for starting goals, recording/classifying/fixing/defering
findings, recording close checks, and evaluating convergence.

MCP goal mutations use the same permission model as other mutation tools.
Dangerous terminal operations such as forced close/cancel and scope expansion
require confirmation. MCP finding details are capped and redacted.

## Non-Goals

Phase 19 does not implement autonomous worker scheduling, semantic embedding
clustering, dashboard mutation UI, raw shell execution, external issue tracker
sync, or automatic merge.
