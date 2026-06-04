# Auto-defer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the orchestrator auto-defer out-of-scope findings (`continue/defer_followups`) via the backlog instead of escalating, closing the last autonomy gap.

**Architecture:** A new `defer` orchestrator action + runner. Dispatch maps `continue/defer_followups` → `defer`; the runner defers open out-of-scope findings through `deferFindingToBacklog` (the CLI/MCP path); the loop continues and the next convergence sees `openOutOfScope === 0`. Judgement (ConvergenceService) and gate are unchanged.

**Tech Stack:** TypeScript ESM, vitest. Touches `src/goal/orchestrator-{types,dispatch,runners}.ts`, `src/goal/orchestrator.ts`, goal tests.

Design: `docs/superpowers/specs/2026-06-05-auto-defer-design.md`.

---

## File Structure

- Modify `src/goal/orchestrator-types.ts` — add `{ kind: "defer" }` and `defer(goalId)`.
- Modify `src/goal/orchestrator-dispatch.ts` — `continue/defer_followups` → defer.
- Modify `src/goal/orchestrator.ts` — handle the `defer` action.
- Modify `src/goal/orchestrator-runners.ts` — implement the `defer` runner.
- Modify tests: `orchestrator-dispatch.test.ts`, `orchestrator-runners.test.ts`, `orchestrator.test.ts`.
- Modify spec `2026-06-04-autonomous-goal-orchestration-design.md` (auto-defer → implemented).

---

## Task 1: Types + dispatch

**Files:**
- Modify: `src/goal/orchestrator-types.ts`, `src/goal/orchestrator-dispatch.ts`
- Test: `tests/unit/goal/orchestrator-dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/goal/orchestrator-dispatch.test.ts` (it has a `conv(decision, actionKind)` helper):

```typescript
it("maps continue + defer_followups to defer", () => {
  expect(decideOrchestratorAction(conv("continue", "defer_followups")).kind).toBe("defer");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/goal/orchestrator-dispatch.test.ts -t "defer_followups to defer"`
Expected: FAIL — currently `continue/defer_followups` returns `{ kind: "escalate" }`.

- [ ] **Step 3a: Add the action + runner method to types**

In `src/goal/orchestrator-types.ts`, add `{ kind: "defer" }` to the `OrchestratorAction` union (after the `classify` variant):

```typescript
  | { kind: "classify" } // needs_classification: deterministic scope classification
  | { kind: "defer" } // continue/defer_followups: defer out-of-scope findings to backlog
  | { kind: "close_and_pr" } // close_ready: close the goal then create the PR
```

And add to the `OrchestratorRunners` interface (after `classify`):

```typescript
  /** Defer open out-of-scope findings to the backlog. Returns how many were deferred. */
  defer(goalId: string): Promise<{ deferred: number }>;
```

- [ ] **Step 3b: Map the decision in dispatch**

In `src/goal/orchestrator-dispatch.ts`, change the `continue` case so `defer_followups` maps to defer (the other non-`run_close_check` actions still escalate):

```typescript
    case "continue":
      if (action === "run_close_check") return { kind: "review" };
      if (action === "defer_followups") return { kind: "defer" };
      return { kind: "escalate", reason: `continue with non-review action ${action}` };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/goal/orchestrator-dispatch.test.ts`
Expected: PASS (existing tests + the new one). Note: the existing test "escalates other continue actions" asserts `continue/fix_findings` and `continue/defer_followups` escalate — update its `defer_followups` assertion to expect `defer` (keep `fix_findings` → escalate).

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/goal/orchestrator-types.ts src/goal/orchestrator-dispatch.ts tests/unit/goal/orchestrator-dispatch.test.ts
git commit -m "feat(goal): orchestrator defer action for continue/defer_followups"
```

---

## Task 2: defer runner

**Files:**
- Modify: `src/goal/orchestrator-runners.ts`
- Test: `tests/unit/goal/orchestrator-runners.test.ts`

The runner loads open out-of-scope findings and defers each via `deferFindingToBacklog` (signature: `{ repository, findingId, reason, createBacklogItem?, backlogContext?: { backlogDir, dbPath } }` → `{ finding, backlogItemId, ... }`, from `src/goal/followups.ts`). It must hold the repo across the async defers, so open the DB manually (the file already imports `openManagedDb` via `withManagedDb`; add `openManagedDb` to that import).

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/goal/orchestrator-runners.test.ts`:

```typescript
it("defer moves open out-of-scope findings to the backlog", async () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "harness-orch-defer-")), "harness.sqlite");
  const root = dbPath; // harnessRoot; backlogDir derives from it via harnessPaths
  let findingId = "";
  {
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "g-defer",
        title: "Defer",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      const f = repo.upsertFinding({
        goalId: "g-defer",
        source: "review",
        severity: "P2",
        category: "future-feature",
        summary: "out of scope idea",
      }).finding;
      // mark it out_of_scope so it is eligible for deferral
      repo.classifyFinding({ findingId: f.findingId, scopeStatus: "out_of_scope", reason: "test" });
      findingId = f.findingId;
    } finally {
      close();
    }
  }
  const runners = createOrchestratorRunners({
    dbPath,
    harnessRoot: root,
    createdBy: "worker",
    coderRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
    reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
  });
  const result = await runners.defer("g-defer");
  expect(result.deferred).toBe(1);
  const { db, close } = openManagedDb({ dbPath });
  try {
    expect(new GoalRepository(db).requireFinding(findingId).lifecycleStatus).toBe("deferred");
  } finally {
    close();
  }
});
```

> **Implementer note:** confirm `upsertFinding` / `classifyFinding` / `requireFinding` signatures and `harnessPaths(root).backlogDir` against `src/goal/repository.ts` and `src/config/paths.ts`. `createBacklogItem: false` is acceptable if `backlogDir` setup is awkward in the test — but the runner itself should create the backlog item (`createBacklogItem: true`) since that mirrors the CLI default for autonomous use. Adjust the assertion to whatever `deferFindingToBacklog` guarantees (finding lifecycle becomes `deferred`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/goal/orchestrator-runners.test.ts -t "defer moves"`
Expected: FAIL — `runners.defer` is not implemented.

- [ ] **Step 3: Implement the defer runner**

In `src/goal/orchestrator-runners.ts`: ensure `openManagedDb` and `deferFindingToBacklog` are imported (`import { openManagedDb, withManagedDb } from "../db/managed-connection.js";` and `import { deferFindingToBacklog } from "./followups.js";`). Add the `defer` method to the returned runners (no mutation gate — deferral is a goal-repository op, not a gated run/review/rerun):

```typescript
    defer: async (goalId) => {
      const { db, close } = openManagedDb({ dbPath: deps.dbPath });
      try {
        const repo = new GoalRepository(db);
        const openStates = new Set(["open", "reopened", "escalated"]);
        const findings = repo
          .listFindings({ goalId, scopeStatus: "out_of_scope" })
          .filter((f) => openStates.has(f.lifecycleStatus));
        let deferred = 0;
        for (const finding of findings) {
          await deferFindingToBacklog({
            repository: repo,
            findingId: finding.findingId,
            reason: "auto-deferred by orchestrator (out-of-scope follow-up)",
            createBacklogItem: true,
            backlogContext: { backlogDir: paths.backlogDir, dbPath: deps.dbPath },
          });
          deferred++;
        }
        return { deferred };
      } finally {
        close();
      }
    },
```

> **Implementer note:** `paths` is the `harnessPaths(deps.harnessRoot)` value already used by `closeAndPr` in this file (it uses `paths.runsDir` etc.). Confirm `paths.backlogDir` exists; if not, derive it from `deps.harnessRoot`. If `deferFindingToBacklog`'s nested `openManagedDb` on the same `dbPath` deadlocks with the outer open, defer outside the outer block: collect `findingId`s inside `openManagedDb`, close, then loop the async defers with a fresh repo per call (each `deferFindingToBacklog` opens its own). Prefer the simplest form that passes; report which you used.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/goal/orchestrator-runners.test.ts`
Expected: PASS.

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/goal/orchestrator-runners.ts tests/unit/goal/orchestrator-runners.test.ts
git commit -m "feat(goal): orchestrator defer runner (out-of-scope -> backlog)"
```

---

## Task 3: Orchestrator handling + spec

**Files:**
- Modify: `src/goal/orchestrator.ts`
- Test: `tests/unit/goal/orchestrator.test.ts`
- Modify: `docs/superpowers/specs/2026-06-04-autonomous-goal-orchestration-design.md`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/goal/orchestrator.test.ts` (it has `freshDbPath`, `openManagedDb`, `runMigrations`, `GoalRepository`, `fakeRunners`). Seed a goal that converges to `continue/defer_followups`: required close conditions passed, an open out-of-scope finding, and a coding attempt so it isn't fresh. The fake `defer` runner should record the call and (since fakeRunners doesn't change goal state) let the loop bound; assert the `defer` action is taken:

```typescript
it("dispatches defer for continue/defer_followups", async () => {
  const dbPath = freshDbPath();
  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    const repo = new GoalRepository(db);
    repo.createSession({
      goalId: "g-defer-loop",
      title: "Defer loop",
      projectId: "demo",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      createdBy: "test",
      createdSource: "worker",
    });
    repo.createAttempt({ goalId: "g-defer-loop", attemptType: "implement" });
    repo.recordCloseCheck({ goalId: "g-defer-loop", conditionId: "typecheck", status: "passed", checkedBy: "test" });
    const f = repo.upsertFinding({ goalId: "g-defer-loop", source: "review", severity: "P2", category: "future", summary: "oos" }).finding;
    repo.classifyFinding({ findingId: f.findingId, scopeStatus: "out_of_scope", reason: "test" });
  } finally {
    close();
  }
  const calls: string[] = [];
  const result = await new GoalOrchestrator({ dbPath }).run({
    goalId: "g-defer-loop",
    runners: fakeRunners(calls),
    maxSteps: 3,
    createdBy: "worker",
  });
  expect(calls).toContain("defer");
  expect(result.steps.some((s) => s.action === "defer")).toBe(true);
});
```

> **Implementer note:** add a `defer` method to the `fakeRunners(calls)` helper: `defer: async () => { calls.push("defer"); return { deferred: 1 }; }`. Confirm the seeded goal actually yields `continue/defer_followups` (requires `policy.deferOutOfScope` true and `allRequiredCloseConditionsPassed`); if it yields something else, adjust the seed (e.g. ensure the goal policy defers out-of-scope) per `convergence.ts:315-330`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/goal/orchestrator.test.ts -t "dispatches defer"`
Expected: FAIL — the loop has no `defer` branch (the action is unhandled / falls through).

- [ ] **Step 3: Handle the defer action**

In `src/goal/orchestrator.ts`, inside the per-step try/catch (alongside `coder`/`review`/`classify`), add before the `close_and_pr` fallthrough:

```typescript
        if (action.kind === "defer") {
          const r = await input.runners.defer(input.goalId);
          steps.push({ step: i, decision: finalDecision, action: "defer", detail: String(r.deferred) });
          continue;
        }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/goal/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the spec**

In `docs/superpowers/specs/2026-06-04-autonomous-goal-orchestration-design.md`, change the "Auto-defer" out-of-scope bullet to note it is implemented in Phase 21.2 (cross-reference `2026-06-05-auto-defer-design.md`). Set the auto-defer spec's Status to implemented.

- [ ] **Step 6: Full suite + typecheck + commit**

```bash
npm run typecheck && npm test
git add -A
git commit -m "feat(goal): orchestrator auto-defers out-of-scope findings; docs"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** the action+dispatch (Task 1), the runner via `deferFindingToBacklog` (Task 2), the loop handling + spec flip (Task 3) cover the design.
- **Placeholders:** dispatch and orchestrator edits have exact code. The runner's `backlogContext`/paths and the seed that yields `continue/defer_followups` are flagged as implementer-verify with the exact reference points (`cli/goal.ts:476`, `convergence.ts:315-330`); these depend on signatures the plan did not fully read.
- **Type consistency:** `{ kind: "defer" }`, `defer(goalId): Promise<{ deferred: number }>`, `listFindings({ goalId, scopeStatus })`, `classifyFinding`, `deferFindingToBacklog` match the merged code and Task 1's additions.
