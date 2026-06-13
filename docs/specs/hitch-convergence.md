# Hitch Convergence Controller

Phase 19 adds a DB-backed control plane for long-running coding-agent hitches.
It answers whether a hitch has converged, needs another bounded fix pass, should
defer new findings, or must stop for human classification/escalation.

Implementation status: Phase 19 is implemented as schema v16 plus repository,
CLI, MCP, run/review integration, and a simulated hitch-loop fixture matrix.
The source of truth is `.harness/harness.sqlite`; compatibility files remain
outside this feature's authority.

## Problem

Iterative agent loops can drift:

```txt
implement -> review -> fix -> review finds unrelated work -> fix -> ...
```

The harness already records runs, review proposals, operations, backlog items,
MCP confirmations, and budgets. Phase 19 ties those primitives to one explicit
hitch session so the loop has a bounded close condition.

## Core Rules

Close conditions are evaluated before opportunistic review expansion. If the
original close conditions pass and only out-of-scope, accepted-risk, or deferred
follow-up findings remain (including out-of-scope findings that were escalated),
the hitch may close. Open, reopened, or escalated in-scope/unknown P0/P1 findings
are active blockers and cannot be treated as ordinary deferred work.

Hitch scope is frozen at session start:

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
automatically expand the hitch.

Mode semantics:

```txt
initial:
  review the full frozen hitch scope against close conditions

delta:
  verify the previous fixes and changed files; unrelated new findings default
  out_of_scope unless they clearly block the original close conditions

close:
  answer whether the original hitch can close; do not add new scope except
  P0/security-critical findings, which escalate instead of extending the loop

regression:
  check existing safety boundaries, tests, and policy gates without expanding
  the hitch
```

## Data Model

Schema v16 stores:

```txt
hitch_sessions                 top-level hitch scope, close conditions, policy, budget
hitch_attempts                 implementation/fix/validate/close-check attempts
hitch_review_cycles            review mode and finding counts per cycle
hitch_findings                 deduped finding lifecycle and scope classification
hitch_close_checks             latest evidence for close conditions
hitch_convergence_decisions    audit trail of continue/close/escalate decisions
```

Hitch sessions link outward to projects, repos, domains, backlog items, run ids,
and operation ids. The hitch tables are the lifecycle authority for convergence;
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
6. (#104) An **unreviewed** coder run — the latest coding attempt (implement/
   rerun) is newer than the latest review cycle — is **reviewed** (`continue` →
   `run_close_check`) before routing to another rerun, classification, or fix
   pass. Placed *after* the budget checks (a genuinely over-budget hitch still
   stops) and gated by the review-cycle budget, so an open finding cannot drive
   endless reruns that never review the fix that would clear it (otherwise the
   hitch burns its rerun budget and dead-ends as `budget_exhausted` with the
   finding still open).
7. Unknown-scope findings block automation when policy requires it.
8. Open in-scope P1 needs a fix.
9. Failed required close checks need a fix.
10. Un-deferred out-of-scope findings require `defer_followups` when policy requires deferral.
11. If the most recent coding attempt (implement/rerun) ended `failed` (e.g. a
    `failed-command` run that never reached `needs_review`), the decision is
    `needs_fix` with `fix_findings` — route to a bounded recovery rerun rather
    than to review (review on a non-`needs_review` run would throw and dead-end
    the hitch). The rerun budget (step 2) terminates this as `budget_exhausted`
    if the run cannot be recovered. The recovery rerun's coder goal carries the
    failed run status so it fixes the cause instead of re-coding blind.
12. Otherwise the decision is `continue`.

Recorded close-check evidence is fresh only when it is at or after the latest
invalidating hitch event: a non-close-check attempt, finding seen/fixed/deferred
transition, or completed review cycle. Stale passed evidence is treated as
pending and the next action is to record fresh close-check evidence.

Hitches with no close conditions are not close-ready by default. Set
`policy.allowEmptyCloseConditions: true` only for hitches where an empty close
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

Hitch-aware operation paths accept an optional `hitchId` and validate that the
hitch project, repo, and domain match the target run or project before recording
anything. A scoped hitch cannot be linked to an unscoped run.

Hitch-linked mutations are also gated by a fresh convergence evaluation. The
harness rejects implementation/review/rerun/process mutations when the hitch is
`close_ready`, `needs_classification`, `diverging`, `budget_exhausted`,
`escalated`, `closed`, or `cancelled`. The gate also checks the recommended
next action: `needs_fix` with `fix_findings` permits only `run.start` and
`rerun.start`; `needs_fix` with `run_close_check` also permits `run.start` and
`rerun.start` so failed close checks can be fixed. `continue` with
`run_close_check` permits review validation (`review.auto` and
`review.process`) so close-check evidence can be generated, but still blocks
implementation mutations. `continue` with `defer_followups` blocks these
hitch-linked mutations until the recommended deferral action is handled.
`review.process` confirmation requests are not created when this gate denies the
linked hitch. The bounded MCP driver `hitch.orchestrate` (`harness.hitch.orchestrate`)
is gated by the same evaluation: it is permitted **exactly when some per-step
mutation would be permitted** (`needs_fix` with `fix_findings`/`run_close_check`,
or `continue` with `run_close_check`). The entry gate denies the driver for
`close_ready`, the stop/terminal decisions (`escalate` / `diverging` /
`budget_exhausted` / `closed` / `cancel`), `defer_followups`, and
`needs_classification`. That denial is about *entering* the driver: once the
driver is running, its loop auto-classifies and auto-defers via the internal
deterministic runner dispatch (see the three-layer table below); only the
deliberate `close_ready` close/PR and the escalation path are left to an
operator out of band. Each internal coder/review step the orchestrator runs
re-checks its own gate. `harness hitch check-convergence` and
`harness.hitch.check_convergence` record an audit decision and synchronize the
durable hitch status for stop/close-ready decisions by default. Review proposal
import uses the same status synchronization after it records its convergence
decision.

### Three layers handle the same decision differently

The same convergence decision is acted on at three layers. All three are
deterministic and fail-closed; the differences are intentional, not a
contradiction:

| decision | MCP per-step gate (`mutation-gate.ts`) | hitch loop (`HitchOrchestrator`) | course dispatch (`orchestrate-dispatch.ts`) |
|---|---|---|---|
| `needs_fix` (`fix_findings`/`run_close_check`) | permits `run.start`/`rerun.start` | drives a bounded fix/rerun | drives the phase |
| `continue` + `run_close_check` | permits review validation | records close-check evidence | drives the phase |
| `needs_classification` | denies the step | **auto-classifies** via the classify runner, then continues | **blocks** the phase and isolates its subtree (operator classifies) |
| `defer_followups` | denies the step | **auto-defers** via the defer runner, then continues | not blocked, but the hitch is not drivable (`allowedByConvergence` is false) → `report_only` unless another linked hitch is drivable |
| `close_ready` | denies the step (operator closes/PRs) | default loop runs `closeAndPr` (close + PR); stops before the PR only when `stopAtCloseReady` is set (the MCP/course drivers set it) | `ready_to_close` when all hitches are ready and no open P0/P1; no auto-close |
| `escalate` / `diverging` / `budget_exhausted` | denies the step | stops | blocks the phase and isolates its subtree |

The in-loop classify/defer runners are internal deterministic dispatch, not
gated mutations, which is why the MCP gate "denying classification/deferral" and
the loop "auto-handling" them are both correct. The course layer deliberately
stops on `needs_classification` rather than auto-resolving across phases.

Implemented links:

```txt
run.start        -> hitch_attempts(attempt_type='implement')
review.auto      -> hitch_attempts(attempt_type='fix-review')
rerun.start      -> hitch_attempts(attempt_type='rerun')
review.process   -> hitch_review_cycles + hitch_findings + close checks
```

Review proposal import maps `required_changes` to P1 finding seeds, then runs
the normal frozen-scope classifier. Required changes that match the hitch scope
become in-scope blockers; required changes that are outside scope or unknown
must be deferred or classified before the loop can continue safely.
`non_blocking_comments` become P2 finding seeds, and
`out_of_scope_suggestions` are forced to out-of-scope follow-ups. A negative
review decision with no required changes still creates an in-scope P1 blocker
so a rejected/changes-requested verdict cannot accidentally become
`close_ready`.
Generic reviewer advisories that only say tests/checks were not run, could not
be run in the review environment, or that command logs/output are missing are
not imported as hitch findings when they appear in `non_blocking_comments`.
They are surfaced as `reviewAdvisories` on review import and copied into
`hitch_close_checks.evidence.reviewerAdvisories`, so operators can see the
missing test evidence without triggering `needs_classification` or escalation.
The carve-out does not apply to `required_changes`, close-check failures, or
actual failing command evidence.

`review_consensus` close conditions are static review evidence only. A passed
`review_consensus` check records that static review consensus approved the run;
it does not prove tests executed. Hitches that require tests must include normal
`kind: command` close conditions for those commands. Convergence evaluates those
command checks using the existing close-condition machinery; it does not inject
synthetic test gates and does not use reviewer self-report as state-transition
evidence.

When a hitch review step is re-driven for a run whose **DB-canonical decision**
(`review_decisions`, not any single participant proposal) is `approved`, AND a
**completed** review cycle already exists for that run, the orchestrator
refreshes the `review_consensus` close-check evidence at the current time
without starting a new review cycle and without invoking Codex. The evidence's
`decision` / `reviewer` / `sourceSha256` come from `review_decisions` (the
canonical decision); the latest processed proposal only supplies supplementary
`proposalId` / advisories. If the run is approved but no completed review cycle
exists (the import never ran, or crashed after persisting the cycle row but
before importing findings), the short-circuit fails closed and escalates rather
than recording a passed check over an unimported/partial review.
This lets stale-but-approved review evidence advance to `close_ready` and then
to `close_and_pr` on the next loop step. If that refreshed review evidence is
fresh but another required close condition is still pending, the loop escalates
with the pending condition id(s) instead of starting another review.

`hitch_lifecycle_events` records `closed`, `cancelled`, and `reopened` reasons
with actor/timestamp for audit. It is not a state-transition source.
Convergence, mutation gates, and roadmap rollup derive state from deterministic
harness inputs (`hitch_sessions`, findings, close checks, budgets, and
convergence metrics), never from lifecycle event rows.

Review-only attempts inherit the related coding iteration when they are linked
to an existing run attempt. This keeps automatic review bookkeeping from
burning the implementation iteration budget.

## CLI Contract

The CLI exposes `harness hitch`:

```bash
harness hitch start --title "..." --scope-file scope.yaml --close-file close.yaml
harness hitch status <hitch-id>
harness hitch reopen <hitch-id> --reason "..." [--created-by actor] [--extend-iterations N] [--extend-review-cycles N] [--extend-reruns N]
harness hitch finding add <hitch-id> --severity P1 --category correctness --summary "..."
harness hitch finding classify <finding-id> --scope in-scope --reason "..."
harness hitch finding fixed <finding-id> --note "..."
harness hitch finding defer <finding-id> --backlog --reason "..."
harness hitch review-cycle start <hitch-id> --mode delta
harness hitch close-check record <hitch-id> --condition typecheck --status passed
harness hitch check-convergence <hitch-id> --json
harness hitch close <hitch-id> --summary "..."
```

CLI command close checks may record command evidence, but Phase 19 does not
make MCP run arbitrary shell commands.

## MCP Contract

MCP exposes read tools for sessions, findings, and decisions, plus guarded
mutation tools for starting hitches, recording/classifying/fixing/deferring
findings, recording close checks, and evaluating convergence.

MCP hitch mutations use the same permission model as other mutation tools.
Dangerous terminal operations such as forced close/cancel and scope expansion
require confirmation. MCP finding details are capped and redacted.

`harness.hitch.orchestrate` is a bounded driver (args: `hitchId`, optional
`maxSteps` 1-50 default 20) that advances the loop a capped number of
orchestrator steps and halts at `close_ready` without opening a PR
(`stopAtCloseReady`). The target repo is resolved server-side from the hitch's
project/domain (never a client-supplied path); it never wires a publisher.
Opening the PR / closing the hitch stays the deliberate CLI
`harness hitch orchestrate` path. See [`mcp.md`](./mcp.md) for the full contract.

Hitch-linked run/review tools support optional `hitchId`:

```txt
harness.run.start
harness.review.auto
harness.rerun.start
harness.review.process
```

When supplied, the operation audit metadata includes both `hitchId` and
`hitch_id`, and the hitch repository records the attempt or review-cycle result.
`review.process` imports the bound review proposal into the hitch only on the
confirmed execution path.

## Fixture Matrix

`tests/unit/hitch/fixture-matrix.test.ts` simulates the agent loop without
calling Codex. The matrix covers:

```txt
converging fix -> close_ready
diverging review cycles -> diverging
out-of-scope follow-up -> defer -> close_ready
unknown scope -> needs_classification -> close_ready after classification
iteration budget exhaustion -> budget_exhausted
```

Each fixture records convergence decisions and updates hitch status so the test
asserts both the decision stream and the loop stop condition.

## Non-Goals

Phase 19 does not implement autonomous worker scheduling, semantic embedding
clustering, dashboard mutation UI, raw shell execution, or external issue
tracker sync.

Automatic merge is now available as an opt-in (default OFF): when
`harness hitch orchestrate --auto-merge` is set, `closeAndPr` evaluates a
deterministic merge gate (close-ready ∧ consensus approved with quorum, or a
human override ∧ CI green) and merges the PR, escalating fail-closed on a
hard-blocked gate. See [`workflow.md`](./workflow.md) (auto-merge).
```
