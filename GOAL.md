# GOAL.md — 実装ロードマップ

monorepo-harness を **goal モード**で自律実装させるための大 Phase / サブ Phase
定義。実行ルール（レビュー・close 条件・テスト粒度・ブランチ運用・安全境界）は
[`GOAL_RULES.md`](./GOAL_RULES.md) を参照。本ファイルは「何を作るか」を、
`GOAL_RULES.md` は「どう作るか」を定める。

- 各 **大 Phase** = feature branch 1 本 → CI green → main merge。
- 各 **サブ Phase** = 1〜数コミット（TDD で関連テスト + `npm run typecheck` 緑）。
- サブ Phase ごとに codex サブレビュー（最大 3 回）、大 Phase 完了時に codex 大
  レビュー（最大 5 回）。未解決 P0 ゼロが close の必須条件。

**実装順（確定）**: Phase 1 → 2 → 3 → 4。

> 各 Phase は着手前に spec / plan を用意する（spec 駆動）。下記の spec パスは
> 着手時に作成する想定の置き場所。

---

## スコープ確定メモ

- **含む**: 軽量保守 / consensus 拡張 / auto-merge / dashboard mutation UI。
- **含まない**:
  - **Copilot PR review 連携** — 2026-06 の実験で実際にレビューされず（アカウント
    /GitHub 側要因）。`docs/future-features.md` に保留。
  - **review consensus の基礎統合** — Phase 11 / 19 で実装・統合済み。本 GOAL では
    その「拡張」のみ扱う。
  - **重み付け投票** — consensus 拡張から除外（quorum / 鮮度 / エスカレーションのみ）。
  - **codex セッション継続** — 安全モデル（ステートレス）とのトレードオフがあり、
    `docs/future-features.md` に保留（spike 前提）。
  - **S3 blob adapter** — スキップ。

---

## Phase 1: 軽量保守（CI / 足回り）

**目的**: CI を Node 24 時代に備えて固め、以降の Phase の土台を安定させる。最小・
低リスクのウォームアップ Phase。

- **関連 spec/plan**: 軽微なため spec は省略可。変更点は CI 設定のみ。
- **base ref**: 現 main（`bce6761` 以降）
- **対象**: `.github/workflows/ci.yml`

### サブ Phase

- **1-1 Node 24 を CI に追加**
  - `node-version` を matrix 化（`["20", "24"]`）。native deps（`better-sqlite3` /
    `fs-ext`）が Node 24 で rebuild され、フルスイートが緑になることを確認。
  - 24 で落ちる場合は原因を切り分け、`20` 維持 + 24 を `continue-on-error` 等で
    段階導入するか判断（回帰禁止）。
- **1-2 actions / workflow 点検**
  - `actions/checkout@v4` / `actions/setup-node@v4` の妥当性確認。必要なら
    commit SHA pin・`permissions:` 最小化など軽微な hardening。
  - concurrency / timeout 設定の見直し（既存の cancel-in-progress は維持）。

### close 条件（Phase 1）
- [ ] フルスイート `npm test` + `npm run typecheck` 緑（CI 上、対象 Node 全バージョン）
- [ ] 未解決 P0 ゼロ
- [ ] CI 変更が docs（必要なら `docs/specs/` の CI 記述）に反映済み

---

## Phase 2: consensus 拡張

**目的**: review consensus を強化し、Phase 3（auto-merge）の安全な merge gate の
前提を作る。`evaluateConsensus`（`src/core/review-consensus.ts`）は pure function
なので TDD しやすい。状態遷移・永続化は harness 側（repository / orchestrator）。

- **関連 spec/plan**: `docs/superpowers/specs/2026-MM-DD-phaseN-consensus-extension-design.md`（着手時作成）
- **base ref**: Phase 1 完了タグ
- **現状の土台**: per-group `minApprovals` / `blockingDecisions` / human override /
  reviewer グループ は実装済み（`src/core/review-consensus.ts`、schema v7 の
  `reviewers` / `review_rules` / `review_consensus` / `review_overrides`）。
- **除外**: 重み付け投票。

### サブ Phase

- **2-1 quorum / 参加率**
  - `ReviewRule` の requirement に「グループ内最低参加人数」または「参加率」を
    追加（既存 `minApprovals` と独立）。`evaluateConsensus` の `requirements-met`
    判定に組み込み、quorum 未達なら `approved` にしない（`requirements-pending`）。
  - 後方互換: quorum 未指定の既存 rule は従来挙動を維持。
- **2-2 proposal 鮮度管理**
  - stale / supersede の概念を導入。再 review で置換された / 古い proposal を
    集計から除外する（supersede chain or stale 閾値）。`EnrichedProposal` と
    `evaluateConsensus` の集計ロジックに反映。
  - 鮮度判定の基準（時刻ベース / supersede 明示）は spec で確定し決定論的に。
- **2-3 エスカレーション連携**
  - consensus が「詰まった」状態（長期 pending / blocking 未解消 / quorum に届かず
    進展なし）を決定論的に検出し、goal orchestrator へエスカレーションを上げる。
  - 状態遷移は harness のみ（LLM 出力を根拠にしない）。`src/goal/review-integration.ts`
    / `src/goal/orchestrator-*.ts` と接続。fail-closed。

### close 条件（Phase 2）
- [ ] フルスイート + typecheck 緑、回帰なし（既存 consensus テスト含む）
- [ ] 未解決 P0 ゼロ
- [ ] quorum / 鮮度 / エスカレーションの新挙動に TDD のテスト
- [ ] `docs/superpowers/specs/...consensus-extension...` と関連 `docs/specs/` 更新

---

## Phase 3: auto-merge

**目的**: close-ready かつ consensus approved な PR を harness 主導で自動マージ。
安全境界が最重要。既定 OFF の opt-in 機能とする。

- **関連 spec/plan**: `docs/superpowers/specs/2026-MM-DD-phaseN-auto-merge-design.md`（着手時作成）
- **base ref**: Phase 2 完了タグ
- **現状の土台**: PR 作成（`src/core/pr-creator.ts` / `src/core/gh-pr-publisher.ts`）、
  close-ready 判定（`src/goal/convergence.ts` / close-checks）、`closeAndPr` runner
  （`src/goal/orchestrator-runners.ts`）は実装済み。merge 実行ロジックは未実装。
- **前提**: Phase 2 の強化された consensus（quorum 込み approved）を merge gate に使う。

### サブ Phase

- **3-1 merge gate 判定（pure）**
  - 「close-ready ∧ consensus approved（quorum 達成）∧ CI green」を満たすか判定
    する純関数を TDD で実装。判定根拠（どの条件が未達か）を構造化して返す。
  - LLM 出力を根拠にしない。判定は DB の事実のみから決定論的に行う。
- **3-2 `gh pr merge` ラッパ**
  - `src/core/gh-pr-publisher.ts` に idempotent な merge を追加（既マージ検出、
    merge method 指定、タイムアウト処理）。EPIPE 等の子プロセス例外を握る。
- **3-3 orchestrator runner / CLI 統合**
  - `closeAndPr` の後段に opt-in の `autoMerge` runner を追加（既定 OFF、flag で
    有効化）。状態遷移・記録は harness のみ。merge 後の goal 状態を確定。
- **3-4 安全境界の固め**
  - merge は「consensus approved（quorum 達成）or 人間 approve」を必須とし、
    gate 未達なら merge せずエスカレーション（fail-closed）。merge 操作を監査記録に
    残す（`mutation` / operation audit と整合）。

### close 条件（Phase 3）
- [ ] フルスイート + typecheck 緑、回帰なし
- [ ] 未解決 P0 ゼロ
- [ ] gate 未達で merge しない / gate 達成で merge する の両方に TDD テスト
- [ ] auto-merge が既定 OFF であることのテスト
- [ ] `docs/specs/overview.md` / `goal-convergence.md` の Non-Goals（auto-merge）を
      実装済みに更新、`docs/specs/workflow.md` 等に挙動を記載

---

## Phase 4: dashboard mutation UI

**目的**: 完成済みの mutation API（Phase 13: CSRF token + Bearer、`dashboard serve
--enable-mutation`）にブラウザ向けフロントエンド UI を載せる。独立 Phase。

- **関連 spec/plan**: `docs/superpowers/specs/2026-MM-DD-phaseN-dashboard-mutation-ui-design.md`（着手時作成）
- **base ref**: Phase 3 完了タグ
- **現状の土台**: backend は完成。POST routes（`/api/runs/:runId/review` /
  `cleanup` / `pr` / `rerun`、`/api/backlog/:itemId/run`）+ CSRF + bearer は
  `src/dashboard/server/server.ts` に実装済み。`src/dashboard/render.ts` は
  read-only の static HTML で mutation UI は無い。
- **安全**: 既定 OFF（`--enable-mutation` 時のみ）。bearer / CSRF を UI 側でも厳守。

### サブ Phase

- **4-1 mutation UI 骨格**
  - `src/dashboard/render.ts`（または分割した新フロント module）に、CSRF token
    取得 + bearer 入力 + `fetch` POST ヘルパを実装。`--enable-mutation` 時のみ
    UI 要素を描画。
- **4-2 各 mutation 操作の UI**
  - review decision / cleanup / PR 作成 / rerun / backlog 実行 の各 POST route に
    対応するフォーム・ボタンを実装。レスポンスを画面に反映。
- **4-3 誤操作防止 / エラー表示**
  - 破壊的操作（cleanup / rerun / merge 系）に確認ダイアログ。エラー時の表示と、
    楽観排他（stale な状態への操作を弾く）を実装。

### close 条件（Phase 4）
- [ ] フルスイート + typecheck 緑、回帰なし
- [ ] 未解決 P0 ゼロ
- [ ] mutation UI が `--enable-mutation` OFF 時に出ない / CSRF・bearer を要求する
      ことのテスト
- [ ] `docs/specs/dashboard.md` / `overview.md`（mutation UI 未提供の記述）を更新

---

## 全体フロー

```
Phase 1 (保守) ─→ Phase 2 (consensus 拡張) ─→ Phase 3 (auto-merge) ─→ Phase 4 (UI)
   各 Phase:
     feature branch を切る / spec・plan 用意
       └ サブ Phase ごとに TDD 実装 → commit → codex サブレビュー(最大3回)
            ├ P0 残 → 修正/再レビュー、上限なら停止+エスカレーション
            └ P0 ゼロ → 残 P1↓ は follow-up、次サブ Phase へ
       └ 大 Phase レビュー(最大5回, フルスイート+typecheck 緑前提)
            └ P0 ゼロ + close 条件 → push → CI green → main merge
```

詳細な判断基準・レビューテンプレート・安全境界は [`GOAL_RULES.md`](./GOAL_RULES.md)。
