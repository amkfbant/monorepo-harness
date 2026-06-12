# Audit fixes spec — Group B（#125–#128, #130, #131, #133, #134）

> Fable-5 作成。親: `2026-06-12-audit-fixes.md`。codex xhigh レビュー対象。

### #125 [P2] 800行上限超 15 ファイルの段階分割（筆頭 src/cli/run.ts）
**現状**: 800行超 15 ファイル: src/cli/run.ts(4389)、src/mcp/registry/tool-registry.ts(2209)、src/mcp/tools/mutation-tools.ts(2108)、src/dashboard/server/server.ts(1841)、src/db/schema.ts(1680)、src/mcp/tools/read-tools.ts(1606)、src/cli/hitch.ts(1461)、src/hitch/repository.ts(1301)、src/db/repositories/runs.ts(1263)、src/mcp/tools/dry-run-tools.ts(1226)、src/cli/db.ts(1141)、src/core/workflow-runner.ts(1054)、src/mcp/tools/hitch-tools.ts(1045)、src/hitch/orchestrator-runners.ts(960)、src/core/review-processor.ts(907)。run.ts は project/policy/db/onboard/hitch/course/mcp を委譲済み（run.ts:4157-4162,4175。パターン `registerHitchCommands(program,{getHarnessRoot})`）。

**変更内容**（段取り spec・機械的移動のみ・挙動変更ゼロ・既存 register*Commands 委譲踏襲）:
*Phase A — run.ts 分割（最優先・コマンド群と群専用 helper を一緒に移す）*: A-1 knowledge 群(2733-3532+helpers) → src/cli/knowledge.ts + knowledge-ops.ts / A-2 workspace 群(3533-4156+helpers) → src/cli/workspace.ts / A-3 review 群(982-1477+parse*Int) → src/cli/review.ts / A-4 rerun/chain(2504-2732) → rerun.ts、pr/request-review/inbox(1494-1750) → pr.ts / A-5 backlog(1751-2025+helpers) → backlog.ts、dashboard(2026-2171) → dashboard.ts / A-6 operations(2172-2291)/session-metrics(2292-2407)/maintenance-cleanup(2408-2503)/release(4243-4371)+verify-guarded(4181-4242) → 4 ファイル / A-7 残部が依然 800 超なら cmdRun/cmdReviewedRun → run-command.ts。`getHarnessRoot()`(run.ts:259) は opts 引数で渡す（export しない）。1 PR=1〜2 群・import 整理以外の差分禁止。
*Phase B*: src/cli/hitch.ts（hitch/attempt/finding/cycle/metrics 単位）、src/cli/db.ts（backup/restore と stats/maintenance）。
*Phase C*: MCP 層（tool-registry/mutation-tools/read-tools/dry-run-tools を機能ドメイン別へ、registry は集約のみ）+ dashboard server の route 分割。
*Phase D（Tier-2・人手レビュー前提・最後）*: src/hitch/repository.ts・orchestrator-runners.ts・core/workflow-runner.ts・core/review-processor.ts。**即時分割しない**。src/db/schema.ts は append-only migration 定数列で対象外明記。

**対象ファイル**: 上表 / **挙動・互換性**: 非 breaking（CLI 表面完全不変）/ **安全境界考慮**: policy 検証・状態遷移に触れない純移動。Tier-2 は人手レビュー必須 / **テスト**: 各 PR で既存テスト緑+typecheck、`--help` 出力前後一致 snapshot を A-1 で先に追加 / **規模**: 中（PR 単位は各小）

### #126 [P2] dead code 整理（stats-snapshots ほか完全未使用 export）
**現状**: src/db/stats-snapshots.ts:1-103 production caller ゼロ（参照は test + schema.ts:1026-1031 DDL のみ。「db stats delta」未配線、cli/db.ts:513 の stats は dbStats のみ）。src/core/errors.ts:1-13 PolicyViolationError/CodexExecutionError 参照ゼロ。src/db/blob-stores.ts:213-221 deleteExternalBlobRow 参照ゼロ。src/mcp/tools/tool-helpers.ts:66-83 withArchiveFallback 参照ゼロ。src/core/backlog.ts:64 addItem は production caller ゼロ・tests のみ。

**変更内容**: (1) 判断=配線せず削除。docs/future-features.md に「DB stats snapshot/delta」を理由付き追記し stats-snapshots.ts + テスト削除。(2) テーブル削除は**新 migration V22**で `DROP TABLE IF EXISTS db_stats_snapshots` + index DROP。過去 V10 DDL（schema.ts:1026-1031）と V10_TABLE_NAMES は**書き換えない**（migration は append-only）。consistency.ts/export-files.ts は同テーブル不参照確認済み。docs/specs/db.md 同コミット更新。(3) errors.ts ファイル削除、deleteExternalBlobRow/withArchiveFallback 関数削除。(4) backlog.addItem は legacy file-backlog→DB import 互換 fixture（tests/unit/core/backlog-db.test.ts:287-322）で使用→**削除しない**。`@internal test-fixture support` 付記、knip は tests を entry に含めて誤検知防止。

**対象ファイル**: src/db/stats-snapshots.ts(削除)、schema.ts(V22)、migrations.ts、core/errors.ts(削除)、blob-stores.ts:213-221、tool-helpers.ts:66-83、docs/specs/db.md、docs/future-features.md / **挙動・互換性**: DROP は schema bump 一方向 migration（旧ハーネスで開けないのは既存ポリシー）。データ消失実質ゼロ。V22 適用は db backup 推奨を ops doc に一行 / **安全境界考慮**: 検証・遷移と無関係。migration 失敗は version 不一致で停止（fail-closed）/ **テスト**: V22 後テーブル非存在・migration 冪等の unit、削除 export 残骸ゼロは typecheck / **規模**: 小

### #127 [P2] course-orchestrate-runtime の直接 unit テスト追加
**現状**: src/roadmap/course-orchestrate-runtime.ts:52-91（makeCourseHitchRunners）に直接テスト無し。分岐: cache hit(52-53)/projectId フォールバック(56)/二重 null エラー(57-61)/domain null エラー(62-64)。createCodexCliRunner/prepareProjectRun を直 import でテスト seam 無し。

**変更内容**: 最小 DI seam（default 現行・挙動変更ゼロ）。makeCourseHitchRunners を export し optional `deps?:{prepareRun?;createRunners?}` 追加。hitchGoalText(95-100, pure) も export。テスト（tests/unit/roadmap/course-orchestrate-runtime.test.ts、in-memory DB+HitchRepository.createSession、prepareRun fake）: (1)session.projectId=null/courseProjectId="p1"→fake が projectId:"p1" で呼ばれる (2)両 null→reject (3)projectId あり/domain=null→reject (4)同一 hitchId 2 回→prepareRun 1 回・同一参照、別 hitchId は 2 回目走る (5)hitchGoalText 3 ケース。

**対象ファイル**: src/roadmap/course-orchestrate-runtime.ts（export+optional deps）、新規テスト / **挙動・互換性**: 非 breaking / **安全境界考慮**: runner DI 抽象という既存設計に沿う・codex は fake / **規模**: 小

### #128 [P2] docs/specs/roadmap.md derived counts 記述の実装追従
**現状**: roadmap.md:116-119 が「listFindings with limit:100_000」と記述。実装は rollup.ts:31-52 openCounts の SQL COUNT 集約（in_scope かつ lifecycle IN('open','reopened') の P0/P1 を GROUP BY・LIMIT 無し）。

**変更内容**: 116-119 を「live counts は hitch_findings への直接 COUNT(*) 集約（openCounts, src/roadmap/rollup.ts）。open と reopened 両 lifecycle を数える（SP-1 invariant）。row-fetch LIMIT 無し」に差替。「never read from a snapshot」維持。

**対象ファイル**: docs/specs/roadmap.md:116-119 / **挙動・互換性**: docs-only / **安全境界考慮**: spec 駆動規律追従 / **テスト**: なし（100_000 残存 grep ゼロ確認）/ **規模**: 小

### #130 [P2] hitch reopen の reason を DB 永続化（close/cancel と対称化）
**現状**: `hitch reopen --reason` 必須だが stdout エコーのみ（src/cli/hitch.ts:272,295-301）。reopenSession（src/hitch/repository.ts:435-470）は reason 受け取らず。**cancel の reason も消失**: updateStatus（:402-423）は note を closed→close_summary/escalated→escalation_reason のみ永続化し cancelled の note 破棄。hitch_convergence_decisions.decision は CHECK 9 値固定（schema.ts:1411-1421）で reopen 行追加は rebuild 要→不採用。

**変更内容**: **schema 追加（V22 同梱可）**。新 audit テーブル `hitch_lifecycle_events`（event_id PK / hitch_id FK / event CHECK IN('reopened','closed','cancelled') / reason TEXT NOT NULL / detail_json / created_at / created_by）。reopenSession に reason/createdBy 追加し status UPDATE + event INSERT を db.transaction 原子化。updateStatus 経由 close/cancel も event 記録（cancel reason 取りこぼし修正）。既存 close_summary/escalation_reason カラムは互換維持。hitch status --json に lifecycle events 追加。docs/specs/{cli,hitch-convergence,db}.md 同コミット更新。

**対象ファイル**: schema.ts(V22)、repository.ts:402-470、cli/hitch.ts:228-303、docs/specs/{cli,hitch-convergence,db}.md / **挙動・互換性**: reopenSession シグネチャ変更は内部 API（CLI/MCP 呼び出し元追従）。CLI 表面不変 / **安全境界考慮**: 状態遷移は harness のみ。event テーブルは**監査ログで遷移根拠でない**（convergence/rollup 不読）を spec 明記 / **テスト**: reopen→event 行 round-trip、cancel→reason 永続化、二重 reopen で 2 行、UPDATE 失敗で event も入らない（tx）+ CLI integration / **規模**: 中

### #131 [P2] reviewer prompt provenance（prompt_sha256 populate + knowledge metadata）
**現状**: review_proposals.prompt_sha256（schema.ts:760, v7）が**どこからも populate されない**（review-proposals.ts:20-31,89-108 の INSERT 列/入力型に無し）。assembled prompt は PROMPT_PREAMBLE+reviewerOpsSection（reviewer-agent.ts:435）、knowledge は buildOperationalKnowledgeReviewSection（operational-knowledge.ts:408-438）が文字列のみ返し entryId/version 喪失。insertProposal 呼び出しは 2 箇所（reviewer-agent.ts:546、review-processor.ts:706=file 由来 legacy）。

**変更内容**: (1) buildOperationalKnowledgeReviewSection を `{section; included:{entryId;version}[]}` 返しに（旧名 thin wrapper 互換）。(2) reviewer-agent.ts で送信 prompt 全文(:435)の sha256 計算、ReviewProposalInput に optional promptSha256 / promptProvenance{template{name;version};knowledge[]} 追加。prompt_sha256 は既存カラムへ、provenance JSON は **V22 で review_proposals に prompt_provenance_json TEXT を ALTER 追加**して格納（context_pack_id は流用しない）。template version は REVIEWER_PROMPT_TEMPLATE(:163-166)。(3) review-processor.ts:706（file 由来）は prompt 無しのため両フィールド NULL（捏造しない）。(4) **#116 と同一 PR か直前後で設計を揃え二重 migration を避ける**。

**対象ファイル**: reviewer-agent.ts:383-446,540-557、operational-knowledge.ts:408-446、review-proposals.ts:20-31,60-112,323-347、schema.ts(V22)、docs/specs/db.md / **挙動・互換性**: 列追加+optional 入力で非 breaking。旧行 NULL / **安全境界考慮**: provenance は**監査用 read-only メタデータ**で判定・遷移に使わない。sha256 は harness 決定論計算 / **テスト**: insertProposal round-trip（あり/なし）、fake runner 経由で DB の prompt_sha256=送信 prompt の sha256、knowledge 0 件時 knowledge:[] / **規模**: 中

### #133 [P3] harness goal erroring stub の削除（0.7.0 冒頭）
**現状**: src/cli/run.ts:4164-4174 hidden goal コマンドが「renamed to hitch」を stderr に exit 1。テスト tests/integration/goal-renamed-stub.test.ts:34-41。docs/specs/cli.md に stub 記載なし。

**変更内容**: 0.7.0 最初の PR で run.ts:4164-4174 削除。goal-renamed-stub.test.ts は「`harness goal` が unknown command として非 0 終了・stderr に `unknown command`」へ書き換え（stub 復活も成功化も検知）。commander は exitOverride 未使用のため unknown command で自前 exit(1)+`error: unknown command 'goal'`、run.ts:4372 の parseAsync().catch と干渉しないことをテスト担保。CHANGELOG に removal 記載。

**対象ファイル**: src/cli/run.ts:4164-4174、tests/integration/goal-renamed-stub.test.ts / **挙動・互換性**: **breaking（意図的）**: 誘導文→generic unknown-command。0.6.x で 1 リリース誘導提供済み、0.7.0 で削除を CHANGELOG 明記 / **安全境界考慮**: なし / **テスト**: 書き換え integration（RED→GREEN）/ **規模**: 小

### #134 [P3] 横断 minor findings（~16件）
- **DomainLock release フラグ順**: db-domain-lock.ts:214-215 — `released=true` を UPDATE 前に立て、UPDATE throw で再 release 不能→TTL 待ち。フラグを UPDATE 成功後へ。
- **course paused 到達不能**: paused は型/filter にあるが設定経路ゼロ（types.ts:1-4, cli/course.ts:306, setStatus は closed のみ :471）。`course pause/resume` 追加 or 型/filter から除外を 0.7.0 で決定（orchestrator gate は :95 で非 active 拒否済みのため pause 追加が安価）。
- **dry-run 出力**: cli/course.ts:236-240 が note/blockedHitch を落とし実 run 出力(255-261) と非対称。整形関数統合。
- **courseError 正規表現**: cli/course.ts:58-64 の `/...|project/i` 過剰一致（内部エラーも user-fixable 化）。message-regex 廃し typed error へ。
- **MCP resolver cast**: hitch-tools.ts:944-946・mutation-tools.ts:1783-1785 の二段 cast を type guard に。
- **budget not_driven ラベル**: course-orchestrator.ts:277-291 — budget 枯渇が途中でも一律 not_driven。partially_driven 相当 or drivenHitches 含む正確ラベル。
- **latestDecision tiebreak**: rollup.ts:59-70 — createdAt>= のみで同時刻は列挙順勝ち。decisionId 第二キー追加で決定論化。
- **normalize 重複**: course-orchestrator.ts:564 と course-tools.ts:347 等の重複を共通 util へ。
- **unlink silent**: phase-repository.ts:129 unlinkHitch が 0 行でも void、CLI 無条件 unlinked(cli/course.ts:677-679)。boolean(changes>0) 返し未リンク時はその旨出力。
- **confirmation 未redact 永続化**: confirmation.ts — input_json/preview_json 生のまま永続化・redact は read 時のみ(:218,224-244)。**確定実行に原本が必要**（confirmation-runner.ts:45-46 が stored args 再 parse 実行）ため insert 時 redact 不可→「at-rest は生・表示面は全経路 redact」を docs/specs/mcp.md 明文化し表示経路の redact 漏れ無しをテスト固定。
- **PR body /tmp 権限**: gh-pr-publisher.ts:63-68 — 共有 tmpdir に予測可能名+default perm。mkdtemp(0700) 配下へ。
- **project_id echo oracle**: read-tools.ts:200 等 — `project not found: ${projectId}` が permission 独立に存在有無返す。permission denied と not-found のエラー形統一（or permission 先行）。
- **dead confirmation config**: config.ts:31,113,158,202,331-334 — requireOutOfBand/allowAgentConfirm は parse/default だが消費者ゼロ。enforce 配線 or schema 除去（除去なら docs/specs/mcp.md 更新）。
- **redaction entropy**: redaction.ts:3-6 — keyword/代入 regex+scanForSecrets のみで高 entropy 未検出。誤検知トレードオフのため docs/future-features.md に defer（理由記録）。
- **symlink diff docs**: 実装は symlink follow しない（review-evaluator.ts:176-201、reviewed-fingerprint.ts:11-15）が docs 記述なし。docs/specs/workflow.md に symlink-safe セマンティクス 1 段落追記。
- **walkCourse 行数/halt label/immutability**: course-orchestrator.ts:241-370 130 行超+可変蓄積。phase 単位処理を helper 抽出、stopReason ラベルを type 固定、蓄積を immutable に（#125 Phase B/C と同時可）。

**挙動・互換性**: 非 breaking（dead config 削除のみ config 表面変更→docs 同時）/ **安全境界考慮**: confirmation 2 件は「shell 迂回禁止/fail-closed」維持方向 / **テスト**: 各 nit に unit 1〜2（lock release 再試行・tiebreak 決定論・unlink 戻り値・oracle エラー形）/ **規模**: 各小

## 実装順（Group B）
#128(docs)→#133(0.7.0 stub)→#127(テスト seam)→ schema V22 設計まとめ(#126 DROP + #130 lifecycle_events + #131 prompt_provenance, #131 は #116 と同時)→ #125 Phase A(run.ts 分割, #133 後)→ #134(独立 nit は単独小 PR、walkCourse は #125 と同時)→ #125 Phase B〜D(Tier-2 最後・人手レビュー)。
