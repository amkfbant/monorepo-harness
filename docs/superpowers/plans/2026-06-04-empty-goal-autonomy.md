# Empty-Goal Autonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a fresh goal (zero coding attempts) converge to `needs_fix/fix_findings` so the orchestrator drives its own first run — closing Phase 21's "seeded first run" precondition.

**Architecture:** One new branch in `ConvergenceService` (approach A), placed after the `close_ready` check and all finding/close branches, before the terminal `continue` fallthrough. The orchestrator, gate, dispatch, and runners are unchanged — the existing `needs_fix`→coder path handles the first run.

**Tech Stack:** TypeScript ESM, vitest. Touches `src/goal/convergence.ts` and goal tests.

Design: `docs/superpowers/specs/2026-06-04-empty-goal-autonomy-design.md`.

---

## File Structure

- Modify `src/goal/convergence.ts` — insert the `attemptsUsed === 0` branch before the final `continue` return (currently line 333).
- Modify `tests/unit/goal/convergence.test.ts` — add the fresh-goal and ordering cases.
- Modify regression tests that asserted a fresh goal yields `continue` (identified by running the suite after Task 1).
- Modify `tests/integration/goal-orchestrate.test.ts` — exercise the empty-start (no seeded run) path.
- Modify both specs to mark empty-goal autonomy implemented.

---

## Task 1: ConvergenceService first-run branch

**Files:**
- Modify: `src/goal/convergence.ts` (before the `return result(... "continue" ...)` at line ~333)
- Test: `tests/unit/goal/convergence.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/goal/convergence.test.ts`, matching the file's existing setup style (it constructs a `GoalRepository` over an in-memory/temp DB, seeds a session, and calls `new ConvergenceService(repo).evaluate(goalId)`; read the file and reuse its exact helpers). The two cases:

```typescript
it("a fresh goal with no coding attempts needs its first run", () => {
  // seed: a session with required close conditions, NO attempts, NO findings,
  // NO close checks recorded (use the file's existing seed helper).
  const result = evaluateFreshGoal(); // adapt to the file's helper that creates a session + evaluates
  expect(result.decision).toBe("needs_fix");
  expect(result.recommendedNextAction.kind).toBe("fix_findings");
  expect(result.reason).toBe("no implementation attempt yet");
});

it("a goal whose required close conditions pass is close_ready even with zero attempts", () => {
  // seed: session + all required close conditions recorded as passed, zero attempts.
  const result = evaluateCloseReadyGoal();
  expect(result.decision).toBe("close_ready");
});
```

> **Implementer note:** read `tests/unit/goal/convergence.test.ts` first and copy its real seeding pattern (session creation, `recordCloseCheck`, evaluate). The first test must produce a session with `attemptsUsed === 0`, no findings, and close conditions still pending. The second guards that the new branch sits BELOW the close_ready check.

- [ ] **Step 2: Run to verify the first test fails**

Run: `npx vitest run tests/unit/goal/convergence.test.ts -t "needs its first run"`
Expected: FAIL — current code returns `continue` / `run_close_check`, not `needs_fix`.

- [ ] **Step 3: Insert the branch**

In `src/goal/convergence.ts`, replace the final fallthrough:

```typescript
  }

  return result(session.goalId, "continue", "more validation required", metrics, {
    kind: "run_close_check",
    message: "Record close-check evidence or run the next review mode.",
  });
```

with:

```typescript
  }

  if (metrics.attemptsUsed === 0) {
    return result(
      session.goalId,
      "needs_fix",
      "no implementation attempt yet",
      metrics,
      {
        kind: "fix_findings",
        message: "Run the initial coder pass for this goal.",
      },
    );
  }

  return result(session.goalId, "continue", "more validation required", metrics, {
    kind: "run_close_check",
    message: "Record close-check evidence or run the next review mode.",
  });
```

(This is below the `close_ready` check at line ~219 and below the finding / `closeConditionsFailed` / out-of-scope branches, so only a genuinely fresh goal reaches it.)

- [ ] **Step 4: Run to verify both new tests pass**

Run: `npx vitest run tests/unit/goal/convergence.test.ts`
Expected: the two new tests PASS. Other tests in this file may now fail (fresh-goal expectations) — that is handled in Task 2.

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/goal/convergence.ts tests/unit/goal/convergence.test.ts
git commit -m "feat(goal): a fresh goal with no run needs its first coder pass"
```

---

## Task 2: Update regression expectations

A fresh, run-less goal now yields `needs_fix` instead of `continue` everywhere. Find and re-point the affected assertions.

**Files:**
- Modify: whichever tests fail (likely `tests/unit/goal/convergence.test.ts`, `tests/unit/goal/orchestrator.test.ts` (`g-loop`), `tests/unit/goal/fixture-matrix.test.ts`, `tests/unit/mcp/goal-tools.test.ts`, `tests/integration/goal-cli.test.ts`).

- [ ] **Step 1: Run the full suite to find the breakage**

Run: `npm test`
Expected: failures wherever a fresh/run-less goal was asserted to be `continue` / `run_close_check`. Note each failing test.

- [ ] **Step 2: Re-point each failing assertion**

For each failure, the goal under test is fresh with zero coding attempts and the decision is now `needs_fix` / `fix_findings`. Update the expectation to match the NEW correct behavior. Do NOT weaken the test or seed a fake attempt to dodge it — unless the test's intent genuinely requires a non-fresh goal, in which case seed a coding attempt (`repo.createAttempt({ goalId, attemptType: "implement", status: "succeeded", runId: "..." })`) so the test exercises its real intent.

Specifically for `tests/unit/goal/orchestrator.test.ts` `g-loop`: it now dispatches to `coder` (not `review`). The fake coder makes no goal-state change, so the loop still runs to `max_steps_exhausted` — keep that assertion; the decision/action observed changes from review-looping to coder-looping. Adjust any decision/action assertion accordingly.

- [ ] **Step 3: Run the full suite to confirm green**

Run: `npm test`
Expected: all pass (1 skipped as before).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(goal): re-point fresh-goal expectations to needs_fix"
```

---

## Task 3: Orchestrator empty-start integration + spec updates

**Files:**
- Modify: `tests/integration/goal-orchestrate.test.ts`
- Modify: `docs/superpowers/specs/2026-06-04-empty-goal-autonomy-design.md`, `docs/superpowers/specs/2026-06-04-autonomous-goal-orchestration-design.md`

- [ ] **Step 1: Add the empty-start test**

In `tests/integration/goal-orchestrate.test.ts`, add a case that does NOT seed a first run (the existing test seeds one — read it and mirror its HARNESS_ROOT / fake-codex / fake-publisher setup). Create the goal session linked to the repo/domain, then run the orchestrator directly:

```typescript
it("drives an empty goal from its own first run to a terminal state", async () => {
  // build HARNESS_ROOT + target git repo + policy + DB (reuse the file's setup)
  // create the goal session ONLY — no runDomainCoding seed
  const result = await new GoalOrchestrator({ dbPath }).run({
    goalId,
    runners: createOrchestratorRunners({
      dbPath, harnessRoot, createdBy: "test",
      coderRunner: fakeCoder, reviewerRunner: fakeReviewer, publisher: fakePublisher,
    }),
    maxSteps: 20,
    createdBy: "test",
  });
  // first step is needs_fix -> coder creates the initial run; then review -> close/pr.
  expect(["closed", "pr_created"]).toContain(result.outcome);
  // assert at least one coder attempt was recorded by the orchestrator itself
  // (use GoalRepository.listAttempts(goalId) and check for an implement attempt with a runId)
});
```

> **Implementer note:** the fake coder must actually produce a reviewable run (it wraps `runDomainCoding`, which needs the policy + target repo set up exactly as the existing seeded test does). Reuse that test's helpers verbatim; the only difference is you do not pre-create the first run. If reaching a terminal needs a close-check to pass after review, mirror how the existing test arranges that.

- [ ] **Step 2: Run the integration test**

Run: `npx vitest run tests/integration/goal-orchestrate.test.ts`
Expected: PASS — the orchestrator reaches a terminal from an empty goal.

- [ ] **Step 3: Update the specs**

In `docs/superpowers/specs/2026-06-04-empty-goal-autonomy-design.md`, change Status to "implemented". In `docs/superpowers/specs/2026-06-04-autonomous-goal-orchestration-design.md`, change the "Empty-goal autonomy" deferred bullet to note it is now implemented (cross-reference the empty-goal-autonomy spec).

- [ ] **Step 4: Full suite + typecheck + commit**

```bash
npm run typecheck && npm test
git add -A
git commit -m "test(goal): orchestrator drives an empty goal end-to-end; docs"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** the convergence branch (Task 1), the fresh-goal/ordering unit tests (Task 1), the all-paths regression update (Task 2), the orchestrator empty-start integration + spec flip (Task 3) cover every section of the design.
- **Placeholders:** Task 1 has the exact insertion (real surrounding code from convergence.ts:331-336). Tasks 2/3 necessarily discover the affected tests by running the suite — the regression set cannot be fully enumerated without running, so the plan instructs running `npm test` and re-pointing each failure with explicit guidance (not "fix tests"). The `g-loop` case is spelled out.
- **Type consistency:** `attemptsUsed`, `needs_fix`, `fix_findings`, `createAttempt({ attemptType: "implement", status, runId })`, `listAttempts`, `GoalOrchestrator`/`createOrchestratorRunners` signatures match the merged Phase 21 code.
