# #230 Deliberation Jury 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** issue #230 の合議制 classification jury を「独立提案 → 証拠決定論チェック → 相互批判 → 敵対反証 → 単調 fail-closed 決定論ゲート」の 5-stage 熟議パイプラインとして実装し、Stage 1–5 を v31 で監査永続化、escalate を consultant 級 MCDA 決定パケットに格上げする。

**Architecture:** classify runner を 3 フェーズ DB 分離（snapshot → DB閉で LLM 熟議 → DB再open で再検証＋永続化＋判定）にする。LLM 出力（提案/批判/反証）は append-only 入力テーブルにのみ載り、状態遷移は決定論ゲート `aggregateDeliberation`（純関数・単調 fail-closed）の結果だけが駆動する。証拠は `verifyEvidence`（決定論 IO・実在のみ保証）で機械検証し、brand 型で未検証証拠を gate に渡せなくする。

**Tech Stack:** TypeScript / better-sqlite3 (DB-canonical `.harness/harness.sqlite`) / vitest / zod (parse schema) / CodexExecRunner (DI, テストは `createFakeCodexRunner()`).

**正本コントラクト:** 型・DDL・安全不変条件・RACI の全文は
[`design-230-deliberation-deepened.md`](./design-230-deliberation-deepened.md)（特に §0.1 v3.1 確定事項・付録 P プロンプト契約）。
凍結 base は [`design-gate-specs.md`](./design-gate-specs.md)（aggregateJuryVotes/auditSeverity §1/§3）・
[`design-db-persistence.md`](./design-db-persistence.md)（DB backbone）・
[`design-230-classification-jury-severity-packet.md`](./design-230-classification-jury-severity-packet.md)（frozen v2）。
本計画と設計が矛盾したら **design doc §0.1 が優先**。

**規律:** TDD（RED→GREEN→REFACTOR）。サブ Phase = 関連テスト + `npm run typecheck` 緑。大 Phase = `npx vitest run`(フル) + typecheck 緑。
Conventional Commits（attribution なし）。各 task 末尾で commit。`base = origin/main`（v0.7.14, schema v30）。branch `feat/230-deliberation-jury`。

---

## File Structure

**新規（`src/hitch/jury/`）:**
- `jury/types.ts` — Raw/VerifiedJuryEvidence・JuryClassificationProposal・RefuterVerdict・DeliberationInput/Result・JuryProposerDeps・JuryLens・EvidenceCheckContext
- `jury/aggregation.ts` — `aggregateJuryVotes`(凍結移植) ＋ `aggregateDeliberation`(深掘り) ＋ `selectFinalRound`（純）
- `jury/evidence.ts` — `verifyEvidence`（決定論 IO）
- `jury/severity-audit.ts` — `auditSeverity`（凍結移植・純）
- `jury/decision-packet.ts` — `buildJurySplitPacket`/`buildOperatorOriginPacket`/`buildSeverityAuditPacket`（純）
- `jury/proposer.ts` — `generateJuryProposals`(Stage1)
- `jury/critique.ts` — `runCritiqueRound`(Stage3)
- `jury/refuter.ts` — `runClassificationRefuter`(Stage4)
- `jury/deliberate.ts` — Stage1–5 統括（メモリ）

**新規（DB）:**
- `src/db/migrations.ts` に `MIGRATION_V31_STATEMENTS`（3 表 CREATE + index）
- `src/db/repositories/jury-classification-proposals.ts`
- `src/db/repositories/jury-classification-refutations.ts`
- `src/db/repositories/jury-severity-audits.ts`
- `src/db/jury-consistency.ts` — `assertFindingHitchConsistency`（3 repo 共有）

**修正:**
- `src/db/schema.ts`（`SCHEMA_VERSION 30→31`・3 DDL 定数・`V31_TABLE_NAMES`・`ALL_TABLE_NAMES` union）
- `src/db/doctor.ts`（jury 整合 check・category union）
- `src/hitch/types.ts`（`HitchDecisionPacket` v2・`HitchNextAction.decisionPacket?`・`ClassifyRunnerResult` 再export）
- `src/hitch/orchestrator-types.ts`（`classify` 戻り型を `ClassifyRunnerResult` に）
- `src/hitch/orchestrator-runners.ts`（classify runner 3 フェーズ化）
- `src/hitch/orchestrator.ts`（WI-9b/D2b: escalate/non-escalating packet 記録）
- `src/hitch/convergence.ts`（任意: 直接 escalate に additive packet）
- docs: `docs/specs/hitch-convergence.md` / `workflow.md` / `db.md` / `mcp.md` / `cli.md` / `GOAL_RULES.md`

**テスト:** `tests/unit/hitch/jury/*.test.ts` / `tests/unit/db/*.test.ts` / `tests/unit/hitch/orchestrator-runners.test.ts` / `tests/integration/hitch-orchestrate.test.ts`。production は `deps.reviewerRunner`、テストは `createFakeCodexRunner()`（events/stdout に proposal JSON を書く）。

---

# Layer 0 — DB 基盤（v31）

### Task A1: v31 migration（3 表 + index + version bump + union 健全性）

**Files:**
- Modify: `src/db/schema.ts`（`SCHEMA_VERSION`, 3 DDL 定数, `V31_TABLE_NAMES`, `ALL_TABLE_NAMES`）
- Modify: `src/db/migrations.ts`（`MIGRATION_V31_STATEMENTS`, `MIGRATIONS` append）
- Test: `tests/unit/db/migration-v31.test.ts`

DDL は design §6.2 + §0.1 R2/R4 の全文を使う（`jury_classification_proposals` は round/evidence_json/refutation_condition/uncertainty/vote_changed/critique_json/`deliberation_id` 追加・business-key=`(finding_id,lens,reviewer_id,round,prompt_sha256)`；`jury_classification_refutations` は target_scope/refute_verdict/counter_evidence_json/`deliberation_id`；`jury_severity_audits` は frozen + `jury_votes_json` + `deliberation_id`）。**全表 FK ゼロ**。

- [ ] **Step 1: RED — migration テスト**

```ts
// tests/unit/db/migration-v31.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations, LATEST_SCHEMA_VERSION } from "../../../src/db/migrations.js";
import { ALL_TABLE_NAMES } from "../../../src/db/schema.js";

const V31_TABLES = [
  "jury_classification_proposals",
  "jury_classification_refutations",
  "jury_severity_audits",
];

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

describe("v31 migration", () => {
  it("LATEST_SCHEMA_VERSION is 31", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(31);
  });

  it("fresh v1->v31 creates the 3 jury tables and records version 31", () => {
    const db = freshDb();
    runMigrations(db);
    const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[];
    expect(applied.at(-1)?.version).toBe(31);
    for (const t of V31_TABLES) {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      expect(row, `table ${t} must exist`).toBeTruthy();
    }
  });

  it("v31 tables have ZERO foreign keys (backbone P1-1)", () => {
    const db = freshDb();
    runMigrations(db);
    for (const t of V31_TABLES) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${t})`).all();
      expect(fks, `${t} must have no FK`).toHaveLength(0);
    }
  });

  it("ALL_TABLE_NAMES includes the 3 v31 tables and matches sqlite_master", () => {
    const db = freshDb();
    runMigrations(db);
    for (const t of V31_TABLES) expect(ALL_TABLE_NAMES).toContain(t);
    const live = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    for (const t of V31_TABLES) expect(live.has(t)).toBe(true);
  });

  it("idempotent: second runMigrations is a no-op", () => {
    const db = freshDb();
    runMigrations(db);
    const before = db.prepare("SELECT count(*) c FROM schema_migrations").get() as { c: number };
    runMigrations(db);
    const after = db.prepare("SELECT count(*) c FROM schema_migrations").get() as { c: number };
    expect(after.c).toBe(before.c);
  });

  it("schema_migrations.name for v31 matches expected (R12: same-number collision guard)", () => {
    const db = freshDb();
    runMigrations(db);
    const row = db.prepare("SELECT name FROM schema_migrations WHERE version=31").get() as { name: string };
    expect(row.name).toBe("epic228_deliberation_v31");
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/unit/db/migration-v31.test.ts`
Expected: FAIL（`LATEST_SCHEMA_VERSION` は 30 / 表が無い）

- [ ] **Step 3: GREEN — schema.ts**

`src/db/schema.ts`: `export const SCHEMA_VERSION = 31;`。design §6.2/§0.1 の 3 DDL を `MIGRATION_V31_PROPOSALS_SQL` 等の const として定義（または migrations.ts に直書き）。
`export const V31_TABLE_NAMES = ["jury_classification_proposals","jury_classification_refutations","jury_severity_audits"] as const;`
`ALL_TABLE_NAMES` union 末尾に `...V31_TABLE_NAMES` を append。

- [ ] **Step 4: GREEN — migrations.ts**

```ts
// src/db/migrations.ts
export const MIGRATION_V31_STATEMENTS: readonly string[] = [
  // design-230-deliberation-deepened.md §6.2 + §0.1 R2/R4 の全 DDL（3 CREATE TABLE + 各 index）
  // 全表 FK 句なし。business-key UNIQUE INDEX を含む。deliberation_id 列を 3 表に含む。
  /* jury_classification_proposals CREATE + 3 index */,
  /* jury_classification_refutations CREATE + 2 index */,
  /* jury_severity_audits CREATE + jury_votes_json + 2 index */,
];
// MIGRATIONS 配列末尾に append:
//   { version: 31, name: "epic228_deliberation_v31", statements: MIGRATION_V31_STATEMENTS }
```

- [ ] **Step 5: Run GREEN + typecheck**

Run: `npx vitest run tests/unit/db/migration-v31.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts src/db/migrations.ts tests/unit/db/migration-v31.test.ts
git commit -m "feat(db): v31 migration for deliberation jury audit tables (#230)"
```

---

### Task A2: jury repositories（insert・business-key dedup・finding_id→hitch_id 整合）

**Files:**
- Create: `src/db/jury-consistency.ts`, `src/db/repositories/jury-classification-proposals.ts`, `.../jury-classification-refutations.ts`, `.../jury-severity-audits.ts`
- Test: `tests/unit/db/jury-repositories.test.ts`

- [ ] **Step 1: RED — repository テスト**

```ts
// tests/unit/db/jury-repositories.test.ts （抜粋・全 case を書く）
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import { JuryClassificationProposalRepository } from "../../../src/db/repositories/jury-classification-proposals.js";

function dbWithFinding(hitchId: string, findingId: string) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // hitch_sessions / hitch_findings に最小行を挿入（既存 helper か直 INSERT）
  // finding_id=findingId, hitch_id=hitchId で hitch_findings に 1 行
  return db;
}

describe("JuryClassificationProposalRepository", () => {
  it("insert persists a round-1 proposal with evidence_json and deliberation_id", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationProposalRepository(db);
    repo.insert({
      findingId: "f1", hitchId: "h1", lens: "correctness", reviewerId: "r1",
      proposedScope: "in_scope", proposalStatus: "complete", round: 1,
      evidence: [{ citation: "src/a.ts:10", kind: "file", claim: "x", verified: true }],
      promptSha256: "abc", deliberationId: "d1", createdAt: "2026-01-01T00:00:00Z",
    });
    const rows = db.prepare("SELECT * FROM jury_classification_proposals WHERE finding_id=?").all("f1");
    expect(rows).toHaveLength(1);
  });

  it("business-key dedup: same (finding,lens,reviewer,round,prompt_sha256) inserted twice -> 1 row", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationProposalRepository(db);
    const base = { findingId: "f1", hitchId: "h1", lens: "correctness" as const, reviewerId: "r1",
      proposedScope: "in_scope" as const, proposalStatus: "complete" as const, round: 1 as const,
      evidence: [], promptSha256: "same", deliberationId: "d1", createdAt: "2026-01-01T00:00:00Z" };
    repo.insert(base);
    repo.insert(base); // INSERT OR IGNORE on business key
    const c = db.prepare("SELECT count(*) c FROM jury_classification_proposals WHERE finding_id=?").get("f1") as { c: number };
    expect(c.c).toBe(1);
  });

  it("round 1 and round 2 are separate rows (business key includes round)", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new JuryClassificationProposalRepository(db);
    const base = { findingId: "f1", hitchId: "h1", lens: "correctness" as const, reviewerId: "r1",
      proposedScope: "in_scope" as const, proposalStatus: "complete" as const,
      evidence: [], promptSha256: "p", deliberationId: "d1", createdAt: "2026-01-01T00:00:00Z" };
    repo.insert({ ...base, round: 1 });
    repo.insert({ ...base, round: 2, voteChanged: false });
    const c = db.prepare("SELECT count(*) c FROM jury_classification_proposals WHERE finding_id=?").get("f1") as { c: number };
    expect(c.c).toBe(2);
  });

  it("rejects insert when finding_id->hitch_id mismatch (R5/P2f fail-closed)", () => {
    const db = dbWithFinding("h1", "f1"); // f1 belongs to h1
    const repo = new JuryClassificationProposalRepository(db);
    expect(() => repo.insert({
      findingId: "f1", hitchId: "WRONG", lens: "correctness", reviewerId: "r1",
      proposedScope: "in_scope", proposalStatus: "complete", round: 1,
      evidence: [], promptSha256: "p", deliberationId: "d1", createdAt: "2026-01-01T00:00:00Z",
    })).toThrow(/hitch_id mismatch/i);
  });
});
// 同様に JuryClassificationRefutationRepository（target_scope/refute_verdict, dedup, hitch 整合）と
// JurySeverityAuditRepository（jury_votes_json round-trip, dedup, hitch 整合）の RED を書く。
```

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/unit/db/jury-repositories.test.ts`
Expected: FAIL（repository 未実装）

- [ ] **Step 3: GREEN — `jury-consistency.ts`**

```ts
// src/db/jury-consistency.ts
import type Database from "better-sqlite3";
export function assertFindingHitchConsistency(db: Database.Database, findingId: string, hitchId: string): void {
  const row = db.prepare("SELECT hitch_id FROM hitch_findings WHERE finding_id=?").get(findingId) as { hitch_id: string } | undefined;
  if (row === undefined) throw new Error(`jury insert: finding_id ${findingId} not found (fail-closed)`);
  if (row.hitch_id !== hitchId) throw new Error(`jury insert: hitch_id mismatch for finding ${findingId}: stored=${row.hitch_id} given=${hitchId}`);
}
```

- [ ] **Step 4: GREEN — 3 repositories**

各 repo は immutable input → `INSERT OR IGNORE`（business-key UNIQUE で dedup）。insert 前に `assertFindingHitchConsistency`。`evidence`/`jury_votes`/`counterEvidence` は `JSON.stringify`。design §0.1 R1（proposer は verified を持たない、verified は verifyEvidence のみ）に従い、proposal の evidence_json は **VerifiedJuryEvidence**（verifyEvidence 通過後）を保存する。

- [ ] **Step 5: Run GREEN + typecheck**

Run: `npx vitest run tests/unit/db/jury-repositories.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/jury-consistency.ts src/db/repositories/jury-*.ts tests/unit/db/jury-repositories.test.ts
git commit -m "feat(db): jury audit repositories with business-key dedup and finding->hitch consistency (#230)"
```

---

### Task A3: doctor 拡張（orphan / hitch_id 整合 / packet↔proposals / auto_confirm 正当性再検証 / import-export DB-only）

**Files:**
- Modify: `src/db/doctor.ts`（category union・新 check）
- Test: `tests/unit/db/jury-doctor.test.ts`, `tests/unit/db/jury-import-export.test.ts`

実装 checks（design §0.1 R11/P2b/P2h）:
1. orphan（finding/run/hitch 消滅後も残る jury 行）→ advisory（FK ゼロゆえ親 purge 後も残るのが正・doctor が報告）。
2. hitch_id 整合（stored vs join）→ advisory。
3. refutation↔proposals: `target_scope` == proposals の unanimous scope / packet.refuter と保存 refutation 一致。
4. **auto_confirm 正当性再検証（P2b）**: jury 由来確定 finding について保存済み proposals(round 選択)/refutations から `aggregateDeliberation` を再実行し `decision==='auto_confirm'` を満たすか → 満たさねば**強い finding**。
5. DELETE repair は dry-run default + operator 承認（既存 repair gate）。

- [ ] **Step 1: RED — doctor + import/export テスト**（orphan 検出 / hitch_id 不整合 / packet↔proposals 不整合 / **import reset 後も v31 行が残る（fresh のみ空）** / backup 包含 / FK ゼロで親削除しても詰まらない）
- [ ] **Step 2: Run RED** — `npx vitest run tests/unit/db/jury-doctor.test.ts tests/unit/db/jury-import-export.test.ts` → FAIL
- [ ] **Step 3: GREEN** — doctor category に `'review'` 流用 or 新カテゴリ、`recommended_next_action` を TS パースする新 check 形（SQL 単独でない）。consistency.ts / import-files.ts RESET list は変更しない（DB-only）。
- [ ] **Step 4: Run GREEN + typecheck** → PASS
- [ ] **Step 5: Commit**

```bash
git commit -am "feat(db): doctor checks for jury audit integrity + auto_confirm re-verification (#230)"
```

---

# Layer 1 — 純粋決定論コア

### Task B1: 型定義（jury/types.ts + hitch/types.ts additive）

**Files:** Create `src/hitch/jury/types.ts`; Modify `src/hitch/types.ts`, `src/hitch/orchestrator-types.ts`; Test `tests/unit/hitch/jury/types.test.ts`（型レベルは tsd 不要・コンパイルで担保。簡単な構築テストのみ）

design §5.1/§5.2/§0.1 R1/R6/R7 の型を定義:
- `JuryLens`, `JURY_LENSES`, `RawJuryEvidence`, `VerifiedJuryEvidence`(brand), `JuryClassificationProposal`(VerifiedJuryEvidence を持つ・round/voteChanged/critique), `RefuterVerdict`, `DeliberationInput`(proposals: Verified... を含む), `DeliberationResult`(gateTrace), `JuryProposerDeps`, `EvidenceCheckContext`, `HitchDecisionPacket`(packetVersion:2), `ClassifyRunnerResult`。
- `src/hitch/types.ts`: `HitchNextAction.decisionPacket?: HitchDecisionPacket`（additive）。
- `src/hitch/orchestrator-types.ts`: `classify(hitchId): Promise<ClassifyRunnerResult>`。

- [ ] **Step 1-2:** RED（`HitchNextAction` に decisionPacket を付けたオブジェクトが構築でき、既存 `recommendedNextAction` round-trip が壊れない最小テスト） → 実行 FAIL
- [ ] **Step 3:** GREEN（型追加）
- [ ] **Step 4:** `npm run typecheck` 緑（既存 import 元の compile を壊さない）
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): jury deliberation types (raw/verified evidence, packet v2, ClassifyRunnerResult) (#230)"`

---

### Task B2: `aggregateJuryVotes`（凍結移植・純）

**Files:** Create `src/hitch/jury/aggregation.ts`; Test `tests/unit/hitch/jury/aggregation.test.ts`

凍結 gate-specs §1/§2.3 のエッジケース表を **そのまま RED に移植**（unanimous=length3∧lens distinct∧同一scope∧判定不能ゼロ / 2-1/1-1-1/lens重複/欠落/4票/空/timeout/unknown混在 → split / confidence 無視 / reason 固定順文字列 / 同入力→同出力）。

- [ ] **Step 1: RED**

```ts
// tests/unit/hitch/jury/aggregation.test.ts （aggregateJuryVotes 部分・gate-specs §2.3 全行）
import { describe, it, expect } from "vitest";
import { aggregateJuryVotes } from "../../../../src/hitch/jury/aggregation.js";

const P = (lens: any, scope: any, status: any = "complete") =>
  ({ findingId: "f", lens, proposedScope: scope, proposalStatus: status, evidence: [], round: 2 as const });

describe("aggregateJuryVotes (frozen contract)", () => {
  it("3 distinct lenses, same in_scope, all complete -> unanimous in_scope", () => {
    const r = aggregateJuryVotes([P("correctness","in_scope"),P("scope_fit","in_scope"),P("spec_adherence","in_scope")]);
    expect(r.decision).toBe("unanimous"); expect(r.scope).toBe("in_scope");
  });
  it("duplicate lens -> split", () => {
    expect(aggregateJuryVotes([P("correctness","in_scope"),P("correctness","in_scope"),P("spec_adherence","in_scope")]).decision).toBe("split");
  });
  it("one timeout -> split (isInconclusive)", () => {
    expect(aggregateJuryVotes([P("correctness","in_scope"),P("scope_fit","in_scope"),P("spec_adherence","in_scope","timeout")]).decision).toBe("split");
  });
  it("scope split 2-1 -> split with fixed-order reason", () => {
    const r = aggregateJuryVotes([P("correctness","in_scope"),P("scope_fit","in_scope"),P("spec_adherence","out_of_scope")]);
    expect(r.decision).toBe("split");
    expect(r.reason).toBe("split votes: in_scope(2), out_of_scope(1), unknown(0), incomplete(0)");
  });
  it("confidence does not drive decision; deterministic (same input twice -> equal)", () => {
    const ps = [P("correctness","in_scope"),P("scope_fit","in_scope"),P("spec_adherence","in_scope")];
    expect(aggregateJuryVotes(ps)).toEqual(aggregateJuryVotes(ps));
  });
  // …gate-specs §2.3 の残ケース（length1/length4/空/unknown混在）も網羅
});
```

- [ ] **Step 2:** Run RED → FAIL
- [ ] **Step 3:** GREEN（gate-specs §2.2 ロジックを純関数実装。`isInconclusive`・lens distinct・固定順 reason）
- [ ] **Step 4:** `npx vitest run tests/unit/hitch/jury/aggregation.test.ts && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): aggregateJuryVotes deterministic scope aggregation (#230)"`

---

### Task B3: `aggregateDeliberation` + `selectFinalRound`（深掘りゲート・純・★単調 fail-closed の中核）

**Files:** Modify `src/hitch/jury/aggregation.ts`; Test `tests/unit/hitch/jury/deliberation-gate.test.ts`

design §4.2 + §0.1 R1(allHaveVerifiedEvidence 述語)/R8(selectFinalRound)。**この task が安全境界の心臓部**。

- [ ] **Step 1: RED — 単調 fail-closed の不変条件**

```ts
// tests/unit/hitch/jury/deliberation-gate.test.ts
import { describe, it, expect } from "vitest";
import { aggregateDeliberation, selectFinalRound } from "../../../../src/hitch/jury/aggregation.js";

const v = (citation = "src/a.ts:1") => ({ citation, kind: "file" as const, claim: "c", verified: true });
const P = (lens: any, scope: any, opts: any = {}) =>
  ({ findingId: "f", lens, proposedScope: scope, proposalStatus: "complete",
     evidence: opts.evidence ?? [v()], round: opts.round ?? 2 });
const unanimous = () => [P("correctness","in_scope"),P("scope_fit","in_scope"),P("spec_adherence","in_scope")];

describe("aggregateDeliberation (monotonic fail-closed)", () => {
  it("unanimous + all-verified + refuter uphold -> auto_confirm", () => {
    const r = aggregateDeliberation({ findingId: "f", proposals: unanimous(),
      refuterVerdict: { refuteVerdict: "uphold", reasoning: "x" } });
    expect(r.decision).toBe("auto_confirm"); expect(r.scope).toBe("in_scope");
    expect(r.gateTrace).toMatchObject({ scopeUnanimous: true, allHaveVerifiedEvidence: true, refuterUpheld: true });
  });
  it("split can NEVER become auto_confirm even if refuter uphold", () => {
    const split = [P("correctness","in_scope"),P("scope_fit","in_scope"),P("spec_adherence","out_of_scope")];
    const r = aggregateDeliberation({ findingId: "f", proposals: split,
      refuterVerdict: { refuteVerdict: "uphold", reasoning: "x" } });
    expect(r.decision).toBe("escalate");
  });
  it("refuter refute/inconclusive vetoes unanimous", () => {
    for (const verdict of ["refute","inconclusive"] as const) {
      const r = aggregateDeliberation({ findingId: "f", proposals: unanimous(),
        refuterVerdict: { refuteVerdict: verdict, reasoning: "x" } });
      expect(r.decision).toBe("escalate");
    }
  });
  it("refuter undefined (not run) -> escalate", () => {
    expect(aggregateDeliberation({ findingId: "f", proposals: unanimous() }).decision).toBe("escalate");
  });
  it("any proposal missing a verified evidence -> escalate (allHaveVerifiedEvidence false)", () => {
    const weak = [P("correctness","in_scope",{ evidence: [] }),P("scope_fit","in_scope"),P("spec_adherence","in_scope")];
    const r = aggregateDeliberation({ findingId: "f", proposals: weak,
      refuterVerdict: { refuteVerdict: "uphold", reasoning: "x" } });
    expect(r.decision).toBe("escalate"); expect(r.gateTrace.allHaveVerifiedEvidence).toBe(false);
  });
  it("evidence with verified=false (unresolved citation) does not count", () => {
    const weak = [P("correctness","in_scope",{ evidence: [{ citation:"nope", kind:"file", claim:"c", verified:false }] }),
      P("scope_fit","in_scope"),P("spec_adherence","in_scope")];
    expect(aggregateDeliberation({ findingId:"f", proposals: weak, refuterVerdict:{refuteVerdict:"uphold",reasoning:"x"} }).decision).toBe("escalate");
  });
  it("deterministic: same input twice -> equal result", () => {
    const input = { findingId: "f", proposals: unanimous(), refuterVerdict: { refuteVerdict: "uphold" as const, reasoning: "x" } };
    expect(aggregateDeliberation(input)).toEqual(aggregateDeliberation(input));
  });
});

describe("selectFinalRound (deterministic round selection)", () => {
  it("picks round=2 per lens when critique ran", () => {
    const r1 = [P("correctness","in_scope",{round:1}),P("scope_fit","in_scope",{round:1}),P("spec_adherence","in_scope",{round:1})];
    const r2 = [P("correctness","out_of_scope",{round:2}),P("scope_fit","out_of_scope",{round:2}),P("spec_adherence","out_of_scope",{round:2})];
    const sel = selectFinalRound([...r1, ...r2]);
    expect(sel.every(p => p.round === 2)).toBe(true); expect(sel).toHaveLength(3);
  });
  it("picks round=1 when no round=2 exists (critique skipped)", () => {
    const r1 = [P("correctness","in_scope",{round:1}),P("scope_fit","in_scope",{round:1}),P("spec_adherence","in_scope",{round:1})];
    expect(selectFinalRound(r1).every(p => p.round === 1)).toBe(true);
  });
  it("never mixes R1 and R2 for the gate (selected set is single-round per lens, fail-closed on missing)", () => {
    const mixed = [P("correctness","in_scope",{round:2}),P("scope_fit","in_scope",{round:1})]; // lens incomplete
    const sel = selectFinalRound(mixed);
    // aggregateJuryVotes(sel) must be split (length<3 / lens missing) — verified downstream
    expect(sel.length).toBeLessThan(3);
  });
});
```

- [ ] **Step 2:** Run RED → FAIL
- [ ] **Step 3: GREEN**

```ts
// src/hitch/jury/aggregation.ts （aggregateDeliberation + selectFinalRound 部分）
import { JURY_LENSES } from "./types.js";
import type { JuryClassificationProposal, DeliberationInput, DeliberationResult, RefuterVerdict } from "./types.js";

export function selectFinalRound(proposals: readonly JuryClassificationProposal[]): JuryClassificationProposal[] {
  const out: JuryClassificationProposal[] = [];
  for (const lens of JURY_LENSES) {
    const forLens = proposals.filter((p) => p.lens === lens);
    if (forLens.length === 0) continue; // missing lens -> downstream aggregateJuryVotes returns split
    const r2 = forLens.find((p) => p.round === 2);
    out.push(r2 ?? forLens.find((p) => p.round === 1)!);
  }
  return out;
}

function proposalHasVerifiedEvidence(p: JuryClassificationProposal): boolean {
  return p.evidence.length > 0
    && p.evidence.every((e) => e.verified !== undefined)
    && p.evidence.some((e) => e.verified === true);
}

export function aggregateDeliberation(input: DeliberationInput): DeliberationResult {
  const agg = aggregateJuryVotes(input.proposals);
  const scopeUnanimous = agg.decision === "unanimous";
  const lensDistinct = new Set(input.proposals.map((p) => p.lens)).size === input.proposals.length
    && input.proposals.length === 3;
  const noInconclusive = scopeUnanimous; // aggregateJuryVotes already enforces this for unanimous
  const allHaveVerifiedEvidence = input.proposals.length > 0 && input.proposals.every(proposalHasVerifiedEvidence);
  const refuterUpheld = input.refuterVerdict === undefined ? null : input.refuterVerdict.refuteVerdict === "uphold";
  const gateTrace = { scopeUnanimous, lensDistinct, noInconclusive, allHaveVerifiedEvidence, refuterUpheld };

  const pass = scopeUnanimous && lensDistinct && noInconclusive && allHaveVerifiedEvidence && refuterUpheld === true;
  if (pass) {
    return { decision: "auto_confirm", scope: agg.scope, reason: `auto_confirm ${agg.scope} (deliberation upheld)`, gateTrace };
  }
  return { decision: "escalate", reason: `escalate: ${agg.reason}`, gateTrace };
}
```

- [ ] **Step 4:** Run GREEN + typecheck → PASS
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): aggregateDeliberation monotonic fail-closed gate + selectFinalRound (#230)"`

---

### Task B4: `auditSeverity`（凍結移植・純・advisory-only）

**Files:** Create `src/hitch/jury/severity-audit.ts`; Test `tests/unit/hitch/jury/severity-audit.test.ts`

gate-specs §3 の RED（aligned/diverged/inconclusive・strict majority・tie→inconclusive・harnessSeverity 不変返却・同入力→同出力・自動降格なし）を移植。

- [ ] **Step 1-2:** RED → FAIL（gate-specs §3 RED 全件）
- [ ] **Step 3:** GREEN（gate-specs §3.2 純関数）
- [ ] **Step 4:** `npx vitest run tests/unit/hitch/jury/severity-audit.test.ts && npm run typecheck` → PASS
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): auditSeverity advisory-only deterministic audit (#230)"`

---

### Task B5: `verifyEvidence`（決定論 IO・実在のみ保証）

**Files:** Create `src/hitch/jury/evidence.ts`; Test `tests/unit/hitch/jury/evidence.test.ts`

design §4.4 + §0.1 R1（LLM 申告 verified を破棄して再計算）+ P3 kind×境界。`EvidenceCheckContext = { worktreePath, compiledPolicy, specDocsGlobs? }`。

- [ ] **Step 1: RED — kind×境界 + LLM verified 破棄**

```ts
// tests/unit/hitch/jury/evidence.test.ts （抜粋）
// fixture worktree を tmp に作り src/x.ts(5行) と docs/specs/foo.md(## Bar) を置く
it("file kind: existing path+line in range -> verified true", () => { /* … */ });
it("file kind: existing path but line out of range -> verified false (P3)", () => { /* … */ });
it("file kind: non-existent path -> verified false", () => { /* … */ });
it("spec kind: existing md heading anchor -> verified true; missing anchor -> false", () => { /* … */ });
it("policy kind: glob matches compiled policy scope -> verified true; zero match -> false", () => { /* … */ });
it("R1: LLM-supplied verified=true on a non-existent citation is DISCARDED -> verified false", () => {
  const out = verifyEvidence({ citation: "nope.ts:1", kind: "file", claim: "c", verified: true } as any, ctx);
  expect(out.verified).toBe(false);
});
it("deterministic: same evidence+ctx twice -> equal", () => { /* … */ });
```

- [ ] **Step 2:** Run RED → FAIL
- [ ] **Step 3: GREEN** — `verifyEvidence(ev, ctx)`: 入力の `verified` を無視し、kind 別に決定論再計算（file=fs.stat + 行数；spec=md heading parse；policy=compiled policy scope/category lookup）。返り値は `VerifiedJuryEvidence`（`{citation,kind,claim,verified,resolvedRef}`）。
- [ ] **Step 4:** Run GREEN + typecheck → PASS
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): verifyEvidence deterministic existence check, discards LLM-claimed verified (#230)"`

---

### Task B6: decision-packet formatters（純・v2 MCDA）

**Files:** Create `src/hitch/jury/decision-packet.ts`; Test `tests/unit/hitch/jury/decision-packet.test.ts`

design §5.2 + §0.1 R6/R7/P3（formatter↔decisionKind 対応表）。`buildJurySplitPacket`/`buildOperatorOriginPacket`/`buildSeverityAuditPacket`。

- [ ] **Step 1: RED** — packet v2 が `findings(summary/detail)`・`evaluationAxes(lensVotes: scope+proposalStatus+evidence+voteChanged)`・`deliberation(critiqueRan/refuter/gateTrace)`・`recommendation.action∈{classify_manually,review_split,review_severity}`・`rejectedProposals/minorityView/riskFlags/unvalidatedAssumptions(←unverified 証拠)/nextActions(owner=operator)/severityAudit?` を満たす / `packetVersion:2` / JSON round-trip / message に JSON を詰めない / **packetVersion:1 を読む reader が壊れない**（discriminated reader テストは Layer3 reader で）。
- [ ] **Step 2:** Run RED → FAIL
- [ ] **Step 3:** GREEN（純 formatter。splits/operator/severity から v2 packet 構築。unverified 証拠を unvalidatedAssumptions へ）
- [ ] **Step 4:** Run GREEN + typecheck → PASS
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): MCDA decision packet v2 formatters (#230)"`

---

# Layer 2 — LLM 提案/批判/反証（DB閉）

> 全 task: production は `deps.reviewerRunner`（CodexExecRunner）。テストは `createFakeCodexRunner()` で events/stdout に proposal JSON を書き、parse 経路を検証。**付録 P の出力契約**（必須フィールド・空批判 reject）を zod strict schema で実装。fail-closed（exit≠0/timeout/parse 失敗 → proposalStatus∈{timeout,parse_error,inconclusive}）。

### Task C1: `generateJuryProposals`（Stage1・3 lens 独立提案 + 証拠検証）

**Files:** Create `src/hitch/jury/proposer.ts`; Test `tests/unit/hitch/jury/proposer.test.ts`

- [ ] **Step 1: RED** — 3 lens 別プロンプトで起動 / DB 非書込 / parse schema は `verified`/`resolvedRef` を**受理しない**（R1）/ 各 evidence を `verifyEvidence` に通して VerifiedJuryEvidence にする / fail-closed（timeout→timeout, parse 失敗→parse_error, evidence ゼロ→検証可能ゼロ）/ logPaths/auditDir 書込。
- [ ] **Step 2:** Run RED → FAIL
- [ ] **Step 3:** GREEN（§3.5 JuryProposerDeps contract・events/stdout から zod strict parse → RawJuryEvidence → verifyEvidence → VerifiedJuryEvidence・proposalStatus 設定）
- [ ] **Step 4:** Run GREEN + typecheck → PASS
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): jury proposer (Stage1) with evidence verification, fail-closed (#230)"`

### Task C2: `runCritiqueRound`（Stage3・条件起動・収束しても confirm しない）

**Files:** Create `src/hitch/jury/critique.ts`; Test `tests/unit/hitch/jury/critique.test.ts`

- [ ] **Step 1: RED** — 起動条件（R1 split or 弱証拠=`evidenceStrength` 決定論述語 P2c）/ R1→R2 で vote 変更可・voteChanged 記録 / **空/定型 objection は reject→proposalStatus=inconclusive**（付録 P・R9）/ 各 objection は他者提案ごとに ≥1 / 出力は round=2 proposals。
- [ ] **Step 2-4:** RED→GREEN→typecheck
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): jury critique round (Stage3) conditional, anti-ritualization contract (#230)"`

### Task C3: `runClassificationRefuter`（Stage4・批判後 unanimous 時のみ）

**Files:** Create `src/hitch/jury/refuter.ts`; Test `tests/unit/hitch/jury/refuter.test.ts`

- [ ] **Step 1: RED** — 批判後 unanimous ∧ 全証拠検証済 のときだけ起動 / verdict∈{uphold,refute,inconclusive} / **uphold でも whyNotFalseConsensus・refutationConditions 必須、欠落→inconclusive**（R9）/ fail-closed（timeout/parse/exit≠0→inconclusive）/ counterEvidence は advisory（gate 非駆動）。
- [ ] **Step 2-4:** RED→GREEN→typecheck
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): adversarial classification refuter (Stage4), uphold requires justification (#230)"`

### Task C4: `deliberate.ts`（Stage1–5 統括・メモリ）

**Files:** Create `src/hitch/jury/deliberate.ts`; Test `tests/unit/hitch/jury/deliberate.test.ts`

design §2 + §0.1 R8/P2j。統括: propose → verifyEvidence(C1 内) → (条件)critique → (unanimous時)refute → `selectFinalRound` → `aggregateDeliberation`。**gate 直前で「全 proposal が VerifiedJuryEvidence のみ」を assert**（R1 不変条件）。critique skip 時は R1 を最終ラウンド・refuter に voteChanged 渡さない（P2j）。

- [ ] **Step 1: RED** — clean unanimous+強証拠→critique skip→refuter→auto_confirm / split→critique→なお split→escalate（refuter 不起動）/ 批判後収束→refuter uphold→auto_confirm / 批判後収束→refuter refute→escalate / deliberationId 一貫 / 全 stage の構造化結果（proposals R1/R2・refutation・severityAudit）を返す。
- [ ] **Step 2-4:** RED→GREEN→typecheck（fake runner 注入）
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): deliberate pipeline (Stage1-5 orchestration, in-memory) (#230)"`

---

# Layer 3 — 統合

### Task D1: classify runner 3 フェーズ化 + source filter + deliberate + Phase3 永続化

**Files:** Modify `src/hitch/orchestrator-runners.ts`（classify runner）, `src/hitch/orchestrator-types.ts`; Test `tests/unit/hitch/orchestrator-runners.test.ts`

design §7.1 + §0.1 R5(部分前進)/P2i(batch cap)/P2k(skip finding も永続化)。

- [ ] **Step 1: RED** — operator-origin は heuristic も jury も通さず即 escalate packet 同梱（R5）/ harness-origin heuristic 確定は即書込・jury bypass / なお unknown を deliberate→auto_confirm は Phase3 で classifyFinding / split→ClassifyRunnerResult{resolved:false,decision:escalate,recommendedNextAction.decisionPacket} / Phase2 で DB 閉（proposer 呼出時に DB handle 解放）/ Phase3 stale finding skip だが**生成済み proposals/refutation/severity 行は永続化**（P2k）/ jury 専用 batch cap で残 unknown は次 cycle（P2i）。
- [ ] **Step 2-4:** RED→GREEN→typecheck
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): classify runner 3-phase deliberation + audit persistence + partial-progress operator-origin (#230)"`

### Task D2: orchestrator WI-9b（escalate 前に packet 永続化）

**Files:** Modify `src/hitch/orchestrator.ts`; Test `tests/unit/hitch/orchestrator.test.ts`

design §7.2 + §0.1 R3。`!r.resolved` のとき escalate return の前に `recordConvergenceDecisionWithStatus({decision:'escalate', reason, metrics, recommendedNextAction(decisionPacket 含む), createdBy})`。

- [ ] **Step 1: RED** — classify split escalate 時に `hitch_convergence_decisions.recommended_next_action.decisionPacket` が DB に serialize される（読み戻し assert）/ status が escalated に同期 / `kind/message/findingIds` 常時 populate。
- [ ] **Step 2-4:** RED→GREEN→typecheck
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): persist decision packet before classify escalate (WI-9b) (#230)"`

### Task D2b: non-escalating severity packet 記録（R3・updateStatus:false）

**Files:** Modify `src/hitch/orchestrator.ts`, `src/hitch/convergence-status.ts`(updateStatus option 確認); Test `tests/unit/hitch/orchestrator.test.ts`

- [ ] **Step 1: RED** — `resolved:true ∧ severityAuditPacket≠null` のとき `recordConvergenceDecisionWithStatus({updateStatus:false, recommendedNextAction.decisionPacket})` で **hitch status 不変・packet 永続化**。scope unanimous + severity diverged で status が escalated にならないことを assert。
- [ ] **Step 2-4:** RED→GREEN→typecheck（`recordConvergenceDecisionWithStatus` が `updateStatus:false` を受けない場合は option 追加）
- [ ] **Step 5: Commit** `git commit -am "feat(hitch): non-escalating severity-audit packet recording (D2b) (#230)"`

### Task D3（任意）: convergence 直接 escalate に additive packet

**Files:** Modify `src/hitch/convergence.ts`; Test `tests/unit/hitch/convergence.test.ts`
- [ ] P0/budget/divergence の直接 escalate にも decisionPacket を additive 付与可能に（既存挙動不変）。RED→GREEN→commit。

### Task D4: integration e2e（hitch-orchestrate）

**Files:** Test `tests/integration/hitch-orchestrate.test.ts`
- [ ] needs_classification→classify→(fake reviewerRunner で)deliberate→auto_confirm で loop 継続 / split→escalate＋packet が DB 永続化 / scope unanimous + severity diverged→分類確定＋severityAudit packet が DB に残る / **packetVersion:1 既存行を v2 reader が壊さず読む**（R6 discriminated reader）。RED→GREEN→commit。

### Task D5: 回帰スイート

**Files:** Test `tests/unit/hitch/convergence.test.ts`, `tests/unit/hitch/fixture-matrix.test.ts`(convergence-only), `tests/unit/hitch/review-integration.test.ts`
- [ ] P0/budget/divergence は jury 不通過 / heuristic 確定は jury bypass / operator-origin は機械分類なし / 固定 severity 不変・close gate 不変・自動降格なし / 既存スイート緑（弱めない）。`npx vitest run`(フル) + typecheck 緑。commit。

---

# Layer 4 — docs（同コミット原則・該当 src 変更と同じ PR）

### Task E1: hitch-convergence.md
- [ ] 5-stage pipeline / RACI(design §8) / packet v2 format / severity precedence(mapping authoritative・jury advisory) / **単調 fail-closed 不変条件** / verifyEvidence は実在のみ(関連性限界)。commit。

### Task E2: workflow.md / db.md / mcp.md / cli.md / GOAL_RULES.md
- [ ] workflow.md: jury 起動条件(harness-origin unknown・orchestrate 駆動のみ)・3 フェーズ・batch cap・escalate packet 構造。
- [ ] db.md: v31 3 表(DB-only/no-FK/business-key/deliberation_id)・**最終 DDL 全文**(P2d)・import で残る(fresh のみ空)。
- [ ] mcp.md/cli.md: **standalone classify_finding は jury 非適用**(R13)・override は guarded mutation。
- [ ] GOAL_RULES.md: provenance footprint 規約・提案/判定分離。commit。

---

## Self-Review

**Spec coverage（design §11 受け入れ条件 → task）:**
1. jury 不一致→必ず escalate = B3(monotonic) + D1 + D4 ✓
2. severity 決定論 = B4 ✓
3. escalate payload 統合フォーマット＋永続化 = B6 + D2 + D4 ✓
4. divergence/fail-closed/severity 回帰なし = D5 ✓
5. docs 同コミット = E1/E2 ✓
6. Stage1-5 永続化＋doctor 監査 = A1/A2/A3 + D1 ✓
7. サブ/大 Phase 緑 = 各 task の typecheck + D5 のフル ✓

**§0.1 P1 → task:** R1=B5/C1/B3, R2=A1/D2b, R3=D2b, R4=A1/A2, R5=D1, R6=B6/D4, R7=B1/B6, R8=B3, R9=C2/C3(付録P), R10=A1, R11=A3, R12=A1, R13=D1/E2 ✓

**Type consistency:** `VerifiedJuryEvidence` を gate(B3)/proposer(C1)/packet(B6)/repo(A2) で一貫。`ClassifyRunnerResult` を B1 定義・D1/D2 使用。`deliberationId` を A1(DDL)/A2(repo)/C4(生成)/D1(配線) で一貫。

**Placeholder scan:** DDL 全文・型全文は design doc に凍結（本計画は参照）。LLM 層(C1-C4)は fake-runner パターンで RED 全文化を実装時に展開（付録 P の strict schema を zod で）。これらは「design で凍結済みを参照」であり TBD ではない。

---

## Execution Handoff

実行は **subagent-driven-development**（task ごと fresh subagent + 2 段レビュー）を推奨。ただしプロジェクト規約（[`CLAUDE.md`](../../CLAUDE.md) / coding-via-codex-exec）では **実装の駆動は codex exec gpt-5.5、レビュー正本も codex** が基線。本計画は ops ハーネス駆動・dev クローン target の鉄則下で、layer 単位（DB→core→LLM→統合→docs）に codex 実装＋多角レビューで land する。
