# Copilot PR review integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `docs/future-features.md` に保留されていた Copilot PR review 連携を、**非基幹・best-effort・retry-then-skip** な feature として回収する。harness の close/merge を一切 gate しない。

**Architecture:** `CopilotReviewer`（DI 抽象: `request`/`poll`）+ 純粋オーケストレーション `runCopilotReview`（**決して throw しない**、retry→skip）+ `gh` アダプタ。呼び出し側（standalone CLI `harness pr request-review` と `goal orchestrate --request-copilot-review` opt-in）が operation 台帳に audit を記録する。外部出力を状態遷移の根拠にしない（既存安全境界と整合）。

**Tech Stack:** TypeScript / Node, commander CLI, better-sqlite3（operations 台帳）, vitest, `gh` CLI。spec: `docs/superpowers/specs/2026-06-05-copilot-review-integration-design.md`。

---

## ファイル構成

| ファイル | 責務 | 新規/変更 |
|------|------|------|
| `src/core/copilot-reviewer.ts` | `CopilotReviewer` 型 + `CopilotReviewPollResult` 型のみ（DI 境界） | 新規 |
| `src/core/copilot-review-run.ts` | `runCopilotReview` 純粋オーケストレーション + 関連型 | 新規 |
| `src/core/copilot-reviewer-gh.ts` | `createGhCopilotReviewer`（`gh` 実装） | 新規 |
| `tests/unit/core/copilot-review-run.test.ts` | `runCopilotReview` の単体テスト（fake reviewer + 注入 sleep/now） | 新規 |
| `tests/integration/copilot-reviewer-gh.test.ts` | `gh` アダプタの統合テスト（fake gh script） | 新規 |
| `tests/integration/copilot-review-cli.test.ts` | `harness pr request-review` CLI のテスト | 新規 |
| `src/cli/run.ts` | `pr request-review` サブコマンド追加 | 変更（`prCmd` 付近 1416-1458） |
| `src/goal/orchestrator-runners.ts` | `OrchestratorRunnerDeps.copilotReview` 追加 + `closeAndPr` で best-effort 実行 | 変更（85-126, 452-499） |
| `src/cli/goal.ts` | `orchestrate --request-copilot-review` flag + deps 組み立て | 変更（680-731） |
| `tests/unit/goal/copilot-review-orchestrate.test.ts` | orchestrate opt-in が close を gate しない / 既定 OFF | 新規 |
| `docs/specs/cli.md` | `pr request-review` / orchestrate flag を追記 | 変更 |
| `docs/specs/workflow.md` | Copilot review が非 gating な観測ステップであることを追記 | 変更 |
| `docs/future-features.md` | Copilot 項目を「実装済み（best-effort opt-in）」へ更新 | 変更 |

各タスクは TDD（RED→GREEN→commit）。コア（`runCopilotReview`）→ gh アダプタ → CLI → orchestrate → docs の順。

---

## Task 1: `CopilotReviewer` DI 境界の型

**Files:**
- Create: `src/core/copilot-reviewer.ts`

DI 境界だけを定義する小ファイル（実装も orchestration も持たない）。型は他タスクが import する。

- [ ] **Step 1: 型ファイルを作成**

`src/core/copilot-reviewer.ts`:

```typescript
/**
 * Copilot PR review 連携の DI 境界（`PrPublisher` / `PrMerger` と同じ慣習）。
 * 実装は `createGhCopilotReviewer`（gh）/ テスト fake。orchestration は
 * `runCopilotReview`（純粋・throw しない）が持つ。
 */

export type CopilotReviewPollResult = "reviewed" | "pending";

export interface CopilotReviewer {
  /**
   * PR に Copilot reviewer を要求する。一時エラーは throw してよい
   * （呼び出し側 = runCopilotReview が retry する）。
   */
  request(prNumber: number): Promise<void>;
  /** Copilot のレビューが投稿済みかを返す。 */
  poll(prNumber: number): Promise<CopilotReviewPollResult>;
}
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS（未使用の型 export だけなので緑）

- [ ] **Step 3: Commit**

```bash
git add src/core/copilot-reviewer.ts
git commit -m "feat: add CopilotReviewer DI boundary type"
```

---

## Task 2: `runCopilotReview` 純粋オーケストレーション（RED）

**Files:**
- Create: `tests/unit/core/copilot-review-run.test.ts`

`runCopilotReview` の契約をテストで固定する。実装はまだ無い → 全テスト失敗（RED）。sleep/now を注入して時間を制御する。

設計上の契約（spec §2）:
- `request` を呼ぶ。一時エラーなら `requestAttempts`（既定 3）まで retry（間隔 `pollIntervalMs` 流用）。全失敗 → `{ status: "failed" }`。
- request 成功後、`pollTimeoutMs`（既定 300_000）を超えるまで `pollIntervalMs`（既定 15_000）間隔で `poll`。`reviewed` → `{ status: "reviewed" }`。timeout 到達（pending のまま）→ `{ status: "skipped" }`。
- `poll` の一時エラーは握って次の interval へ。
- **決して throw しない**。

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/core/copilot-review-run.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { runCopilotReview } from "../../../src/core/copilot-review-run.js";
import type { CopilotReviewer } from "../../../src/core/copilot-reviewer.js";

/** A fake reviewer scripted by per-call behaviour, recording call counts. */
function fakeReviewer(opts: {
  request: Array<"ok" | "throw">;
  poll: Array<"reviewed" | "pending" | "throw">;
}): CopilotReviewer & { requestCalls: number; pollCalls: number } {
  const state = { requestCalls: 0, pollCalls: 0 };
  return {
    get requestCalls() {
      return state.requestCalls;
    },
    get pollCalls() {
      return state.pollCalls;
    },
    async request() {
      const verb = opts.request[state.requestCalls] ?? "ok";
      state.requestCalls += 1;
      if (verb === "throw") throw new Error("gh transient");
    },
    async poll() {
      const verb = opts.poll[state.pollCalls] ?? "pending";
      state.pollCalls += 1;
      if (verb === "throw") throw new Error("gh transient");
      return verb;
    },
  };
}

/** A controllable clock: now() advances by `pollIntervalMs` each sleep. */
function fakeClock(stepMs: number) {
  const state = { t: 0 };
  return {
    now: () => state.t,
    sleep: async (ms: number) => {
      state.t += ms === 0 ? stepMs : ms;
    },
  };
}

describe("runCopilotReview", () => {
  const config = { requestAttempts: 3, pollTimeoutMs: 300_000, pollIntervalMs: 15_000 };

  it("returns reviewed when poll reports reviewed", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: ["reviewed"] });
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("reviewed");
    expect(reviewer.requestCalls).toBe(1);
    expect(out.polls).toBeGreaterThanOrEqual(1);
  });

  it("returns skipped when poll stays pending until the timeout (bounded polls)", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: [] }); // default pending
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("skipped");
    // ceil(300000/15000) = 20 polls max — never an unbounded loop.
    expect(reviewer.pollCalls).toBeLessThanOrEqual(20);
    expect(out.detail).toMatch(/timed out/i);
  });

  it("returns failed when request throws on every attempt", async () => {
    const reviewer = fakeReviewer({ request: ["throw", "throw", "throw"], poll: [] });
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("failed");
    expect(reviewer.requestCalls).toBe(3);
    expect(reviewer.pollCalls).toBe(0);
  });

  it("recovers: request retries a transient error then succeeds", async () => {
    const reviewer = fakeReviewer({ request: ["throw", "ok"], poll: ["reviewed"] });
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("reviewed");
    expect(reviewer.requestCalls).toBe(2);
  });

  it("swallows a transient poll error and keeps polling until reviewed", async () => {
    const reviewer = fakeReviewer({ request: ["ok"], poll: ["throw", "pending", "reviewed"] });
    const clock = fakeClock(15_000);
    const out = await runCopilotReview({
      reviewer,
      prNumber: 7,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("reviewed");
    expect(reviewer.pollCalls).toBe(3);
  });

  it("never throws even when both request and poll always throw", async () => {
    const reviewer: CopilotReviewer = {
      async request() {
        throw new Error("boom");
      },
      async poll() {
        throw new Error("boom");
      },
    };
    const clock = fakeClock(15_000);
    // must resolve (not reject) — best-effort contract.
    const out = await runCopilotReview({
      reviewer,
      prNumber: 1,
      config,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(out.status).toBe("failed");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/unit/core/copilot-review-run.test.ts`
Expected: FAIL（`Cannot find module '.../copilot-review-run.js'` 等）

---

## Task 3: `runCopilotReview` 実装（GREEN）

**Files:**
- Create: `src/core/copilot-review-run.ts`
- Test: `tests/unit/core/copilot-review-run.test.ts`（Task 2）

- [ ] **Step 1: 最小実装を書く**

`src/core/copilot-review-run.ts`:

```typescript
import type { CopilotReviewer } from "./copilot-reviewer.js";

export interface CopilotReviewConfig {
  /** request の一時エラー retry 上限（既定 3）。 */
  requestAttempts: number;
  /** poll の総タイムアウト（既定 300_000 = 5 分）。 */
  pollTimeoutMs: number;
  /** poll 間隔（既定 15_000）。 */
  pollIntervalMs: number;
}

export type CopilotReviewStatus = "reviewed" | "skipped" | "failed";

export interface CopilotReviewOutcome {
  status: CopilotReviewStatus;
  /** 実 request 試行回数。 */
  attempts: number;
  /** 実 poll 回数。 */
  polls: number;
  /** 人間可読の要約。 */
  detail: string;
}

const DEFAULT_CONFIG: CopilotReviewConfig = {
  requestAttempts: 3,
  pollTimeoutMs: 300_000,
  pollIntervalMs: 15_000,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Best-effort Copilot review orchestration. NEVER throws — always resolves to
 * an outcome. The result is observational only: callers MUST NOT gate any state
 * transition on it (close / merge stay independent — existing safety boundary).
 *
 * - `request` の一時エラーは `requestAttempts` まで retry。全失敗 → failed。
 * - request 成功後、`pollTimeoutMs` まで `pollIntervalMs` 間隔で poll。
 *   reviewed → reviewed。timeout（pending のまま）→ skipped。
 * - poll の一時エラーは握って次の interval へ（best-effort）。
 */
export async function runCopilotReview(input: {
  reviewer: CopilotReviewer;
  prNumber: number;
  config?: Partial<CopilotReviewConfig>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<CopilotReviewOutcome> {
  const config: CopilotReviewConfig = { ...DEFAULT_CONFIG, ...input.config };
  const sleep = input.sleep ?? defaultSleep;
  const now = input.now ?? (() => Date.now());

  // --- request phase: retry transient errors up to requestAttempts. ---
  let attempts = 0;
  let lastError = "";
  let requested = false;
  while (attempts < config.requestAttempts) {
    attempts += 1;
    try {
      await input.reviewer.request(input.prNumber);
      requested = true;
      break;
    } catch (e) {
      lastError = (e as Error).message;
      if (attempts < config.requestAttempts) {
        await sleep(config.pollIntervalMs);
      }
    }
  }
  if (!requested) {
    return {
      status: "failed",
      attempts,
      polls: 0,
      detail: `could not request Copilot review after ${attempts} attempts: ${lastError}`,
    };
  }

  // --- poll phase: poll until reviewed or the timeout elapses. ---
  const deadline = now() + config.pollTimeoutMs;
  let polls = 0;
  // The first poll happens immediately; subsequent ones after each interval.
  // The clock is advanced by sleep(); the loop is bounded by the deadline.
  for (;;) {
    polls += 1;
    try {
      const result = await input.reviewer.poll(input.prNumber);
      if (result === "reviewed") {
        return { status: "reviewed", attempts, polls, detail: "Copilot review posted" };
      }
    } catch {
      // best-effort: a transient poll error is swallowed; keep polling.
    }
    if (now() >= deadline) {
      return {
        status: "skipped",
        attempts,
        polls,
        detail: `Copilot review timed out after ${config.pollTimeoutMs}ms`,
      };
    }
    await sleep(config.pollIntervalMs);
    if (now() >= deadline) {
      return {
        status: "skipped",
        attempts,
        polls,
        detail: `Copilot review timed out after ${config.pollTimeoutMs}ms`,
      };
    }
  }
}
```

> 設計ノート: poll ループは `now() >= deadline` を sleep の前後でチェックし、`fakeClock` が `sleep` ごとに `pollIntervalMs` 進めるテストでも、実 `Date.now()` でも同じ境界で skipped へ収束する。`ceil(pollTimeoutMs/pollIntervalMs)` ≈ 20 回で必ず終わる（無限ループ無し）。

- [ ] **Step 2: テストが通ることを確認**

Run: `npx vitest run tests/unit/core/copilot-review-run.test.ts`
Expected: PASS（6 ケース全緑）

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/copilot-review-run.ts tests/unit/core/copilot-review-run.test.ts
git commit -m "feat: add runCopilotReview best-effort orchestration (retry-then-skip)"
```

---

## Task 4: `createGhCopilotReviewer` gh アダプタ（RED）

**Files:**
- Create: `tests/integration/copilot-reviewer-gh.test.ts`

`gh` を fake script（spawn 可能な実ファイル）に差し替え、`request` が `requested_reviewers` を叩き、`poll` が `copilot-pull-request-reviewer` を検出/未検出で reviewed/pending を返すことを固定する。既存 `tests/integration/gh-pr-publisher.test.ts` の fake-gh パターンに倣う。

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/copilot-reviewer-gh.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGhCopilotReviewer } from "../../src/core/copilot-reviewer-gh.js";

/**
 * A fake `gh`. `api ... requested_reviewers` records its argv to
 * `$dir/request-called`. `pr view --json reviews` prints a reviews array whose
 * sole author login is `$reviewerLogin` (empty → no reviews).
 */
function writeFakeGh(reviewerLogin: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
  const bin = join(dir, "gh");
  const reviewsJson =
    reviewerLogin === ""
      ? "{\"reviews\":[]}"
      : `{"reviews":[{"author":{"login":"${reviewerLogin}"}}]}`;
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "api" ]; then',
    `  echo "$@" > "${dir}/request-called"`,
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    `  printf '${reviewsJson}'`,
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n");
  writeFileSync(bin, `${script}\n`);
  execFileSync("chmod", ["+x", bin]);
  return { bin, dir };
}

describe("createGhCopilotReviewer", () => {
  it("request invokes `gh api ... requested_reviewers` with Copilot", async () => {
    const { bin, dir } = writeFakeGh("");
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    await reviewer.request(42);
    const called = readFileSync(join(dir, "request-called"), "utf8");
    expect(called).toContain("requested_reviewers");
    expect(called).toContain("reviewers[]=Copilot");
  });

  it("poll returns reviewed when Copilot's bot author is present", async () => {
    const { bin } = writeFakeGh("copilot-pull-request-reviewer");
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    expect(await reviewer.poll(42)).toBe("reviewed");
  });

  it("poll returns pending when no Copilot review is present", async () => {
    const { bin } = writeFakeGh("");
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    expect(await reviewer.poll(42)).toBe("pending");
  });

  it("poll returns pending for a non-Copilot reviewer (a human review)", async () => {
    const { bin } = writeFakeGh("some-human");
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    expect(await reviewer.poll(42)).toBe("pending");
  });

  it("request throws on a gh non-zero exit (so the orchestration can retry)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
    const bin = join(dir, "gh");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n");
    execFileSync("chmod", ["+x", bin]);
    const reviewer = createGhCopilotReviewer(tmpdir(), bin, 5_000);
    await expect(reviewer.request(42)).rejects.toThrow();
    expect(existsSync(join(dir, "request-called"))).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/integration/copilot-reviewer-gh.test.ts`
Expected: FAIL（module 不在）

---

## Task 5: `createGhCopilotReviewer` 実装（GREEN）

**Files:**
- Create: `src/core/copilot-reviewer-gh.ts`
- Test: `tests/integration/copilot-reviewer-gh.test.ts`（Task 4）

`runGh` 相当（spawn + SIGKILL timeout）が必要。`gh-pr-publisher.ts` の `runGh` は module-private なので、この小ファイルに同等の最小 spawn ヘルパを持たせる（DRY より境界の独立を優先。各ファイルが自分の `gh` 起動を完結させる既存方針に沿う）。

- [ ] **Step 1: 実装を書く**

`src/core/copilot-reviewer-gh.ts`:

```typescript
import { spawn } from "node:child_process";
import type {
  CopilotReviewer,
  CopilotReviewPollResult,
} from "./copilot-reviewer.js";

const DEFAULT_GH_TIMEOUT_MS = 120_000;

/** GitHub's Copilot reviewer posts its review under this bot login. */
const COPILOT_BOT_LOGIN = "copilot-pull-request-reviewer";

/**
 * A `CopilotReviewer` backed by the GitHub `gh` CLI. `request` adds the
 * "Copilot" reviewer to the PR; `poll` checks whether the Copilot bot has
 * posted a review yet. `gh` resolves owner/repo from `repoDir` (its cwd).
 * Each call is bounded by a timeout so a hang fails loudly (request → the
 * orchestration retries; poll → it is swallowed best-effort).
 */
export function createGhCopilotReviewer(
  repoDir: string,
  ghBin = "gh",
  timeoutMs = DEFAULT_GH_TIMEOUT_MS,
): CopilotReviewer {
  return {
    async request(prNumber: number): Promise<void> {
      await runGh(
        ghBin,
        [
          "api",
          "--method",
          "POST",
          `repos/{owner}/{repo}/pulls/${prNumber}/requested_reviewers`,
          "-f",
          "reviewers[]=Copilot",
        ],
        repoDir,
        timeoutMs,
      );
    },
    async poll(prNumber: number): Promise<CopilotReviewPollResult> {
      const out = await runGh(
        ghBin,
        ["pr", "view", String(prNumber), "--json", "reviews"],
        repoDir,
        timeoutMs,
      );
      const parsed = JSON.parse(out.trim() || "{}") as {
        reviews?: Array<{ author?: { login?: unknown } }>;
      };
      const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
      const reviewed = reviews.some(
        (r) => r?.author?.login === COPILOT_BOT_LOGIN,
      );
      return reviewed ? "reviewed" : "pending";
    },
  };
}

function runGh(
  ghBin: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghBin, args as string[], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to run ${ghBin}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`gh ${args[0]} timed out after ${timeoutMs}ms`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `gh ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`,
          ),
        );
      }
    });
  });
}
```

- [ ] **Step 2: テストが通ることを確認**

Run: `npx vitest run tests/integration/copilot-reviewer-gh.test.ts`
Expected: PASS（5 ケース全緑）

- [ ] **Step 3: typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/core/copilot-reviewer-gh.ts tests/integration/copilot-reviewer-gh.test.ts
git commit -m "feat: add gh-backed CopilotReviewer adapter"
```

---

## Task 6: `harness pr request-review` CLI（RED）

**Files:**
- Create: `tests/integration/copilot-review-cli.test.ts`

CLI を子プロセスで起動し、fake `gh`（`HARNESS_GH_BIN`）+ 一時 `HARNESS_ROOT` で動かす。reviewed → exit 0 + status 出力 + audit 行が記録される、failed → 非 0 を固定する。既存 CLI 統合テストの起動パターンに倣う（`tsx src/cli/run.ts` を spawn）。

まず既存の CLI 統合テストを 1 つ読み、`HARNESS_ROOT` の初期化（`db migrate` 相当）と spawn 方法を確認すること:

```bash
ls tests/integration/ | grep -i "cli\|pr\|run"
```

- [ ] **Step 1: 失敗するテストを書く**

`tests/integration/copilot-review-cli.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { harnessPaths } from "../../src/config/paths.js";
import { runMigrations } from "../../src/db/migrations.js";

/** A fake `gh` whose `pr view --json reviews` reports a Copilot review. */
function writeReviewedGh(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
  const bin = join(dir, "gh");
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "api" ]; then exit 0; fi',
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    `  printf '{"reviews":[{"author":{"login":"copilot-pull-request-reviewer"}}]}'`,
    "  exit 0",
    "fi",
    "exit 1",
  ].join("\n");
  writeFileSync(bin, `${script}\n`);
  execFileSync("chmod", ["+x", bin]);
  return bin;
}

/** Initialise an empty harness root with a migrated DB. */
function initRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-root-"));
  const paths = harnessPaths(root);
  execFileSync("mkdir", ["-p", join(root, ".harness")]);
  const db = new Database(paths.dbPath);
  runMigrations(db);
  db.close();
  return root;
}

function runCli(root: string, ghBin: string, args: string[]) {
  return spawnSync(
    "npx",
    ["tsx", join(process.cwd(), "src/cli/run.ts"), ...args],
    {
      env: { ...process.env, HARNESS_ROOT: root, HARNESS_GH_BIN: ghBin },
      encoding: "utf8",
    },
  );
}

describe("harness pr request-review", () => {
  it("exits 0 and reports reviewed, recording a copilot-review operation", () => {
    const root = initRoot();
    const gh = writeReviewedGh();
    const r = runCli(root, gh, [
      "pr",
      "request-review",
      "55",
      "--repo",
      tmpdir(),
      "--poll-interval",
      "0",
      "--timeout",
      "1",
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/copilot-review=reviewed/);
    // an audit row was recorded.
    const db = new Database(harnessPaths(root).dbPath);
    const row = db
      .prepare(
        "SELECT status FROM operations WHERE operation_type = 'copilot-review'",
      )
      .get() as { status: string } | undefined;
    db.close();
    expect(row?.status).toBe("succeeded");
  });

  it("exits non-zero when the request can never be established (failed)", () => {
    const root = initRoot();
    const failDir = mkdtempSync(join(tmpdir(), "harness-fake-gh-"));
    const failGh = join(failDir, "gh");
    writeFileSync(failGh, "#!/bin/sh\nexit 1\n");
    execFileSync("chmod", ["+x", failGh]);
    const r = runCli(root, failGh, [
      "pr",
      "request-review",
      "55",
      "--repo",
      tmpdir(),
      "--poll-interval",
      "0",
      "--request-attempts",
      "1",
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr + r.stdout).toMatch(/copilot-review=failed|failed/);
  });
});
```

> 注: 既存 CLI 統合テストが別の root 初期化ヘルパ（例: `db migrate` を spawn）を使っている場合は **それに合わせる**。`initRoot` は `runMigrations` を直接呼ぶ最小版。テスト実行が遅い `npx tsx` 起動を含むため、`--timeout 1`（1 秒）+ `--poll-interval 0` で即収束させる。

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/integration/copilot-review-cli.test.ts`
Expected: FAIL（`pr request-review` 未実装 → commander が unknown command で非 0、reviewed マッチ無し）

---

## Task 7: `harness pr request-review` CLI 実装（GREEN）

**Files:**
- Modify: `src/cli/run.ts`（`prCmd` 定義の直後、1458 付近に追加）
- Test: `tests/integration/copilot-review-cli.test.ts`（Task 6）

`pr create` と同じ `prCmd` 配下に `request-review` を足す。audit は `startOperation` → outcome に応じ `succeedOperation`(reviewed) / `markOperationPending`(skipped) / `failOperation`(failed)。audit 自体は best-effort（記録失敗で本処理を壊さない）。

- [ ] **Step 1: import を追加**

`src/cli/run.ts` の import 群に（既存の `createGhPrPublisher` import の近く）:

```typescript
import { createGhCopilotReviewer } from "../core/copilot-reviewer-gh.js";
import { runCopilotReview } from "../core/copilot-review-run.js";
import {
  startOperation,
  succeedOperation,
  markOperationPending,
  failOperation,
} from "../db/repositories/operations.js";
import { randomUUID } from "node:crypto";
```

> `openManagedDb` は既に import 済み（`createPullRequest` 経由）か確認。未 import なら `import { openManagedDb } from "../db/managed-connection.js";` を追加。`runMigrations` も同様。

- [ ] **Step 2: `request-review` サブコマンドを追加**

`src/cli/run.ts` の `pr create` の `.action(...)` ブロックの直後（1458 の `});` の後）に追加:

```typescript
prCmd
  .command("request-review")
  .description(
    "best-effort: request a Copilot review on a PR (retry-then-skip, non-gating)",
  )
  .argument("<pr-number>", "GitHub PR number")
  .requiredOption("--repo <path>", "path to the target git repo")
  .option("--timeout <seconds>", "total poll timeout in seconds", "300")
  .option("--poll-interval <seconds>", "seconds between polls", "15")
  .option("--request-attempts <n>", "request retry attempts", "3")
  .option("--json", "emit JSON", false)
  .action(async (prArg: string, raw: Record<string, unknown>) => {
    const prNumber = Number(prArg);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      process.stderr.write(`harness error: invalid PR number: ${prArg}\n`);
      process.exit(2);
    }
    const ghBin = process.env.HARNESS_GH_BIN ?? "gh";
    const repoDir = String(raw.repo);
    const config = {
      pollTimeoutMs: Math.max(0, Number(raw.timeout) * 1000),
      pollIntervalMs: Math.max(0, Number(raw.pollInterval) * 1000),
      requestAttempts: Math.max(1, Number(raw.requestAttempts)),
    };
    const outcome = await runCopilotReview({
      reviewer: createGhCopilotReviewer(repoDir, ghBin),
      prNumber,
      config,
    });

    // audit (best-effort: a recording failure must not change the exit code).
    try {
      const paths = harnessPaths(getHarnessRoot());
      const dbHandle = openManagedDb({ dbPath: paths.dbPath });
      try {
        runMigrations(dbHandle.db);
        const operationId = `op-${randomUUID()}`;
        startOperation(dbHandle.db, {
          operationId,
          operationType: "copilot-review",
          targetType: "pr",
          targetId: String(prNumber),
          actor: "cli",
          dryRun: false,
          input: { prNumber, config },
        });
        if (outcome.status === "reviewed") {
          succeedOperation(dbHandle.db, operationId, outcome);
        } else if (outcome.status === "skipped") {
          markOperationPending(dbHandle.db, operationId, outcome);
        } else {
          failOperation(
            dbHandle.db,
            operationId,
            "copilot_review_failed",
            outcome.detail,
          );
        }
      } finally {
        dbHandle.close();
      }
    } catch (e) {
      process.stderr.write(
        `warning: could not record copilot-review audit: ${(e as Error).message}\n`,
      );
    }

    if (raw.json === true) {
      process.stdout.write(`${JSON.stringify({ prNumber, ...outcome })}\n`);
    } else {
      process.stdout.write(
        `pr=#${prNumber} copilot-review=${outcome.status} (${outcome.detail})\n`,
      );
    }
    // reviewed / skipped (a timeout is a normal best-effort result) → 0;
    // failed (the request itself could not be established) → non-0 so an
    // operator notices. orchestrate ignores this exit (non-gating).
    process.exit(outcome.status === "failed" ? 1 : 0);
  });
```

> `getHarnessRoot` / `harnessPaths` / `openManagedDb` / `runMigrations` は run.ts で既に使用済み（`pr create` action 参照）。同じ参照を使うこと。

- [ ] **Step 3: テストが通ることを確認**

Run: `npx vitest run tests/integration/copilot-review-cli.test.ts`
Expected: PASS（2 ケース）。遅ければ timeout を上げる（vitest の testTimeout）。

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/run.ts tests/integration/copilot-review-cli.test.ts
git commit -m "feat: add 'harness pr request-review' best-effort Copilot review CLI"
```

---

## Task 8: orchestrate opt-in 配線（RED）

**Files:**
- Create: `tests/unit/goal/copilot-review-orchestrate.test.ts`

`closeAndPr` に `deps.copilotReview`（reviewer + config?）を渡したとき、Copilot review の outcome が reviewed/skipped/failed のいずれでも **close まで進む**（gate しない）こと、`deps.copilotReview` 省略時は reviewer が一切呼ばれないことを固定する。

まず既存 `tests/unit/goal/orchestrator-runners.test.ts` を読み、`createOrchestratorRunners` を fake publisher で叩く `closeAndPr` の既存テストの組み立て（goal を close_ready に持っていく helper、fake publisher、approved run の用意）を再利用すること。

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/goal/copilot-review-orchestrate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { CopilotReviewer } from "../../../src/core/copilot-reviewer.js";
// NOTE: reuse the existing harness from orchestrator-runners.test.ts for
// building a close_ready goal + approved run + fake publisher. Import or
// duplicate the minimal setup helper here (see that file).
import {
  setupCloseReadyGoal, // ← if not exported, copy the helper inline (see existing test)
} from "./orchestrator-runners.test.helpers.js";

/** A reviewer that records calls and returns a scripted poll result. */
function recordingReviewer(
  poll: "reviewed" | "pending",
): CopilotReviewer & { requestCalls: number; pollCalls: number } {
  const state = { requestCalls: 0, pollCalls: 0 };
  return {
    get requestCalls() {
      return state.requestCalls;
    },
    get pollCalls() {
      return state.pollCalls;
    },
    async request() {
      state.requestCalls += 1;
    },
    async poll() {
      state.pollCalls += 1;
      return poll;
    },
  };
}

describe("closeAndPr Copilot review opt-in", () => {
  it("runs Copilot review but still closes the goal (reviewed does not gate)", async () => {
    const { runners, goalId, repo } = await setupCloseReadyGoal();
    const reviewer = recordingReviewer("reviewed");
    // inject opt-in deps (the helper exposes a way to set deps.copilotReview).
    const result = await runners.closeAndPr(goalId, {
      copilotReview: {
        reviewer,
        config: { pollTimeoutMs: 0, pollIntervalMs: 0, requestAttempts: 1 },
      },
    });
    expect(reviewer.requestCalls).toBeGreaterThanOrEqual(1);
    expect(result.prUrl).not.toBe("");
    expect(repo.requireSession(goalId).status).toBe("closed");
  });

  it("a Copilot review that never posts (skipped) still closes the goal", async () => {
    const { runners, goalId, repo } = await setupCloseReadyGoal();
    const reviewer = recordingReviewer("pending");
    const result = await runners.closeAndPr(goalId, {
      copilotReview: {
        reviewer,
        config: { pollTimeoutMs: 0, pollIntervalMs: 0, requestAttempts: 1 },
      },
    });
    expect(result.prUrl).not.toBe("");
    expect(repo.requireSession(goalId).status).toBe("closed");
  });

  it("a throwing reviewer does NOT break close (exception swallowed, non-gating)", async () => {
    const { runners, goalId, repo } = await setupCloseReadyGoal();
    const reviewer: CopilotReviewer = {
      async request() {
        throw new Error("boom");
      },
      async poll() {
        throw new Error("boom");
      },
    };
    const result = await runners.closeAndPr(goalId, {
      copilotReview: { reviewer, config: { pollTimeoutMs: 0, pollIntervalMs: 0, requestAttempts: 1 } },
    });
    expect(result.prUrl).not.toBe("");
    expect(repo.requireSession(goalId).status).toBe("closed");
  });

  it("default (no copilotReview dep) never requests a review", async () => {
    const { runners, goalId } = await setupCloseReadyGoal();
    const reviewer = recordingReviewer("reviewed");
    await runners.closeAndPr(goalId); // no opt-in deps
    expect(reviewer.requestCalls).toBe(0);
  });
});
```

> **重要**: `closeAndPr` の現行シグネチャは `(goalId) => ...`。この plan では opt-in を `deps.copilotReview` として `createOrchestratorRunners(deps)` に渡す方式に統一する（Task 9）。上テストの `runners.closeAndPr(goalId, {copilotReview})` は擬似的な書き方 — 実際は **deps に注入**し、`setupCloseReadyGoal` が deps を受け取れるようにする。テスト helper が無ければ既存 `orchestrator-runners.test.ts` の close_ready セットアップをこのファイルにインライン複製し、`createOrchestratorRunners({...deps, copilotReview})` を直接呼ぶ形にすること（`.test.helpers.js` の import は便宜表記）。

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/unit/goal/copilot-review-orchestrate.test.ts`
Expected: FAIL（`deps.copilotReview` 未対応 → reviewer が呼ばれず requestCalls=0）

---

## Task 9: orchestrate opt-in 実装（GREEN）

**Files:**
- Modify: `src/goal/orchestrator-runners.ts`（`OrchestratorRunnerDeps` 85-126、`closeAndPr` 452-499）
- Test: `tests/unit/goal/copilot-review-orchestrate.test.ts`（Task 8）

- [ ] **Step 1: import を追加**

`src/goal/orchestrator-runners.ts` の import 群に:

```typescript
import type { CopilotReviewer } from "../core/copilot-reviewer.js";
import {
  runCopilotReview,
  type CopilotReviewConfig,
} from "../core/copilot-review-run.js";
import {
  startOperation,
  succeedOperation,
  markOperationPending,
  failOperation,
} from "../db/repositories/operations.js";
import { randomUUID } from "node:crypto";
```

> `withManagedDb` は既に import 済み（closeAndPr で使用）。

- [ ] **Step 2: `OrchestratorRunnerDeps` に opt-in フィールドを追加**

`autoMerge?: {...}` ブロックの直後（126 の `baseBranch?` の前）に追加:

```typescript
  /**
   * Best-effort Copilot PR review (opt-in; default OFF). When present,
   * `closeAndPr` requests a Copilot review after creating the PR and records
   * an audit row. The outcome is observational ONLY — it never gates close or
   * auto-merge, and any exception is swallowed (non-gating safety boundary).
   */
  copilotReview?: {
    reviewer: CopilotReviewer;
    config?: Partial<CopilotReviewConfig>;
  };
```

- [ ] **Step 3: `closeAndPr` で PR 作成後・auto-merge 前に best-effort 実行**

`closeAndPr` の `const pr = await createPullRequest({...});`（454-466）の直後、`// Phase 3: opt-in auto-merge after the PR exists.`（468）の前に挿入:

```typescript
      // Best-effort Copilot review (opt-in). Observational only: it NEVER
      // gates close/merge, and ANY failure (including an unexpected throw) is
      // swallowed — the goal proceeds regardless (existing safety boundary:
      // external output must not drive a state transition).
      if (deps.copilotReview !== undefined) {
        try {
          const outcome = await runCopilotReview({
            reviewer: deps.copilotReview.reviewer,
            prNumber: pr.prNumber,
            config: deps.copilotReview.config,
          });
          withManagedDb({ dbPath: deps.dbPath }, (db) => {
            const operationId = `op-${randomUUID()}`;
            startOperation(db, {
              operationId,
              operationType: "copilot-review",
              targetType: "pr",
              targetId: String(pr.prNumber),
              actor: deps.createdBy,
              dryRun: false,
              input: { goalId, prNumber: pr.prNumber },
            });
            if (outcome.status === "reviewed") {
              succeedOperation(db, operationId, outcome);
            } else if (outcome.status === "skipped") {
              markOperationPending(db, operationId, outcome);
            } else {
              failOperation(db, operationId, "copilot_review_failed", outcome.detail);
            }
          });
        } catch {
          // non-gating: a Copilot review failure must never break close/merge.
        }
      }
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run tests/unit/goal/copilot-review-orchestrate.test.ts`
Expected: PASS（4 ケース）

- [ ] **Step 5: typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/goal/orchestrator-runners.ts tests/unit/goal/copilot-review-orchestrate.test.ts
git commit -m "feat: opt-in best-effort Copilot review in closeAndPr (non-gating)"
```

---

## Task 10: orchestrate CLI flag 配線

**Files:**
- Modify: `src/cli/goal.ts`（orchestrate command 680-731）

`--request-copilot-review`（既定 OFF）を足し、ON のとき `deps.copilotReview = { reviewer: createGhCopilotReviewer(repoPath) }` を組み立てる。CLI flag は配線のみ（ロジックは Task 9 で実装済み）なので、専用テストは追加せず typecheck + フルスイートで担保する（既存 orchestrate テストが回帰しないこと）。

- [ ] **Step 1: import を追加**

`src/cli/goal.ts` の import 群（`createGhPrMerger` 等と同じ block）に:

```typescript
import { createGhCopilotReviewer } from "../core/copilot-reviewer-gh.js";
```

- [ ] **Step 2: flag を追加**

`.option("--merge-method <method>", ...)`（685-689）の直後に:

```typescript
    .option(
      "--request-copilot-review",
      "opt-in: best-effort request a Copilot review on the PR (non-gating)",
      false,
    )
```

- [ ] **Step 3: deps を組み立て**

`const autoMerge = ...;`（711-718）の直後に:

```typescript
        // Best-effort Copilot review is opt-in (default OFF). Non-gating: the
        // outcome never affects close/merge.
        const copilotReview =
          raw.requestCopilotReview === true
            ? { reviewer: createGhCopilotReviewer(repoPath) }
            : undefined;
```

そして `createOrchestratorRunners({...})`（721-731）の `...(autoMerge !== undefined ? { autoMerge } : {}),`（728）の直後に:

```typescript
            ...(copilotReview !== undefined ? { copilotReview } : {}),
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: 関連テストが回帰しないことを確認**

Run: `npx vitest run tests/unit/goal/ tests/integration/copilot-review-cli.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/cli/goal.ts
git commit -m "feat: wire 'goal orchestrate --request-copilot-review' opt-in flag"
```

---

## Task 11: docs 更新（spec 駆動）

**Files:**
- Modify: `docs/specs/cli.md`
- Modify: `docs/specs/workflow.md`
- Modify: `docs/future-features.md`

CLAUDE.md の spec 駆動規律: `src/` の動作が変わったら同じコミット群で `docs/specs/*` を更新する（`docs/specs/` は現状スナップショット、TODO を書かない）。

- [ ] **Step 1: `docs/specs/cli.md` に追記**

まず該当箇所を特定:

```bash
grep -n "pr create\|orchestrate" docs/specs/cli.md
```

`pr create` の項の後に `pr request-review` を追加（reviewed/skipped→exit 0、failed→非 0、best-effort、operation 台帳に `copilot-review` を記録）。`goal orchestrate` の項に `--request-copilot-review`（既定 OFF、非 gating）を追記。

- [ ] **Step 2: `docs/specs/workflow.md` に追記**

```bash
grep -n "auto-merge\|PR\|close" docs/specs/workflow.md | head
```

PR 作成後の **観測ステップ**として Copilot review（opt-in・best-effort・**close/merge を gate しない**・外部出力を状態遷移の根拠にしない）を 1 段落追記。

- [ ] **Step 3: `docs/future-features.md` の Copilot 項目を更新**

```bash
grep -n -i "copilot" docs/future-features.md
```

該当項目を「**実装済み**（best-effort opt-in: `harness pr request-review` / `goal orchestrate --request-copilot-review`、非 gating）」へ更新（項目を削除せず、実装済みと明記して経緯を残す）。

- [ ] **Step 4: Commit**

```bash
git add docs/specs/cli.md docs/specs/workflow.md docs/future-features.md
git commit -m "docs: document Copilot review CLI + orchestrate flag (best-effort, opt-in)"
```

---

## Task 12: フルスイート + 大レビュー前検証

**Files:** なし（検証のみ）

- [ ] **Step 1: typecheck（必須）**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: フルスイート（回帰禁止）**

Run: `npm test`
Expected: PASS（全緑。テストを弱める/skip しての緑化は禁止）

- [ ] **Step 3: codex 大レビュー（GOAL_RULES 準拠、大 Phase 扱い）**

`GOAL_RULES.md` の大用テンプレートで `codex exec -m gpt-5.5 -c model_reasoning_effort="xhigh" --sandbox read-only` に diff を stdin で渡す。未解決 P0 ゼロが close の必須条件。P0/P1 が出たら最大 5 回まで修正リトライ（各リトライ後にフルスイート + typecheck 緑を再確認）。

レビュー観点（この feature 固有）:
- `runCopilotReview` が **本当に throw しない**か（request/poll 双方の例外、config 境界値 0）。
- orchestrate 経路で Copilot outcome が **close/merge を一切 gate しない**か（reviewed/skipped/failed/throw すべてで close 到達）。
- audit 記録失敗が本処理を壊さないか（best-effort）。
- 既定 OFF（flag/dep 無し）で reviewer が呼ばれないか。
- 外部出力（Copilot のレビュー有無）が状態遷移の根拠になっていないか（安全境界）。

- [ ] **Step 4: P0 ゼロを確認後、close**

未解決 P0 ゼロを確認したら local main へマージ（`docs/超 GOAL_RULES` のブランチ/マージ運用に従う。direct push to origin/main は不可、ローカル main マージ + close タグ運用）。

---

## Self-Review（plan 作成者による spec 突合）

**1. Spec coverage:**
- spec §1 `CopilotReviewer` → Task 1 ✅
- spec §2 `runCopilotReview`（throw しない retry/skip）→ Task 2-3 ✅
- spec §3 `createGhCopilotReviewer` → Task 4-5 ✅
- spec §4 operation audit（succeeded/pending/failed）→ Task 7（CLI）+ Task 9（orchestrate）✅
- spec §5 CLI `harness pr request-review`（exit code 規約）→ Task 6-7 ✅
- spec §6 orchestrate `--request-copilot-review`（既定 OFF・非 gating）→ Task 8-10 ✅
- spec データフロー / エラーハンドリング → Task 9 の try/catch + Task 3 の never-throw ✅
- spec テスト節 → Task 2,4,6,8 で全ケース網羅 ✅
- spec close 条件（フル+typecheck 緑 / P0 ゼロ / best-effort・非 gating・既定 OFF テスト / docs 更新）→ Task 11-12 ✅

**2. Placeholder scan:** コード step は全て実コードを掲載。`setupCloseReadyGoal` は既存 `orchestrator-runners.test.ts` のセットアップ再利用で、Task 8 step 1 に「helper が無ければインライン複製」と明記済み（実装者が既存テストを読む前提）。

**3. Type consistency:**
- `CopilotReviewPollResult` = `"reviewed"|"pending"`（Task 1）、`CopilotReviewStatus` = `"reviewed"|"skipped"|"failed"`（Task 3）— poll 結果と outcome status を別型に分離（混同しない）。
- `runCopilotReview` の入力 `{reviewer, prNumber, config?, sleep?, now?}` は Task 2/3/7/9 で一致。
- `CopilotReviewConfig` フィールド名 `requestAttempts`/`pollTimeoutMs`/`pollIntervalMs` は全タスク一致。
- operations API（`startOperation`/`succeedOperation`/`markOperationPending`/`failOperation`、`operationType:"copilot-review"`、`targetType:"pr"`）は Task 7/9 で一致、`operations.ts` の実シグネチャと整合。
- `closeAndPr` の opt-in は `deps.copilotReview`（`createOrchestratorRunners` 経由）に統一。Task 8 のテスト表記の擬似 `closeAndPr(goalId, {...})` は step 1 の注記で deps 注入へ修正済み。
