# Empty-goal autonomy — design

**Date:** 2026-06-04
**Phase:** 21.1 (follow-up to Phase 21 autonomous goal orchestration)
**Depends on:** Phase 19 (goal convergence), Phase 21 (orchestrator)
**Status:** design approved, pending implementation plan

## Goal

Let `harness goal orchestrate` drive a goal **from empty** — including creating
the very first coder run — instead of requiring a human to seed an initial run.
Phase 21 deferred this: a fresh goal (no coding attempts) evaluates to
`continue / run_close_check`, where the orchestrator dispatches to `review`,
which has no run to review and escalates. This phase closes that gap.

**Core principle (unchanged):** the orchestrator does not gain special-case
logic. The convergence service — the deterministic judge — is taught that a goal
with no implementation attempt yet *needs a run*. The orchestrator keeps acting
only on the decision; the gate and runners are untouched. (This is approach A;
approaches B "orchestrator special-case" and C "loosen the gate" were rejected
because they break the judgement/execution separation or the fail-closed gate.)

## The change (one branch in ConvergenceService)

In `src/goal/convergence.ts`, immediately before the terminal
`continue / run_close_check` result (the "more validation required" fallthrough
that a fresh goal currently hits), insert:

```
if metrics.attemptsUsed === 0:
    return needs_fix / fix_findings
      reason:  "no implementation attempt yet"
      message: "Run the initial coder pass for this goal."
```

`metrics.attemptsUsed` already counts only coding attempts (close-check attempts
are excluded — `convergence.ts:141`). Placement matters: this branch comes
**after** every higher-priority branch — crucially **after the `close_ready`
check at `convergence.ts:219`**, and after the in-scope P0/P1/P2 findings,
`closeConditionsFailed`, and out-of-scope deferral branches. So:
- a goal whose required close conditions already pass still returns `close_ready`
  even with `attemptsUsed === 0` (a closeable goal closes — unchanged);
- a goal with findings / failed close conditions keeps its current decision;
- the new branch fires **only** for a genuinely fresh goal with nothing else to
  act on (no run, no findings, close conditions still pending).

## Why this is sufficient

- `needs_fix / fix_findings` → the orchestrator's existing dispatch returns
  `{ kind: "coder" }` (`orchestrator-dispatch.ts`), which the mutation gate
  already permits for `run.start` (`needs_fix + fix_findings` → run/rerun).
- The orchestrator's `coder` runner calls `runDomainCoding`, records the
  attempt, and the loop re-evaluates — now `attemptsUsed > 0`, so subsequent
  steps follow the normal review → close → pr path.
- No change to `orchestrator.ts`, `orchestrator-runners.ts`, `mutation-gate.ts`,
  or the dispatch table.

## Impact

- **Fresh-goal decision changes** from `continue/run_close_check` to
  `needs_fix/fix_findings`, on **all paths** (CLI `goal status` /
  `check-convergence`, MCP `goal.check_convergence`, orchestrator). This is the
  intended semantics: "a goal with no run yet needs its first run."
- **Status sync:** `needs_fix` does not move `goal_sessions.status`
  (`statusForConvergenceDecision` returns null for it), so a fresh goal stays
  `open` — no regression.
- **Existing tests to update** (expect `needs_fix` instead of `continue` for a
  fresh, run-less goal): cases in `tests/unit/goal/convergence.test.ts`; the
  orchestrator `g-loop` seed in `tests/unit/goal/orchestrator.test.ts` (fresh,
  close pending, zero attempts → now `needs_fix`, so it dispatches to `coder`
  rather than looping on `review` — update the expectation, the fake coder makes
  no goal-state change so it still reaches `max_steps_exhausted`); any
  `tests/unit/goal/fixture-matrix.test.ts` fresh-goal row; and MCP/CLI tests that
  assert a fresh goal's decision. The `g-close` seed is **unchanged** (it returns
  `close_ready` via the line-219 check, above the new branch). Re-point each, do
  not work around.

## Testing

- **convergence unit:** a fresh goal (`attemptsUsed === 0`, no findings, close
  pending) → `needs_fix / fix_findings`; and confirm the higher-priority
  branches still win when findings / failed close conditions exist (ordering).
- **orchestrator integration:** extend `tests/integration/goal-orchestrate.test.ts`
  so the goal starts with NO seeded run and the orchestrator drives the initial
  coder run itself, then review → close/pr. (The Phase 21 test seeded the first
  run; empty-start should now reach a terminal without that seed.)
- **spec update:** flip the "empty-goal autonomy" bullet in
  `2026-06-04-autonomous-goal-orchestration-design.md` from deferred to
  implemented (cross-reference this spec).

## Out of scope (unchanged from Phase 21)

Auto-defer of `continue/defer_followups`, daemon / worker-pool, external
single-step scheduler, auto-merge. All still deferred.
