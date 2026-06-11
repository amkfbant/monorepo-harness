# SP-2 Course Orchestrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **コーディングは `codex exec -m gpt-5.5 -c model_reasoning_effort="high" -s workspace-write` に委譲する（TDD）。各タスク後に Opus サブエージェントでレビュー、大 Phase 最終で Fable-5 + codex。**

**Goal:** SP-1 の roadmap 層の上に、link 済み hitch を phase tree 順に駆動して phase status を機械的に advance する drive-only の bounded driver（CLI + MCP）を追加する。

**Architecture:** 純粋関数 dispatch（`decideCoursePhaseAction`）＋ stateless な `CourseOrchestrator`（lease / budget / CAS write / `HitchOrchestrator` DI）。判定の正本は既存 `ConvergenceService` / `allowedByConvergence` を再利用。migration ゼロ。PR / close / spawn は書かない。

**Tech Stack:** TypeScript, better-sqlite3, vitest, commander, 既存 `HitchOrchestrator` / `domain_locks` / MCP guarded-mutation framework。

**Branch:** `feat/course-orchestrate`（spec コミット済み `8825b4d`）。

**Test runner:** `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run <path>`。フルスイートは `--poolOptions.forks.maxForks=4 --poolOptions.forks.minForks=1`。commit 前に `npm run typecheck` 必須。

**安全境界（不可侵）:** policy 検証は事後 git diff／LLM 出力を状態遷移の根拠にしない／状態遷移は harness のみ（決定論）／MCP confirmation_required を shell で迂回しない／fail-closed。

---

## File Structure

| File | 責務 | 変更/新規 |
|---|---|---|
| `src/roadmap/phase-repository.ts` | `transitionStatus` CAS を追加 | 変更 |
| `src/roadmap/ready-to-close.ts` | 純粋関数 `derivePhaseReadiness` | 新規 |
| `src/roadmap/rollup.ts` | `PhaseRollup.readyToClose` を派生 | 変更 |
| `src/roadmap/types.ts` | （rollup 型は rollup.ts 内。変更なし想定） | — |
| `src/roadmap/orchestrator-types.ts` | SP-2 の型（action/outcome/result/stopReason） | 新規 |
| `src/roadmap/orchestrate-dispatch.ts` | 純粋関数 `decideCoursePhaseAction` | 新規 |
| `src/roadmap/course-orchestrator.ts` | `CourseOrchestrator`（実行/lease/budget/CAS） | 新規 |
| `src/cli/course.ts` | `course orchestrate` subcommand | 変更 |
| `src/mcp/tools/course-tools.ts` | `courseOrchestrateTool`（guarded mutation） | 変更 |
| `src/mcp/registry/tool-registry.ts` | `harness.course.orchestrate` 登録 | 変更 |
| `docs/specs/roadmap.md` / `cli.md` / `mcp.md`, `CLAUDE.md` | spec 更新・旧 SP-2 spawn 文言の修正 | 変更 |

ビルド順は依存順（下から上へ積む）: Task 1（CAS）→ 2（readyToClose）→ 3（dispatch 純関数）→ 4（orchestrator）→ 5（CLI）→ 6（MCP）→ 7（docs）。

---

## Task 1: PhaseRepository.transitionStatus（CAS 遷移）

**Files:**
- Modify: `src/roadmap/phase-repository.ts`（`setStatus` の直後、Line 82-87 付近に追加）
- Test: `tests/unit/roadmap/repository.test.ts`（既存 `describe("Course/Phase repositories (SP-1)")` 内）

**背景:** 現 `setStatus(phaseId, status, now?)` は `UPDATE phases SET status=?, updated_at=? WHERE phase_id=?` の blind UPDATE。driver の `pending→in_progress` が operator の `blocked` を後勝ちで上書きしうる。`transitionStatus` は現在値を `IN (...)` 条件に入れた CAS で、遷移できたか bool を返す。

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/roadmap/repository.test.ts` の `describe("Course/Phase repositories (SP-1)")` 内に追加:

```typescript
it("transitionStatus performs CAS: succeeds only from an allowed prior status", () => {
  const c = courses.create({ title: "C", projectId: "demo", createdBy: "t", createdSource: "cli" });
  const p = phases.add({ courseId: c.courseId, title: "P", createdBy: "t", createdSource: "cli" });

  // pending -> in_progress allowed
  expect(phases.transitionStatus(p.phaseId, ["pending"], "in_progress")).toBe(true);
  expect(phases.require(p.phaseId).status).toBe("in_progress");

  // a second pending->in_progress is a no-op (current status is in_progress, not in the from-set)
  expect(phases.transitionStatus(p.phaseId, ["pending"], "in_progress")).toBe(false);
  expect(phases.require(p.phaseId).status).toBe("in_progress");

  // operator blocks it; driver's pending->in_progress must NOT override (current=blocked)
  phases.setStatus(p.phaseId, "blocked");
  expect(phases.transitionStatus(p.phaseId, ["pending"], "in_progress")).toBe(false);
  expect(phases.require(p.phaseId).status).toBe("blocked");
});

it("transitionStatus returns false for an unknown phase (no throw)", () => {
  expect(phases.transitionStatus("phase-does-not-exist", ["pending"], "in_progress")).toBe(false);
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/roadmap/repository.test.ts -t "transitionStatus"`
Expected: FAIL（`phases.transitionStatus is not a function`）

- [ ] **Step 3: transitionStatus を実装**

`src/roadmap/phase-repository.ts` の `setStatus`（Line 82-87）の直後に追加。`PhaseStatus` は既に import 済み。

```typescript
  /**
   * CAS 遷移: 現在 status が `from` のいずれかのときのみ `to` に更新する。
   * 遷移できたら true、現在値が `from` 外（または phase 不在）なら false（no-op）。
   * driver の自動 write が operator の宣言（blocked/closed）を後勝ちで上書きしない
   * ようにするための lost-update 防止。
   */
  transitionStatus(phaseId: string, from: PhaseStatus[], to: PhaseStatus, now?: string): boolean {
    if (from.length === 0) return false;
    const placeholders = from.map(() => "?").join(", ");
    const ts = now ?? new Date().toISOString();
    const info = this.db
      .prepare(
        `UPDATE phases SET status = ?, updated_at = ?
          WHERE phase_id = ? AND status IN (${placeholders})`,
      )
      .run(to, ts, phaseId, ...from);
    return info.changes > 0;
  }
```

- [ ] **Step 4: テスト成功を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/roadmap/repository.test.ts`
Expected: PASS（全テスト）

- [ ] **Step 5: typecheck & commit**

```bash
npm run typecheck
git add src/roadmap/phase-repository.ts tests/unit/roadmap/repository.test.ts
git commit -m "feat: PhaseRepository.transitionStatus CAS guard (SP-2)"
```

---

## Task 2: rollup.ts に派生 readyToClose を追加

**Files:**
- Create: `src/roadmap/ready-to-close.ts`
- Modify: `src/roadmap/rollup.ts`（`PhaseRollup` 型 Line 6-15、rollupCourse Line 69-131）
- Test: `tests/unit/roadmap/ready-to-close.test.ts`（新規）, `tests/unit/roadmap/rollup.test.ts`（既存に追加）

**背景:** `readyToClose` は stored status にせず live `ConvergenceService.evaluate`（read-only）から導出。純粋判定を `ready-to-close.ts` に分離し、rollup.ts が wiring する。

- [ ] **Step 1: derivePhaseReadiness の失敗テストを書く**

`tests/unit/roadmap/ready-to-close.test.ts`（新規）:

```typescript
import { describe, it, expect } from "vitest";
import { derivePhaseReadiness } from "../../../src/roadmap/ready-to-close.js";
import type { HitchConvergenceResult } from "../../../src/hitch/types.js";

function conv(decision: HitchConvergenceResult["decision"]): HitchConvergenceResult {
  return {
    hitchId: "h",
    decision,
    reason: "",
    metrics: {
      openInScopeP0: 0, openInScopeP1: 0, openInScopeP2: 0, openUnknownScope: 0,
      openOutOfScope: 0, totalNewFindings: 0, newFindingsThisCycle: 0,
      reviewCyclesUsed: 0, iterationsUsed: 0, rerunsUsed: 0,
      closeConditionsPassed: 0, closeConditionsFailed: 0, closeConditionsPending: 0,
      maxReopenCount: 0,
    },
    recommendedNextAction: { kind: "close_hitch", message: "" },
  };
}

describe("derivePhaseReadiness", () => {
  it("false when the phase has no hitches", () => {
    expect(derivePhaseReadiness({ hitchConvergences: [], derivedOpenP0: 0, derivedOpenP1: 0 })).toBe(false);
  });
  it("true when all hitches are close_ready/closed and 0 open P0/P1", () => {
    expect(derivePhaseReadiness({
      hitchConvergences: [conv("close_ready"), conv("closed")], derivedOpenP0: 0, derivedOpenP1: 0,
    })).toBe(true);
  });
  it("false when any hitch is not close_ready/closed", () => {
    expect(derivePhaseReadiness({
      hitchConvergences: [conv("close_ready"), conv("needs_fix")], derivedOpenP0: 0, derivedOpenP1: 0,
    })).toBe(false);
  });
  it("false when there are open in-scope P0/P1 (defense-in-depth)", () => {
    expect(derivePhaseReadiness({
      hitchConvergences: [conv("close_ready")], derivedOpenP0: 1, derivedOpenP1: 0,
    })).toBe(false);
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/roadmap/ready-to-close.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: derivePhaseReadiness を実装**

`src/roadmap/ready-to-close.ts`（新規）:

```typescript
import type { HitchConvergenceResult } from "../hitch/types.js";

/**
 * phase が "ready-to-close" かを live convergence から純粋に判定する（stored しない）。
 * 全 linked hitch が close_ready/closed、かつ独立 SQL 集計の derived open in-scope
 * P0/P1 がゼロ、かつ hitch が 1 つ以上。derived P0/P1 の再チェックは close_ready が
 * 既に内包するため論理冗長だが、独立集計による defense-in-depth として保持する。
 */
export function derivePhaseReadiness(input: {
  hitchConvergences: HitchConvergenceResult[];
  derivedOpenP0: number;
  derivedOpenP1: number;
}): boolean {
  if (input.hitchConvergences.length === 0) return false;
  const allReady = input.hitchConvergences.every(
    (c) => c.decision === "close_ready" || c.decision === "closed",
  );
  return allReady && input.derivedOpenP0 === 0 && input.derivedOpenP1 === 0;
}
```

- [ ] **Step 4: derivePhaseReadiness テスト成功を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/roadmap/ready-to-close.test.ts`
Expected: PASS

- [ ] **Step 5: PhaseRollup に readyToClose を足す失敗テストを書く**

`tests/unit/roadmap/rollup.test.ts` に追加（既存 setup を流用。1 phase + close_ready hitch を seed する形は既存テストにならう）:

```typescript
it("rollup marks a phase readyToClose when its only hitch is close_ready with 0 open P0/P1", () => {
  // 既存テストの seed パターンを流用: course + phase + linked hitch をつくり、
  // hitch を close-ready 状態（open in-scope P0/P1 ゼロ・close conditions 充足）にする。
  // 期待: rollupCourse(...).phases[0].readyToClose === true
  // （seed の詳細は同ファイル先頭の "declared closed cannot hide open P1" テストを参照）
});
```

> 実装者へ: 既存 `tests/unit/roadmap/rollup.test.ts` の hitch seed ヘルパ（findings / convergence 状態を作る箇所）をそのまま使い、close_ready になる seed と、needs_fix が残る seed の 2 ケースで `readyToClose` の true/false を assert すること。

- [ ] **Step 6: rollup.ts に readyToClose を wiring**

`src/roadmap/rollup.ts`:
1. `PhaseRollup` 型（Line 6-15）に `readyToClose: boolean;` を追加。
2. rollupCourse 内で各 phase の `hitchIds` について `ConvergenceService`（`new ConvergenceService(new HitchRepository(db))`）で `evaluate(hitchId)` し、`derivePhaseReadiness({ hitchConvergences, derivedOpenP0, derivedOpenP1 })` を計算して各 `PhaseRollup` に載せる。
3. import 追加: `import { ConvergenceService } from "../hitch/convergence.js";` `import { HitchRepository } from "../hitch/repository.js";` `import { derivePhaseReadiness } from "./ready-to-close.js";`

> evaluate は read-only（DB 書き込みなし）なので rollup の deterministic / read-only 性は保たれる。

- [ ] **Step 7: 全 roadmap テスト成功を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/roadmap`
Expected: PASS（既存 rollup テストの戻り型に `readyToClose` が増えても他 assert は不変）

- [ ] **Step 8: typecheck & commit**

```bash
npm run typecheck
git add src/roadmap/ready-to-close.ts src/roadmap/rollup.ts tests/unit/roadmap/ready-to-close.test.ts tests/unit/roadmap/rollup.test.ts
git commit -m "feat: PhaseRollup.readyToClose derived from live convergence (SP-2)"
```

---

## Task 3: orchestrator-types + 純粋関数 decideCoursePhaseAction

**Files:**
- Create: `src/roadmap/orchestrator-types.ts`
- Create: `src/roadmap/orchestrate-dispatch.ts`
- Test: `tests/unit/roadmap/orchestrate-dispatch.test.ts`（新規）

**背景:** per-phase の決定論判定を DB 非依存の純関数に切り出す。drivability は `allowedByConvergence("hitch.orchestrate", convergence)` を再利用（独自述語を作らない）。

- [ ] **Step 1: 型を定義**

`src/roadmap/orchestrator-types.ts`（新規）:

```typescript
import type { OrchestrationOutcome } from "../hitch/orchestrator-types.js";
import type { CourseRollup } from "./rollup.js";

export type CoursePhaseActionKind =
  | "skip_closed"
  | "skip_blocked"
  | "container"
  | "needs_link"
  | "drive"
  | "blocked_hitch"
  | "ready_to_close"
  | "report_only";

export type CoursePhaseAction =
  | { kind: "skip_closed" }
  | { kind: "skip_blocked" }
  | { kind: "container" }
  | { kind: "needs_link" }
  | { kind: "drive"; hitchIds: string[] }
  | { kind: "blocked_hitch"; hitchId: string; decision: string }
  | { kind: "ready_to_close" }
  | { kind: "report_only" };

export type CourseStopReason = "completed" | "budget_exhausted";

export interface DrivenHitch {
  hitchId: string;
  outcome: OrchestrationOutcome;
  stepCount: number;
}

export interface PhaseOutcome {
  phaseId: string;
  action: CoursePhaseActionKind;
  drivenHitches?: DrivenHitch[];
  blockedHitch?: { hitchId: string; decision: string };
  readyToClose?: boolean;
  note?: string;
}

export interface CourseOrchestrationResult {
  courseId: string;
  stopReason: CourseStopReason;
  phaseOutcomes: PhaseOutcome[];
  drivenHitches: DrivenHitch[];
  rollupAfter: CourseRollup;
  followUps: string[];
}
```

- [ ] **Step 2: dispatch の失敗テストを書く**

`tests/unit/roadmap/orchestrate-dispatch.test.ts`（新規）:

```typescript
import { describe, it, expect } from "vitest";
import { decideCoursePhaseAction } from "../../../src/roadmap/orchestrate-dispatch.js";
import type { HitchConvergenceResult } from "../../../src/hitch/types.js";

function conv(hitchId: string, decision: HitchConvergenceResult["decision"], action: HitchConvergenceResult["recommendedNextAction"]["kind"] = "run_close_check"): HitchConvergenceResult {
  return {
    hitchId, decision, reason: "",
    metrics: {
      openInScopeP0: 0, openInScopeP1: 0, openInScopeP2: 0, openUnknownScope: 0,
      openOutOfScope: 0, totalNewFindings: 0, newFindingsThisCycle: 0,
      reviewCyclesUsed: 0, iterationsUsed: 0, rerunsUsed: 0,
      closeConditionsPassed: 0, closeConditionsFailed: 0, closeConditionsPending: 0,
      maxReopenCount: 0,
    },
    recommendedNextAction: { kind: action, message: "" },
  };
}

describe("decideCoursePhaseAction", () => {
  it("skip_closed for a declared-closed phase", () => {
    expect(decideCoursePhaseAction({ declaredStatus: "closed", isLeaf: true, hitches: [], derivedOpenP0: 0, derivedOpenP1: 0 }).kind).toBe("skip_closed");
  });
  it("skip_blocked for a declared-blocked phase", () => {
    expect(decideCoursePhaseAction({ declaredStatus: "blocked", isLeaf: true, hitches: [], derivedOpenP0: 0, derivedOpenP1: 0 }).kind).toBe("skip_blocked");
  });
  it("container for a non-leaf phase with no hitches", () => {
    expect(decideCoursePhaseAction({ declaredStatus: "pending", isLeaf: false, hitches: [], derivedOpenP0: 0, derivedOpenP1: 0 }).kind).toBe("container");
  });
  it("needs_link for a leaf actionable phase with no hitches", () => {
    expect(decideCoursePhaseAction({ declaredStatus: "pending", isLeaf: true, hitches: [], derivedOpenP0: 0, derivedOpenP1: 0 }).kind).toBe("needs_link");
  });
  it("blocked_hitch when any linked hitch is escalate/diverging/budget_exhausted/needs_classification", () => {
    const r = decideCoursePhaseAction({ declaredStatus: "in_progress", isLeaf: true, hitches: [conv("h1", "escalate", "ask_human")], derivedOpenP0: 0, derivedOpenP1: 0 });
    expect(r.kind).toBe("blocked_hitch");
    if (r.kind === "blocked_hitch") { expect(r.hitchId).toBe("h1"); expect(r.decision).toBe("escalate"); }
  });
  it("drive when a hitch is drivable per allowedByConvergence (needs_fix + fix_findings)", () => {
    const r = decideCoursePhaseAction({ declaredStatus: "pending", isLeaf: true, hitches: [conv("h1", "needs_fix", "fix_findings")], derivedOpenP0: 1, derivedOpenP1: 0 });
    expect(r.kind).toBe("drive");
    if (r.kind === "drive") expect(r.hitchIds).toEqual(["h1"]);
  });
  it("ready_to_close when all hitches are close_ready and 0 open P0/P1", () => {
    expect(decideCoursePhaseAction({ declaredStatus: "in_progress", isLeaf: true, hitches: [conv("h1", "close_ready", "close_hitch")], derivedOpenP0: 0, derivedOpenP1: 0 }).kind).toBe("ready_to_close");
  });
  it("blocked_hitch takes precedence over drive when both present", () => {
    const r = decideCoursePhaseAction({ declaredStatus: "in_progress", isLeaf: true, hitches: [conv("h1", "needs_fix", "fix_findings"), conv("h2", "diverging", "ask_human")], derivedOpenP0: 1, derivedOpenP1: 0 });
    expect(r.kind).toBe("blocked_hitch");
  });
  it("report_only when a hitch is neither drivable nor ready (e.g. defer)", () => {
    expect(decideCoursePhaseAction({ declaredStatus: "in_progress", isLeaf: true, hitches: [conv("h1", "continue", "defer_followups")], derivedOpenP0: 0, derivedOpenP1: 0 }).kind).toBe("report_only");
  });
});
```

- [ ] **Step 3: テスト失敗を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/roadmap/orchestrate-dispatch.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 4: decideCoursePhaseAction を実装**

`src/roadmap/orchestrate-dispatch.ts`（新規）。drivability は `allowedByConvergence` を import して再利用。

```typescript
import type { HitchConvergenceResult } from "../hitch/types.js";
import type { PhaseStatus } from "./types.js";
import { allowedByConvergence } from "../hitch/mutation-gate.js";
import type { CoursePhaseAction } from "./orchestrator-types.js";

const BLOCKED_DECISIONS = new Set([
  "escalate", "diverging", "budget_exhausted", "needs_classification",
]);

export interface CoursePhaseDispatchInput {
  declaredStatus: PhaseStatus;
  isLeaf: boolean;
  hitches: { hitchId: string; convergence: HitchConvergenceResult }[];
  derivedOpenP0: number;
  derivedOpenP1: number;
}

/**
 * per-phase 決定論判定。入力は phase の宣言状態と各 linked hitch の live convergence
 * のみ（LLM 出力を入力にしない）。drivability の正本は allowedByConvergence。
 */
export function decideCoursePhaseAction(input: CoursePhaseDispatchInput): CoursePhaseAction {
  if (input.declaredStatus === "closed") return { kind: "skip_closed" };
  if (input.declaredStatus === "blocked") return { kind: "skip_blocked" };

  if (input.hitches.length === 0) {
    return input.isLeaf ? { kind: "needs_link" } : { kind: "container" };
  }

  // blocked_hitch が最優先（subtree 隔離のトリガ）
  for (const h of input.hitches) {
    if (BLOCKED_DECISIONS.has(h.convergence.decision)) {
      return { kind: "blocked_hitch", hitchId: h.hitchId, decision: h.convergence.decision };
    }
  }

  const drivable = input.hitches.filter((h) =>
    allowedByConvergence("hitch.orchestrate", h.convergence),
  );
  if (drivable.length > 0) {
    return { kind: "drive", hitchIds: drivable.map((h) => h.hitchId) };
  }

  const allReady = input.hitches.every(
    (h) => h.convergence.decision === "close_ready" || h.convergence.decision === "closed",
  );
  if (allReady && input.derivedOpenP0 === 0 && input.derivedOpenP1 === 0) {
    return { kind: "ready_to_close" };
  }

  return { kind: "report_only" };
}
```

- [ ] **Step 5: テスト成功を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/roadmap/orchestrate-dispatch.test.ts`
Expected: PASS

> もし `allowedByConvergence("hitch.orchestrate", conv("h1","needs_fix","fix_findings"))` が false を返してテストが落ちる場合、実コード `src/hitch/mutation-gate.ts:85-112` の許可条件（needs_fix + fix_findings|run_close_check、continue + run_close_check）に合わせて conv ヘルパの `action` 値をテスト側で調整する（実装ではなくテスト fixture を実挙動に合わせる）。

- [ ] **Step 6: typecheck & commit**

```bash
npm run typecheck
git add src/roadmap/orchestrator-types.ts src/roadmap/orchestrate-dispatch.ts tests/unit/roadmap/orchestrate-dispatch.test.ts
git commit -m "feat: deterministic course phase dispatch (SP-2)"
```

---

## Task 4: CourseOrchestrator（実行ループ・lease・budget・CAS・DI）

**Files:**
- Create: `src/roadmap/course-orchestrator.ts`
- Test: `tests/integration/course-orchestrator.test.ts`（新規）

**背景:** stateless な driver。tree pre-order walk、top-level subtree 単位で escalation を隔離、phase write は CAS、budget は course 単位、course-pass lease は `domain_locks` 再利用。hitch 駆動は `HitchOrchestrator` に DI（runners は注入＝テストで fake 可能）。

**設計詳細（実装者が守る不変条件）:**
- constructor: `new CourseOrchestrator({ db, makeHitchOrchestrator, makeRunners })` の形で DI。`makeHitchOrchestrator(hitchId) => HitchOrchestrator` と `makeRunners(hitchId) => OrchestratorRunners`（publisher なし）をテストで差し替える。本番 wiring は Task 5/6 が供給する。
- `run({ courseId, maxDrivenHitches, maxStepsPerHitch, createdBy }): Promise<CourseOrchestrationResult>`。
- 手順（spec「実行ループ」を厳守）:
  1. `courses.require(courseId)`、`status !== "active"` → `throw new CourseCliError("course ${courseId} is not active (...)")`（CLI/MCP が refuse に変換）。
  2. course-pass lease: `acquireDomainLock(db, { domainKey: "course:"+courseId, repoId: ..., domain: "course-orchestrate", runId, pid: process.pid, hostname })`。`DomainLockBusyError` は捕捉して refuse 用エラーに変換し再 throw。
  3. `rollupCourse({ db, courseId })`（tree 不整合 throw は素通しで abort）。
  4. tree pre-order（`rollupAfter.phases` の順 = pre-order）で各 phase を処理。top-level subtree（depth 0 ノードとその子孫）単位で隔離フラグを管理。
  5. 各 phase: linked hitch ごとに `new ConvergenceService(new HitchRepository(db)).evaluate(hitchId)` → `decideCoursePhaseAction(...)`。
  6. `drive` のとき: `transitionStatus(phaseId, ["pending"], "in_progress")`（戻り値は問わない＝既に in_progress でも続行）。対象 hitch を順に駆動。各 drive 前に `drivenHitches.length >= maxDrivenHitches` なら `stopReason="budget_exhausted"` で残りを `not_driven` 記録し return。各 drive 前に phase declared status を再読し blocked/closed なら残り中止。
  7. drive 結果 outcome が `"escalated"` → その phase を `blocked_hitch` outcome 化、**当該 top-level subtree の残り phase を skip（`blocked_subtree` note）**、次の top-level subtree へ。
  8. lease は finally で必ず release。driver 例外（rollup throw 等）は再 throw（fail-closed）。
  9. 最後に `rollupCourse` を再取得して `rollupAfter` に入れ、`followUps` を組む（ready_to_close phase の hitch を `hitch orchestrate <id> --repo ...` の文字列、needs_link phase の一覧）。

> repoId / runId は lease に必要。runId は `course-orch-${randomUUID()}` を生成。repoId は course の repo_id（無ければ projectId、両方 null なら lease の domainKey は courseId のみで足りるので `repoId: courseId` を渡してよい＝lease は domainKey で一意になる）。

- [ ] **Step 1: 失敗する integration テストを書く（fake runners）**

`tests/integration/course-orchestrator.test.ts`（新規）。`tests/unit/hitch/orchestrator.test.ts` の `fakeRunners` と `tests/unit/roadmap/rollup.test.ts` の seed を参考に、以下のシナリオを TDD で:

```typescript
// 骨子（実装者が seed ヘルパを補完する）:
// 1. paused course を作り run() が refuse（throw / not active）すること
// 2. lease busy: 先に acquireDomainLock("course:"+id) してから run() が refuse すること
// 3. 2 つの top-level subtree。subtree A の hitch を escalate にし、A は隔離、
//    subtree B の drivable hitch は driven されること（B の outcome に driven 記録）
// 4. budget: maxDrivenHitches=1 で 2 つ drivable phase があるとき、1 つ driven /
//    残りは not_driven、stopReason="budget_exhausted"
// 5. 冪等: in_progress の phase を持つ course を再 run しても CAS が no-op で
//    二重 in_progress 化せず、close_ready hitch は driven されない（mutation gate が deny）
```

> 実装者へ: fake `makeRunners` は `coder/review/classify/defer/closeAndPr` を返すスタブ。hitch を「escalate」状態にするには finding/attempts を seed して `ConvergenceService.evaluate` が escalate を返すようにするか、`makeHitchOrchestrator` 自体を fake にして `run()` が `{ outcome: "escalated", ... }` を返すようにしてよい（後者の方が integration の境界として軽い）。dispatch の網羅は Task 3 で済んでいるので、ここでは **subtree 隔離 / budget / lease / CAS 冪等 / not-active refuse** の orchestrator 制御フローに集中する。

- [ ] **Step 2: テスト失敗を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/integration/course-orchestrator.test.ts`
Expected: FAIL（module not found）

- [ ] **Step 3: CourseOrchestrator を実装**

`src/roadmap/course-orchestrator.ts`（新規）。上記「設計詳細」の不変条件を満たす。型は Task 3 の `orchestrator-types.ts`、CAS は Task 1、readyToClose は Task 2 を使う。lease は `src/workspace/db-domain-lock.ts` の `acquireDomainLock` / `DomainLockBusyError`。`CourseCliError` は `src/cli/course.ts`（または既存のエラー型）から re-use できなければ `src/roadmap/` 内に専用エラー `CourseOrchestrateError` を定義して CLI/MCP で分類する。

> 実装者へ: hitch 駆動部は **DI（`makeHitchOrchestrator` / `makeRunners`）越しにのみ**呼ぶ。`CourseOrchestrator` 自身は codex / gh / publisher を import しない（テスト可能性と「PR を開かない」を構造で保証）。本番 runner の構築は Task 5（CLI）/ Task 6（MCP）が注入する。

- [ ] **Step 4: テスト成功を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/integration/course-orchestrator.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck & commit**

```bash
npm run typecheck
git add src/roadmap/course-orchestrator.ts tests/integration/course-orchestrator.test.ts
git commit -m "feat: CourseOrchestrator drive-only bounded driver (SP-2)"
```

---

## Task 5: CLI `course orchestrate`

**Files:**
- Modify: `src/cli/course.ts`（`registerCourseCommands` 内、`course` グループに subcommand 追加）
- Test: `tests/integration/course-cli.test.ts`（既存に追加）

**背景:** CLI surface。`--dry-run` は dispatch のみ（write/lease/drive なし）。本番 runner（codex）を `makeHitchOrchestrator`/`makeRunners` で注入。per-pass で operation row を記録。

**実装詳細:**
- subcommand: `course orchestrate <course-id> [--max-driven-hitches <n>] [--max-steps-per-hitch <n>] [--dry-run] [--json]`。
- default: maxDrivenHitches=3（clamp ≤10）、maxStepsPerHitch=20（clamp ≤50）。
- 本番 runner 構築は既存 `src/cli/hitch.ts` の `hitch orchestrate` の runner 構築（`createCodexCliRunner` + `createOrchestratorRunners`、**publisher は渡さない**＝stopAtCloseReady で PR を開かない）を参照して `makeRunners(hitchId)` を作る。per-hitch repo 解決は `prepareProjectRun({ harnessRoot, projectId, domain })`。
- `--dry-run`: lease/write/drive せず、各 phase の `decideCoursePhaseAction` 結果だけを表示。
- exit code: 0=completed、1=user-fixable（not active / lease busy / budget_exhausted）、2=driver 例外。`courseError` を拡張して `CourseOrchestrateError`（not active / lease busy）を exit 1 に分類。
- pass 単位で `startOperation`/`succeedOperation`/`failOperation`（`src/db/repositories/operations.js`、`operationType: "course.orchestrate"`）を `orchestrator-runners.ts:596-622` のパターンで記録。

- [ ] **Step 1: 失敗する CLI テストを書く**

`tests/integration/course-cli.test.ts` に追加（既存 helper `runCli` / `setup` を流用）:

```typescript
it("course orchestrate --dry-run prints phase actions without side effects", () => {
  const { root } = setup();
  // seed: course(active) + leaf phase(pending, no hitch)
  // ... 既存 seed パターンで course/phase を作る ...
  const result = runCli(root, ["course", "orchestrate", "<course-id>", "--dry-run", "--json"]);
  expect(result.code).toBe(0);
  // dry-run なので phase status は pending のまま（write されていない）
});

it("course orchestrate on a non-active course exits 1", () => {
  const { root } = setup();
  // seed: course を paused にする
  const result = runCli(root, ["course", "orchestrate", "<paused-course-id>"]);
  expect(result.code).toBe(1);
  expect(result.out).toMatch(/not active/i);
});
```

> 実装者へ: `<course-id>` 等は seed して得た実 id に置換。dry-run の無副作用は「実行後に `phase show` で status が pending のまま」を assert して確認。codex を実際に呼ぶ drive パスは CLI テストでは回さない（fake は orchestrator 層テストで担保済み）。dry-run と refuse 系のみ CLI で検証する。

- [ ] **Step 2: テスト失敗を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/integration/course-cli.test.ts -t "orchestrate"`
Expected: FAIL（unknown command）

- [ ] **Step 3: subcommand を実装**

`src/cli/course.ts` の `registerCourseCommands` 内、`course` グループに `orchestrate` を追加。`--dry-run` は `CourseOrchestrator` を使わず（または dryRun フラグを渡して）dispatch のみ実行。drive パスは本番 runner を注入。

- [ ] **Step 4: テスト成功を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/integration/course-cli.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck & commit**

```bash
npm run typecheck
git add src/cli/course.ts tests/integration/course-cli.test.ts
git commit -m "feat: harness course orchestrate CLI (SP-2)"
```

---

## Task 6: MCP `harness.course.orchestrate`

**Files:**
- Modify: `src/mcp/tools/course-tools.ts`（`courseOrchestrateTool` を追加）
- Modify: `src/mcp/registry/tool-registry.ts`（登録）
- Test: `tests/unit/mcp/course-tools.test.ts`（既存に追加）

**背景:** guarded mutation。`stopAtCloseReady` 強制（PR を開かない）。project-visibility ゲート、clamp、idempotency、mutation budget は既存 framework（`runMcpOperation` / `runMcpMutationOperation`）に乗る。

**実装詳細:**
- `courseOrchestrateTool(args, context)`: `args = { courseId, maxDrivenHitches?, maxStepsPerHitch?, idempotencyKey, actorNote? }`。
- 先に course の project を解決して `ensureProjectVisible(context.config, course.projectId)`（既存 `courseGetTool` パターン。不可視なら permission_denied）。
- clamp: maxDrivenHitches ∈ [1,10] default 3、maxStepsPerHitch ∈ [1,50] default 20（`mutation-tools.ts:465-469` の clamp ロジックにならう）。
- `runMcpOperation`（**not** runMcpMutationOperation — orchestrate は hitch 版同様に per-hitch gate と repo 解決が要る）を `operationType: "course.orchestrate"`, `target: { type: "course", id: courseId }` で。`workWithDb` 内で `CourseOrchestrator` を本番 runner DI（publisher なし、stopAtCloseReady）で構築し run。per-hitch の `assertHitchCanStartMutation(..., "hitch.orchestrate")` は CourseOrchestrator の drive 直前で担保（dispatch 述語と同一）。
- registry: `define({ name: "harness.course.orchestrate", kind: "mutation", operation: "course.orchestrate", argsSchema: z.object({ courseId: z.string().min(1), maxDrivenHitches: z.number().int().min(1).optional(), maxStepsPerHitch: z.number().int().min(1).optional() }).merge(MutationArgsBaseSchema).strict(), resolveProjectIdForPermission: resolveCourseProjectId, handler: courseOrchestrateTool, inputSchema: ... })`。
- `confirmation_required` 不要（PR/close を書かない）。

- [ ] **Step 1: 失敗する MCP テストを書く**

`tests/unit/mcp/course-tools.test.ts` に追加（既存 `server`/`callTool`/`mutationConfig` を流用）:

```typescript
it("registers harness.course.orchestrate in tools/list", async () => {
  const s = server(freshRoot(), DEFAULT_MCP_CONFIG);
  const names = await listTools(s);
  expect(names).toContain("harness.course.orchestrate");
});

it("course.orchestrate is denied by default permissions (not allowlisted)", async () => {
  const root = freshRoot();
  // seed active course
  const s = server(root, mutationConfig([])); // no allowedOperations
  const result = await callTool(s, "harness.course.orchestrate", {
    courseId: "<course-id>", idempotencyKey: "orch-denied",
  });
  expect(result.status).toBe("permission_denied");
});

it("course.orchestrate returns permission_denied for a restricted client on a different-project course", async () => {
  // seed a course in project "other"; client allowedProjects ["demo"] + allowedOperations ["course.orchestrate"]
  // expect permission_denied (visibility gate before any drive)
});
```

> 実装者へ: drive が実 codex を呼ぶ完全成功パスは MCP unit では回さない（registration / deny-by-default / visibility / clamp / idempotency replay に集中。drive 制御は Task 4 の fake で担保済み）。clamp は「maxStepsPerHitch=999 を渡しても内部で 50 に丸まる」ことを、operation result か audit input で確認する形にする。

- [ ] **Step 2: テスト失敗を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/mcp/course-tools.test.ts -t "orchestrate"`
Expected: FAIL

- [ ] **Step 3: courseOrchestrateTool + 登録を実装**

`src/mcp/tools/course-tools.ts` に `courseOrchestrateTool`、`src/mcp/registry/tool-registry.ts` に登録。本番 runner DI は Task 5 と共通化できるならヘルパに切り出す（`src/roadmap/` or `src/mcp/` 内）。

- [ ] **Step 4: テスト成功を確認**

Run: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run tests/unit/mcp/course-tools.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck & commit**

```bash
npm run typecheck
git add src/mcp/tools/course-tools.ts src/mcp/registry/tool-registry.ts tests/unit/mcp/course-tools.test.ts
git commit -m "feat: harness.course.orchestrate MCP guarded mutation (SP-2)"
```

---

## Task 7: docs（spec 駆動）

**Files:**
- Modify: `docs/specs/roadmap.md`（SP-2 orchestrate 節を追加。**旧 SP-2「phase → hitch spawn」を含む文言を、drive-only + spawn は後続増分、に修正**）
- Modify: `docs/specs/cli.md`（`harness course orchestrate` subcommand）
- Modify: `docs/specs/mcp.md`（`harness.course.orchestrate` tool）
- Modify: `CLAUDE.md`（必要ならポインタ）
- Modify: `docs/future-features.md`（auto-spawn / --open-prs / 並列 drive / durable course_orchestration_runs / phase 間依存 を out-of-scope として記録）

- [ ] **Step 1: roadmap.md に orchestrate 節を追加**

drive-only の 1 pass・dispatch・停止条件（subtree 隔離 / hard stop は driver 例外・budget・not-active）・budget（course 単位 maxDrivenHitches 3/clamp10 × maxStepsPerHitch 20/clamp50）・readyToClose 派生・PR/close を書かない・lease（domain_locks 再利用）・migration ゼロ・安全境界マッピングを現状仕様として記述（TODO を書かない）。**旧 SP-2 の spawn 前提の一文を修正。**

- [ ] **Step 2: cli.md / mcp.md を更新**

`harness course orchestrate <id> [--max-driven-hitches] [--max-steps-per-hitch] [--dry-run] [--json]` と exit code、`harness.course.orchestrate`（args / clamp / guarded / visibility / confirmation 不要）を追記。

- [ ] **Step 3: future-features.md に out-of-scope を記録**

auto-spawn（needs_link が接合点）/ course レベル PR 自動化 `--open-prs` / phase auto-close / 並列 drive / `course_orchestration_runs` durable テーブル / phase 間依存エッジ。

- [ ] **Step 4: フルスイート + typecheck（大 Phase ゲート）**

```bash
npm run typecheck
HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 npx vitest run --poolOptions.forks.maxForks=4 --poolOptions.forks.minForks=1
```
Expected: 全 PASS（回帰なし）

- [ ] **Step 5: commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: SP-2 course orchestrate spec + future-features (SP-2)"
```

---

## 完了後（大 Phase レビュー → マージ）

1. **Fable-5 最終レビュー**（大 Phase 全体）。P0/P1 を修正。
2. **codex exec gpt-5.5 xhigh** 差分レビュー（`-s read-only -o <out> "<prompt>" < /dev/null`）。P0/P1 必須修正、P2 は修正 or future-features defer。
3. PR 作成 → CI（node 20/24）green + **codex App** レビュー「no major issues」まで対応。
4. **ユーザーの明示承認を得てから** squash-merge（`--delete-branch`）→ ローカル main 同期。

## Self-Review（plan 作成者チェック済み）

- **Spec coverage:** 4 方向 + 6 修正 + budget + surface + schema-zero + 安全境界 + テスト戦略 + out-of-scope を Task 1-7 が網羅。
- **Placeholder scan:** 各 code step は実シグネチャ。Task 4/5/6 の本番 runner 構築は「既存 `hitch orchestrate` の構築を mirror（publisher なし）」と具体参照（実コードを読む指示）で、vague placeholder ではない。
- **Type consistency:** `CoursePhaseAction` / `PhaseOutcome` / `CourseOrchestrationResult` / `CourseStopReason` / `transitionStatus(from[],to)` / `derivePhaseReadiness({...})` / `decideCoursePhaseAction({declaredStatus,isLeaf,hitches,derivedOpenP0,derivedOpenP1})` は Task 1-4 で一貫。`readyToClose` は PhaseRollup（Task 2）。
