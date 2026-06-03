# Autonomous goal orchestration — design

**Date:** 2026-06-04
**Phase:** 21 (proposed)
**Depends on:** Phase 18 (MCP), Phase 19 (goal convergence controller), Phase 11
(review governance / consensus / review rules)
**Status:** design approved, pending implementation plan

## Goal

Drive a Phase 19 goal session to its terminal state **without per-step human
triggering**. Today an operator runs `harness goal check-convergence`, reads the
decision, then manually launches the next `run` / `review` / `rerun`. This phase
automates that control-plane loop while keeping the harness safety model intact.

**Core principle (unchanged):** the harness does not let an LLM decide
convergence. `ConvergenceService` computes the decision deterministically from
metrics (open findings, close conditions, budgets, divergence); the orchestrator
only *acts on* that decision. codex (coder and reviewer) is never trusted to
judge whether the goal is done — and codex never sees the goal session at all.

## Decisions (from brainstorming)

| Question | Decision |
|----------|----------|
| Execution model | **Single-command foreground loop**: `harness goal orchestrate <goalId>` runs one goal to a terminal state and exits. (Daemon / worker-pool and external-scheduler stepping are deferred.) |
| Autonomy level | **Aggressive**: automate through `close` and `pr create`. |
| `needs_classification` | **Deterministic rule**: classify findings by matching category against goal scope (`allowedFindingCategories` / `excludedCategories`); anything that does not match cleanly **escalates and stops** (no LLM classification). |
| Review trust | **review-rule-driven**: Phase 11 review rules decide single vs consensus per domain/risk. |

## Architecture — separation of judgement and execution

```
harness goal orchestrate <goalId>
        │
        ▼
GoalOrchestrator (src/goal/orchestrator.ts) — bounded loop, control only
   each step:
     1. evaluateConvergenceAndRecordStatus(goalId)   # judgement: ConvergenceService (deterministic)
     2. dispatch an action from decision/nextAction
     3. pass through the mutation gate (Phase 19 hardening)
     4. run the action via an injected runner
     5. record the attempt/cycle on the goal session (GoalRepository)
        ▼
runners (DI): { coder, reviewer, processor, rerun, pr }   # prod = real, test = fake
        ▼
existing core operations (runDomainCoding / review auto / review process / rerun / pr create)
        ▼
codex exec  — does not know the goal session; each run does the domain task only
```

The orchestrator holds **no judgement logic**. Judgement lives in
`ConvergenceService`, execution in the runners, classification in
`classification`, persistence in `GoalRepository`. Each is independent and
separately testable.

## Components

- **`src/goal/orchestrator.ts`** — `GoalOrchestrator.run(goalId, runners, opts):
  OrchestrationResult`. Just the loop and the decision→action dispatch. Target
  well under the 800-line limit; if dispatch grows, extract a `dispatch.ts`.
- **runners interface** — `{ coder, reviewer, processor, rerun, pr }`, injected
  (the `reviewed-run-workflow.ts` runner-injection pattern). Production wires the
  real core operations; tests wire fakes.
- **Reused as-is**: `ConvergenceService`,
  `evaluateConvergenceAndRecordStatus` / `recordConvergenceDecisionWithStatus`
  (`convergence-status.ts`), the mutation gate (`mutation-gate.ts`),
  deterministic finding classification (`classification.ts`), `GoalRepository`,
  and Phase 11 review rules / consensus.

## Data flow — decision → action

| decision (+ nextAction) | orchestrator action |
|---|---|
| `needs_fix` (`fix_findings` / `run_close_check`) | coder `run`/`rerun` weaving in required_changes/findings → record attempt |
| `continue` (`run_close_check`) | reviewer `review auto` → `review process` (review-rule decides single/consensus) → record cycle |
| `continue` (other nextAction) | treat as no safe automated action → **escalate and stop** (the mutation gate already only permits `continue + run_close_check` for review) |
| `needs_classification` | deterministic classification (scope match); resolved → re-evaluate; unresolved → **escalate and stop** |
| `close_ready` | `close` → `pr create` (aggressive mode) |
| `diverging` / `budget_exhausted` / `escalate` | **stop and escalate** (leave a resumable state for a human) |
| `closed` / `cancel` | finished — exit |

The dispatch table is kept consistent with the mutation gate's permit matrix:
the orchestrator only attempts actions the gate would allow; any decision the
gate denies (and that is not a clean terminal) escalates rather than forcing.

### Bounds

- Hard bound: the goal session's `maxIterations` / `maxReviewCycles` /
  `maxReruns` (existing budgets; exceeding them yields `budget_exhausted`).
- Belt-and-suspenders: an orchestrator `maxSteps` guard against an unexpected
  non-terminating loop, independent of the budgets.

## Error handling, interruption, and resume

- **runner failure** (codex timeout / policy violation / command failure) — the
  run finishes `failed-*` as today; the orchestrator records it as an attempt.
  It feeds the next convergence evaluation; sustained no-progress converges to
  `diverging` / `budget_exhausted` and stops.
- **mutation-gate denial** — the action is not executed; the orchestrator stops
  rather than stepping into a state inconsistent with the decision.
- **consensus not yet satisfied** (review-rule-driven, `StateConflictError`) —
  launch additional reviewers up to the rule's required count; stop and escalate
  past the limit.
- **unexpected exception** — abort safely, set goal status `escalated`, and
  record the failing step in `OrchestrationResult`.
- **stateless & resumable** — the orchestrator keeps no state of its own; all
  state lives in the goal session DB (canonical). Re-running
  `harness goal orchestrate` continues from the current convergence. Each step
  goes through the existing `OperationRunner` idempotency key, so a re-run does
  not double-apply a step.

## Testing

- **Unit (fake runners):** a fixture matrix over every decision path —
  convergence (needs_fix → review → close_ready → close → pr → closed),
  divergence stop, budget stop, classification (resolved vs escalate), review
  (single approved vs consensus required). No real codex. Reuses the existing
  goal fixture-matrix / reviewed-run patterns.
- **Integration (one):** real git + fake codex, end-to-end `orchestrate → pr`.

## CLI

```bash
harness goal orchestrate <goalId> [--max-steps <n>] [--dry-run]
```

- `--dry-run` — do not execute; print the current convergence and the single
  action the orchestrator *would* take next (a cost-free plan check).
- Output — per step: decision / action / result; final outcome (`closed` /
  `escalated:<reason>` / pr URL). On escalate, print the reason a human should
  look at and how to resume.

## Out of scope (deferred)

- Daemon / worker-pool execution over many goals concurrently
  (`GOAL_CREATED_SOURCES` already includes `"worker"` for this future).
- External-scheduler single-step mode (`harness goal step`).
- LLM-based classification or LLM-judged convergence (deliberately never).
- Auto-merge of the created PR (PR is created; merge stays human).
- Dashboard UI for orchestration.
- **Empty-goal autonomy.** A fresh goal (no runs yet) evaluates to
  `continue / run_close_check`, where the gate permits only `review.*` — so the
  orchestrator drives from *review onward* and requires a **seeded first run**
  (create the initial coder run with `harness run` / a linked `run.start`). If
  the orchestrator hits review before any run exists, it now escalates cleanly
  (it no longer crashes). Closing the loop so the orchestrator can create the
  very first run itself needs a gate/convergence change and is deferred.
- **Auto-defer of out-of-scope follow-ups.** `continue / defer_followups`
  currently escalates rather than auto-deferring (deferral is deterministic and
  safe via `deferFindingToBacklog`, so this is a candidate for a future
  `defer` action; today it stays human to remain fail-closed).
