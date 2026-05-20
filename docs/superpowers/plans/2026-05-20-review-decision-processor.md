# Review-decision processor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** reviewer が `runs/<runId>/review-decision.yaml` を編集して `decision: approved | changes_requested | rejected` にした後、`harness review process --run-id <id>` で meta.json の status を遷移させ、`review_processed` イベントを events.jsonl に追記する。

**Architecture:** review-decision.yaml を Zod でパース → run の現在 meta を読む → 整合性検査 → meta.status を update → reviewer / reviewedAt を meta に保存 → event 追記。worktree 削除や再 run トリガはこの処理の外（後続 CLI / Phase 3）。

**Tech Stack:** 既存ハーネスと同じ (TypeScript / Zod / yaml / commander)。新規依存なし。

---

## Scope check

Phase 2 全体は「review processor + cleanup + command allowlist」の 3 サブ。本 plan は **processor 単独**。cleanup と command allowlist は別 plan。各々独立に動く小さい単位。

## 設計判断（plan を書く前の決定）

- **reviewer フィールド:** optional（null 許容）。フィルされていないと stderr に warning を出すが処理は止めない
- **reviewed_at フィールド:** null なら processor が現在時刻で auto-fill → review-decision.yaml に書き戻す
- **必要な現在 status:** `needs_review` のみ受理。`approved` / `rejected` / `changes_requested` で再 process する場合はエラー（誤操作防止；後で `--force` を入れる余地）
- **decision == "pending":** エラー（reviewer が決めていない）
- **runId / domain mismatch:** エラー（ファイル取り違え防止）
- **`required_changes` 等のフィールド:** processor は読み取るが現在使わない（Phase 3 retry loop で活用）
- **冪等性:** 同じ run を 2 度 process しようとすると 2 回目はエラーで止める（idempotent ではない、意図的）
- **list 機能:** 今 plan には含まない（`docs/specs/cli.md` の "予定" に残す）

## File structure

新規:
```
src/core/
  review-decision-schema.ts    # Zod schema for review-decision.yaml
  review-processor.ts          # processReviewDecision(runDir) コア logic
  review-decision-loader.ts    # load + parse + write-back helper

src/cli/
  (run.ts に subcommand 追加)

tests/unit/core/
  review-decision-schema.test.ts
  review-processor.test.ts

tests/integration/
  cli-review-process.test.ts
```

修正:
```
src/cli/run.ts                 # commander tree に `review process` を追加
src/logging/run-log.ts         # RunMeta に reviewer? / reviewedAt? を追加
src/reporter/review-decision.ts # 既存 file の構造はそのまま、schema を共有
docs/specs/cli.md              # CLI reference に review process を追記
docs/specs/workflow.md         # status machine に reviewer/reviewedAt の出所を追記
docs/specs/overview.md         # 「できること」リストに review processor を追加
```

---

## Phase 0 — Schema + loader

### Task 1: review-decision Zod schema

**Files:**
- Create: `src/core/review-decision-schema.ts`
- Test: `tests/unit/core/review-decision-schema.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/core/review-decision-schema.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { ReviewDecisionFileSchema } from "../../../src/core/review-decision-schema.js";

const VALID_PENDING = {
  runId: "run-1",
  domain: "apps/user",
  decision: "pending",
  required_changes: [],
  non_blocking_comments: [],
  out_of_scope_suggestions: [],
  reviewer: null,
  reviewed_at: null,
};

describe("ReviewDecisionFileSchema", () => {
  it("parses the initial pending shape", () => {
    expect(ReviewDecisionFileSchema.parse(VALID_PENDING).decision).toBe(
      "pending",
    );
  });

  it("accepts approved with reviewer + reviewed_at", () => {
    const p = ReviewDecisionFileSchema.parse({
      ...VALID_PENDING,
      decision: "approved",
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    expect(p.decision).toBe("approved");
    expect(p.reviewer).toBe("alice");
  });

  it("accepts changes_requested and rejected", () => {
    expect(
      ReviewDecisionFileSchema.parse({
        ...VALID_PENDING,
        decision: "changes_requested",
        required_changes: ["fix validation"],
      }).decision,
    ).toBe("changes_requested");
    expect(
      ReviewDecisionFileSchema.parse({ ...VALID_PENDING, decision: "rejected" })
        .decision,
    ).toBe("rejected");
  });

  it("rejects unknown decision values", () => {
    expect(() =>
      ReviewDecisionFileSchema.parse({ ...VALID_PENDING, decision: "maybe" }),
    ).toThrow();
  });

  it("rejects extra top-level fields", () => {
    expect(() =>
      ReviewDecisionFileSchema.parse({ ...VALID_PENDING, extra: true }),
    ).toThrow();
  });

  it("requires required_changes / comments / suggestions to be arrays of strings", () => {
    expect(() =>
      ReviewDecisionFileSchema.parse({
        ...VALID_PENDING,
        required_changes: [1, 2],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
npx vitest run tests/unit/core/review-decision-schema.test.ts
```
Expected: FAIL（module 未実装）。

- [ ] **Step 3: 実装**

`src/core/review-decision-schema.ts`:
```ts
import { z } from "zod";

export const ReviewDecisionValueSchema = z.enum([
  "pending",
  "approved",
  "changes_requested",
  "rejected",
]);
export type ReviewDecisionValue = z.infer<typeof ReviewDecisionValueSchema>;

export const ReviewDecisionFileSchema = z
  .object({
    runId: z.string().min(1),
    domain: z.string().min(1),
    decision: ReviewDecisionValueSchema,
    required_changes: z.array(z.string()),
    non_blocking_comments: z.array(z.string()),
    out_of_scope_suggestions: z.array(z.string()),
    reviewer: z.string().nullable(),
    reviewed_at: z.string().nullable(),
  })
  .strict();

export type ReviewDecisionFile = z.infer<typeof ReviewDecisionFileSchema>;
```

- [ ] **Step 4: テスト合格を確認**

```bash
npx vitest run tests/unit/core/review-decision-schema.test.ts
```
Expected: 6 tests passed.

- [ ] **Step 5: 既存 reporter/review-decision.ts を schema に揃える**

```ts
// src/reporter/review-decision.ts に追加 import
import { ReviewDecisionFileSchema, type ReviewDecisionFile } from "../core/review-decision-schema.js";

// ローカルの interface を削除、再 export
export type { ReviewDecisionFile, ReviewDecisionValue } from "../core/review-decision-schema.js";
```

これで生成側と読み取り側が同じ型を共有する。typecheck pass を確認。

- [ ] **Step 6: コミット**

```bash
git add src/core/review-decision-schema.ts src/reporter/review-decision.ts tests/unit/core/review-decision-schema.test.ts
git commit -m "feat(core): zod schema for review-decision.yaml"
```

---

### Task 2: review-decision file loader / writer

**Files:**
- Create: `src/core/review-decision-loader.ts`
- Test: `tests/unit/core/review-decision-loader.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/core/review-decision-loader.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadReviewDecision,
  writeReviewDecision,
} from "../../../src/core/review-decision-loader.js";

describe("loadReviewDecision", () => {
  it("loads a valid YAML file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-rd-"));
    writeFileSync(
      join(dir, "review-decision.yaml"),
      [
        "runId: run-1",
        "domain: apps/user",
        "decision: approved",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: alice",
        "reviewed_at: 2026-05-20T12:00:00Z",
        "",
      ].join("\n"),
    );
    const p = await loadReviewDecision(join(dir, "review-decision.yaml"));
    expect(p.decision).toBe("approved");
    expect(p.reviewer).toBe("alice");
  });

  it("throws on invalid yaml content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-rd-"));
    writeFileSync(join(dir, "review-decision.yaml"), "decision: garbage\n");
    await expect(
      loadReviewDecision(join(dir, "review-decision.yaml")),
    ).rejects.toThrow();
  });
});

describe("writeReviewDecision", () => {
  it("serializes back to YAML round-trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-rd-"));
    const path = join(dir, "review-decision.yaml");
    await writeReviewDecision(path, {
      runId: "run-1",
      domain: "apps/user",
      decision: "approved",
      required_changes: [],
      non_blocking_comments: [],
      out_of_scope_suggestions: [],
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    const reloaded = await loadReviewDecision(path);
    expect(reloaded.decision).toBe("approved");
    expect(reloaded.reviewer).toBe("alice");
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
npx vitest run tests/unit/core/review-decision-loader.test.ts
```
Expected: FAIL（module 未実装）。

- [ ] **Step 3: 実装**

`src/core/review-decision-loader.ts`:
```ts
import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import {
  ReviewDecisionFileSchema,
  type ReviewDecisionFile,
} from "./review-decision-schema.js";

export async function loadReviewDecision(
  path: string,
): Promise<ReviewDecisionFile> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return ReviewDecisionFileSchema.parse(parsed);
}

export async function writeReviewDecision(
  path: string,
  data: ReviewDecisionFile,
): Promise<void> {
  await writeFile(path, yamlStringify(data), "utf8");
}
```

- [ ] **Step 4: テスト合格を確認**

```bash
npx vitest run tests/unit/core/review-decision-loader.test.ts
```
Expected: 3 tests passed.

- [ ] **Step 5: コミット**

```bash
git add src/core/review-decision-loader.ts tests/unit/core/review-decision-loader.test.ts
git commit -m "feat(core): load/write review-decision.yaml with schema validation"
```

---

## Phase 1 — RunMeta に reviewer / reviewedAt

### Task 3: RunMeta フィールド追加

**Files:**
- Modify: `src/logging/run-log.ts`
- Test: `tests/unit/logging/run-log.test.ts` （既存テストに追加）

- [ ] **Step 1: 失敗テストを書く**

既存 `tests/unit/logging/run-log.test.ts` の末尾に追記:
```ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunLog, type RunMeta } from "../../../src/logging/run-log.js";

// (既存 META を再利用)

describe("createRunLog — reviewer fields", () => {
  it("setReviewerInfo updates reviewer + reviewedAt in meta.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-"));
    const log = await createRunLog({ runsDir: root, runId: META.runId, meta: META });
    await log.setReviewerInfo({ reviewer: "alice", reviewedAt: "2026-05-20T12:00:00Z" });
    const m = JSON.parse(readFileSync(join(log.runDir, "meta.json"), "utf8"));
    expect(m.reviewer).toBe("alice");
    expect(m.reviewedAt).toBe("2026-05-20T12:00:00Z");
  });
});
```

ファイル先頭の `META` 定義（既存）に `reviewer / reviewedAt` は **追加しない**。新規メソッドで埋める前提。

- [ ] **Step 2: 失敗を確認**

```bash
npx vitest run tests/unit/logging/run-log.test.ts
```
Expected: `setReviewerInfo is not a function` で FAIL。

- [ ] **Step 3: 実装**

`src/logging/run-log.ts` の `RunMeta` interface に追加:
```ts
export interface RunMeta {
  // ... 既存フィールド ...
  /** Reviewer のハンドル。review-decision.yaml で記入されたもの。null は未記入。 */
  reviewer?: string | null;
  /** ISO 8601 reviewed timestamp。review processor が auto-fill する。 */
  reviewedAt?: string | null;
}
```

`RunLog` interface に追加:
```ts
export interface RunLog {
  // ... 既存メソッド ...
  setReviewerInfo(p: {
    reviewer: string | null;
    reviewedAt: string;
  }): Promise<void>;
}
```

createRunLog の return 値内に追加:
```ts
async setReviewerInfo({ reviewer, reviewedAt }) {
  await updateMeta({ reviewer, reviewedAt });
},
```

- [ ] **Step 4: テスト合格を確認**

```bash
npx vitest run tests/unit/logging/run-log.test.ts
```
Expected: 既存 5 tests + 新規 1 test = 6 tests passed.

- [ ] **Step 5: typecheck**

```bash
npm run typecheck
```
Expected: pass。

- [ ] **Step 6: コミット**

```bash
git add src/logging/run-log.ts tests/unit/logging/run-log.test.ts
git commit -m "feat(logging): add reviewer/reviewedAt to RunMeta + setReviewerInfo"
```

---

## Phase 2 — Processor コアロジック

### Task 4: processReviewDecision 関数

**Files:**
- Create: `src/core/review-processor.ts`
- Test: `tests/unit/core/review-processor.test.ts`

- [ ] **Step 1: 失敗テストを書く**

`tests/unit/core/review-processor.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processReviewDecision } from "../../../src/core/review-processor.js";

interface FakeMeta {
  runId: string;
  repoId: string;
  repoPath: string;
  domain: string;
  workflow: string;
  baseBranch: string;
  baseSha: string;
  runBranch: string;
  status: string;
  safetyStatus?: string;
  ignoredUntrackedCount?: number;
  secretSuspectCount?: number;
  startedAt: string;
  finishedAt?: string;
  reviewer?: string | null;
  reviewedAt?: string | null;
}

function writeFakeRun(
  runsDir: string,
  runId: string,
  meta: Partial<FakeMeta>,
  decisionFile: Record<string, unknown>,
): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const fullMeta: FakeMeta = {
    runId,
    repoId: "mini-commerce",
    repoPath: "/tmp/mini",
    domain: "apps/user",
    workflow: "domain-coding",
    baseBranch: "main",
    baseSha: "abc",
    runBranch: "harness/x",
    status: "needs_review",
    startedAt: "2026-05-20T00:00:00Z",
    ...meta,
  };
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(fullMeta, null, 2));
  writeFileSync(join(runDir, "events.jsonl"), "");
  const decision = {
    runId,
    domain: fullMeta.domain,
    required_changes: [],
    non_blocking_comments: [],
    out_of_scope_suggestions: [],
    reviewer: null,
    reviewed_at: null,
    ...decisionFile,
  };
  const yamlLines = Object.entries(decision)
    .map(([k, v]) => {
      if (v === null) return `${k}: null`;
      if (Array.isArray(v))
        return v.length === 0 ? `${k}: []` : `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}`;
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join("\n");
  writeFileSync(join(runDir, "review-decision.yaml"), yamlLines + "\n");
  return runDir;
}

describe("processReviewDecision", () => {
  it("transitions needs_review → approved when decision=approved + reviewer set", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-A", {}, {
      decision: "approved",
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    const r = await processReviewDecision({ runsDir, runId: "run-A" });
    expect(r.previousStatus).toBe("needs_review");
    expect(r.newStatus).toBe("approved");
    expect(r.reviewer).toBe("alice");
    const meta = JSON.parse(
      readFileSync(join(runsDir, "run-A", "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("approved");
    expect(meta.reviewer).toBe("alice");
    expect(meta.reviewedAt).toBe("2026-05-20T12:00:00Z");
  });

  it("transitions to changes_requested and rejected likewise", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-B", {}, {
      decision: "changes_requested",
      reviewer: "bob",
      reviewed_at: "2026-05-20T13:00:00Z",
    });
    const r = await processReviewDecision({ runsDir, runId: "run-B" });
    expect(r.newStatus).toBe("changes_requested");

    writeFakeRun(runsDir, "run-C", {}, {
      decision: "rejected",
      reviewer: "carol",
      reviewed_at: "2026-05-20T14:00:00Z",
    });
    const r2 = await processReviewDecision({ runsDir, runId: "run-C" });
    expect(r2.newStatus).toBe("rejected");
  });

  it("auto-fills reviewed_at when null and writes back to file", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-D", {}, {
      decision: "approved",
      reviewer: "alice",
      reviewed_at: null,
    });
    const before = new Date().getTime();
    const r = await processReviewDecision({ runsDir, runId: "run-D" });
    const after = new Date().getTime();
    const ts = new Date(r.reviewedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    // file が書き戻されている
    const raw = readFileSync(
      join(runsDir, "run-D", "review-decision.yaml"),
      "utf8",
    );
    expect(raw).not.toMatch(/reviewed_at: null/);
  });

  it("rejects when decision is still pending", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-E", {}, { decision: "pending" });
    await expect(
      processReviewDecision({ runsDir, runId: "run-E" }),
    ).rejects.toThrow(/pending/);
  });

  it("rejects when current meta.status is not needs_review", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-F", { status: "approved" }, {
      decision: "approved",
      reviewer: "alice",
    });
    await expect(
      processReviewDecision({ runsDir, runId: "run-F" }),
    ).rejects.toThrow(/status is "approved"/);
  });

  it("rejects when runId in file does not match dir name", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-G", {}, {
      runId: "run-different",
      decision: "approved",
      reviewer: "alice",
    });
    await expect(
      processReviewDecision({ runsDir, runId: "run-G" }),
    ).rejects.toThrow(/runId/);
  });

  it("rejects when domain in file does not match meta.json", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-H", { domain: "apps/user" }, {
      domain: "apps/other",
      decision: "approved",
      reviewer: "alice",
    });
    await expect(
      processReviewDecision({ runsDir, runId: "run-H" }),
    ).rejects.toThrow(/domain/);
  });

  it("appends a review_processed event", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-I", {}, {
      decision: "approved",
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    await processReviewDecision({ runsDir, runId: "run-I" });
    const events = readFileSync(
      join(runsDir, "run-I", "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const ev = events.find((e) => e.type === "review_processed");
    expect(ev).toBeDefined();
    expect(ev?.decision).toBe("approved");
    expect(ev?.reviewer).toBe("alice");
  });

  it("returns a warning flag when reviewer is null", async () => {
    const runsDir = mkdtempSync(join(tmpdir(), "harness-rp-"));
    writeFakeRun(runsDir, "run-J", {}, {
      decision: "approved",
      reviewer: null,
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    const r = await processReviewDecision({ runsDir, runId: "run-J" });
    expect(r.reviewer).toBeNull();
    expect(r.warnings).toContain("reviewer field is null");
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
npx vitest run tests/unit/core/review-processor.test.ts
```
Expected: FAIL（module 未実装）。

- [ ] **Step 3: 実装**

`src/core/review-processor.ts`:
```ts
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunMeta, RunStatus } from "../logging/run-log.js";
import {
  loadReviewDecision,
  writeReviewDecision,
} from "./review-decision-loader.js";
import type { ReviewDecisionValue } from "./review-decision-schema.js";

export interface ProcessOpts {
  runsDir: string;
  runId: string;
  now?: Date;
}

export interface ProcessResult {
  runId: string;
  previousStatus: RunStatus;
  newStatus: RunStatus;
  reviewer: string | null;
  reviewedAt: string;
  warnings: string[];
}

const DECISION_TO_STATUS: Record<
  Exclude<ReviewDecisionValue, "pending">,
  RunStatus
> = {
  approved: "approved",
  changes_requested: "changes_requested",
  rejected: "rejected",
};

export async function processReviewDecision(
  opts: ProcessOpts,
): Promise<ProcessResult> {
  const runDir = join(opts.runsDir, opts.runId);
  const metaPath = join(runDir, "meta.json");
  const decisionPath = join(runDir, "review-decision.yaml");

  const meta = JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
  const decision = await loadReviewDecision(decisionPath);

  // 整合性
  if (decision.runId !== opts.runId) {
    throw new Error(
      `review-decision.yaml runId (${decision.runId}) does not match directory (${opts.runId})`,
    );
  }
  if (decision.domain !== meta.domain) {
    throw new Error(
      `review-decision.yaml domain (${decision.domain}) does not match meta.json domain (${meta.domain})`,
    );
  }
  if (decision.decision === "pending") {
    throw new Error(
      `decision is still pending in ${decisionPath}; reviewer must set it to approved | changes_requested | rejected`,
    );
  }
  if (meta.status !== "needs_review") {
    throw new Error(
      `run ${opts.runId} status is "${meta.status}", only needs_review can be processed`,
    );
  }

  const warnings: string[] = [];
  if (decision.reviewer === null) {
    warnings.push("reviewer field is null");
  }

  const newStatus = DECISION_TO_STATUS[decision.decision];
  const now = opts.now ?? new Date();
  const reviewedAt = decision.reviewed_at ?? now.toISOString();

  // 書き戻し: reviewed_at が null だった場合のみ
  if (decision.reviewed_at === null) {
    await writeReviewDecision(decisionPath, {
      ...decision,
      reviewed_at: reviewedAt,
    });
  }

  // meta 更新
  const updatedMeta: RunMeta = {
    ...meta,
    status: newStatus,
    reviewer: decision.reviewer,
    reviewedAt,
  };
  await writeFile(metaPath, `${JSON.stringify(updatedMeta, null, 2)}\n`, "utf8");

  // event 追記
  const event = {
    type: "review_processed",
    runId: opts.runId,
    decision: decision.decision,
    previousStatus: meta.status,
    newStatus,
    reviewer: decision.reviewer,
    reviewedAt,
  };
  await appendFile(
    join(runDir, "events.jsonl"),
    `${JSON.stringify(event)}\n`,
    "utf8",
  );

  return {
    runId: opts.runId,
    previousStatus: meta.status,
    newStatus,
    reviewer: decision.reviewer,
    reviewedAt,
    warnings,
  };
}
```

- [ ] **Step 4: テスト合格を確認**

```bash
npx vitest run tests/unit/core/review-processor.test.ts
```
Expected: 9 tests passed.

- [ ] **Step 5: typecheck**

```bash
npm run typecheck
```
Expected: pass。

- [ ] **Step 6: コミット**

```bash
git add src/core/review-processor.ts tests/unit/core/review-processor.test.ts
git commit -m "feat(core): processReviewDecision applies review-decision.yaml to meta.json"
```

---

## Phase 3 — CLI subcommand

### Task 5: harness review process subcommand

**Files:**
- Modify: `src/cli/run.ts`
- Test: `tests/integration/cli-review-process.test.ts`

- [ ] **Step 1: 失敗 integration test を書く**

`tests/integration/cli-review-process.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setupHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-cli-rp-"));
  mkdirSync(join(root, "runs/run-X"), { recursive: true });
  writeFileSync(
    join(root, "runs/run-X/meta.json"),
    JSON.stringify(
      {
        runId: "run-X",
        repoId: "t",
        repoPath: "/tmp/t",
        domain: "apps/user",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha: "abc",
        runBranch: "harness/x",
        status: "needs_review",
        startedAt: "2026-05-20T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "runs/run-X/events.jsonl"), "");
  writeFileSync(
    join(root, "runs/run-X/review-decision.yaml"),
    [
      "runId: run-X",
      "domain: apps/user",
      "decision: approved",
      "required_changes: []",
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      "reviewer: alice",
      "reviewed_at: 2026-05-20T12:00:00Z",
      "",
    ].join("\n"),
  );
  return root;
}

function run(
  args: string[],
  harnessRoot: string,
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: harnessRoot },
    }).toString();
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      status: err.status ?? 1,
    };
  }
}

describe("harness review process", () => {
  it("approves a needs_review run and updates meta + emits event", () => {
    const root = setupHarness();
    const { stdout, status } = run(
      ["review", "process", "--run-id", "run-X"],
      root,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/needs_review.*approved/);
    expect(stdout).toMatch(/reviewer=alice/);
    const meta = JSON.parse(
      readFileSync(join(root, "runs/run-X/meta.json"), "utf8"),
    );
    expect(meta.status).toBe("approved");
    const events = readFileSync(
      join(root, "runs/run-X/events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events[0]?.type).toBe("review_processed");
  });

  it("errors on pending decision", () => {
    const root = setupHarness();
    writeFileSync(
      join(root, "runs/run-X/review-decision.yaml"),
      [
        "runId: run-X",
        "domain: apps/user",
        "decision: pending",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: null",
        "reviewed_at: null",
        "",
      ].join("\n"),
    );
    const { stdout, status } = run(
      ["review", "process", "--run-id", "run-X"],
      root,
    );
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/pending/);
  });

  it("warns when reviewer is null but still processes", () => {
    const root = setupHarness();
    writeFileSync(
      join(root, "runs/run-X/review-decision.yaml"),
      [
        "runId: run-X",
        "domain: apps/user",
        "decision: approved",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: null",
        "reviewed_at: 2026-05-20T12:00:00Z",
        "",
      ].join("\n"),
    );
    const { stdout, status } = run(
      ["review", "process", "--run-id", "run-X"],
      root,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/warning.*reviewer field is null/i);
    const meta = JSON.parse(
      readFileSync(join(root, "runs/run-X/meta.json"), "utf8"),
    );
    expect(meta.status).toBe("approved");
  });
});
```

- [ ] **Step 2: 失敗を確認**

```bash
npx vitest run tests/integration/cli-review-process.test.ts
```
Expected: FAIL（subcommand 未実装）。

- [ ] **Step 3: CLI に subcommand 追加**

`src/cli/run.ts` の lock command の隣に追加（既存の `program.command("lock")` のブロックの直後）:

```ts
import { processReviewDecision } from "../core/review-processor.js";

// ... 既存 ...

const reviewCmd = program
  .command("review")
  .description("operate on review-decision.yaml under runs/<id>/");
reviewCmd
  .command("process")
  .description("apply review-decision.yaml to meta.status")
  .requiredOption("--run-id <id>", "target run identifier")
  .action(async (raw: Record<string, unknown>) => {
    const harnessRoot = getHarnessRoot();
    const paths = harnessPaths(harnessRoot);
    const result = await processReviewDecision({
      runsDir: paths.runsDir,
      runId: String(raw.runId),
    });
    for (const w of result.warnings) {
      process.stdout.write(`warning: ${w}\n`);
    }
    process.stdout.write(
      `run=${result.runId} ${result.previousStatus} → ${result.newStatus} reviewer=${result.reviewer ?? "(none)"} reviewedAt=${result.reviewedAt}\n`,
    );
  });
```

- [ ] **Step 4: テスト合格を確認**

```bash
npx vitest run tests/integration/cli-review-process.test.ts
```
Expected: 3 tests passed.

- [ ] **Step 5: 全テスト + typecheck**

```bash
npm run typecheck
npm test
```
Expected: 全 PASS（既存 132 + 新規 〜18 = 〜150）。

- [ ] **Step 6: コミット**

```bash
git add src/cli/run.ts tests/integration/cli-review-process.test.ts
git commit -m "feat(cli): add 'harness review process --run-id' subcommand"
```

---

## Phase 4 — Docs 更新

### Task 6: docs/specs を最新の挙動に合わせる

**Files:**
- Modify: `docs/specs/cli.md`
- Modify: `docs/specs/workflow.md`
- Modify: `docs/specs/overview.md`

- [ ] **Step 1: cli.md に review process を追記**

`docs/specs/cli.md` の `## harness lock release` セクションの **後ろ** に追加:

```markdown
## `harness review process`

`runs/<runId>/review-decision.yaml` の `decision` を読み、meta.status を遷移させる。

### Synopsis

```bash
harness review process --run-id <id>
```

### Options

| Option | Required | 説明 |
|--------|:--------:|------|
| `--run-id <id>` | ✅ | 対象 run の識別子 |

### 動作

1. `runs/<runId>/meta.json` を読み込み (`status` must be `needs_review`)
2. `runs/<runId>/review-decision.yaml` を読み込み (`decision` must be `approved` / `changes_requested` / `rejected`)
3. runId と domain の整合性を check
4. `reviewed_at` が null なら現在時刻を入れて yaml に書き戻し
5. `meta.json` の `status` / `reviewer` / `reviewedAt` を更新
6. `events.jsonl` に `review_processed` イベント追記

### Output

```
[warning: …]
run=<runId> needs_review → approved reviewer=alice reviewedAt=2026-05-20T12:00:00Z
```

reviewer が null の場合、warning を stdout に出力するが exit code は 0。

### Exit code

- `0`: 処理成功（reviewer null 警告含む）
- `1`: decision が pending / status が needs_review 以外 / runId or domain mismatch
- `2`: meta.json / review-decision.yaml が読めない、その他の予期しない例外
```

- [ ] **Step 2: workflow.md の status machine 図を更新**

`docs/specs/workflow.md` の status 遷移図を更新。`needs_review → approved/changes_requested/rejected` の遷移を「`harness review process` が起こす」と明記:

該当箇所:
```
   │            │              │                     ├─► approved (review-decision で外部更新; MVP では handler 無)
   │            │              │                     ├─► changes_requested (同上)
   │            │              │                     └─► rejected (同上)
```

を:
```
   │            │              │                     ├─► approved              ┐
   │            │              │                     ├─► changes_requested     ├─ harness review process
   │            │              │                     └─► rejected              ┘
```

に書き換え。

同ファイル `## artifact レイアウト` 直下の説明に追加:
```
`review-decision.yaml` を reviewer が編集した後、`harness review process --run-id <id>`
で meta.status を遷移させる。reviewer / reviewedAt が meta.json に同期され、
`review_processed` イベントが events.jsonl に追記される。
```

- [ ] **Step 3: overview.md の「できること」更新**

`docs/specs/overview.md` の `## できないこと（MVP の範囲外）` を変更:

```
- review-decision.yaml の処理（approved / changes_requested / rejected の状態遷移）
```

を削除し、`## できること` セクションの末尾に追加:

```
- `harness review process` で review-decision.yaml を読んで meta.status を遷移
  (approved / changes_requested / rejected)、reviewer と reviewedAt を記録、
  events.jsonl に review_processed を追記
```

- [ ] **Step 4: docs/reports/README.md の Finding registry は触らない**

review processor は new finding を生まないので registry に追加なし。

- [ ] **Step 5: 全テストと typecheck 最終確認**

```bash
npm run typecheck
npm test
```
Expected: 全 PASS。

- [ ] **Step 6: コミット**

```bash
git add docs/specs/cli.md docs/specs/workflow.md docs/specs/overview.md
git commit -m "docs(specs): document 'harness review process' subcommand"
```

---

## Self-review

**1. Spec coverage:**
- ✅ review-decision.yaml の load + validation（Task 1, 2）
- ✅ pending / mismatch のエラー（Task 4 の test）
- ✅ status 遷移 needs_review → approved/changes_requested/rejected（Task 4）
- ✅ reviewer / reviewedAt を meta.json に記録（Task 3, 4）
- ✅ reviewed_at の auto-fill + file 書き戻し（Task 4）
- ✅ review_processed event 追記（Task 4）
- ✅ CLI subcommand（Task 5）
- ✅ docs 更新（Task 6）
- ❌（意図的）`--force` で再 process / list 機能 / cleanup → 後続 plan
- ❌（意図的）`required_changes` を retry loop に流す → Phase 3

**2. Placeholder scan:**
- TBD / TODO / fill-in: なし
- "Similar to Task N": なし
- 「validation を追加」みたいな曖昧記述: なし

**3. Type consistency:**
- `ReviewDecisionFile` / `ReviewDecisionValue` を Task 1 で定義、Task 2 / 4 で再利用 → OK
- `RunMeta.reviewer / reviewedAt` を Task 3 で追加、Task 4 で使用 → OK
- `processReviewDecision` の opts / result は Task 4 で定義、Task 5 で使用 → OK
- 既存 `reporter/review-decision.ts` の型 export は Task 1 Step 5 で schema 経由に切り替え → 既存呼び出し元 (workflow-runner) の壊れ無いことを typecheck で確認

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-20-review-decision-processor.md`. Two execution options:

1. **Subagent-Driven (recommended)** - タスクごとに新しい subagent、レビューでバトンを渡す
2. **Inline Execution** - このセッション内で `superpowers:executing-plans` を使い、チェックポイントを置く

6 タスク・各々 TDD step で完結しており、内部の依存関係も明確（1→2→3→4→5→6 の順）。**Inline Execution** が向きそう（前 phase で機能した形）。

進め方を選んで下さい。
