# Phase 3: auto-merge — 設計

GOAL.md Phase 3。close-ready かつ consensus approved な PR を harness 主導で自動
マージする **opt-in（既定 OFF）** 機能。安全境界が最重要。

- base ref: `goal-phase2-close`
- 前提: Phase 2 の強化された consensus（quorum 込み approved）を merge gate に使う。
- 安全境界（GOAL_RULES.md §G）: 判定は決定論的（DB の事実のみ）、LLM 出力を根拠に
  しない、状態遷移は harness のみ、fail-closed。merge は破壊的なので慎重に。

---

## 3-1 merge gate 判定（pure）

`src/core/merge-gate.ts` に純関数 `evaluateMergeGate`。

```ts
export interface MergeGateConsensus {
  status: "pending" | "approved" | "changes_requested" | "rejected";
  /** 全 requirement の quorum を満たすか（latest-proposal は requirement 無し→true）。 */
  quorumSatisfied: boolean;
}

export interface MergeGateInput {
  autoMergeEnabled: boolean;   // 既定 OFF。false なら常に merge しない。
  closeReady: boolean;         // goal が close_ready（ConvergenceService）か。
  consensus: MergeGateConsensus | null; // active review_consensus（無ければ null）。
  humanApproved: boolean;      // human override approve があったか。
  ciGreen: boolean;            // PR の required checks が緑か（wiring が gh から取得）。
}

export type MergeBlockerReason =
  | "auto_merge_disabled"
  | "not_close_ready"
  | "consensus_not_approved"   // hard block → escalate 対象
  | "quorum_not_satisfied"     // hard block → escalate 対象
  | "ci_not_green";            // transient（pending）→ escalate しない

export interface MergeGateResult {
  canMerge: boolean;
  blockers: MergeBlockerReason[];
  /** hard block（人手が要る）か transient（待てば解消）か。fail-closed の分岐に使う。 */
  hardBlocked: boolean;
}
```

判定（決定論的・fail-closed）:
- `autoMergeEnabled === false` → `auto_merge_disabled`（hardBlocked=false: 単に無効）。
- `closeReady === false` → `not_close_ready`（hard）。
- 承認: `humanApproved === true` **または**
  （`consensus.status === "approved"` かつ `consensus.quorumSatisfied`）でなければ
  `consensus_not_approved` / `quorum_not_satisfied`（hard）。consensus が null かつ
  human approve 無し → `consensus_not_approved`（hard, fail-closed）。
- `ciGreen === false` → `ci_not_green`（transient）。
- `canMerge = blockers.length === 0`。`hardBlocked = blockers に hard reason を含む`。

LLM 出力は入力にしない。承認は consensus（quorum 込み）or human override のみ。

## 3-2 `gh pr merge` ラッパ（idempotent）

`src/core/gh-pr-publisher.ts` に `PrMerger` を追加（`pr-creator.ts` に interface）。

```ts
export interface PrMergeInputs {
  repoDir: string;
  prNumber: number;
  method: "squash" | "merge" | "rebase"; // 既定 squash
}
export interface PrMergeResult { merged: boolean; alreadyMerged: boolean; }
export interface PrMerger { merge(inputs: PrMergeInputs): Promise<PrMergeResult>; }
```

`createGhPrMerger(ghBin, timeoutMs)`:
- idempotency: 先に `gh pr view <n> --json state,mergedAt,headRefOid` で
  **既マージ検出** → merged なら `{ merged:true, alreadyMerged:true }`（再 merge
  しない）。
- **head SHA pin（安全境界・P0）**: merge は `gh pr merge <n> --match-head-commit
  <sha> --<method>` で **reviewed commit に固定**する。`expectedHeadSha` は
  `createPullRequest` が **commit + push した immutable な reviewed commit SHA**
  （`git rev-parse HEAD`、push 直前に worktree を fingerprint 検証済み）。PR 作成後に
  branch が未レビュー commit へ進んでも、merge は reviewed SHA を要求し `gh` が
  拒否 → 例外 → escalate（fail-closed）。reviewed SHA が不明なら merge しない。
  already-merged の idempotent no-op も、expected と異なる commit で merge 済みなら
  fail-closed（成功扱いにしない）。
- timeout / 子プロセス例外（EPIPE 等）は既存 `runGh`（spawn + SIGKILL timeout）で
  握る。timeout は `GhTimeoutError` で loud に失敗。

CI green は wiring 側 `createGhCiStatus`（`gh pr checks <n> --required`、**required
checks のみ**）。不確定（pending/失敗/timeout/error）は false=fail-closed。wiring は
**CI 判定前に head SHA を 1 度取得**し、それを CI 判定と merge pin の両方に紐づける
（CI 検証した commit と merge 対象 commit を一致させる）。merge wrapper 自体は CI を
見ない。

auto-merge opt-in 時は PR を **non-draft で作成**する（draft PR は merge 不可）。
通常（auto-merge OFF）は従来どおり draft。

## 3-3 orchestrator runner / CLI 統合

- `OrchestratorRunnerDeps` に **任意** `autoMerge?: { merger: PrMerger; ciStatus:
  (prNumber) => Promise<boolean>; method?: "squash"|"merge"|"rebase" }` を追加。
  未指定 = auto-merge 無効（既定 OFF）。
- `closeAndPr` runner の **PR 作成後** に auto-merge 段を追加（同一 terminal step）:
  1. `deps.autoMerge` が無ければ従来どおり（close + pr_created）。
  2. あれば gate 入力を **DB の事実**から収集: `closeReady`（再評価で true 確定済み）、
     `consensus`（`review_consensus` active の status + summary.requirements の
     quorumMet 全合致）、`humanApproved`（review_overrides）、`ciGreen`（
     `deps.autoMerge.ciStatus(prNumber)`）。
  3. `evaluateMergeGate` を評価。
     - `canMerge` → merger.merge を呼び、成功なら outcome `merged`。operation audit に
       記録。
     - `hardBlocked` → **merge せず escalate**（fail-closed、goal は escalated）。
     - transient（ci_not_green のみ）→ merge せず PR を残す（outcome `pr_created`、
       escalate しない。GitHub 側 / 次回判定に委ねる）。
- 新 outcome `merged` を `OrchestrationOutcome` に追加。
- CLI `harness goal orchestrate` に `--auto-merge`（既定 OFF）+ `--merge-method`
  を追加。flag ON 時のみ `deps.autoMerge` を組み立てる（`createGhPrMerger` +
  `gh pr checks` ベースの ciStatus）。

## 3-4 安全境界の固め

- merge は「consensus approved（quorum 達成）or 人間 approve」を必須（gate で強制）。
- gate hard 未達なら merge せず escalate（fail-closed）。
- merge 操作を **operation audit**（`operations` / `startOperation` →
  `succeedOperation` / `failOperation`、operationType=`merge`, targetType=`pr`,
  targetId=prNumber）に記録。
- MCP `confirmation_required` の dangerous-operation 経路は迂回しない（本機能は
  orchestrator/CLI の opt-in flag であり、MCP 経由の自動 merge は本 Phase 範囲外）。

## テスト（TDD・回帰禁止）

- `tests/unit/core/merge-gate.test.ts`: gate の全分岐（disabled / not close-ready /
  consensus 未承認 / quorum 未達 / human approve / ci 未green / 全充足）。
- `tests/integration/gh-pr-publisher.test.ts` 拡張 or 新 merger テスト: 既マージ
  検出（再 merge しない）、timeout loud（fake gh）。
- orchestrator: auto-merge OFF が既定で merge しない / gate 達成で merge / hard 未達で
  escalate / ci 未green で pr 残す、を fake merger で検証。
- フルスイート + typecheck 緑。

## close 条件（GOAL.md Phase 3）

- [ ] フルスイート + typecheck 緑、回帰なし
- [ ] 未解決 P0 ゼロ
- [ ] gate 未達で merge しない / gate 達成で merge する 両方に TDD テスト
- [ ] auto-merge が既定 OFF であることのテスト
- [ ] `docs/specs/overview.md` / `goal-convergence.md` の Non-Goals（auto-merge）を
      実装済みに更新、`docs/specs/workflow.md` 等に挙動を記載
