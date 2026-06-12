# Audit fixes spec — #112–#134（「大」#129/#132 を除く 21 issue）

Status: Fable-5 作成 → codex gpt-5.5 xhigh レビュー対象。実装は codex exec gpt-5.5 high（TDD）。
Date: 2026-06-12 / target: v0.6.0 main。

## 範囲
2026-06-12 の Fable 詳細監査で起票した #112–#134 のうち、**大きな仕様変更（#129 failed-command 自動復帰 / #132 AbortSignal 中断）を除く 21 issue** の修正方針 spec。各 issue: 現状 / 変更内容 / 対象 file:line / 挙動・互換性 / 安全境界考慮 / テスト / 規模。

## 不可侵の安全境界（全 spec が遵守）
policy 事後 git diff 検証を緩めない / LLM 出力を状態遷移根拠にしない / 状態遷移は harness のみ決定論 / MCP confirmation_required を shell で迂回しない / fail-closed / fail-open(完了/許可)=決定論+operator・fail-closed(制限/作業追加)=外部可 の非対称 / 小ファイル・immutability・spec 駆動。

## 調査中の重要メモ
- **#116**: 提案された主修正（insertProposal の tx 内 run-status 再読 + ReviewerAgentGateError）は既に commit `6db3659` で実装済み・テスト有り。本 spec は残存ギャップ（overwrite guard の非アトミック性 = 並行 review auto の後勝ち supersede）に限定。docs/future-features.md の当該 active follow-up は stale。
- **#124 調査中の新発見**: `src/mcp/tools/mutation-tools.ts:1341` の第三の private `runMcpOperation` が input を redact しない（wrapper 版は redact 済み）→ 監査ログへの機微情報混入の可能性。**本バッチ外の新規 issue として起票推奨**。
- schema 変更を伴う #126(DROP) / #130(hitch_lifecycle_events) / #131(prompt_provenance_json) は **migration V22 として設計をまとめてから**個別 PR にする。

---

# Group A（#112–#124）


---

# codex gpt-5.5 xhigh レビュー反映（2026-06-12・改訂）

総合判定: **P0 なし / P1×4（#113, #124, #126, #121）は実装前に spec 修正必須**。#115/#117/#114/#120/#130 は P2 補正を入れれば実装素材として使える。以下を Group A/B の各 issue に対する**上書き指示**とする。

## P1 修正（実装着手の前提）
- **#113 改訂**: lock/lease 衝突を rethrow するだけでは不足。`createOrchestratorRunners` は coder 実行前に attempt を作り例外時に一律 failed 完了 + iteration を進める（src/hitch/orchestrator-runners.ts:321,359 / repository.ts:472,1088）。そのため `DomainLockBusyError`/`LeaseLostError`/`LeaseGuardFailedError` を **runner 側で attempt 非消費（cancelled/no-op 扱い）**にする設計まで spec に含める。さらに run 中の `LeaseGuardFailedError` は最終的に `RunFinalizedError` に包まれて投げられる（workflow-runner.ts:502,573）ため、catch は **RunFinalizedError でラップされたケースも判定**する（cause チェック）。
- **#124 改訂**: private `runMcpOperation`（mutation-tools.ts:1341）の **raw input 永続化（未 redact）を future-defer にしない**。共通 wrapper は redact 済み（operation-wrapper.ts:59,156）だが private 版は `opts.input` を生で `operations.input_json` へ渡し、dangerous 系（review.process / pr.create / DB apply）から使われる。**この redaction fix を本バッチの先行 P1 として #124 に含める**（少なくとも #124 refactor と同時）。
- **#126 改訂**: `db_stats_snapshots` は `V10_TABLE_NAMES` 経由で `ALL_TABLE_NAMES` に含まれ（schema.ts:1035,1663）、`tests/unit/db/migrations.test.ts:42` が全 ALL_TABLE_NAMES の存在を期待する。V10 DDL/V10_TABLE_NAMES は append-only で触らないが、**「最新スキーマの table list（ALL_TABLE_NAMES）から dropped table を除外する」方針と migrations.test.ts の更新を spec に明記**する。
- **#121 改訂**: COUNT 検証の lifecycle 条件が不足。classify runner は unknown を `open/reopened/escalated` で処理、defer runner は `open/reopened/out_of_scope` を処理する（orchestrator-runners.ts:437,465）。spec の `countFindings(unknown, open)` だけだと reopened/escalated/out_of_scope を残して resolved:true/deferred 完了にできる。**#112 の `countFindings` に `lifecycleStatusIn` 相当の filter を含め、classify は open/reopened/escalated、defer は open/reopened/out_of_scope を数える**と明記。

## P2 補正
- **#115**: `prepareProjectRun` は `projectContextPacks` も返す（run-project.ts:32）が MCP/course hitch 経路はこれも捨てている（mutation-tools.ts:490 / course-orchestrate-runtime.ts:66）。安全境界ではないが project-runtime 同等性として **projectContextPacks も thread 対象に含める**。
- **#117**: 「permissions.ts の 1 箇所で confirmation 起票も閉じる」は不正確。server の汎用 confirmation 起票は `tool.kind === "mutation"` 限定（server.ts:269）で、dangerous は handler 側 `confirmationResult` 経由。**permission deny は handler 前に効くので実害は少ない**が、spec の説明とテスト観点を「permission 層 deny が handler 実行前に dangerous 起票を止める」に修正。
- **#114**: repoId-only で `effectiveProjectId` が導出されない global client では同一 idempotencyKey が **null scope で衝突し得る**（hitch-tools.ts:289）。**projectId 不明時の null scope を意図仕様として明文化**（または scope fallback を定義）。restricted client の leak は塞がるが null-scope 衝突は「同一 null-project の正当な replay」として許容する旨を記す。
- **#120**: `created_at` tie-break は既存データで created_at 同一なら `phase_id` 順に戻るため「全0 course が作成順に直る」は**完全保証でない**旨を spec に注記（自動採番は新規 phase には有効）。
- **#130**: `hitch_lifecycle_events.created_by` を入れるなら `updateStatus`（actor を受けない・repository.ts:402）の **caller から actor を渡す設計**を明記。

## 妥当と確認された点
- #112 の SQL 集計化（方向性正しい・`latestFindingMutationAt` を全 finding 対象にすれば現状より安全側・findingIds advisory truncate 明記も妥当）。
- #116（主修正は 6db3659 で実装済み・残存 supersede gap への `failIfSupersedes` 追加は筋が通る）。
- #130/#131 を V22 にまとめる方針（additive column + audit table は no-downgrade に反しない）。#126 の DROP のみ上記の table-list/test 補正が要る。
- 実装順の依存（#112→#121 / #115→#113 / #116↔#131 / V22 まとめ）は概ね妥当。**追加: #124 の redaction fix は #124 refactor と同時 or 先行**。

## 改訂後の着手条件
#113 / #124 / #126 / #121 の spec を上記で改訂後に実装着手可。#115/#117/#114/#120/#130 は P2 補正込みでそのまま TDD 実装素材として使える。
