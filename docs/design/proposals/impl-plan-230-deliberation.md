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

## 計画 v1.1 改訂（多角レビュー反映・確定事項）

> 本計画を **codex xhigh ＋ Opus 計画レビュワー 5体**（設計忠実性/RED質/実装可能性/task分解/完全性）でレビュー。
> **全 6 レビュアー GO-with-fixes・P0 ゼロ**（中核の単調 fail-closed ゲートは実コード裏取りで健全）。
> 以下は確定対処。**本節は本文 task の該当箇所を上書きする（矛盾時は本節が優先）**。

### PR1（必須）決定論的近接性フィルタ（設計 §0.1 R1）を実装 — Task B1/B3/B5/C4/D1
設計 R1 が auto_confirm の証拠条件に AND を命じた近接性フィルタが全 task に欠落（4 レビュアー合意）。実装:
- `DeliberationInput` に `finding: { filePath?: string; category?: string }` を追加（B1）。`HitchFinding` は filePath/category を持つ（裏取り済み）ので D1 で配線。
- B3 に決定論述語 `evidenceProximityOk(e: VerifiedJuryEvidence, finding): boolean` を追加し `allHaveVerifiedEvidence` に AND:
  - `e.kind==='file'`: `finding.filePath` があり、citation path が `finding.filePath` の **先頭2パスセグメント prefix を共有** → true。`finding.filePath` 無し → **false（fail-closed）**。
  - `e.kind∈{'spec','policy'}`: `finding.category` があり citation の domain/category が一致 → true。`finding.category` 無し → **false（fail-closed）**。
  - 「実在するが無関係ドメインの citation」は verified=true でも proximity=false → escalate（安全を緩めず厳格化する向き）。
- `gateTrace` に `proximityOk: boolean` を追加。RED:「verified だが finding と無関係ドメインの citation のみ → escalate / finding.filePath 無し → escalate」。

### PR2（必須）`selectFinalRound` を fail-closed 化（R8）— Task B3
`r2 ?? r1` 混在・lens 重複黙殺・`!` 非null断定を排除。**確定実装**:
```ts
export function selectFinalRound(proposals: readonly JuryClassificationProposal[]): JuryClassificationProposal[] {
  const targetRound: 1 | 2 = proposals.some((p) => p.round === 2) ? 2 : 1; // R2 が1件でもあれば全 lens R2 を要求
  const out: JuryClassificationProposal[] = [];
  for (const lens of JURY_LENSES) {
    const forLens = proposals.filter((p) => p.lens === lens && p.round === targetRound);
    // 1件のみ正常。0件(欠落)/2件以上(重複)はそのまま push し、下流 aggregateJuryVotes が
    //   length!==3 または lens 非distinct で split → escalate（fail-closed）。R1/R2 混在も targetRound 限定で排除。
    out.push(...forLens);
  }
  return out;
}
```
RED 追加:「correctness=R2,scope_fit=R2,spec_adherence=R1（部分R2混在）→ 選択集合 length<3 → 下流 split」「同一 lens に R2 2件 → length>3/重複 → split」「lens 欠落 → length<3 → split」。

### PR3（必須）`deliberation_id` を packet・型・生成関数に配置（R4）— Task B1/B6/D1/D2/A3
- B1: `HitchDecisionPacket.deliberationId: string`（必須）/ `DeliberationInput.deliberationId` / `DeliberationResult` 経由で運ぶ。
- 新純関数 `computeDeliberationId(hitchId, findingId, gateInputSha256): string`（`aggregation.ts` または `jury/ids.ts`）。RED: 同入力→同 ID・決定論。`gateInputSha256` は最終ラウンド proposals + refuter verdict の canonical JSON sha256。
- B6: formatter が packet に `deliberationId` を載せる。D1: 3 表 insert 時に同一 `deliberationId` を渡す（A1 DDL の `deliberation_id` 列・既出）。
- D2/D4: read-back で `recommended_next_action.decisionPacket.deliberationId` を assert。A3 doctor: packet↔proposals/refutations 照合を **`deliberation_id` 基準**に。

### PR4（必須）Layer2 テストは prompt-routing inline fake runner — Task C1/C2/C3/C4 前段
`createFakeCodexRunner()` は run() 全呼び出しに単一固定 stdout を返すため 3 lens/3 stage の差分応答を作れない（3 レビュアー合意）。**確定方針**: Layer2 は `input.prompt`（lens 名/stage 名を含む）で discriminate する **inline カスタム `CodexExecRunner`**（`tests/unit/core/reviewer-agent.test.ts` の capturingRunner / `reviewed-run-workflow.test.ts` の `async run(input)` パターン）を使う。`createFakeCodexRunner` は degenerate（全 lens 同一）ケースのみ。
- C1 前段 step:「prompt の lens トークン規約（例 prompt に `[[lens:correctness]]`）を決め、lens 別 JSON を返す test helper `routingRunner(map)` を `tests/unit/hitch/jury/_fake-jury-runner.ts` に作る」。RED で `split`（1 lens だけ out_of_scope）・`unanimous`・vote-change・refuter verdict 別を注入可能にする。

### PR5（必須）付録P 契約の RED を本文コード化 — Task C1/C2/C3/B5/B6
省略記法（`/* … */`）をやめ、儀式化防止契約を exact-assert RED で本文化:
- C1: `proposer evidence:[] → 検証可能ゼロ → proposalStatus=inconclusive` / `parse 失敗 → parse_error` / `parser は verified/resolvedRef を受理しない（与えても drop）`。
- C2: `critique 空 objections → reject → proposalStatus=inconclusive` / `各 objection が他者提案ごとに ≥1`。
- C3: `refuter whyNotFalseConsensus 欠落 → inconclusive` / `refutationConditions 欠落 → inconclusive` / `uphold でも両必須`。
- B5: kind×境界を exact-assert（file 行範囲外→false / spec anchor 不在・重複の決定論 / policy glob ゼロ→false / **R1: LLM verified=true を破棄→false**）。
- B6: `proposedSeverity を持つ proposal → packet.evaluationAxes[].lensVotes[].severity が round-trip`（R2 packet 側・下記 P3 packet severity と同件）。

### PR6（対応済み）packetVersion:1 discriminated reader の本体 code task = Task D6（Layer3 に追加済み）
R6 は「全 reader に packetVersion discriminate + optional chaining」を要求。**reader 本体の改修は Layer3 の `Task D6` で実施**（本計画 Layer3 に追加済み・Self-Review の R6→B6/D6 参照）。D4 は e2e integration test であり reader 本体改修は D6 が担う。Task D6 の手順（再掲）:
- reader 実体を grep（dashboard read API / MCP tools / CLI listDecisions のうち `recommended_next_action`/`decisionPacket` を読む箇所）。
- RED:「`packetVersion:1` 行（`deliberation`/`evidence` 欠落）を各 reader が壊さず読む（undefined fallback）」。GREEN: optional chaining + default。CLI/MCP threading が docs だけで code 不要かは grep 結果で判定。

### 主要 P2（実装計画に確定織り込み）
- **P2-a JURY_BATCH_LIMIT（Task D1）**: jury 専用 cap 定数を `orchestrator-runners.ts` に新設（既定値を明記・`FINDING_BATCH_LIMIT=200` 以下。per-finding 4〜7 codex 呼び出しを踏まえ小さめ）。heuristic 確定は既存 while-drain 維持、**jury 対象は cap 件のみ処理し残 unknown は `resolved:true` で次 cycle 持ち越し（no-progress escalate に誤って落とさない）**。RED:「unknown が cap 超 → cap 件だけ deliberate・残は次 cycle」。
- **P2-b evidenceStrength（Task B3 近傍）**: Stage3 起動条件「弱証拠」を決定論純関数 `isWeakEvidence(proposals): boolean`（`aggregation.ts`・例: いずれかの lens の proximate-verified 証拠件数 < 1）として定義場所・閾値を pin。doctor の critiqueRan 再計算（A3/P2b）が**同一関数**を import。RED: 境界値・同入力同出力。
- **P2-c noInconclusive を独立計算（Task B3）**: GREEN の `noInconclusive = scopeUnanimous` トートロジーをやめ、`input.proposals.length>0 && input.proposals.every(p => p.proposalStatus==='complete' && p.proposedScope!=='unknown')` で独立計算（gateTrace の独立監査軸に）。
- **P2-d pass 条件は aggregateJuryVotes に委譲（Task B3）**: auto_confirm の pass = `scopeUnanimous ∧ allHaveVerifiedEvidence(proximity込) ∧ refuterUpheld===true` のみ（lensDistinct/noInconclusive は scopeUnanimous が内包＝二重判定を排除）。gateTrace の lensDistinct/noInconclusive/proximityOk は**監査表示用**でコメント明記「判定権威は aggregateJuryVotes」。
- **P2-e B3 gateTrace 専用 RED（Task B3）**: 「duplicate lens + refuter uphold + 全証拠 verified → escalate ∧ gateTrace 各 field」「3 件全 inconclusive → escalate ∧ noInconclusive=false」を追加。
- **P2-f CompiledPolicy 型確定（Task B5 前段）**: `EvidenceCheckContext.compiledPolicy` の型を `RunDomainCodingOpts["compiledPolicy"]` の再 export か新 interface で確定してから policy-kind RED を書く。file/spec kind は fs/md fixture で先行可。
- **P2-g brand 型境界の compile テスト（Task B1/B3）**: `// @ts-expect-error RawJuryEvidence は VerifiedJuryEvidence に代入不可` の型 RED を追加し、未検証 evidence が gate に入らないことを型で証明。
- **P2-h A1 table-name 健全性を exact-match（Task A1）**: `CURRENT_TABLE_NAMES` と `sqlite_master`（`schema_migrations` 等を除く data table 集合）の exact match に強化（contains だけにしない）。
- **P2-i severity 回帰の専用 RED（Task B4/D5）**: 「severityAudit diverged でも `hitch_findings.severity` 不変かつ `closeRequires`（close 判定）に非波及」を専用 assert（既存スイート任せにしない）。
- **P2-j docs 同コミット（Task A1/D1/E）**: 最小限 A1↔db.md（v31 DDL/no-FK/deliberation_id）、D1↔workflow.md（3 フェーズ/batch cap）を各 task のコミットに同梱。E は残り docs。Layer4 ヘッダ文言を「同コミット（主要分）＋残りは同 PR」に正直化。

### P3（既存利用・文言修正・nit）
- **`updateStatus:false` は既存実装済み**（`convergence-status.ts:23,72-74`）。**doctor `review` category も既存**（`doctor.ts:28`）。D2b/A3 の「option/category 追加」というヘッジ文言を**削除**し「既存利用・配線のみ」に確定（調査 step を削る）。
- packet v2 `lensVotes.severity?: HitchFindingSeverity` を追加（R2 packet 側・PR5 B6 RED と同件）。
- R12 collision guard: name assert は維持しつつ「同一 version で別 name の migration を並べない運用規約 + レビュー gate」で担保（runMigrations の collision 検出強化は #230 スコープ外＝follow-up）と 1 文明記。
- selectFinalRound テストコメントを「lens ごとに targetRound 行を選ぶ。欠落/重複/部分R2混在は下流で split（fail-closed）」に修正。

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

DDL は design §6.2 + §0.1 R2/R4 の全文を使う（`jury_classification_proposals` は round/evidence_json/refutation_condition/uncertainty/vote_changed/critique_json/`deliberation_id` 追加・business-key=`(finding_id,lens,reviewer_id,round,prompt_sha256,deliberation_id)`；`jury_classification_refutations` は target_scope/refute_verdict/counter_evidence_json/`deliberation_id`・business-key=`(finding_id,target_scope,reviewer_id,prompt_sha256,deliberation_id)`；`jury_severity_audits` は frozen + `jury_votes_json` + `deliberation_id`・business-key=`(finding_id,prompt_sha256,deliberation_id)`）。**全表 FK ゼロ**。business-key に `deliberation_id` を含めることで retry を別行・packet と常に一致（R15）。

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
// tests/unit/hitch/jury/deliberation-gate.test.ts （v1.1 + codex#252 P1 反映: finding/proximity/partial-R2/gateTrace）
import { describe, it, expect } from "vitest";
import { aggregateDeliberation, selectFinalRound } from "../../../../src/hitch/jury/aggregation.js";

const FINDING = { filePath: "src/a.ts", category: "core" };
const v = (citation = "src/a.ts:1", kind = "file" as const, resolvedRef?: string) =>
  ({ citation, kind, claim: "c", verified: true, resolvedRef });
const P = (lens: any, scope: any, opts: any = {}) =>
  ({ findingId: "f", lens, proposedScope: scope, proposalStatus: opts.status ?? "complete",
     evidence: opts.evidence ?? [v()], round: opts.round ?? 2 });
const unanimous = () => [P("correctness","in_scope"),P("scope_fit","in_scope"),P("spec_adherence","in_scope")];
const D = (proposals: any, verdict?: any) =>
  ({ findingId: "f", deliberationId: "d1", finding: FINDING, proposals,
     ...(verdict ? { refuterVerdict: { refuteVerdict: verdict, reasoning: "x" } } : {}) });

describe("aggregateDeliberation (monotonic fail-closed)", () => {
  it("unanimous + proximate-verified + refuter uphold -> auto_confirm", () => {
    const r = aggregateDeliberation(D(unanimous(), "uphold"));
    expect(r.decision).toBe("auto_confirm"); expect(r.scope).toBe("in_scope");
    expect(r.gateTrace).toMatchObject({ scopeUnanimous: true, allHaveVerifiedEvidence: true, proximityOk: true, refuterUpheld: true });
  });
  it("split can NEVER become auto_confirm even if refuter uphold", () => {
    const split = [P("correctness","in_scope"),P("scope_fit","in_scope"),P("spec_adherence","out_of_scope")];
    expect(aggregateDeliberation(D(split, "uphold")).decision).toBe("escalate");
  });
  it("refuter refute/inconclusive vetoes unanimous", () => {
    for (const verdict of ["refute","inconclusive"] as const)
      expect(aggregateDeliberation(D(unanimous(), verdict)).decision).toBe("escalate");
  });
  it("refuter undefined (not run) -> escalate", () => {
    expect(aggregateDeliberation(D(unanimous())).decision).toBe("escalate");
  });
  it("any proposal missing a verified evidence -> escalate (allHaveVerifiedEvidence false)", () => {
    const weak = [P("correctness","in_scope",{ evidence: [] }),P("scope_fit","in_scope"),P("spec_adherence","in_scope")];
    const r = aggregateDeliberation(D(weak, "uphold"));
    expect(r.decision).toBe("escalate"); expect(r.gateTrace.allHaveVerifiedEvidence).toBe(false);
  });
  it("verified=false (unresolved citation) does not count -> escalate", () => {
    const weak = [P("correctness","in_scope",{ evidence: [{ citation:"nope", kind:"file", claim:"c", verified:false }] }),
      P("scope_fit","in_scope"),P("spec_adherence","in_scope")];
    expect(aggregateDeliberation(D(weak, "uphold")).decision).toBe("escalate");
  });
  it("PR1: verified but UNRELATED-domain citation only -> escalate (proximityOk false)", () => {
    const off = [P("correctness","in_scope",{ evidence: [v("vendor/x.ts:1")] }),
      P("scope_fit","in_scope",{ evidence: [v("vendor/y.ts:1")] }),
      P("spec_adherence","in_scope",{ evidence: [v("vendor/z.ts:1")] })];
    const r = aggregateDeliberation(D(off, "uphold"));
    expect(r.decision).toBe("escalate"); expect(r.gateTrace.proximityOk).toBe(false);
  });
  it("PR1: finding without filePath/category -> proximity fail-closed -> escalate", () => {
    const r = aggregateDeliberation({ findingId:"f", deliberationId:"d1", finding:{}, proposals: unanimous(),
      refuterVerdict:{ refuteVerdict:"uphold", reasoning:"x" } });
    expect(r.decision).toBe("escalate"); expect(r.gateTrace.proximityOk).toBe(false);
  });
  it("duplicate lens + refuter uphold -> escalate (gateTrace.lensDistinct false)", () => {
    const dup = [P("correctness","in_scope"),P("correctness","in_scope"),P("spec_adherence","in_scope")];
    const r = aggregateDeliberation(D(dup, "uphold"));
    expect(r.decision).toBe("escalate"); expect(r.gateTrace.lensDistinct).toBe(false);
  });
  it("all inconclusive -> escalate (gateTrace.noInconclusive false)", () => {
    const inc = [P("correctness","in_scope",{status:"timeout"}),P("scope_fit","in_scope",{status:"parse_error"}),
      P("spec_adherence","in_scope",{status:"inconclusive"})];
    const r = aggregateDeliberation(D(inc, "uphold"));
    expect(r.decision).toBe("escalate"); expect(r.gateTrace.noInconclusive).toBe(false);
  });
  it("deterministic: same input twice -> equal result", () => {
    const input = D(unanimous(), "uphold");
    expect(aggregateDeliberation(input)).toEqual(aggregateDeliberation(input));
  });
});

describe("selectFinalRound (deterministic, target-round only)", () => {
  it("picks round=2 for every lens when any R2 exists", () => {
    const r1 = [P("correctness","in_scope",{round:1}),P("scope_fit","in_scope",{round:1}),P("spec_adherence","in_scope",{round:1})];
    const r2 = [P("correctness","out_of_scope",{round:2}),P("scope_fit","out_of_scope",{round:2}),P("spec_adherence","out_of_scope",{round:2})];
    const sel = selectFinalRound([...r1, ...r2]);
    expect(sel.every(p => p.round === 2)).toBe(true); expect(sel).toHaveLength(3);
  });
  it("picks round=1 when no round=2 exists (critique skipped)", () => {
    const r1 = [P("correctness","in_scope",{round:1}),P("scope_fit","in_scope",{round:1}),P("spec_adherence","in_scope",{round:1})];
    expect(selectFinalRound(r1).every(p => p.round === 1)).toBe(true);
  });
  it("codex#252-P1: partial-R2 mix (2 lenses R2, 1 only R1) -> targetRound=2 drops R1 lens -> <3 -> downstream escalate", () => {
    const mix = [P("correctness","in_scope",{round:2}),P("scope_fit","in_scope",{round:2}),P("spec_adherence","in_scope",{round:1})];
    const sel = selectFinalRound(mix);
    expect(sel).toHaveLength(2); // spec_adherence (R1 only) dropped because targetRound=2 → no stale R1 in unanimous
    expect(aggregateDeliberation(D(sel, "uphold")).decision).toBe("escalate");
  });
  it("duplicate (lens,round) -> length>3 / non-distinct -> downstream escalate", () => {
    const dup = [P("correctness","in_scope",{round:2}),P("correctness","in_scope",{round:2}),
      P("scope_fit","in_scope",{round:2}),P("spec_adherence","in_scope",{round:2})];
    const sel = selectFinalRound(dup);
    expect(sel.length).toBeGreaterThan(3);
    expect(aggregateDeliberation(D(sel, "uphold")).decision).toBe("escalate");
  });
});
```

- [ ] **Step 2:** Run RED → FAIL
- [ ] **Step 3: GREEN**

```ts
// src/hitch/jury/aggregation.ts （aggregateDeliberation + selectFinalRound。v1.1 PR1/PR2/P2-c/P2-d + codex#252 P1 反映）
import { JURY_LENSES } from "./types.js";
import type { JuryClassificationProposal, VerifiedJuryEvidence, DeliberationInput, DeliberationResult } from "./types.js";

// PR2/codex#252-P1: target-round 限定。欠落/重複/部分R2混在は下流 aggregateJuryVotes で split（fail-closed）。
// R2 が1件でもあれば全 lens に R2 を要求（stale R1 が unanimous に混入しない）。
export function selectFinalRound(proposals: readonly JuryClassificationProposal[]): JuryClassificationProposal[] {
  const targetRound: 1 | 2 = proposals.some((p) => p.round === 2) ? 2 : 1;
  const out: JuryClassificationProposal[] = [];
  for (const lens of JURY_LENSES) {
    out.push(...proposals.filter((p) => p.lens === lens && p.round === targetRound));
  }
  return out; // length!==3 / lens 非distinct は aggregateJuryVotes が split→escalate
}

// PR1/codex#252-P1: 近接性フィルタ。citation の path/domain が finding の filePath/category と一致。
// finding メタ欠如は fail-closed（false）。file は行番号 suffix を除いて先頭2セグメント比較。
function evidenceProximityOk(e: VerifiedJuryEvidence, finding: DeliberationInput["finding"]): boolean {
  const seg = (p: string) => p.split(":")[0].split("/").slice(0, 2).join("/");
  if (e.kind === "file") return finding?.filePath !== undefined && seg(e.citation) === seg(finding.filePath);
  return finding?.category !== undefined && (e.resolvedRef ?? e.citation).includes(finding.category); // spec/policy
}

export function aggregateDeliberation(input: DeliberationInput): DeliberationResult {
  const agg = aggregateJuryVotes(input.proposals);
  const scopeUnanimous = agg.decision === "unanimous"; // 判定権威（lens distinct + 判定不能ゼロを内包）
  // gateTrace は監査表示用に独立計算（P2-c）。pass 判定は scopeUnanimous に委譲し二重判定を排除（P2-d）。
  const lensDistinct = new Set(input.proposals.map((p) => p.lens)).size === 3 && input.proposals.length === 3;
  const noInconclusive = input.proposals.length > 0
    && input.proposals.every((p) => p.proposalStatus === "complete" && p.proposedScope !== "unknown");
  const allHaveVerifiedEvidence = input.proposals.length > 0
    && input.proposals.every((p) => p.evidence.length > 0
      && p.evidence.every((e) => e.verified !== undefined)
      && p.evidence.some((e) => e.verified === true));
  const proximityOk = input.proposals.length > 0
    && input.proposals.every((p) => p.evidence.some((e) => e.verified === true && evidenceProximityOk(e, input.finding)));
  const refuterUpheld = input.refuterVerdict === undefined ? null : input.refuterVerdict.refuteVerdict === "uphold";
  const gateTrace = { scopeUnanimous, lensDistinct, noInconclusive, allHaveVerifiedEvidence, proximityOk, refuterUpheld };

  // PR1/PR2/P2-d: scopeUnanimous(aggregateJuryVotes 権威) ∧ verified ∧ proximate ∧ refuter uphold のみ auto_confirm。
  const pass = scopeUnanimous && allHaveVerifiedEvidence && proximityOk && refuterUpheld === true;
  if (pass) return { decision: "auto_confirm", scope: agg.scope, reason: `auto_confirm ${agg.scope} (deliberation upheld)`, gateTrace };
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

### Task D6: packetVersion discriminated reader 本体改修（v1.1 PR6 / codex#252 P2）

**Files:** grep で特定（dashboard read API / MCP tools / CLI listDecisions のうち `recommended_next_action`/`decisionPacket` を読む箇所）; Test 各 reader の unit
- [ ] **Step 1: grep** — `recommended_next_action` / `decisionPacket` を読む reader を列挙し、改修対象ファイルを確定。CLI/MCP threading が docs のみで code 不要かもここで判定。
- [ ] **Step 2: RED** — 「`packetVersion:1` 行（`deliberation`/`evidence`/`deliberationId` 欠落）を各 reader が壊さず読む（undefined fallback）」「`packetVersion:2` 行も読める」。
- [ ] **Step 3: GREEN** — 各 reader を `packetVersion` で discriminate + optional chaining + default fallback。
- [ ] **Step 4-5:** typecheck 緑 → commit。

---

# Layer 4 — docs（主要分は同コミット・残りは同 PR）

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

**§0.1 P1 → task:** R1=B5/C1/B3, R2=A1/D2b, R3=D2b, R4=A1/A2/B6, R5=D1, R6=B6/**D6**, R7=B1/B6, R8=B3, R9=C2/C3(付録P), R10=A1, R11=A3, R12=A1, R13=D1/E2 / R14(mixed-kind packet)=B6, R15(deliberation_id dedup)=A1/A2 ✓

**Type consistency:** `VerifiedJuryEvidence` を gate(B3)/proposer(C1)/packet(B6)/repo(A2) で一貫。`ClassifyRunnerResult` を B1 定義・D1/D2 使用。`deliberationId` を A1(DDL)/A2(repo)/C4(生成)/D1(配線) で一貫。

**Placeholder scan:** DDL 全文・型全文は design doc に凍結（本計画は参照）。LLM 層(C1-C4)は fake-runner パターンで RED 全文化を実装時に展開（付録 P の strict schema を zod で）。これらは「design で凍結済みを参照」であり TBD ではない。

---

## Execution Handoff

実行は **subagent-driven-development**（task ごと fresh subagent + 2 段レビュー）を推奨。ただしプロジェクト規約（[`CLAUDE.md`](../../CLAUDE.md) / coding-via-codex-exec）では **実装の駆動は codex exec gpt-5.5、レビュー正本も codex** が基線。本計画は ops ハーネス駆動・dev クローン target の鉄則下で、layer 単位（DB→core→LLM→統合→docs）に codex 実装＋多角レビューで land する。
