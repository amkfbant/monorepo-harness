# Autonomous Goal Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `harness goal orchestrate <goalId>`, a single-command bounded loop that drives a Phase 19 goal session to a terminal state (closed / escalated / pr-created) without per-step human triggering.

**Architecture:** Separation of judgement and execution. `ConvergenceService` decides deterministically; a new `GoalOrchestrator` only maps each decision to an action and runs it through injected runners that wrap existing core operations. The orchestrator is stateless (state lives in the goal session DB) and bounded by the goal's budgets plus a `maxSteps` guard. codex never sees the goal session.

**Tech Stack:** TypeScript (ESM, NodeNext), better-sqlite3, commander, vitest. Reuses `ConvergenceService`, `convergence-status.ts`, `mutation-gate.ts`, `classification.ts`, `GoalRepository`, and the `reviewed-run-workflow.ts` runner-injection pattern.

Design: `docs/superpowers/specs/2026-06-04-autonomous-goal-orchestration-design.md`.

---

## File Structure

- Create `src/goal/orchestrator-types.ts` — `OrchestratorRunners` interface, `OrchestratorAction`, `OrchestrationStep`, `OrchestrationResult`.
- Create `src/goal/orchestrator-dispatch.ts` — `decideOrchestratorAction(convergence)` pure function (decision→action; consistent with the mutation-gate permit matrix).
- Create `src/goal/orchestrator.ts` — `GoalOrchestrator.run(...)` bounded loop.
- Create `src/goal/orchestrator-runners.ts` — production runner factory wiring the real core operations.
- Modify `src/cli/goal.ts` — add the `orchestrate` subcommand (+ `--dry-run`, `--max-steps`).
- Create `tests/unit/goal/orchestrator-dispatch.test.ts`, `tests/unit/goal/orchestrator.test.ts`.
- Create `tests/integration/goal-orchestrate.test.ts`.

---

## Task 1: Orchestrator types and runner interface

**Files:**
- Create: `src/goal/orchestrator-types.ts`

- [ ] **Step 1: Write the file**

```typescript
import type { GoalConvergenceResult } from "./types.js";

/** One logical action the orchestrator can take per loop step. */
export type OrchestratorAction =
  | { kind: "coder" } // needs_fix: run/rerun the coder to fix findings / run close checks
  | { kind: "review" } // continue + run_close_check: review the latest run
  | { kind: "classify" } // needs_classification: deterministic scope classification
  | { kind: "close_and_pr" } // close_ready: close the goal then create the PR
  | { kind: "stop"; outcome: "closed" | "cancelled" } // already terminal
  | { kind: "escalate"; reason: string }; // diverging / budget / escalate / unsupported

/**
 * High-level runners the orchestrator drives. Each method performs one logical
 * action against the goal's session and returns a short status. Production wires
 * these to the real core operations (Task 5); tests pass fakes.
 */
export interface OrchestratorRunners {
  /** Run/rerun the coder for the goal; records the attempt. Returns the run status. */
  coder(goalId: string): Promise<{ runId: string; runStatus: string }>;
  /** review auto + review process for the goal's latest run; records the cycle. */
  review(goalId: string): Promise<{ runId: string; decision: string }>;
  /** Deterministically classify open unknown-scope findings. Returns whether all resolved. */
  classify(goalId: string): Promise<{ resolved: boolean; escalateReason?: string }>;
  /** Close the goal and create a PR. Returns the PR url. */
  closeAndPr(goalId: string): Promise<{ prUrl: string }>;
}

export interface OrchestrationStep {
  step: number;
  decision: string;
  action: OrchestratorAction["kind"];
  detail: string;
}

export type OrchestrationOutcome =
  | "closed"
  | "cancelled"
  | "escalated"
  | "pr_created"
  | "max_steps_exhausted";

export interface OrchestrationResult {
  goalId: string;
  outcome: OrchestrationOutcome;
  steps: OrchestrationStep[];
  finalDecision: string;
  escalateReason?: string;
  prUrl?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/goal/orchestrator-types.ts
git commit -m "feat(goal): orchestrator types and runner interface"
```

---

## Task 2: Decision → action dispatch (pure, fail-closed)

This is the heart of the orchestrator and must match the mutation-gate permit matrix: `needs_fix` (fix_findings/run_close_check) → coder; `continue` (run_close_check) → review; everything else either terminates or escalates.

**Files:**
- Create: `src/goal/orchestrator-dispatch.ts`
- Test: `tests/unit/goal/orchestrator-dispatch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { decideOrchestratorAction } from "../../../src/goal/orchestrator-dispatch.js";
import type {
  GoalConvergenceDecision,
  GoalConvergenceResult,
  GoalNextActionKind,
} from "../../../src/goal/types.js";

function conv(
  decision: GoalConvergenceDecision,
  actionKind: GoalNextActionKind,
): GoalConvergenceResult {
  return {
    goalId: "g1",
    decision,
    reason: "test",
    metrics: {
      openInScopeP0: 0,
      openInScopeP1: 0,
      openInScopeP2: 0,
      openUnknownScope: 0,
      openOutOfScope: 0,
      totalNewFindings: 0,
      newFindingsThisCycle: 0,
      reviewCyclesUsed: 0,
      iterationsUsed: 0,
      rerunsUsed: 0,
      closeConditionsPassed: 0,
      closeConditionsFailed: 0,
      closeConditionsPending: 0,
      maxReopenCount: 0,
    },
    recommendedNextAction: { kind: actionKind, message: "m" },
  };
}

describe("decideOrchestratorAction", () => {
  it("maps needs_fix + fix_findings/run_close_check to coder", () => {
    expect(decideOrchestratorAction(conv("needs_fix", "fix_findings")).kind).toBe("coder");
    expect(decideOrchestratorAction(conv("needs_fix", "run_close_check")).kind).toBe("coder");
  });

  it("escalates needs_fix with an unsupported next action", () => {
    expect(decideOrchestratorAction(conv("needs_fix", "ask_human")).kind).toBe("escalate");
  });

  it("maps continue + run_close_check to review, escalates other continue actions", () => {
    expect(decideOrchestratorAction(conv("continue", "run_close_check")).kind).toBe("review");
    expect(decideOrchestratorAction(conv("continue", "fix_findings")).kind).toBe("escalate");
    expect(decideOrchestratorAction(conv("continue", "defer_followups")).kind).toBe("escalate");
  });

  it("maps needs_classification to classify and close_ready to close_and_pr", () => {
    expect(decideOrchestratorAction(conv("needs_classification", "classify_findings")).kind).toBe("classify");
    expect(decideOrchestratorAction(conv("close_ready", "close_goal")).kind).toBe("close_and_pr");
  });

  it("stops on terminal decisions and escalates unsafe ones", () => {
    expect(decideOrchestratorAction(conv("closed", "close_goal"))).toEqual({ kind: "stop", outcome: "closed" });
    expect(decideOrchestratorAction(conv("cancel", "ask_human"))).toEqual({ kind: "stop", outcome: "cancelled" });
    for (const d of ["diverging", "budget_exhausted", "escalate"] as const) {
      const a = decideOrchestratorAction(conv(d, "ask_human"));
      expect(a.kind).toBe("escalate");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/goal/orchestrator-dispatch.test.ts`
Expected: FAIL — `decideOrchestratorAction` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
import type { GoalConvergenceResult } from "./types.js";
import type { OrchestratorAction } from "./orchestrator-types.js";

/**
 * Map a convergence result to a single orchestrator action. Fail-closed: any
 * decision/action pair that is not an explicitly safe step escalates rather
 * than forcing a mutation. Kept consistent with mutation-gate's permit matrix.
 */
export function decideOrchestratorAction(
  convergence: GoalConvergenceResult,
): OrchestratorAction {
  const action = convergence.recommendedNextAction.kind;
  switch (convergence.decision) {
    case "needs_fix":
      if (action === "fix_findings" || action === "run_close_check") {
        return { kind: "coder" };
      }
      return { kind: "escalate", reason: `needs_fix with unsupported action ${action}` };
    case "continue":
      if (action === "run_close_check") return { kind: "review" };
      return { kind: "escalate", reason: `continue with non-review action ${action}` };
    case "needs_classification":
      return { kind: "classify" };
    case "close_ready":
      return { kind: "close_and_pr" };
    case "closed":
      return { kind: "stop", outcome: "closed" };
    case "cancel":
      return { kind: "stop", outcome: "cancelled" };
    case "diverging":
    case "budget_exhausted":
    case "escalate":
      return { kind: "escalate", reason: convergence.decision };
    default:
      return { kind: "escalate", reason: `unknown decision ${convergence.decision}` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/goal/orchestrator-dispatch.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/goal/orchestrator-dispatch.ts tests/unit/goal/orchestrator-dispatch.test.ts
git commit -m "feat(goal): decision->action dispatch for the orchestrator"
```

---

## Task 3: Orchestrator loop — convergence path (fake runners)

**Files:**
- Create: `src/goal/orchestrator.ts`
- Test: `tests/unit/goal/orchestrator.test.ts`

The loop: evaluate convergence (records the decision + syncs status), decide the action, run it via a runner, repeat until a terminal/escalate action or `maxSteps`. `classify` re-evaluates next iteration; if it cannot resolve it returns `escalateReason`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { GoalRepository } from "../../../src/goal/repository.js";
import { GoalOrchestrator } from "../../../src/goal/orchestrator.js";
import type { OrchestratorRunners } from "../../../src/goal/orchestrator-types.js";

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "harness-orch-")), "harness.sqlite");
}

// A goal that is immediately close_ready: one passed close check, no findings.
function seedCloseReady(dbPath: string): void {
  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    const repo = new GoalRepository(db);
    repo.createSession({
      goalId: "g-close",
      title: "Close ready",
      projectId: "demo",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      createdBy: "test",
      createdSource: "worker",
    });
    repo.recordCloseCheck({
      goalId: "g-close",
      conditionId: "typecheck",
      status: "passed",
      checkedBy: "test",
    });
  } finally {
    close();
  }
}

function fakeRunners(calls: string[]): OrchestratorRunners {
  return {
    coder: async () => {
      calls.push("coder");
      return { runId: "r1", runStatus: "needs_review" };
    },
    review: async () => {
      calls.push("review");
      return { runId: "r1", decision: "approved" };
    },
    classify: async () => {
      calls.push("classify");
      return { resolved: true };
    },
    closeAndPr: async () => {
      calls.push("closeAndPr");
      return { prUrl: "https://example/pr/1" };
    },
  };
}

describe("GoalOrchestrator", () => {
  it("closes a close_ready goal and creates a PR", async () => {
    const dbPath = freshDbPath();
    seedCloseReady(dbPath);
    const calls: string[] = [];
    const result = await new GoalOrchestrator({ dbPath }).run({
      goalId: "g-close",
      runners: fakeRunners(calls),
      maxSteps: 10,
      createdBy: "worker",
    });
    expect(result.outcome).toBe("pr_created");
    expect(result.prUrl).toBe("https://example/pr/1");
    expect(calls).toContain("closeAndPr");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/goal/orchestrator.test.ts`
Expected: FAIL — `GoalOrchestrator` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
import { withManagedDb } from "../db/managed-connection.js";
import { GoalRepository } from "./repository.js";
import { evaluateConvergenceAndRecordStatus } from "./convergence-status.js";
import { decideOrchestratorAction } from "./orchestrator-dispatch.js";
import type {
  OrchestrationResult,
  OrchestrationStep,
  OrchestratorRunners,
} from "./orchestrator-types.js";

export interface GoalOrchestratorOpts {
  dbPath: string;
}

export interface RunOrchestrationInput {
  goalId: string;
  runners: OrchestratorRunners;
  maxSteps: number;
  createdBy: string;
}

export class GoalOrchestrator {
  constructor(private readonly opts: GoalOrchestratorOpts) {}

  async run(input: RunOrchestrationInput): Promise<OrchestrationResult> {
    const steps: OrchestrationStep[] = [];
    let finalDecision = "";
    for (let i = 1; i <= input.maxSteps; i++) {
      const convergence = withManagedDb({ dbPath: this.opts.dbPath }, ({ db }) =>
        evaluateConvergenceAndRecordStatus({
          repository: new GoalRepository(db),
          goalId: input.goalId,
          createdBy: input.createdBy,
        }),
      );
      finalDecision = convergence.decision;
      const action = decideOrchestratorAction(convergence);

      if (action.kind === "stop") {
        steps.push({ step: i, decision: finalDecision, action: "stop", detail: action.outcome });
        return { goalId: input.goalId, outcome: action.outcome, steps, finalDecision };
      }
      if (action.kind === "escalate") {
        steps.push({ step: i, decision: finalDecision, action: "escalate", detail: action.reason });
        return {
          goalId: input.goalId,
          outcome: "escalated",
          steps,
          finalDecision,
          escalateReason: action.reason,
        };
      }
      if (action.kind === "coder") {
        const r = await input.runners.coder(input.goalId);
        steps.push({ step: i, decision: finalDecision, action: "coder", detail: r.runStatus });
        continue;
      }
      if (action.kind === "review") {
        const r = await input.runners.review(input.goalId);
        steps.push({ step: i, decision: finalDecision, action: "review", detail: r.decision });
        continue;
      }
      if (action.kind === "classify") {
        const r = await input.runners.classify(input.goalId);
        steps.push({ step: i, decision: finalDecision, action: "classify", detail: String(r.resolved) });
        if (!r.resolved) {
          return {
            goalId: input.goalId,
            outcome: "escalated",
            steps,
            finalDecision,
            escalateReason: r.escalateReason ?? "classification unresolved",
          };
        }
        continue;
      }
      // close_and_pr
      const pr = await input.runners.closeAndPr(input.goalId);
      steps.push({ step: i, decision: finalDecision, action: "close_and_pr", detail: pr.prUrl });
      return { goalId: input.goalId, outcome: "pr_created", steps, finalDecision, prUrl: pr.prUrl };
    }
    return { goalId: input.goalId, outcome: "max_steps_exhausted", steps, finalDecision };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/goal/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/goal/orchestrator.ts tests/unit/goal/orchestrator.test.ts
git commit -m "feat(goal): orchestrator bounded loop (convergence path)"
```

---

## Task 4: Orchestrator loop — escalate, classify-stop, and maxSteps paths

**Files:**
- Test: `tests/unit/goal/orchestrator.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe("GoalOrchestrator", ...)`:

```typescript
  it("escalates a diverging goal without calling runners", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new GoalRepository(db);
      repo.createSession({
        goalId: "g-div",
        title: "Diverging",
        projectId: "demo",
        maxTotalNewFindings: 0,
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      const cycle = repo.startReviewCycle({ goalId: "g-div", reviewMode: "initial" });
      repo.completeReviewCycle({ cycleId: cycle.cycleId, findingsNew: 1 });
    } finally {
      close();
    }
    const calls: string[] = [];
    const result = await new GoalOrchestrator({ dbPath }).run({
      goalId: "g-div",
      runners: fakeRunners(calls),
      maxSteps: 10,
      createdBy: "worker",
    });
    expect(result.outcome).toBe("escalated");
    expect(result.escalateReason).toBe("diverging");
    expect(calls).toEqual([]);
  });

  it("stops with max_steps_exhausted when the loop never reaches a terminal", async () => {
    const dbPath = freshDbPath();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new GoalRepository(db).createSession({
        goalId: "g-loop",
        title: "Loop",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
    } finally {
      close();
    }
    // A coder/review runner that never changes goal state keeps the decision
    // non-terminal; maxSteps must stop the loop.
    const result = await new GoalOrchestrator({ dbPath }).run({
      goalId: "g-loop",
      runners: fakeRunners([]),
      maxSteps: 3,
      createdBy: "worker",
    });
    expect(result.outcome).toBe("max_steps_exhausted");
    expect(result.steps.length).toBe(3);
  });
```

- [ ] **Step 2: Run tests to verify they fail or pass against the Task 3 implementation**

Run: `npx vitest run tests/unit/goal/orchestrator.test.ts`
Expected: the diverging and max_steps tests exercise branches already implemented in Task 3; if any assertion fails (e.g. a non-terminal seed actually converges), adjust the seed so the decision is genuinely `continue`/`needs_fix`. Do not change `orchestrator.ts` unless a branch is genuinely missing.

- [ ] **Step 3: Run the goal suite to confirm no regressions**

Run: `npx vitest run tests/unit/goal/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/unit/goal/orchestrator.test.ts
git commit -m "test(goal): orchestrator escalate / classify-stop / maxSteps paths"
```

---

## Task 5: Production runner factory (wire real core operations)

**Files:**
- Create: `src/goal/orchestrator-runners.ts`
- Test: `tests/unit/goal/orchestrator-runners.test.ts`

Each runner method loads what it needs from the goal session (project/repo/domain) and calls the existing operation, passing the gate. This task focuses on the `closeAndPr` runner (deterministic, no codex) for a unit test; `coder`/`review` are wired but exercised end-to-end in Task 7's integration test (they require real git + codex runner).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { GoalRepository } from "../../../src/goal/repository.js";
import { createOrchestratorRunners } from "../../../src/goal/orchestrator-runners.js";

describe("createOrchestratorRunners.classify", () => {
  it("returns resolved=true when there are no unknown-scope findings", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "harness-orch-run-")), "harness.sqlite");
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new GoalRepository(db).createSession({
        goalId: "g-c",
        title: "C",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
    } finally {
      close();
    }
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot: dbPath, // unused by classify
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false }) },
    });
    const r = await runners.classify("g-c");
    expect(r.resolved).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/goal/orchestrator-runners.test.ts`
Expected: FAIL — `createOrchestratorRunners` not found.

- [ ] **Step 3: Write the implementation**

```typescript
import { withManagedDb } from "../db/managed-connection.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { GoalRepository } from "./repository.js";
import { classifyFindingForGoal } from "./classification.js";
import { assertGoalCanStartMutation } from "./mutation-gate.js";
import type { OrchestratorRunners } from "./orchestrator-types.js";

export interface OrchestratorRunnerDeps {
  dbPath: string;
  harnessRoot: string;
  createdBy: string;
  coderRunner: CodexExecRunner;
  reviewerRunner: CodexExecRunner;
}

/**
 * Wire the high-level orchestrator runners to the real core operations. Each
 * mutating runner first asserts the goal gate (which is also where a missing
 * goal / wrong convergence is rejected), then performs the operation.
 *
 * NOTE: coder/review/closeAndPr load goal project/repo/domain from the session
 * and call runDomainCoding / runReviewerAgent+processReviewDecision /
 * createPullRequest respectively. Those operations require a configured
 * harness root (policies, runs dir) and are covered end-to-end by the
 * integration test in Task 7. The classify runner is pure DB + classification.
 */
export function createOrchestratorRunners(
  deps: OrchestratorRunnerDeps,
): OrchestratorRunners {
  return {
    coder: async (goalId) => {
      assertGoalGate(deps.dbPath, goalId, "run.start");
      // Wired in Task 7's integration harness via runDomainCoding(...).
      throw new Error("coder runner requires the integration wiring (Task 7)");
    },
    review: async (goalId) => {
      assertGoalGate(deps.dbPath, goalId, "review.auto");
      throw new Error("review runner requires the integration wiring (Task 7)");
    },
    classify: async (goalId) =>
      withManagedDb({ dbPath: deps.dbPath }, ({ db }) => {
        const repo = new GoalRepository(db);
        const session = repo.requireSession(goalId);
        const unknown = repo.listFindings({ goalId }).filter(
          (f) => f.scopeStatus === "unknown" && f.status === "open",
        );
        for (const finding of unknown) {
          const c = classifyFindingForGoal(session, finding);
          if (c.scopeStatus === "unknown") {
            return { resolved: false, escalateReason: `cannot classify finding ${finding.findingId}` };
          }
          repo.classifyFinding({ findingId: finding.findingId, scopeStatus: c.scopeStatus, reason: c.reason });
        }
        return { resolved: true };
      }),
    closeAndPr: async (goalId) => {
      assertGoalGate(deps.dbPath, goalId, "run.start");
      throw new Error("closeAndPr runner requires the integration wiring (Task 7)");
    },
  };

  function assertGoalGate(dbPath: string, goalId: string, kind: "run.start" | "review.auto"): void {
    withManagedDb({ dbPath }, ({ db }) => {
      assertGoalCanStartMutation({ repository: new GoalRepository(db), goalId, mutationKind: kind });
    });
  }
}
```

> **Implementer note:** `repo.listFindings(filter: GoalFindingFilter)` (repository.ts:893) and `repo.classifyFinding(input: ClassifyFindingInput)` (repository.ts:707) are the real methods. Confirm `GoalFindingFilter` accepts `{ goalId }` and the exact fields of `ClassifyFindingInput` / `GoalFinding` (`scopeStatus`, `status`, `findingId`) before writing — grep `ClassifyFindingInput` and `GoalFindingFilter` in repository.ts. The classify test asserts only the no-unknown-findings path, which calls neither.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/goal/orchestrator-runners.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/goal/orchestrator-runners.ts tests/unit/goal/orchestrator-runners.test.ts
git commit -m "feat(goal): orchestrator production runner factory (classify + gate)"
```

---

## Task 6: CLI `goal orchestrate` subcommand

**Files:**
- Modify: `src/cli/goal.ts` (add a `.command("orchestrate")` inside `registerGoalCommands`)
- Test: `tests/integration/goal-cli.test.ts` (add a `--dry-run` case)

`--dry-run` evaluates convergence (without recording — pass a read path) and prints the single action that would be taken. The full run wires `createOrchestratorRunners` with the real codex runner and calls `GoalOrchestrator.run`.

- [ ] **Step 1: Write the failing test**

```typescript
  it("orchestrate --dry-run prints the next action without running codex", () => {
    const { root } = setup(); // existing helper that inits HARNESS_ROOT + DB
    // create a goal via the CLI
    run(["goal", "start", "--title", "Dry", "--goal-id", "g-dry", "--domain", "src", "--created-by", "cli"], root);
    const r = run(["goal", "orchestrate", "g-dry", "--dry-run"], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/decision=/);
    expect(r.stdout).toMatch(/next-action=/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/goal-cli.test.ts -t "orchestrate"`
Expected: FAIL — unknown command `orchestrate`.

- [ ] **Step 3: Implement the subcommand**

Add inside `registerGoalCommands`, following the existing `status` subcommand pattern:

```typescript
  goalCmd
    .command("orchestrate")
    .description("drive a goal to a terminal state (run/review/rerun/close/pr)")
    .argument("<goal-id>", "goal id")
    .option("--max-steps <n>", "loop step cap", "50")
    .option("--dry-run", "print the next action only; do not execute", false)
    .action((goalId: string, raw: Record<string, unknown>) => {
      withGoalErrorExit(async () => {
        if (raw.dryRun === true) {
          const convergence = withGoalRepo(opts, ({ repo }) =>
            new ConvergenceService(repo).evaluate(goalId),
          );
          const action = decideOrchestratorAction(convergence);
          process.stdout.write(
            `goal=${goalId} decision=${convergence.decision} next-action=${action.kind}\n`,
          );
          return;
        }
        const result = await new GoalOrchestrator({ dbPath: goalDbPath(opts) }).run({
          goalId,
          runners: createOrchestratorRunners({
            dbPath: goalDbPath(opts),
            harnessRoot: opts.harnessRoot,
            createdBy: "cli",
            coderRunner: opts.codexRunner,
            reviewerRunner: opts.reviewerRunner,
          }),
          maxSteps: Number(raw.maxSteps ?? 50),
          createdBy: "cli",
        });
        process.stdout.write(
          `goal=${goalId} outcome=${result.outcome}${result.prUrl ? ` pr=${result.prUrl}` : ""}` +
            `${result.escalateReason ? ` escalate=${result.escalateReason}` : ""}\n`,
        );
      });
    });
```

> **Implementer note:** confirm how `registerGoalCommands` already obtains the DB path and a codex runner (grep `dbPath`, `codexRunner`, `withGoalRepo` in `src/cli/goal.ts`). Reuse those exact helpers (`goalDbPath`/`opts.codexRunner` are placeholders for whatever the file already uses). Import `ConvergenceService`, `decideOrchestratorAction`, `GoalOrchestrator`, `createOrchestratorRunners` at the top. `withGoalErrorExit` must support an async callback; if it does not, await the orchestration before the existing sync wrapper or add an async-aware variant.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/goal-cli.test.ts -t "orchestrate"`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/cli/goal.ts tests/integration/goal-cli.test.ts
git commit -m "feat(cli): goal orchestrate subcommand (+ --dry-run)"
```

---

## Task 7: End-to-end integration (real git + fake codex)

**Files:**
- Create: `tests/integration/goal-orchestrate.test.ts`
- Modify (if needed): `src/goal/orchestrator-runners.ts` to finish wiring `coder`/`review`/`closeAndPr` to `runDomainCoding` / `runReviewerAgent` + `processReviewDecision` / `createPullRequest`.

This proves the orchestrator drives real operations. Use a throwaway git repo and a fake codex bin (reuse the `writeFakeCodexBin` pattern from `tests/integration/cli-rerun.test.ts`) so no real codex/network is needed.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
// build a HARNESS_ROOT with a smoke target repo + minimal policy (reuse the
// setup helpers from cli-rerun.test.ts / workflow-fake-codex.test.ts), create a
// goal linked to the repo/domain, then:
//   const result = await new GoalOrchestrator({ dbPath }).run({ goalId, runners, maxSteps, createdBy });
// Assert that, starting from a goal whose only gap is one close check, the
// orchestrator runs the coder, the review records a cycle, and the goal reaches
// outcome=closed or pr_created with attempts recorded on the session.

describe("goal orchestrate (real git + fake codex)", () => {
  it("drives a goal session through coder -> review -> close", async () => {
    // ... see implementer note; assert result.outcome is terminal and that
    // GoalRepository shows recorded attempts/cycles for the goal.
    expect(true).toBe(true); // replace with real assertions
  });
});
```

> **Implementer note:** this is the one task that needs real wiring. Finish the `coder`/`review`/`closeAndPr` runners in `orchestrator-runners.ts`:
> - `coder`: load session (project/repo/domain), call `runDomainCoding({ harnessRoot, repoPath, repoId, domain, goal: <session goal + required_changes>, baseBranch, codexRunner: deps.coderRunner })`, then `repo.createAttempt(...)` / `repo.completeAttempt(...)` with the returned `runId`/`status`.
> - `review`: `runReviewerAgent({ runsDir, runId, dbPath, codexRunner: deps.reviewerRunner })` then `processReviewDecision({ runsDir, runId, locksDir, dbPath })`; record a review cycle via `startReviewCycle`/`completeReviewCycle`.
> - `closeAndPr`: `repo.updateStatus(goalId, "closed", ...)` (or the existing close path) then `createPullRequest({ runsDir, workspacesDir, locksDir, runId, base, draft: true, publisher })`.
> Replace the placeholder assertion with real checks. Keep the test self-contained (mkdtemp HARNESS_ROOT, fake codex bin, throwaway git repo) and delete it from `/tmp` is unnecessary (tmp dirs).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/goal-orchestrate.test.ts`
Expected: FAIL until the runners are wired and assertions are real.

- [ ] **Step 3: Wire the runners and make the test pass**

Implement per the note above. Run: `npx vitest run tests/integration/goal-orchestrate.test.ts`
Expected: PASS.

- [ ] **Step 4: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all pass (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/goal/orchestrator-runners.ts tests/integration/goal-orchestrate.test.ts
git commit -m "feat(goal): wire orchestrator runners; end-to-end orchestrate test"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** execution model (Task 6 CLI), aggressive autonomy through close+pr (Task 3 `close_and_pr` + Task 7 wiring), deterministic classification + escalate-on-unknown (Task 5 `classify`), review-rule-driven review (delegated to existing `processReviewDecision`/review rules invoked by the `review` runner, Task 7), bounds (goal budgets via ConvergenceService + `maxSteps` in Task 3), stateless/resumable (loop reads convergence from DB each step, Task 3), `--dry-run` (Task 6), error/escalate paths (Task 4).
- **Repository methods verified:** `listFindings(GoalFindingFilter)` (repository.ts:893) and `classifyFinding(ClassifyFindingInput)` (repository.ts:707) exist; `setFindingScope` does NOT (corrected to `classifyFinding`). **CLI helpers** (`withGoalRepo` / `withGoalErrorExit` — both confirmed in goal.ts; a DB path / codex runner from `RegisterGoalCommandsOptions` at goal.ts:47) are implementer-verify points: grep `RegisterGoalCommandsOptions` and confirm whether `withGoalErrorExit` accepts an async callback (Task 6 depends on it; add an async-aware path if not).
- **Type consistency:** `OrchestratorAction`, `OrchestrationResult`, `OrchestratorRunners` are defined once in Task 1 and used unchanged in Tasks 2–7.
