# GOAL.md — 実装ロードマップ

monorepo-harness を **goal モード**で実装させるための作業項目定義。実行ルール
（レビュー・close 条件・テスト粒度・ブランチ運用・安全境界）は
[`GOAL_RULES.md`](./GOAL_RULES.md) を参照。本ファイルは「何を作るか」を、
`GOAL_RULES.md` は「どう作るか」を定める。

> **大 Phase 1〜4 は全て完了・main merge 済み**（`goal-phaseN-close` タグ。
> Phase 1=CI 足回り / Phase 2=consensus 拡張 / Phase 3=auto-merge / Phase 4=
> dashboard mutation UI。設計は `docs/superpowers/specs/2026-06-05-phaseN-*.md`）。

---

## 完了した follow-up（A〜D）

follow-up A〜D は**すべて実装・main merge 済み**（close 条件＝テスト + spec 更新も充足）。
履歴・設計根拠は git log / 各 PR を参照。

| follow-up | 内容 | 実体（現状コード） | テスト | spec |
|-----------|------|------|------|------|
| **A** | `review auto` proposal insert の TOCTOU 解消 | `ReviewProposalRepository.insertProposal` が `tx.immediate()` 内で `runs.status`/`source_mode` を再読し非 `db-first && needs_review` なら `ReviewerAgentGateError`（`src/db/repositories/review-proposals.ts`） | `tests/unit/db/review-proposals.test.ts`（guard throw / 正常通過） | `docs/specs/workflow.md` |
| **B** | `CopilotReviewer.poll` を AbortSignal でキャンセル可能に | `poll(prNumber, timeoutMs?, signal?)` を gh runner まで配線、watchdog 発火で in-flight poll を abort（`src/core/copilot-reviewer*.ts` / `copilot-review-run.ts`）。`runCopilotReview` の non-throw / 非 gating 不変条件は維持 | `tests/unit/core/copilot-review-run.test.ts` | `docs/specs/cli.md` / `workflow.md` |
| **C** | `harness knowledge deprecate` コマンド | `knowledge deprecate <id>` が DB-current revision に `deprecated: true` を記録し compat file を export（`src/cli/run.ts`） | `tests/integration/cli-knowledge-promote.test.ts`（deprecate → build-context 除外） | `docs/specs/cli.md` / `overview.md` |
| **D** | `overview.md` の stale 修正（pr create / rerun の実 codex smoke） | doc のみ。`pr create` / `rerun` の実 codex smoke を検証済みに反映 | — | `docs/specs/overview.md`（`2026-06-04-real-codex-smoke.md` リンク） |

---

## 現在の focus — operational knowledge の deferred surfaces（issue #57）

[issue #57](https://github.com/amkfbant/monorepo-harness/issues/57) の **Core + MCP read**
は完了（schema v19 `knowledge_entries.category` / `harness knowledge ops` CLI /
`harness.ops_knowledge.*` MCP read。`docs/specs/{db,cli,mcp}.md`）。残る deferred surfaces
を本ロードマップの現行項目とする（詳細スケッチは [`docs/future-features.md`](./docs/future-features.md)）。

- **E: inbox / session surfacing** — ✅ 完了（`DbInboxSummary.operationalKnowledge` →
  `harness.inbox` / scoped CLI / dashboard）。
- **F: goal / reviewer context 注入** — ✅ 完了（`buildOperationalKnowledgeReviewSection`
  を reviewer prompt に append。project+repo scope・bounded・**coder には注入しない**。
  goal モードの review も同 path）。
- **G: MCP write（`ops_knowledge.record` / `deprecate`）** — ✅ 完了（guarded-mutation：
  `allowedOperations` allowlist + OperationRunner の idempotency / audit / budget）。
- **H: file-export parity** — operational entry の `docs/ops-knowledge/` compat export
  （importer namespace の衝突回避が前提）。**残（未着手）**。

各項目 = サブ Phase 規模（TDD で関連テスト + `npm run typecheck` 緑、codex サブレビュー
最大 3 回、未解決 P0 ゼロが close 必須）。相互依存は薄く独立に着手・merge してよい。
E/F/G は完了、残るは H（+ reviewer prompt provenance audit、`docs/future-features.md`）。

---

## 大 Phase R — self-driving 信頼性バグ修正（再起動不要・#72 #73 #75 #80 #96）

> **✅ 完了・全サブ Phase main merge 済み**（2026-06-09、goal モード駆動）。
> R1 #96→PR #97 / R2 #72→PR #98（salvage gate・codex App P1×2 修正）/ R3 #75→PR #99 /
> R4 #80→PR #100 / R5 #73→PR #101。各 PR は CI（node 20/24 typecheck+build+test）緑 +
> codex App レビューを経て squash merge。R5 は codex rate-limit のため最終の 2 P1
> （advisory filter 拡張・mcp.md 整合）を operator が手動反映して PR 化（経緯は PR #101）。
> 対応 issue #72/#73/#75/#80/#96 は全て close 済み。以下は実装時の計画記録。

0.3.0 ハーネスを実運用（ops）で回した際に見つかった **MCP serve 再起動が不要なバグ**を
**1 本の feature branch（大 Phase）で一斉修正**する。「再起動不要」とは、修正面が
**`goal orchestrate` の収束ループ（CLI 別プロセス＝毎回新 dist）/ DB import 層 / CLI
コマンド**に閉じ、常駐 MCP serve（メモリ上の dist）の挙動にも **schema** にも触れない、
という意味。よって ops 取り込みは「pull → `npm run build`」だけで反映でき、稼働中の
serve を止める必要がない。

> **CLI⇔MCP の二面性（codex 指摘・重要）**: R2/R3/R5 が触る共有関数（`runReviewerAgent` /
> `processReviewDecision` / `importReviewProposalToGoal` / `createPullRequest`）は **MCP mutation
> tool（review/pr 系）からも呼ばれる**。本 Phase の **no-restart 保証と動作確認は CLI
> `goal orchestrate` / CLI import / CLI 表示の経路に限定**する。同じ修正を**稼働中 serve の MCP
> mutation tool 経路**へ反映するには **serve restart が必要**で、それは本 Phase の close / 動作確認の
> **対象外**（restart は任意・別途）。

> このロードマップ項目は **GitHub issue #72 / #73 / #75 / #80 / #96** に対応する。
> 各 issue 本文が一次情報。実体コードは現状コミット（`85ae392`）基準で行番号を併記する。

### 確定した取り決め（事前合意済み）

- **スコープ**: #72 #73 #75 #80 #96 の 5 件のみ（全て no-restart）。#68（WSL symlink
  fail-fast）は WSL 限定で darwin の mini-commerce では動作検証不可のため**含めない**。
- **#73 の方針**: **軽量**。`review_consensus` を「static 合格（テスト未実行）」と明示し、
  close 条件に「テスト実行ゲート」を別途設け、「テスト未実行」を operator に **surface**
  する。**レビュー環境での実テスト実行（依存解決・ephemeral DB）は本 Phase ではやらない**
  （`docs/future-features.md` に defer）。
- **#96 の方針**: **A（write-through）**。単発 `project import` でも canonical と同一 tx で
  compat `project_profiles` / `domains` を書く。**B（consistency を canonical 基準に）/
  C（native reconcile コマンド）は defer**。
- **実装場所**: **dev クローン**（`/Users/kn/dev/monorepo-harness`、feature branch）。
  ops checkout の `src/` は read-only のまま触らない。
- **動作確認の実プロジェクト**: **mini-commerce**（`docs/examples/mini-commerce.md`）を
  orchestrate の target repo として使う。
- **schema 不変の制約（重要）**: 本 Phase は **schema を変更しない**（no-restart かつ
  no-migrate を維持するため）。状態は既存の run/review artifact・既存カラム・escalation
  reason text に記録する。schema 変更が避けられないと判明したら**スコープを広げず停止して
  再決定**（escalate）。

### 運用（GOAL_RULES 準拠）

- これは **大 Phase 1 本** = `feat/self-driving-reliability-fixes`（base: `main`）。
  各 issue = **サブ Phase**（R1〜R5）。
- 各サブ Phase: **TDD（RED→GREEN→REFACTOR）** → commit（Conventional Commits、commit 前
  `npm run typecheck`）→ **codex サブレビュー最大 3 回**。未解決 P0 が残れば停止+エスカレー
  ション。**修正可能な P1 はリトライ枠内で修正**し、上限到達後になお残る P1 以下のみ follow-up に
  積む（P0 が残るなら停止）。
- 全サブ Phase 後: **フルスイート `npm test` + typecheck 緑** → **codex 大レビュー最大 5 回**
  → P0 ゼロ → push → **CI green → main merge**。
- **安全境界（不可侵・GOAL_RULES §G）**: policy 検証は事後 `git diff` ベースを維持／LLM の
  自己申告を状態遷移の根拠にしない／状態遷移は harness のみ／迷ったら fail-closed。

### 実装順（依存）

R1（#96・DB import 層で独立）→ R2（#72・最終化冪等）→ R3（#75・finding 分類）→
R4（#80・outcome 表面）→ R5（#73・consensus セマンティクス）。R3 と R5 は
「**テスト未実行は surface するが escalate はしない**」で連動するため、R3→R5 の順で
境界を一貫させる。

---

#### サブ Phase R1 — #96 `project import` write-through（DB import 整合）

- **観測**: `harness project import <path>` 後に `harness db check-consistency` が当該
  project を `missing-db`（"profile exists on disk but not in the DB"）と誤報。公式手順の
  `db import --from-files` でも直らない（`if-missing` ガードで skip）。
- **根因**: 単発 `project import` は canonical（`projects` + `project_profile_revisions`）
  のみ書き、compat `project_profiles` / `domains` を書かない。一方 consistency は compat を
  INNER JOIN で参照する（`src/db/consistency.ts:143-152`）。bulk の `importProjects` は両方
  書く（`src/db/import/projects.ts:58-70`, `123-141`）。
- **修正方針（A）**: bulk の `upsertProfile` / `upsertDomain` 相当を**共有関数に抽出**し、
  単発 `project import` 経路からも同一 tx で呼ぶ。これで単発 import 後も整合する。
- **対象**: `src/db/import/projects.ts`（共有 write-through を export）、`src/cli/project.ts`
  の `project import` ハンドラ（`:81`）、`src/db/repositories/project-profile-revisions.ts`、
  `src/db/consistency.ts`（変更不要・検証対象）。
- **TDD**: ① RED: 単発 `project import` 後に `project_profiles`/`domains` 行が存在し
  `check-consistency` が `ok` を返す integration（現状の `missing-db` を先に固定）。
  ② unit: 抽出した write-through が `project_profiles`+`domains` を**冪等 upsert**。
  ③ 回帰: `db import --from-files` の挙動・冪等性が不変。
- **mini-commerce 動作確認**: temp HARNESS_ROOT に mini-commerce profile を `project import`
  → `db check-consistency` = ok を確認。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／`docs/specs/db.md`（project import が compat も
  書く旨）更新。**B/C は defer**。

#### サブ Phase R2 — #72 orchestrate 最終化の冪等化＋workspace branch surface

- **観測**: coder は workspace に正しい変更を書き終えているのに、review→commit→PR の最終段が
  落ち `<runDir>/review-decision.yaml not found; the run may not have completed normally`
  （`src/core/reviewer-agent.ts:325`）で**間欠 escalate**。`workspaces/run-<id>/repo` に
  **未コミット変更が取り残され手動リカバリ必須**（1 セッションで 3 回再現）。
- **修正方針**: ① 最終化段（review-decision 生成・commit・PR）を**冪等＋失敗時リトライ可能**にし、
  `review-decision.yaml` 未生成の**根因をログ/記録**。**runDir はあるが `review-decision.yaml` だけ
  欠ける**ケース（`ensureRunMaterialized` は `meta.json` があると no-op で修復されない＝
  `src/core/run-materialize.ts:48`）を**明示的に再生成/再 materialize** する（根因ログだけでは close
  条件未達＝codex 指摘）。② escalate 時でも workspace の変更を **commit/push してブランチを surface**し、
  **escalation の reason text にブランチ名を含める**（schema を増やさず既存 reason に載せる）。
- **対象**: `src/core/reviewer-agent.ts`（`decisionPath` 未存在 `:290`/`:325` のハンドリング・根因・
  再 materialize）、`src/core/run-materialize.ts`（review-decision 欠落時の再生成）、`src/cli/goal.ts`
  （orchestrate 最終化〜escalate 状態遷移 `~1061-1073`、reason にブランチ付与）、`src/core/pr-creator.ts`
  （commit/PR 段の冪等性・salvage gate）、workspace（per-run worktree）層。
- **安全境界（P0 ガード必須・codex 指摘）**: escalate 時の自動 commit/push は **salvage 専用 gate**を
  満たす場合のみ行い、既存 PR 作成の `status === "approved"` gate ＋ reviewed fingerprint 再検証
  （`src/core/pr-creator.ts:317`）を**迂回しない**。salvage gate の最低条件:
  `run.status === needs_review` ／ `safetyStatus === allowed` ／ `meta.reviewed.paths`・fingerprint が
  存在し**再一致** ／ stage するのは **reviewed allowed paths のみ** ／ **PR 作成・goal close はしない**
  （ブランチ surface に限定）／ 失敗は **fail-closed**。policy 検証（事後 git diff）と状態遷移
  （harness のみ）は不変。自動 commit/push は **per-run worktree 内に限定**。
- **TDD**: fake codex runner で「coder は変更済みだが review-decision 未生成」を再現し、
  (a) 根因が記録される (b) workspace 変更が commit/push されブランチが escalation に含まれる
  (c) 再実行で冪等復帰、を検証。回帰: 正常系 finalize→PR 不変。
- **mini-commerce 動作確認**: mini-commerce に `goal orchestrate` を回し、最終化失敗時に
  未コミット残しが起きず・ブランチが surface されることを確認。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／`docs/specs/workflow.md`（最終化冪等・escalation
  payload にブランチ）更新。

#### サブ Phase R3 — #75 reviewer 環境メタ注記を escalate トリガから分離

- **観測**: reviewer の環境メタ注記（例「テスト未実行」）が **unknown-scope finding** として
  扱われ escalate を誘発する。
- **修正方針**: reviewer の `out_of_scope_suggestions` / `non_blocking_comments` 等の**環境条件注記
  （environment meta note）を harness 側で決定論的に分類**し、goal finding 化（escalate を誘発する
  unknown-scope finding）から分離。環境メタ注記は **surface はするが finding 化・escalate しない**
  （R5 と境界を共有）。実 finding（correctness）の escalate は**従来どおり維持**。
- **対象（実 finding 経路・codex 指摘）**: `src/goal/review-integration.ts`（finding seed の実経路
  `proposalFindingSeeds` `:205` ／ `non_blocking_comments` → unknown-scope 化）、
  `src/goal/classification.ts`（finding 分類）。参考: `src/core/review-evaluator.ts` /
  `src/core/review-processor.ts`（reviewer 出力の `out_of_scope`）。
- **安全境界**: 「escalate しない」を fail-open にしない。対象は**環境メタ注記に限定**し、判定は
  harness 側パターン分類で行う（LLM の「これは scope 外」を鵜呑みにしない）。
- **TDD**: 環境メタ注記のみ（実 required change なし）→ escalate しない／実 required change あり
  → 従来どおり escalate、の両ケース。
- **mini-commerce 動作確認**: 依存解決不可状況を mini-commerce で作り、環境注記だけでは escalate
  しないことを確認。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／`docs/specs/workflow.md`（finding 分類）更新。

#### サブ Phase R4 — #80 orchestrate outcome に draft PR を明示

- **観測**: orchestrate は PR を **draft** で作る（`src/core/pr-creator.ts:414` →
  `src/core/gh-pr-publisher.ts:88` `--draft`）が、outcome（`pr_created`）に draft が出ず、後で
  merge 時 `Pull Request is still a draft` で弾かれる。
- **修正方針（最小）**: PR 結果型（`OrchestrationResult` / `closeAndPr` result＝
  `src/goal/orchestrator-types.ts:44`）に **`draft: boolean` を追加**して伝播し、**CLI 表示のみ**
  `outcome=pr_created draft=true`（または `pr_created(draft)`）と明示。**typed outcome enum は不変**
  （文字列 enum を崩さない＝codex 指摘）。**自動 ready 化／設定化は defer**。
- **対象**: `src/goal/orchestrator-types.ts`（result に draft）、`src/core/pr-creator.ts`（戻り値に
  draft 状態）、`src/cli/goal.ts`（CLI 表示 `:~886`）。
- **TDD**: draft で PR 作成時に outcome に draft が明示されること。
- **mini-commerce 動作確認**: orchestrate で PR 作成 → outcome に `(draft)` を確認。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／`docs/specs/{workflow,cli}.md` 更新。

#### サブ Phase R5 — #73 `review_consensus` セマンティクス明確化＋テスト実行ゲート＋surface

- **観測**: `review_consensus` 通過後に PR が作られるが、内部レビューは **static（compile+diff）
  のみでテスト未実行**のため実 correctness バグ（実 DB 依存エッジケース・schema 制約違反・出力
  契約不整合）を通過させる。reviewer は「tests were not run in this environment ...」と自己申告。
- **修正方針（軽量・決定論）**: ① `review_consensus` の意味を「**static 合格（テスト未実行）**」と
  明示（spec＋記録文言）。「approved＝テスト緑」の過信を排除。② close 条件に「**テスト実行ゲート**」を
  設ける。**既存 schema の `command` close condition を使う**（or orchestrate が required な test
  condition を合成する）方式とし、テスト実行の確証が無い限り **`close_ready` にせず
  `continue`/`run_close_check` に留める**（現行 convergence は `session.closeConditions` のみ参照＝
  `src/goal/convergence.ts:247`。`review_consensus` だけの goal が素通りで close_ready にならないことを
  **回帰テストで固定**＝codex 指摘）。**LLM の「テストした」自己申告を根拠にしない**。③「テスト未実行」を
  operator に **明示 surface**（escalate はしない＝R3 連動）。**実テスト実行（依存解決・ephemeral DB）は
  defer**。
- **schema 不変の徹底（codex 指摘）**: `static-approved` を `review_consensus.status` や
  `review_proposals.decision` の enum に**入れない**（CHECK 制約違反で schema 不変が崩れる＝
  `src/db/schema.ts:535`/`:720`）。`summary_json` ／ `review-decision.source_yaml` の文言 ／
  `goal_close_checks.evidence_json`・`message` ／ CLI 表示**のみ**に限定。status/decision enum は現状維持。
- **対象**: `src/core/review-consensus.ts`、`src/goal/convergence.ts`（close 条件評価 `:247`）、
  `src/cli/goal.ts`（close 経路）、`src/core/reviewer-agent.ts`（テスト未実行の検出/記録）、
  `docs/specs/workflow.md` / `docs/specs/goal-convergence.md`。
- **安全境界（重要）**: これは「弱いゲートを**弱いと明示**し fail-closed 寄りにする」変更。
  **ゲートを緩めない**。状態遷移・ゲート判定は harness 側ロジック。**schema を増やさない**（既存の
  review-decision artifact / 既存フィールドに記録）。
- **TDD**: 「テスト未実行」申告時に static-approved として記録・surface されること／テスト実行
  ゲートが未充足を区別すること／LLM 自己申告だけではゲートが緑にならないこと。
- **mini-commerce 動作確認**: mini-commerce で依存解決不可状況を作り、static-approved＋テスト未実行
  surface を確認（実バグが通っても「テスト未実行」が明示される）。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／spec 更新。

---

### 大 Phase R の close & ops 反映

- 全サブ Phase R1〜R5 が close 条件充足 → フルスイート `npm test` + typecheck 緑 → **codex 大
  レビュー（最大 5 回）** → 未解決 P0 ゼロ → push → **CI green → `main` merge**。
- ops 反映: ops checkout で `git pull` → `npm run build`。**本 Phase は schema 不変のため
  `db migrate` 不要**。**CLI `goal orchestrate` / CLI import / CLI 表示の経路は serve 再起動なしで
  反映**される。ただし**同じ共有関数の MCP mutation tool 経路**（review/pr 系）を新コードにするには
  **serve restart が必要**（本 Phase の close / 動作確認の対象外。restart は任意・別途）。
- **defer（`docs/future-features.md` へ）**: #73 の実テスト実行（依存解決・ephemeral DB
  integration）／#96 の B（consistency canonical 基準化）・C（native reconcile コマンド）／
  #80 の自動 ready 化・設定化。

---

## 実行フロー

```
各 follow-up:
  branch を切る（必要なら spec / plan 用意）
    └ TDD 実装 → commit → codex サブレビュー（最大 3 回）
         ├ P0 残 → 修正 / 再レビュー、上限なら停止 + エスカレーション
         └ P0 ゼロ → 残 P1↓ は follow-up、close 条件を満たして merge
```

詳細な判断基準・レビューテンプレート・安全境界は [`GOAL_RULES.md`](./GOAL_RULES.md)。
より大きい保留事項（multi-reviewer consensus orchestration / codex session
continuation 等）は [`docs/future-features.md`](./docs/future-features.md)。
