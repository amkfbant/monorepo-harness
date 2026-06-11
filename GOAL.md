# GOAL.md — 実装ロードマップ

> **⚠️ このロードマップは SP-1 で計画中の DB ベース roadmap に置き換えられる予定**
> （historical reference として残置）。新規の作業計画は SP-1 の DB roadmap を正本と
> する。なお「goal モード」は **hitch モード**、`harness goal` は `harness hitch` に
> 改名済み（SP-0、`docs/specs/hitch-convergence.md`）。

monorepo-harness を **hitch モード**で実装させるための作業項目定義。実行ルール
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
  hitch モードの review も同 path）。
- **G: MCP write（`ops_knowledge.record` / `deprecate`）** — ✅ 完了（guarded-mutation：
  `allowedOperations` allowlist + OperationRunner の idempotency / audit / budget）。
- **H: file-export parity** — operational entry の `docs/ops-knowledge/` compat export
  （importer namespace の衝突回避が前提）。**残（未着手）**。

各項目 = サブ Phase 規模（TDD で関連テスト + `npm run typecheck` 緑、codex サブレビュー
最大 3 回、未解決 P0 ゼロが close 必須）。相互依存は薄く独立に着手・merge してよい。
E/F/G は完了、残るは H（+ reviewer prompt provenance audit、`docs/future-features.md`）。

---

## 大 Phase R — self-driving 信頼性バグ修正（再起動不要・#72 #73 #75 #80 #96）

> **✅ 完了・全サブ Phase main merge 済み**（2026-06-09、hitch モード駆動）。
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
  再 materialize）、`src/core/run-materialize.ts`（review-decision 欠落時の再生成）、`src/cli/hitch.ts`
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
- **対象（実 finding 経路・codex 指摘）**: `src/hitch/review-integration.ts`（finding seed の実経路
  `proposalFindingSeeds` `:205` ／ `non_blocking_comments` → unknown-scope 化）、
  `src/hitch/classification.ts`（finding 分類）。参考: `src/core/review-evaluator.ts` /
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
  `src/hitch/orchestrator-types.ts:44`）に **`draft: boolean` を追加**して伝播し、**CLI 表示のみ**
  `outcome=pr_created draft=true`（または `pr_created(draft)`）と明示。**typed outcome enum は不変**
  （文字列 enum を崩さない＝codex 指摘）。**自動 ready 化／設定化は defer**。
- **対象**: `src/hitch/orchestrator-types.ts`（result に draft）、`src/core/pr-creator.ts`（戻り値に
  draft 状態）、`src/cli/hitch.ts`（CLI 表示 `:~886`）。
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
  `src/hitch/convergence.ts:247`。`review_consensus` だけの goal が素通りで close_ready にならないことを
  **回帰テストで固定**＝codex 指摘）。**LLM の「テストした」自己申告を根拠にしない**。③「テスト未実行」を
  operator に **明示 surface**（escalate はしない＝R3 連動）。**実テスト実行（依存解決・ephemeral DB）は
  defer**。
- **schema 不変の徹底（codex 指摘）**: `static-approved` を `review_consensus.status` や
  `review_proposals.decision` の enum に**入れない**（CHECK 制約違反で schema 不変が崩れる＝
  `src/db/schema.ts:535`/`:720`）。`summary_json` ／ `review-decision.source_yaml` の文言 ／
  `hitch_close_checks.evidence_json`・`message` ／ CLI 表示**のみ**に限定。status/decision enum は現状維持。
- **対象**: `src/core/review-consensus.ts`、`src/hitch/convergence.ts`（close 条件評価 `:247`）、
  `src/cli/hitch.ts`（close 経路）、`src/core/reviewer-agent.ts`（テスト未実行の検出/記録）、
  `docs/specs/workflow.md` / `docs/specs/hitch-convergence.md`。
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

## 大 Phase S — 運用実害 + 安全・信頼性修正（#79 #77 #103 / #69 #76 #83 #104）

大 Phase R を **hitch モードで自走実装した運用中に観測した実害** と、未対応の
**安全・信頼性** 課題を 1 本の feature branch（大 Phase）で修正する。スコープは
ユーザー合意済み（実害: #79 #77 #103／安全・信頼性: #69 #76 #83 #104）。

> 対応 issue: #79 #77 #103（実害）/ #69 #76 #83 #104（安全・信頼性）。#103/#104 は
> 大 Phase R 運用中に発見し本 Phase 着手時に起票。各 issue 本文が一次情報。

### 自己ホスティングの再帰に注意（最重要）

**#103 / #104 / #76 / #83 は harness の goal/orchestrate 機構そのものを改善する**。その
機構を使って本 Phase を実装する＝自己ホスティングの再帰。**goal loop を触る変更（#104
orchestrator / #76 lifecycle / #83 MCP tool / #103 pr-creator）は、merge 後の orchestrate
から有効化される**ので: ① loop を触らない実害修正（#79 #77）と安全層（#69）を先に、
② loop 改善（#104）を次に置いて以降のサブ Phase の収束を助け、③ 各サブ Phase 後に
**loop が壊れていないか実際に 1 本回して検証**してから次へ。loop を壊す変更は即座に
後続の自走を止めるため、回帰に最大限慎重に。

### 確定した取り決め

- **スコープ**: #79 #77 #103 #69 #76 #83 #104 の 7 件。
- **実装場所**: dev クローン feature branch（`feat/ops-safety-reliability-fixes`）。
- **運用**: 大 Phase R と同一（GOAL_RULES 準拠）。各サブ Phase = TDD → commit → codex
  サブレビュー（未解決 P0 ゼロ gate）→ close → PR → CI green（node 20/24）＋ codex App
  レビュー → squash merge → local main 同期。**budget は iter6+/rerun4+**（R の budget
  枯渇の学び）、close は **command close-condition**（typecheck + 関連 targeted tests）で
  決定論ゲート。**PR は conventional commit タイトル**で出す（#103 を待たず手動 PR でも
  `fix:`/`feat:` を付け release-please に拾わせる）。
- **schema 変更**: #76/#83/#104 で goal 状態や MCP に触れる際、**極力 schema を増やさない**。
  避けられない additive migration が要ると判明したら停止して再決定（ops 反映に migrate が
  要る点を明示）。

### 提案する取り決め（要確認・実装着手前に確定）

- **#69（安全ガードレール）の機構**: 「常時ハーネス強制」はしない（design/docs/triage は
  ハーネス外で正当）。**`harness verify-guarded`（仮）= 対象 repo の working tree / branch を
  guarded ドメインの write/deny スコープに照らし「未検証(non-harness) diff が guarded 領域に
  無いか」を決定論的に検査する read-only コマンド** を追加し、operator / CI / pre-push hook
  から呼べる形にする（強制は呼び出し側の選択）。git hook の自動設置や CI 必須化は本 Phase で
  はやらず defer。→ **この方向で良いか確認**。
- **#83（orchestrate MCP tool）**: 1 回の呼び出しで**有界ステップ**だけ loop を進め status を
  返す guarded-mutation tool（`harness.hitch.orchestrate`）にし、client が繰り返し呼ぶ（単発の
  長時間ブロッキングにしない）。**MCP tool 追加は serve 再起動が必要**（registration）＝本 Phase
  の中で唯一 ops 反映に **serve 再起動を要する**。dangerous（run/PR を駆動）なので
  `allowedOperations` + OperationRunner（idempotency/audit/budget）必須。→ **同期/有界方式で
  良いか確認**。
- **#104（budget/convergence）**: ① rerun の後は必ず re-review を 1 サイクル挟んでから次 rerun
  へ（review-after-rerun 保証）。② `budget_exhausted` でも operator が「最新 needs_review run を
  review→approve→close/PR」へ進める **harness-native な出口**（force-review / 既存 run の review
  経路）を用意（raw-SQL での budget 改変に頼らない）。→ **この 2 点で良いか確認**。

### 実装順（依存・再帰配慮）

S1 #79 → S2 #77 → S3 #103（loop 非依存の実害）→ S4 #69（安全・goal loop と独立な policy 層）
→ S5 #104（loop 改善＝以降の自走を助ける）→ S6 #76（lifecycle）→ S7 #83（MCP tool・要 restart）。
#104 以降は goal loop を触るので各々 merge 後に loop の健全性を検証する。**検証は決定論シナリオを
固定**: mini-commerce に対し「intentional P1 を出す小 goal を 1 本回し、rerun→re-review→close_ready→
close が budget 内で収束する（outcome=pr_created）」ことを確認（S5）／「close 後に finding を record→
reopen→needs_fix→fix-rerun→再 close できる」を確認（S6）。期待 outcome を明示。

> **本計画は Fable（claude-fable-5）サブエージェントでレビュー済み**（codex はクレジット切れの代替）。
> P1×5（S1 既実装・S2 export-OFF 判別・S4 帰属単位/fail-closed・S5/S6 sticky-terminal budget）+ 主要
> P2 を反映。指摘は実コードで裏取り済み。これは codex 正本レビューの代替であり、codex 復帰後に
> 着手前の差分レビューを別途行う。

---

#### S1 — #79 HARNESS_EXPORT_FILES 警告スパム

- **観測**: プロセス起動毎（orchestrate / MCP serve 等）に `HARNESS_EXPORT_FILES is unset` 警告が
  出てログを埋める（1 セッション十数回）。本 Phase の orchestrate 出力でも毎回発生。
- **修正方針（Fable レビューで修正）**: once フラグ（`let warned`）も
  `HARNESS_SUPPRESS_EXPORT_MODE_WARNING` も **既に実装済み**（`export-mode.ts:40-65`、警告は
  既にプロセス 1 回）。実態は **クロスプロセス**（1 セッションで CLI が十数回起動し各プロセスで
  1 回ずつ）。対処は: Phase 9 移行警告を **撤去** or **opt-in 化**（`HARNESS_WARN_EXPORT_MODE=1`
  のときだけ警告）or **TTY 時のみ**。二重否定の suppress-env 既定 ON は運用が分かりにくいので
  **警告の撤去/opt-in 化**を推奨。挙動（export 既定 OFF）は変えない。
- **対象**: `src/config/export-mode.ts`。
- **TDD**: opt-in 化なら「既定で警告 0 回・`HARNESS_WARN_EXPORT_MODE=1` で 1 回」。export モード
  判定（既定 OFF）の回帰なし。
- **動作確認**: orchestrate 出力に警告が 1 回（or 0 回）。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／docs 該当あれば更新。schema 不変。

#### S2 — #77 escalation メッセージの多義解消

- **観測**: `<runDir>/review-decision.yaml not found; the run may not have completed normally`
  （`src/core/reviewer-agent.ts:331`）が「run 途中不具合（リカバリ可能）」と「approved run の
  再 orchestrate（再実行不要）」の双方で出て切り分け不能。
- **修正方針（Fable レビューで修正・DB-first）**: 区別は **DB の run status を一次**にする
  （:132 は doc コメント。実ゲートは :324 status / :377 DB active-proposal / :384 file decision。
  かつ **export OFF（運用既定）では approved 後に sidecar が削除される**＝`reviewer-agent.ts:547`
  ので「ファイルの既存決定＝already_approved」は approved 再実行で発火しない）。判別:
  **run status ≠ `needs_review` → `already_<status>`（再実行不要）** ／ **status = `needs_review` かつ
  materialize 後も decision/proposal 不在 → `run_incomplete`（リカバリ可能）**。区別したメッセージ＋
  escalation reason／終了区分＋推奨アクションを併記。
- **着手前 repro（必須）**: #77 で実際に当該文言を出したゲート（:324 か :331 か）を再現確認して
  から実装（観測時の status を特定）。
- **対象**: `src/core/reviewer-agent.ts`（:324 status gate・:331 欠落メッセージ）、escalation reason を
  載せる goal 経路（`src/cli/hitch.ts`）。
- **安全境界**: 状態遷移は harness のまま。`already_approved` を「成功」と誤認して状態を進めない
  （区別は表示・reason のみ、判定は決定論）。
- **TDD**: fake で (a) 既存 approved decision → `already_approved` 文言、(b) decision 欠落 →
  `run_incomplete` 文言、を検証。
- **動作確認**: mini-commerce で approved run を再 orchestrate → `already_approved` 表示。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／`docs/specs/workflow.md` 更新。schema 不変。

#### S3 — #103 goal/orchestrate の PR タイトルを conventional commit に

- **観測**: orchestrate の PR squash commit が `harness: run-<id>`（`pr-creator.ts:386` commit /
  `:413` PR title）で conventional でなく、release-please が拾わず 0.6.0 CHANGELOG から R1–R4 が
  漏れた。
- **修正方針（Fable レビューで補強）**: PR タイトル＝squash commit title を **conventional 形式**に。
  goal に `--commit-type`（既定 `fix`、新規機能 `feat`）を持たせ `<type>: <goal title 由来> (run-<id>)`
  を生成（`(#NN)` は GitHub issue autolink と紛らわしいので **`(run-<id>)`**）。**commit-type の永続**は
  orchestrate が別プロセスのため必要だが **新カラムを足さず**、既存 JSON カラム（`scope_json` 等）に
  additive フィールド or **goal title を conventional 必須にして導出**（schema 不変）。
  **squash 経路の確定**: squash commit subject は repo 設定依存なので、release-please が確実に拾う経路を
  1 つに固定（`gh pr merge --squash` で subject 明示 or PR title 既定を前提）し TDD/動作確認に含める。
  `closeAndPr` は `createPullRequest` を `title` 未指定で呼ぶが `opts.title` は既存（`pr-creator.ts:412`）
  ＝配線は軽量。既存 harness: commit の release-please 補完運用も docs 化。
- **対象**: `src/core/pr-creator.ts`（:386 commit / :413 title）、`src/cli/hitch.ts`（commit-type）、
  `src/hitch/orchestrator-runners.ts`（closeAndPr 伝播 :554-566）、`src/hitch/repository.ts`（永続先）。
- **TDD**: commit-type 指定時に PR title/commit が `fix:`/`feat:` 形式になる。既定の回帰なし。
- **動作確認**: 本 Phase の各 PR が conventional タイトルで作られ release-please に拾われる。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／`docs/specs/{workflow,cli}.md` 更新。schema 不変。

#### S4 — #69 ガード対象ドメインへの非ハーネス変更の検知（安全）

- **観測**: policy 検証は**ハーネスが行う変更**に対する事後 git diff のみ。対象 repo の guarded
  ドメインへの **out-of-band（非ハーネス）変更**は未強制。「guarded 領域に未検証 diff を入れない」
  不変条件が target 側で守られていない。
- **修正方針（提案・要確認／Fable レビューで帰属単位を確定）**: read-only コマンド
  `harness verify-guarded`（仮）を追加。**帰属判定の単位**を以下で確定（path-only 照合は
  fail-closed にならない＝`run_changed_files` は path/status/allowed のみで内容ハッシュ無し・reviewed
  fingerprint も全ファイル合成の単一 sha のため、過去にハーネスが触った guarded ファイルへの
  out-of-band 改変を恒久的に見逃す）:
  - ① **uncommitted working-tree diff vs HEAD** = 記録照合せず **常に未検証扱い**（最も起きやすい
    素手編集を確実に捕捉）。
  - ② **committed 変更** = `pull_requests` の reviewedHeadSha / merge commit からの **到達可能性**で
    commit 単位に「ハーネス由来か」を帰属。
  - これらを guarded ドメインの write/deny スコープに照らし、**未検証 guarded 変更を検出→非ゼロ exit
    （fail-closed）**。diff base（working-tree vs HEAD ／ base..HEAD）を明示。**per-file hash 記録が
    必要と判明したら additive migration で「schema 不変想定」が崩れる**ので停止して再決定。
- **対象**: 新規 `src/core/verify-guarded.ts`（仮）、`src/policy/`（**glob 照合と `isUnsafePath` のみ
  再利用**。`path-policy-validator.ts:30` の `validateChangedPaths` は「run の変更が write スコープ内か」
  ＝**逆向きの意味論**なので関数直接再利用はしない）、`src/cli/run.ts`（配線）、`docs/specs/policy.md`。
  複数ドメイン横断（ドメイン A の write スコープは run が B 由来でも guarded）の意味論を明記。
- **安全境界**: 検証は決定論。検出は fail-closed（記録に確実に紐づかない変更は未検証扱い）。policy
  検証の事後 git diff 設計は不変・緩めない。
- **TDD**: guarded 領域の未検証変更あり→非ゼロ exit＋報告、ハーネス記録に紐づく変更や非 guarded 変更→
  ゼロ exit。
- **動作確認**: mini-commerce で guarded path を素手編集→`verify-guarded` が検出。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／`docs/specs/policy.md` 更新。**B/C（hook 自動設置・
  CI 必須化）は defer**。schema 不変想定。

#### S5 — #104 orchestrate の budget/convergence（信頼性）

- **観測**: in-scope P1 を rerun で修正し run が needs_review（tests 緑）になっても re-review が
  budget 内で走りきらず `budget_exhausted`、P1 が open のまま取り残る（R2/R5 で頻発、作り直しに）。
- **修正方針（提案・要確認／Fable レビューで budget 会計を確定）**: ① **rerun 直後の 1 review を
  budget 例外**にする（または rerun+review を 1 単位で会計）。**配置は convergence の decide 内で
  `goalBudgetLimitReason`（`convergence.ts:264`）より前**、判定材料は「最新 coding attempt 成功 ∧
  それ以降に review cycle 無し」＝attempts/cycles から決定論導出（**schema 不変で可**）。これを入れないと
  `reviewCyclesUsed >= max` 等で結局 `budget_exhausted` に落ちる（同 :440 で sticky terminal）。
  ② `budget_exhausted` は **session status に書かれ sticky terminal**（`convergence.ts:198,434-443`）
  なので、run-level の `review auto` だけでは goal は永久に terminal のまま。**terminal status から監査付き
  で再開する決定論的な status 遷移コマンド（+ budget 延長）**として設計し、最新 needs_review run を
  review→approve→close/PR に進める。raw-SQL での budget 改変に頼らない。
- **S6 と統合**: ② の「terminal status からの監査付き再開 + budget 延長」は **#76 reopen（S6）と同一
  プリミティブ**。共通化して **loop を触る面積を減らす**（下記 S6 参照）。
- **対象**: `src/hitch/orchestrator.ts` / `orchestrator-dispatch.ts` / `orchestrator-runners.ts`、
  `src/hitch/convergence.ts`（:264 budget 判定 / :434 terminal）、`src/hitch/convergence-status.ts`、
  `src/cli/hitch.ts`、`docs/specs/hitch-convergence.md`。
- **安全境界**: 状態遷移・budget 会計は harness 側決定論。force-review も **実 review を回す**
  （LLM 自己申告で approve しない）。close 条件・未解決 P0 ゼロ gate は不変。budget 例外は決定論材料
  のみで判定（attempts/cycles）。
- **TDD**: fake で rerun 後に re-review が必ず入ること、review-after-rerun で P1 が fixed になり
  budget_exhausted を回避すること、budget_exhausted からの出口で needs_review run を review→close
  できること。
- **動作確認**: mini-commerce で P1 を出す goal を回し、rerun→re-review→close が budget 内で収束。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／`docs/specs/hitch-convergence.md` 更新。**merge 後、
  以降のサブ Phase の orchestrate がこの改善 loop で回ることを 1 本検証**。

#### S6 — #76 close 済み（approved）goal への後発 finding 反映経路（信頼性）

- **観測**: 内部 review_consensus で close した後に外部/別レイヤが本物の P1 を検出しても、closed/
  approved goal の再 orchestrate は escalate（approved run の再実行は review-decision を見つけられず
  停止）。PR クローズ＆新 goal で再実装するしか無かった。
- **修正方針（Fable レビューで budget/痕跡を確定）**: closed goal を **reopen して fix-rerun**
  （新 finding を record → goal を needs_fix に戻して orchestrate）。**closed goal は budget をほぼ
  消費済み**なので、reopen は **決定論的な budget 延長/リセット**（既存カラム UPDATE＝schema 不変）を
  伴わないと reopen 直後に `goalBudgetLimitReason` で再び budget_exhausted に落ちて needs_fix に
  到達しない。加えて `updateStatus` は `COALESCE` で `closed_at`/`close_summary` を**保持**する
  （`repository.ts:394-395`）ので reopen 時に **`closed_at` をクリア**する。状態遷移は harness のみ。
  reopen は dangerous 操作として確認（MCP は confirmation）。
- **S5 と統合**: S5 ② の「terminal status からの監査付き再開 + budget 延長」と **同一プリミティブ**として
  実装し、reopen（closed→needs_fix）と budget_exhausted 再開を 1 つの harness-native 経路に。
- **対象**: `src/hitch/repository.ts`（:380 `updateStatus`・closed_at クリア・budget 延長）、
  `src/hitch/convergence.ts`、`src/cli/hitch.ts`（reopen サブコマンド）、`src/hitch/orchestrator-dispatch.ts`、
  `docs/specs/hitch-convergence.md`。
- **安全境界**: reopen は harness 側状態遷移のみ。reopen 後も未解決 P0 ゼロ gate・close 条件は不変。
  LLM が close/reopen を直接駆動しない。
- **TDD**: closed goal に finding record → reopen → needs_fix → orchestrate で fix-rerun が回る。
  reopen なしの closed goal は従来どおり terminal。
- **動作確認**: mini-commerce で close 後に finding を足し reopen→fix→close。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／spec 更新。schema 追加が要れば additive + ops migrate
  明記。

#### S7 — #83 `harness.hitch.orchestrate` MCP tool（信頼性・MCP 自走）

- **観測**: goal の lifecycle 操作は MCP で完結するが、convergence ループ駆動（orchestrate）だけ MCP
  に無く、自走ループが CLI 必須＝MCP client から完結できない・経路/認証/ログが二分。
- **修正方針（提案・要確認／Fable レビューで timeout・confirmation を補強）**: guarded-mutation tool
  `harness.hitch.orchestrate` を追加。**1 呼び出しで有界ステップ**進め status（次アクション/outcome）を
  返し client が繰り返し呼ぶ。**注意: maxSteps=1 でも 1 ステップ＝coder/review 実行で数分〜数十分**
  （codex 実行を含む）→ MCP client の timeout / progress 通知の扱いを明記。**PR 作成は別の確認付き
  呼び出しに分離**: ループ途中で `confirmation_required` を返すのでなく、既存 `stopAtCloseReady`
  （`orchestrator.ts`）で close_and_pr 手前で必ず停止し、PR 作成は別呼び出しの confirmation で行う
  （既存 goal.close/cancel の `confirmationResult` パターンと整合）。dangerous → `allowedOperations`
  allowlist + OperationRunner（idempotency/audit/budget）。
- **対象**: `src/mcp/tools/goal-tools.ts`（tool 追加）、`src/mcp/tools/mutation-tools.ts`（必要なら）、
  orchestrate コアの再利用（CLI と共通化）、`docs/specs/mcp.md`。
- **安全境界**: MCP が状態遷移を直接書かない（harness ロジック経由）。`confirmation_required` を shell で
  迂回しない設計を維持。CLI と同じ決定論ゲート。
- **ops 反映**: **MCP tool 追加は serve 再起動が必要**（registration）。本 Phase で唯一 restart を要する
  サブ Phase。
- **TDD**: MCP orchestrate が有界ステップで status を返す／guarded-mutation 権限ゲート／CLI と同じ収束。
- **動作確認**: mini-commerce を MCP orchestrate で 1 ステップ進め status を確認。
- **close**: 関連テスト+typecheck 緑／P0 ゼロ／`docs/specs/mcp.md` 更新。

---

### 大 Phase S の close & ops 反映

- 全サブ Phase が close → フルスイート `npm test` + typecheck 緑 → codex 大レビュー（最大 5 回）→
  未解決 P0 ゼロ → push → CI green → main merge。
- ops 反映: `git pull` → `npm run build`。**#83（MCP tool 追加）のみ serve 再起動が必要**。#76 等で
  schema 変更が入れば `db migrate` も。他は CLI/config/policy 表面で再起動不要。
- **defer（`docs/future-features.md` へ）**: #69 の hook 自動設置・CI 必須化、#103 の既存 harness:
  commit 補完の自動化、#83 の単発フル loop（長時間ブロッキング）方式。

> **大 Phase S は完了・main merge 済み**（PR #105 / squash `6bc50d4`。S1–S7 + 大レビュー P1 修正。
> #79 #77 #103 #69 #76 #83 #104 close／#104・#83 は close 操作のみ残）。

---

## 大 Phase T — 運用セットアップ・DX のつまずき修正（#78 #81 #82 #68）

大 Phase R/S を実プロジェクト（mini-commerce / 実機）に対し hitch モードで運用した際に
観測した **セットアップ／DX のつまずき** を 1 本の feature branch（大 Phase）で修正する。
4 件いずれも **CLI / config / workspace 表面の追加で DB schema に触れず・goal loop に非依存**
（回帰リスクが低い）。**#74（マルチドメイン1論理変更・協調マージ）はユーザー合意により今回
除外**（schema 変更 + multi-PR 協調マージの再設計を要し、他 4 件の合計より大。独立 大 Phase に
回し brainstorm から）。

> 対応 issue: #78 #81 #82 #68。各 issue 本文が一次情報（実機 ops での観測）。

### レビュー体制（codex クレジット切れの代替）

大 Phase S と同一: **サブ Phase = opus サブエージェントレビュー**、**大 Phase = Fable-5
サブエージェントレビュー**（codex 正本レビューの代替。codex 復帰後に着手前差分レビューを別途）。
**未解決 P0／P1 ゼロが close gate**（P0=安全境界違反/重大バグ・修正必須、P1=機能バグ・修正必須、
P2=修正 or 理由付き defer、P3=nit）。

### 確定した取り決め

- **スコープ**: #78 #81 #82 #68 の 4 件。#74 は除外（future 大 Phase）。
- **実装場所**: dev クローン新 feature branch（`feat/ops-setup-dx-fixes`）。
- **運用**: GOAL_RULES 準拠。各サブ = TDD → commit → opus サブレビュー（P0/P1 ゼロ gate）→ close →
  PR（**conventional title**）→ CI green（node 20/24）→ squash merge → local main 同期。大 Phase =
  フルスイート `npm test` + typecheck 緑 → Fable 大レビュー → 未解決 P0/P1 ゼロ → merge。
- **schema 変更なし**: 4 件いずれも DB schema に触れない。触れる必要が判明したら **停止して再決定**。
- **ops 反映**: `git pull` → `npm run build`。新 CLI（#78）・preflight（#68）・検証 worktree（#82）は
  CLI/run/workspace 表面で **serve 再起動不要**。#81 は MCP の **メッセージ／導出ロジック変更のみ**
  （tool registration 不変）。MCP transport は stdio なので実行中 serve には反映されず **次回 client 接続
  から有効**（P3-2）。migrate 不要。

### 確定した取り決め（Fable 計画レビューで確定）

- **#78 の CLI 配置／出力**: `harness policy compile --project <id> [--out <path>] [--force]`（既存
  `policy snapshot` / `policy export` と対称）。既定出力は orchestrate が読む `policies/repos/<repoId>.yaml`。
  `compileProjectPolicy().repoPolicy`（`src/project/policy-compiler.ts`）を YAML 化（`policy snapshot` の
  compile パイプライン再利用）。**global policy も手当する**（P1-2）: `loadGlobalPolicy`（`src/policy/loader.ts`）
  は素の readFile で `policies/global.yaml` 不在なら **global 側でも ENOENT** になるため、不在なら
  `compiledPolicy.globalPolicy` も併せて生成（repo 側と同じ `--force` ゲート）。生成 YAML 先頭に
  **provenance ヘッダ**（project id / profile version / source sha / 生成時刻 / 「harness policy compile が
  生成・手編集非推奨」）を付与しドリフト検出の足がかりに（P2-5）。**DB は不変**＝`effective_policy_snapshots`
  には記録しない（snapshot が要れば既存 `policy snapshot` を使う旨 doc 化、P3-3）。
- **#81 の repoId→projectId 導出**: **入れる**。メッセージ改善（projectId 未指定＝null を明示し
  allowedProjects 併記）＋ `projects` テーブルで repoId に**一意対応**する project があれば projectId を
  **導出**（0 件／複数件は導出せず改善メッセージで停止＝fail-closed）。**導出は permission 判定に必要な
  場合に限定**（`allowedProjects` 非空 && projectId 未指定）＝ allowedProjects 空のときは挙動を変えない
  （P2-1）。導出値は **必ず `ensureProjectVisible` を通し**、`CreateGoalSessionInput.projectId` に**永続化**
  （後続 `goal.status` 等の可視性判定が機能するため）。`goal.start` の null 拒否（scope 必須）は維持。
- **#82 の機構**: doc 化（`git fetch origin pull/<n>/head:<name>` 手順を `workspace.md` に明記）＋
  **detached read-only 検証 worktree** helper（`harness workspace verify-pr <n>` ＝PR head sha を
  `git worktree add --detach` でブランチ非占有取得）を**入れる**。配置先（`workspaces/verify-pr-<n>/` 等）・
  **cleanup 手段**（remove subcommand or `--rm` or doc 指示で作りっぱなし防止）・`pull/<n>/head` が
  **GitHub origin 前提**・「read-only は運用約束（detached worktree は書ける）」を T4 に明記（P2-4）。
- **#68 の preflight 位置**: `isSymlinkCapable(dir)` probe を新規 `src/workspace/fs-preflight.ts` に。
  **worktree が実際に置かれる FS** を probe する＝ `createWorktree`（run worktree・probe 対象 `opts.worktreesDir`）
  **と** `src/workspace/agent-workspace.ts` の workspace 作成（probe 対象 workspace 親 dir）の**両経路に配線**
  （P1-1: 元インシデントは repo の sibling に作る agent workspace が `/mnt/d` 上で踏んだもので、HARNESS_ROOT
  側だけ probe しても検出できない。repoPath と HARNESS_ROOT が別 FS のケースが本質）。EPERM を fail-fast
  （FS 名＋remediation 明示）。doctor の `fs` カテゴリ常設は defer。

### 実装順（相互独立・低リスク→高表面）

T1 #81（メッセージ／導出・最小）→ T2 #78（compile CLI）→ T3 #68（preflight・新ファイル）→
T4 #82（検証 worktree・doc）。4 件は相互依存なし。goal loop を触らないため S のような自己ホスティング
再帰の懸念は無い（各サブ merge 後の loop 健全性検証は不要、通常の関連テスト＋typecheck で足りる）。
T3 先行で T4 の検証 worktree 作成が preflight を自然に再利用できる。

> **本計画は Fable（claude-fable-5）サブエージェントでレビュー済み**（codex クレジット切れの代替）。
> P0 ゼロ・着手可（条件付き）。P1×2（#68 の probe 配線を run worktree + agent workspace の両経路に／
> #78 の global.yaml 不在 ENOENT も手当）と要確認 4 点への推奨回答、主要 P2（#81 導出範囲・#82 helper
> 未決事項・#78 provenance ヘッダ・#82 workspace.md 誤記述訂正）を本文に反映済み。指摘は実コードで裏取り
> 済み。codex 正本レビューは復帰後に着手前差分で別途。

---

#### T1 — #81 `project_not_allowed (projectId: null)` メッセージ改善 + repoId 導出

- **観測**: MCP `harness.hitch.start` を repoId 指定で呼ぶと `permission_denied: project_not_allowed
  (projectId: null)`。projectId が別途必須だと気づけない。
- **修正方針**: `ensureProjectVisible`（`src/mcp/tools/tool-helpers.ts:113-125`）で projectId が
  null/undefined かつ `allowedProjects` 非空のとき、メッセージを「**projectId 未指定（null）。
  allowedProjects=[...] に対し projectId を指定せよ**」に分岐。`goalStartTool`（`src/mcp/tools/goal-tools.ts:272`）
  で repoId が与えられ `projects` テーブルに**一意対応**があれば projectId を導出（0 件／複数件は導出せず
  改善メッセージ＝fail-closed）。導出は **allowedProjects 非空 && projectId 未指定**に限定し（P2-1）、導出値は
  必ず `ensureProjectVisible` を通し `CreateGoalSessionInput.projectId` に永続化。`isProjectAllowed`
  （`src/mcp/security/permissions.ts:55` null 許容、P3-1）と `ensureProjectVisible`（null 拒否）の非対称は
  **意図確認の上、goal.start は scope 必須＝拒否を維持しメッセージのみ改善**。
- **対象**: `src/mcp/tools/tool-helpers.ts`、`src/mcp/tools/goal-tools.ts`、`projects` lookup（`src/db`）。
- **安全境界**: 権限判定は決定論のまま緩めない（曖昧導出は禁止＝fail-closed）。状態遷移に影響しない。
- **TDD**: (a) projectId 未指定＋allowedProjects 設定 → メッセージに projectId/allowedProjects を含む、
  (b) repoId 一意対応 → 導出され通過、(c) repoId 曖昧（複数 project）→ 導出せず deny、
  (d) 導出値が allowedProjects に**無い** → deny（fail-closed の明示）、(e) 0 件対応 → 改善メッセージ（P2-2）。
- **動作確認**: mini-commerce で repoId のみの goal.start → 具体的メッセージ or 導出成功。
- **close**: 関連テスト+typecheck 緑／P0・P1 ゼロ／`docs/specs/mcp.md` 更新。schema 不変。

#### T2 — #78 profile → repo policy コンパイル CLI

- **観測**: `goal orchestrate` の repoId モードは `policies/repos/<repoId>.yaml` を読むが、project profile
  からこれを生成する CLI が無く（`project init` は inspect/migrate のみ）、ワンオフスクリプトを知らないと
  `ENOENT policies/repos/<repoId>.yaml` で escalate。
- **修正方針**: `harness policy compile --project <id> [--out <path>] [--force]` を追加。`loadCompileInputs`
  + `compileProjectPolicy`（`src/project/policy-compiler.ts`）で compile し `repoPolicy` を YAML 化
  （`policy snapshot` と同パイプライン・`src/cli/policy.ts` の既存 import 再利用）して既定
  `policies/repos/<repoId>.yaml` に書く（**既存ファイルは `--force` 必須＝誤上書き防止 fail-safe**）。
  `compile` の `warnings` を surface。**global.yaml も手当**（P1-2）: `policies/global.yaml` 不在なら
  `compiledPolicy.globalPolicy` も生成（同 `--force` ゲート）し、orchestrate が global 側 ENOENT で落ちない
  ようにする。生成 YAML 先頭に **provenance ヘッダ**を付与（P2-5）。`effective_policy_snapshots` には
  記録しない＝DB 不変（P3-3）。
- **対象**: `src/cli/policy.ts`（`compile` サブコマンド）、`docs/specs/{cli,policy}.md`。
- **安全境界**: 生成のみ。既存上書きは `--force` ゲート。compile は決定論。DB 不変。
- **TDD**: profile → `policies/repos/<id>.yaml` 生成・内容が `compileProjectPolicy().repoPolicy` と一致、
  global.yaml 不在時に global も生成、`--force` 無しの上書き拒否、warnings 表示、provenance ヘッダ付与。
- **動作確認**: fresh HARNESS_ROOT で compile → orchestrate が repo/global とも ENOENT を出さず policy を読める。
- **close**: 関連テスト+typecheck 緑／P0・P1 ゼロ／`docs/specs/{cli,policy}.md` 更新。schema 不変。

#### T3 — #68 symlink 非対応 FS（WSL 9p/drvfs）の preflight

- **観測**: workspace/HARNESS_ROOT が `/mnt/*`（9p/drvfs）上だと `symlink(2)` が EPERM。worktree/venv/
  node_modules 段で cryptic errno として深部で表面化。ext4 等 Linux ネイティブ FS は無影響。
- **修正方針**: `isSymlinkCapable(dir): boolean` probe を新規 `src/workspace/fs-preflight.ts` に（temp subdir
  へ symlink を試行→EPERM 捕捉→cleanup。fs を注入可能にして unit テスト）。**worktree が実際に置かれる FS**
  を probe し、不可なら **FS 名＋remediation**（「Linux ネイティブ FS（例 `~/ops/...`）で実行せよ」）を明示して
  **fail-fast（fail-closed）**。**両経路に配線**（P1-1）: `createWorktree`（run worktree・probe 対象
  `opts.worktreesDir`）**と** `src/workspace/agent-workspace.ts` の workspace 作成（probe 対象 workspace 親 dir
  ＝repo の sibling）。元インシデントは repo 側 FS（`/mnt/d`）で踏んだもので、repoPath と HARNESS_ROOT が
  別 FS のケースが本質。`docs/specs/workspace.md` に symlink-capable FS の注記。
- **対象**: 新規 `src/workspace/fs-preflight.ts`、`src/workspace/git-worktree.ts` + `src/workspace/agent-workspace.ts`
  （両経路に配線）、`docs/specs/workspace.md`。doctor の `fs` カテゴリ常設は defer。
- **安全境界**: 能力不明なら停止（fail-closed）。既存挙動（ext4 等）は不変。
- **TDD**: probe が capable=true/false を返す（fs inject）、preflight が EPERM を actionable error に変換、
  両経路（run worktree / agent workspace）で probe が呼ばれる、capable FS では透過。
- **動作確認**: capable FS で透過（実機 WSL は CI 外のため probe の unit で EPERM 分岐を担保）。
- **close**: 関連テスト+typecheck 緑／P0・P1 ゼロ／`docs/specs/workspace.md` 更新。schema 不変。

#### T4 — #82 PR 検証用の非占有（detached）worktree + doc

- **観測**: run ごとの worktree が PR ブランチ（`harness/<runId>/<domain>`）を占有し、別 checkout で
  `gh pr checkout <n>` すると `fatal: '<branch>' is already used by worktree at ...` で失敗。毎回
  `git fetch origin pull/<n>/head:<name>` で別名取得して回避した。
- **修正方針**: ① `docs/specs/workspace.md` に「PR 検証は `git fetch origin pull/<n>/head:<name>` で
  別名取得、または detached worktree」を明記。**同 doc の既存誤記述を訂正**（P2-3）: 現状 60 行目付近の
  「run 内部 worktree は detached」は事実と矛盾（実装は `-b harness/<runId>/<domain>` で**ブランチ占有**＝
  #82 の痛みの原因）。② **detached read-only 検証 worktree** helper を `src/workspace/git-worktree.ts` に
  追加（`git worktree add --detach <path> <sha>` ＝**ブランチ非占有**）し、PR head を取得する CLI
  （`harness workspace verify-pr <n>`）として提供。**配置先**（`workspaces/verify-pr-<n>/` 等）・**cleanup**
  （remove subcommand or `--rm` or doc 指示で作りっぱなし防止）・`pull/<n>/head` が **GitHub origin 前提**・
  「read-only は運用約束（detached worktree は書ける）」を明記（P2-4）。
- **対象**: `src/workspace/git-worktree.ts`（detached helper）、`src/cli/`（`workspace verify-pr`）、
  `docs/specs/workspace.md`（既存誤記述の訂正含む）。
- **安全境界**: read-only は運用約束（detached・書き戻さない）。run worktree のライフサイクルは不変。
- **TDD**: detached worktree がブランチを占有せず作られ既存 run worktree（ブランチ占有）と競合しない
  （local bare remote の fake）、cleanup でリーク無し。
- **動作確認**: PR ブランチが run worktree に占有された状態で detached 検証 worktree を作成→成功。
- **close**: 関連テスト+typecheck 緑／P0・P1 ゼロ／`docs/specs/workspace.md` 更新。schema 不変。

### 大 Phase T の close & ops 反映

- 全サブ close → フルスイート `npm test` + typecheck 緑 → Fable 大レビュー（未解決 P0/P1 ゼロ）→ push →
  CI green（node 20/24）→ main merge。
- ops 反映: `git pull` → `npm run build`。**serve 再起動・migrate ともに不要**（CLI/workspace/MCP メッセージ
  表面のみ、schema 不変、tool registration 不変）。
- **defer（`docs/future-features.md` へ）**: #74（マルチドメイン協調マージ・独立 大 Phase）、#68 の doctor
  `fs` カテゴリ常設・venv/node_modules 段の個別 preflight、#82 の run worktree 自動 cleanup タイミング変更。

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
