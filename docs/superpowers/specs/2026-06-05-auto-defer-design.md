# Auto-defer — design

**Date:** 2026-06-05
**Phase:** 21.2 (follow-up to Phase 21 autonomous goal orchestration)
**Depends on:** Phase 19 (goal convergence, finding deferral), Phase 21 (orchestrator)
**Status:** design approved, pending implementation plan

## Goal

Let the orchestrator automatically defer out-of-scope follow-up findings instead
of escalating. Today, when convergence returns `continue / defer_followups`
(required close conditions pass but out-of-scope findings still need deferral),
the orchestrator escalates — forcing a human into a deterministic, safe step.
This phase makes that step automatic, closing the last autonomy gap in the
orchestration loop.

**Core principle (unchanged):** judgement stays in `ConvergenceService`
(deterministic); the orchestrator only acts on the decision. Deferral is a safe,
deterministic operation — findings are moved to the backlog and tracked, not
dropped — so automating it does not loosen the fail-closed posture.

## The change (existing-pattern extension, 4 sites)

- **`src/goal/orchestrator-types.ts`**: add `{ kind: "defer" }` to
  `OrchestratorAction`; add `defer(goalId: string): Promise<{ deferred: number }>`
  to `OrchestratorRunners`.
- **`src/goal/orchestrator-dispatch.ts`**: map `continue` + `defer_followups` →
  `{ kind: "defer" }`. Every other `continue` action stays as it is today
  (`run_close_check` → review; anything else → escalate). Fail-closed default
  unchanged.
- **`src/goal/orchestrator.ts`**: handle the `defer` action inside the existing
  per-step try/catch — call `runners.defer(goalId)`, push a `defer` step, and
  continue the loop. The next evaluation sees `openOutOfScope === 0` and moves on
  (typically to `close_ready`).
- **`src/goal/orchestrator-runners.ts`**: implement the `defer` runner — load the
  goal's open out-of-scope findings via
  `listFindings({ goalId, scopeStatus: "out_of_scope" })` (filtered to open
  lifecycle states), and defer each through `deferFindingToBacklog` (the same
  path the CLI `goal finding defer` and the MCP `goal.defer_finding` tool use).
  Return the count deferred.

No change to `mutation-gate.ts` (deferral is a goal-repository operation, not a
gated run/review/rerun mutation), to `convergence.ts`, or to the dispatch
fail-closed default.

## Why approach A (runner reads the repository)

Convergence puts the candidate ids in `recommendedNextAction.findingIds`, so a
"pass them through" variant (B) is possible. Approach A — the runner fetches open
out-of-scope findings itself from the repository — is chosen because every other
runner takes only `goalId`, keeping the `OrchestratorRunners` interface uniform
and the runner self-contained. The set A computes is the same one convergence
flagged (open, out-of-scope), so they do not diverge.

## Safety and termination

- Deferral moves findings to the backlog (tracked, recoverable) — fail-closed is
  preserved; nothing is silently dropped.
- If the `defer` runner defers zero findings while convergence still asks for
  `defer_followups` (e.g. a finding cannot be deferred), the loop would repeat;
  the existing `maxSteps` guard and the H1 per-step try/catch turn that into a
  bounded `max_steps_exhausted` / `escalated` outcome rather than an infinite
  loop. The runner should surface such a no-op (deferred === 0 when findings were
  expected) by letting the loop's bound handle it — it must not claim success it
  did not achieve.

## Testing

- **dispatch unit**: `continue` + `defer_followups` → `{ kind: "defer" }`;
  confirm other `continue` actions still escalate / map to review.
- **runner unit**: a goal with open out-of-scope findings → `defer` returns the
  count, the findings move to a deferred lifecycle state, and backlog items are
  created (assert via `GoalRepository`).
- **orchestrator unit**: a goal that reaches `continue / defer_followups` is
  driven through `defer` to a terminal (`close_ready` → close), using fake
  runners.
- **spec update**: flip the "auto-defer" deferred bullet in
  `2026-06-04-autonomous-goal-orchestration-design.md` to implemented
  (cross-reference this spec).

## Out of scope (unchanged)

Daemon / worker-pool, external single-step scheduler, auto-merge, Streamable HTTP
MCP, dashboard mutation UI, S3 blob adapter, external issue tracker. All deferred.
