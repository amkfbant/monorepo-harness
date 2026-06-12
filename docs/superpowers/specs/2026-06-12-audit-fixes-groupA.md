# Audit fixes spec — Group A（#112–#124）

> Fable-5 作成。親: `2026-06-12-audit-fixes.md`。codex xhigh レビュー対象。

### #112 [P1] convergence の findings LIMIT 10,000 で close_ready が fail-open
**現状**: `ConvergenceService.evaluate` は `this.repo.listFindings({ hitchId, limit: 10_000 })` の行フェッチで全判定材料を作る（src/hitch/convergence.ts:28）。`listFindings` は `ORDER BY first_seen_at ASC, finding_id ASC LIMIT ?`（src/hitch/repository.ts:962-977、既定 `filter.limit ?? 200` は :969）。この rows から (a) severity/scope カウント（convergence.ts:100-117 `buildMetrics`）、(b) `maxReopenCount`（:129-132）、(c) close-check 鮮度の `freshAfter` タイムスタンプ（:196-222 `lastCloseCheckInvalidatingMutationAt` が `lastSeenAt`/`fixedAt`/`deferredAt`/`escalatedAt` を走査）、(d) `finding_policy` close condition の open カウント（src/hitch/close-checks.ts:120-145 `evaluateFindingPolicy`）、(e) 推奨アクションの findingIds 列挙（convergence.ts:551-568）を全て導出。10,000 件超で first_seen_at が新しい open P0/P1 が (a)(b)(c)(d) から消え、`close_ready`（:283-297）が fail-open し得る。rollup 側は SQL COUNT で既に修正済み（src/roadmap/rollup.ts:31-52 `openCounts`、LIMIT なし）。

**変更内容**: スカラー値は全て SQL 集計に置換し、行フェッチは findingIds 列挙のみに限定する。
1. `HitchRepository` に集計メソッドを追加: `countFindingSummary(hitchId)`（GROUP BY scope_status,severity,lifecycle_status の 1 クエリで openInScopeP0/P1/P2・openUnknownScope・openOutOfScope）、`maxFindingReopenCount(hitchId)`（COALESCE(MAX(reopen_count),0)）、`latestFindingMutationAt(hitchId)`（MAX over last_seen_at/fixed_at/deferred_at/escalated_at）、`countFindings(filter)`（汎用 COUNT・#121 流用）。
2. `evaluate()` で `buildMetrics` の finding 系 5 フィールド + `maxReopenCount` を上記集計から構築。`lastCloseCheckInvalidatingMutationAt` の finding 寄与を `latestFindingMutationAt` に置換（attempts/cycles 走査は現状維持）。
3. `evaluateCloseConditions` の入力を `findings: HitchFinding[]` → `findingCounts: {openInScopeP0;openInScopeP1;openInScopeP2;openUnknownScope}` に変更（close-checks.ts:43-48,120-145。呼び出し元は convergence.ts:32-42 のみ）。
4. `openFindingIds`/`unresolvedOutOfScopeFindingIds` 用の行フェッチは scope/lifecycle/severity を WHERE で絞った `listFindings`（明示 limit 200）に置換し、「recommendedNextAction.findingIds は advisory・truncate され得る」と JSDoc 明記。
5. export されている `buildConvergenceMetrics`（convergence.ts:68-90）は src 内他呼び出しが無いため counts 入力に揃える。

**対象ファイル**: src/hitch/convergence.ts:26-65,92-134,196-222,551-568 / src/hitch/repository.ts:962-977 / src/hitch/close-checks.ts:43-88,120-152 / docs/specs/hitch-convergence.md

**挙動・互換性**: 10,000 件以下では判定不変。超過時のみ fail-open → 正確化（escalate/needs_fix 方向）。findingIds truncate は従来も暗黙に存在（明文化のみ）。breaking なし。

**安全境界考慮**: fail-open バグ除去。判定は決定論 SQL のまま。close_ready（完了方向）の根拠厳密化 = 非対称原則整合。

**テスト**: 集計メソッド単体（lifecycle/scope 境界・rollup openCounts と同値）/ closed 多数 + first_seen_at 最新の open in-scope P0 1 件で evaluate が escalate / evaluateCloseConditions の counts 入力化。

**規模**: 中（~120 行 + テスト）

### #113 [P1] course-pass lease のフェンシング未適用 — 失効 lease 下の phase write / 偽 escalation
**現状**: course pass は acquire 時のみ lease 取得（src/roadmap/course-orchestrator.ts:123-146）。`beforeDriveHitch: () => lease.heartbeat()`（:170）は各 drive 前フェンシングだが、(a) phase CAS `transitionStatus`（:416、呼び出し :329-339→:398-429）は heartbeat 成功後 suspend で失効した lease 下でも走り得る、(b) drive 中の background heartbeat 失敗は flag のみで drive 完了後 throw（:210-236）。run 層には write 時フェンシング `assertActiveLease`（src/workspace/db-domain-lock.ts:333-354）があるが course 層に等価物無し。新旧 pass 衝突時、新 pass coder run が run 層 lock busy（src/core/workflow-runner.ts:331-338）→ runner throw → `HitchOrchestrator` catch が hitch を無条件 escalated 遷移（src/hitch/orchestrator.ts:123-148, 特に :144-147）= 偽 escalation。

**変更内容**:
1. `DomainLockHandle` に `assertHeld(now?)` 追加（延長しない検証。`SELECT 1 ... WHERE lock_id=? AND holder_run_id=? AND released_at IS NULL AND expires_at>?`、assertActiveLease と同形）。
2. `WalkCourseOptions` に `beforeStatusWrite?` を追加し `transitionStatus`（:416）直前で呼ぶ。`runWithLease` が `beforeStatusWrite: () => lease.assertHeld()` を渡す（plan パスは渡さない）。`beforeDriveHitch` heartbeat 維持。
3. `runWithLeaseHeartbeat` で leaseLost フラグ後（および LeaseLostError 捕捉時）course 層は以後 write せず `CourseOrchestrateError("lease_lost")` に正規化 abort（`CourseOrchestrateErrorCode` に `"lease_lost"` 追加）。
4. 偽 escalation 抑止: `HitchOrchestrator.run` catch（orchestrator.ts:123-148）で `DomainLockBusyError||LeaseLostError||LeaseGuardFailedError` の場合は escalated に**せず** rethrow（lock/lease 衝突=他プロセス作業中の一時状態、escalated と区別）。course 層は lease_lost/lease_busy 系として stop。

**対象ファイル**: src/workspace/db-domain-lock.ts:97-228 / src/roadmap/course-orchestrator.ts:33,72-80,164-239,398-429 / src/hitch/orchestrator.ts:123-148 / docs/specs/roadmap.md

**挙動・互換性**: CLI `hitch orchestrate` 単体でも run 層 lock busy 時は hitch=escalated でなくエラー終了（hitch 状態不変）に変わる。CHANGELOG 記載。course orchestrate は lease 喪失で lease_lost エラー。

**安全境界考慮**: 状態遷移は決定論ロジックのまま（エラー型分岐・LLM 不使用）。escalated にしない=「遷移しない」= fail-closed。lease 検証強化は制限方向。

**codex 改訂（P1）**: rethrow だけでは不足。`createOrchestratorRunners` は coder 実行前に attempt を作り例外時に一律 failed 完了 + iteration を進める（src/hitch/orchestrator-runners.ts:321,359 / repository.ts:472,1088）ので、lock/lease 衝突（一時状態）を「failed coding attempt + budget 消費」として残してしまう。→ **runner 側で `DomainLockBusyError`/`LeaseLostError`/`LeaseGuardFailedError` を attempt 非消費（cancelled/no-op）扱い**にする設計まで含める。さらに run 中の `LeaseGuardFailedError` は最終的に `RunFinalizedError` に包まれて投げられる（workflow-runner.ts:502,573）ため、catch は **`RunFinalizedError` の cause も判定**する。

**テスト**: assertHeld 単体（held/expired/奪取/released）/ phase transition 直前に lease 奪取 → transitionStatus 走らず lease_lost abort（HARNESS_LOCK_LEASE_MS 短縮・既存 lease-stolen-finalize.test.ts 流用）/ coder runner が DomainLockBusyError を投げる fake で hitch が escalated にならず**かつ attempt が failed として残らない** / RunFinalizedError(cause=LeaseGuardFailedError) も lease_lost として扱う。

**規模**: 中（~120 行 + テスト）

### #114 [P1] hitch.start の idempotency id に project scope 欠如（cross-project replay leak）
**現状**: `hitchIdForIdempotencyKey` は key 単体の sha256（src/mcp/tools/hitch-tools.ts:963-966）。`hitchStartTool` は `args.hitchId ?? hitchIdForIdempotencyKey(args.idempotencyKey)`（:299）→ `target: {type:"goal", id:hitchId}`（:302）。OperationRunner replay キー UNIQUE `(operation_type,target_id,idempotency_key)`（src/operations/operation-runner.ts:20-27）に project 次元無し → 別 project の restricted クライアント同士が同一 key で 2 人目が 1 人目の hitch を replay 受領。course/phase は修正済み（`scopedIdForIdempotencyKey` が JSON `[scope,key]` tuple を hash、src/mcp/tools/course-tools.ts:297-336）。

**変更内容**:
1. `scopedIdForIdempotencyKey`（course-tools.ts:314-322, module-private）を `src/mcp/tools/scoped-idempotency.ts` へ抽出・export（設計コメントごと）。course-tools は import に。
2. hitch-tools.ts:963 を `hitchIdForIdempotencyKey(projectScope, key) => scopedIdForIdempotencyKey("hitch", projectScope, key)` に。呼び出し（:299）は `hitchIdForIdempotencyKey(effectiveProjectId ?? null, args.idempotencyKey)`（effectiveProjectId は #81 repoId 導出後 :289-296）。`args.hitchId` 明示パス不変。

**対象ファイル**: src/mcp/tools/hitch-tools.ts:299,963-966 / src/mcp/tools/course-tools.ts:297-336 / 新規 src/mcp/tools/scoped-idempotency.ts / docs/specs/mcp.md

**codex 補正（P2）**: repoId-only で `effectiveProjectId` が導出されない global client では同一 idempotencyKey が **null scope で衝突し得る**（hitch-tools.ts:289）。これは「同一 null-project 内の正当な replay」として許容する仕様（restricted client 跨ぎの leak は projectScope で塞がる）。→ **projectId 不明時は null scope で導出する**ことを意図仕様として spec に明文化（course 側と同じ扱い）。

**挙動・互換性**: **replay 非互換**: 同一 idempotencyKey の再送が別 hitchId 導出で新規作成になる（upgrade 跨ぎ）。`hitch-` プレフィックス不変。CHANGELOG 明記。

**安全境界考慮**: cross-project 漏洩（fail-open）閉鎖。導出は決定論 hash。

**テスト**: project A/B が同一 key で hitch.start → 異 hitchId・replay されない / 同一 project+key → replay 成立 / null scope と空文字 project の distinctness。

**規模**: 小（~40 行 + テスト）

### #115 [P1] orchestrator が coder に compiledPolicy を thread せず、事後 git diff 検証スコープが乖離
**現状**: `runDomainCoding` は `opts.compiledPolicy ?? { raw policies/global.yaml + policies/<repoId>.yaml }`（src/core/workflow-runner.ts:114,283-289）で事後検証（diffAndValidate→validateChangedPaths, :223-249）が走る。`OrchestratorRunnerDeps`（src/hitch/orchestrator-runners.ts:121-196）に compiledPolicy 無く coder runner（:337-345）も渡さない → orchestrator 経由は常に raw repo policy。MCP `harness.hitch.orchestrate` は prepareProjectRun で compile 済みなのに `prepared.compiledPolicy` 破棄（src/mcp/tools/mutation-tools.ts:490-510）。course 層同様（src/roadmap/course-orchestrate-runtime.ts:66-90）。`run --project` 経路は thread 済み（src/core/reviewed-run-workflow.ts:86-92 / mutation-tools.ts:208,361 / src/project/run-project.ts:38,129-132）。

**変更内容**:
1. `OrchestratorRunnerDeps` に `compiledPolicy?: {global;repo}` / `project?: RunMeta["project"]` 追加。
2. coder runner（:337-345）で `runDomainCoding` に spread thread。`closeAndPr` は policy 消費しないため thread 不要（issue 文言との差を spec 明記）。
3. wiring: mutation-tools.ts:499 / course-orchestrate-runtime.ts:71 に `compiledPolicy: prepared.compiledPolicy, project: prepared.project`。CLI（src/cli/hitch.ts:551,899,1019）は projectId ある hitch で `prepareProjectRun(...)` 解決して渡す共通ヘルパー `resolveHitchRunnerDeps` 導入。projectId 無し素 repo hitch は従来 raw policy（非 project モード仕様）。
4. **codex 補正（P2）**: `prepareProjectRun` は `projectContextPacks` も返す（run-project.ts:32）が MCP/course hitch 経路はこれも捨てている（mutation-tools.ts:490 / course-orchestrate-runtime.ts:66）。安全境界ではないが project-runtime 同等性として **`projectContextPacks` も thread 対象に含める**（`run --project` 経路と挙動を揃える）。

**対象ファイル**: src/hitch/orchestrator-runners.ts:121-196,337-345 / src/mcp/tools/mutation-tools.ts:490-510 / src/roadmap/course-orchestrate-runtime.ts:66-90 / src/cli/hitch.ts:551,899,1019 / docs/specs/workflow.md・project.md

**挙動・互換性**: project-scoped hitch の事後検証が raw→compiled に変わり、profile が狭めた scope では従来 allowed の diff が denied になり得る（**制限方向**・CHANGELOG）。effective policy snapshot の source が project-runtime に。

**安全境界考慮**: 検証は緩めない — 対象 policy を意図した（狭い側）に正す fail-closed。

**テスト**: profile が repo policy より狭い fixture で MCP/course coder run の snapshot が compiled(source=project-runtime) / raw 通過・compiled deny の path を fake codex が書くと run=denied / projectId 無し hitch は従来挙動。

**規模**: 中（~120 行 + テスト）

### #116 [P1] review auto insertProposal の transactional run-status guard（TOCTOU）— 残存ギャップのみ
**現状**: 主 fix は実装済み（insertProposal が tx.immediate 内で run status/source_mode 再読し ReviewerAgentGateError、src/db/repositories/review-proposals.ts:61-78,111。commit 6db3659・テスト有り）。**残る非アトミック性**: `allowOverwrite=false` の「active proposal 既存なら拒否」は codex 実行前の readonly probe のみ（src/core/reviewer-agent.ts:380-418, 特に :405-412）で insert（:546）時に再検証されず、並行 2 本の review auto が両方通過すると後着が無条件 supersede UPDATE（review-proposals.ts:82-88）で先着 verdict を黙って置換。

**変更内容**:
1. `ReviewProposalInput` に `failIfSupersedes?` 追加。`insertProposal` tx 内で supersede UPDATE の `changes>0` かつ `failIfSupersedes` なら ReviewerAgentGateError（rollback）。
2. reviewer-agent.ts:546 で `failIfSupersedes: !inputs.allowOverwrite` を渡す。review-processor.ts:706 の file-import 経路は現行どおり。
3. docs/future-features.md の当該 active follow-up を削除（実装済み + 本 issue で残部完了）。issue close 時に「主提案は 6db3659 で実装済み」コメント。

**対象ファイル**: src/db/repositories/review-proposals.ts:20-31,60-112 / src/core/reviewer-agent.ts:539-557 / docs/future-features.md

**挙動・互換性**: 並行 review auto の 2 本目が黙って supersede → エラー（restriction）。`--allow-overwrite` 明示置換不変。

**安全境界考慮**: LLM(reviewer) 出力 2 本競合の後勝ち置換穴を閉じる。判定は tx 内決定論。

**テスト**: 既存 in-tx guard 維持 / failIfSupersedes:true で active 既存なら throw・フラグ無しは supersede 成功 / reviewer-agent 経由で probe〜insert 間に別 proposal 挿入 → ReviewerAgentGateError + review-auto-error.json。

**規模**: 小（~40 行 + テスト）

### #117 [P2] dangerous 系 MCP が per-client mode を素通り
**現状**: `decideMcpPermission` は `kind==="dangerous" || requireConfirmation.includes(operation)` を kind 別ゲートより前に評価し clientMode を見ず `confirmation-required(allowed:true)`（src/mcp/security/permissions.ts:93-103）。mutation は guarded-mutation 以外拒否（:120-127）、dry-run は read-only 拒否（:109-118）と非対称。confirm 時再評価（src/mcp/confirmation-runner.ts:60-71）も同様素通り → read-only クライアントが dangerous 10 tools（tool-registry.ts:1655-1823: review.process/cleanup.apply/pr.create/hitch.close/hitch.cancel/hitch.expand_scope/db.repair.apply/db.archive.apply/db.migrate_blobs.apply/db.gc_blobs.apply）の confirmation 起票でき人間 confirm 後実行。hitch.close close_ready fast-path のみ guarded-mutation+allowlist 要求（src/mcp/tools/hitch-tools.ts:877-893）。

**変更内容**: confirmation-required 分岐（:93-103）に clientMode ゲート追加: `kind!=="read" && clientMode!=="guarded-mutation"` なら `permissionDenied(reason:"dangerous_disabled_for_client")`。**codex 補正（P2）**: 「permissions.ts 1 箇所で起票も閉じる」は不正確 — server の汎用 confirmation 起票は `tool.kind==="mutation"` 限定（server.ts:269）で dangerous は handler 側 `confirmationResult` 経由。ただし **permission 層 deny は handler 実行前に効く**ため、`decideMcpPermission` で deny すれば dangerous 起票も confirm 後実行も止まる（正）。テスト観点は「permission 層が handler 前に dangerous を deny する」で書く。`allowedOperations` allowlist を dangerous に課す横展開は既存 config breaking のため見送り→docs/future-features.md に defer。

**対象ファイル**: src/mcp/security/permissions.ts:93-103 / docs/specs/mcp.md / docs/future-features.md

**挙動・互換性**: read-only/dry-run クライアントの dangerous 起票が拒否に（restriction 方向の breaking・CHANGELOG・`.harness/mcp.yaml` で guarded-mutation 昇格の移行手順）。guarded-mutation/CLI confirm 不変。

**安全境界考慮**: confirmation モデル不変（迂回しない）。per-client 境界を最破壊的クラスに適用 = fail-closed。

**テスト**: clientMode×kind の decideMcpPermission 単体マトリクス + confirm 再評価で read-only snapshot 拒否の confirmation-runner integration。

**規模**: 小（~30 行 + テスト）

### #118 [P2] doctor.summary が project-scoped クライアントに全 project finding を漏洩
**現状**: `doctorSummaryTool`（src/mcp/tools/read-tools.ts:756-808）が最新 doctor run の全 doctor_findings を message/details_json 込みで返す（:780-805）。登録（tool-registry.ts:1069-1078）に project ゲート無し。doctor_findings に project 列無く（schema.ts:979）details に他 project の runId/path（doctor.ts:161）。

**変更内容**: finding→project の決定論的解決不可のため project-scoped クライアントには集計のみ返す（fail-closed）: allowedProjects>0 なら latest ヘッダ + severity/status 別件数のみ・message/details/findingId/checkId 伏せ・`findingsRedacted:true, reason:"project_scoped_client"`。global クライアントは現行どおり全詳細。db.status は機微度低のため future-features 注記のみ。

**対象ファイル**: src/mcp/tools/read-tools.ts:756-808 / docs/specs/mcp.md

**挙動・互換性**: project-scoped クライアント応答から finding 詳細消失（restriction）。global 不変。

**安全境界考慮**: cross-project read leak 閉鎖（伏せ方向=fail-closed）。

**テスト**: allowedProjects context で message/details/findingId 非含有・件数+findingsRedacted:true / global は詳細（regression）。

**規模**: 小（~40 行 + テスト）

### #119 [P2] db.migrate_blobs.apply に global-scope ガード欠如
**現状**: archive(:916-921)/gc(:1022-1027) は `allowedProjects>0 → global_scope_required` 拒否。`dbMigrateBlobsApplyTool`（src/mcp/tools/mutation-tools.ts:972-1016）に同ガード無く project 限定クライアントが confirm 経由で全 project blob 移行可。

**変更内容**: :975（isConfirmed 前）に同形 `allowedProjects>0 → permissionDenied(reason:"global_scope_required")` 追加。confirm 後実行も同 handler 再入のため両方閉じる。

**対象ファイル**: src/mcp/tools/mutation-tools.ts:972-1016 / docs/specs/mcp.md

**挙動・互換性**: project 限定クライアントの migrate_blobs 拒否（restriction）。global 不変。

**安全境界考慮**: archive/gc と対称な fail-closed。confirmation モデル不変。

**テスト**: allowedProjects 付き context で起票・confirm 後とも permission_denied / global は従来。

**規模**: 小（~10 行 + テスト）

### #120 [P2] phase position 既定0+UUID tiebreak で drive 順が作成順と無関係
**現状**: `add` は `input.position ?? 0`（src/roadmap/phase-repository.ts:45）、順序 `ORDER BY position ASC, phase_id ASC`（:63-65、tree :69-80 継承）。phase_id は CLI `phase-<uuid>`(:40)/MCP idempotency hash（course-tools.ts:331-336）→ 無指定 sibling は全 position=0 で UUID/hash 辞書順。SP-2 はこの pre-order で drive。

**変更内容**: (1) 自動採番: add で position 未指定時、同一 tx で `SELECT COALESCE(MAX(position)+1,0) WHERE course_id=? AND parent_phase_id IS ?` を採番。add 全体を `transaction().immediate()` 化。(2) 既存救済 tiebreak: listForCourse/tree の ORDER BY を `position ASC, created_at ASC, phase_id ASC` に。

**対象ファイル**: src/roadmap/phase-repository.ts:26-50,62-80 / docs/specs/roadmap.md

**挙動・互換性**: 既存「全 0」course の順が UUID→作成順に（意図に近づく・CHANGELOG）。明示 position 不変。migration 不要。**codex 補正（P2）**: 既存データで `created_at` が同一ミリ秒なら `phase_id` 順に戻るため「全0 course が作成順に直る」は**完全保証ではない**（自動採番は新規 phase に有効・既存救済は best-effort）旨を注記。

**安全境界考慮**: 決定論順序の確定のみ。drive 可否判定に触れない。

**テスト**: 無指定 3 phase→作成順 / 明示+無指定混在 / 採番が parent ごと独立 / 既存形式 fixture で作成順 regression。

**規模**: 小（~30 行 + テスト）

### #121 [P2] classify/defer runner の暗黙 limit 200 で resolved:true の contract violation
**現状**: classify runner は `listFindings({hitchId,scopeStatus:"unknown"})`（limit→200）処理して無条件 `{resolved:true}`（src/hitch/orchestrator-runners.ts:437-454）。defer も同様（:462-470）。200 件超で未処理残るのに resolved:true（orchestrator.ts:76-82 が信じて continue）。

**変更内容**: 両 runner をバッチループ + 最終 COUNT 検証に。classify はバッチ取得→classifyFinding（scope 変わるので次バッチに出ない＝有限）→最終 COUNT が 0 なら resolved:true・残れば resolved:false+escalateReason。defer も同形（deferred 実数累積・進捗ゼロバッチ検知で停止し無限ループ防止）。countFindings は #112 追加メソッド流用。**codex 改訂（P1）**: 現行 classify runner は unknown を `open/reopened/escalated` で処理、defer runner は `open/reopened/out_of_scope` を処理する（orchestrator-runners.ts:437,465）。`countFindings(unknown, open)` だけだと reopened/escalated/out_of_scope を残して完了扱いにできてしまう。→ **#112 の `countFindings` に `lifecycleStatusIn` 相当の filter を持たせ、classify の残数検証は `scope=unknown かつ lifecycle IN(open,reopened,escalated)`、defer は `scope=out_of_scope かつ lifecycle IN(open,reopened,out_of_scope)` を数える**と明記（処理対象 lifecycle と検証対象 lifecycle を一致させる）。

**対象ファイル**: src/hitch/orchestrator-runners.ts:433-492 / src/hitch/repository.ts（countFindings, #112 共有）/ docs/specs/hitch-convergence.md

**挙動・互換性**: 200 件超でも 1 step 全件処理・resolved/deferred 真値化。通常規模で不変。

**安全境界考慮**: resolved=true（完了方向）を決定論 COUNT で裏取る fail-closed 化。進捗ゼロ停止も fail-closed。

**テスト**: unknown 201+ → 1 回で全件・resolved:true / 分類不能混在→resolved:false+escalateReason / out_of_scope 201+→deferred=実数 / 進捗ゼロ fake で有限終了。

**規模**: 小〜中（~60 行 + テスト）

### #122 [P2] walkCourse の pass 開始時 rollup スナップショットで非 drive phase 報告が陳腐化
**現状**: walkCourse は rollup を pass 冒頭 1 回（src/roadmap/course-orchestrator.ts:245-248）。actionForPhase（:446-461, 呼び出し :268）は snapshot の declaredStatus/hitchIds/derivedOpenP0/P1 を使う（convergence のみ :457 live）。drive phase は :293/:409 で再読し write 保護するが非 drive 判定と pass 終盤報告は stale。

**変更内容**: per-phase live 再読（option A）: (1) rollup.ts の openCounts(:31-52) を export。(2) actionForPhase で snapshot は tree 構造（順序/depth/isLeaf）のみ使い、declaredStatus/hitchIds/derivedOpenP0/P1 を評価時点で再読。(3) docs/specs/roadmap.md に「tree 構造は pass 開始 snapshot 固定・各 phase 判定は到達時 live・pass 中追加 phase は次 pass まで不可視」明記。

**対象ファイル**: src/roadmap/rollup.ts:31-52 / src/roadmap/course-orchestrator.ts:241-268,446-461 / docs/specs/roadmap.md

**挙動・互換性**: pass 中の operator 操作が後続 phase 判定へ即時反映。plan も同経路。breaking なし。

**安全境界考慮**: ready_to_close（完了示唆）が stale counts に基づく穴を閉じる=fail-closed。write 保護（再読+#113 フェンシング）維持。

**テスト**: driveHitch コールバック内で別 phase を blocked 化/hitch link する fixture→後続 phase outcome が live 反映 / pass 開始後追加 phase が今 pass に現れない。

**規模**: 小〜中（~50 行 + テスト）

### #123 [P2] mutation-gate コメント vs orchestrator 実挙動の不整合（ドキュメント修正）
**現状**: src/hitch/mutation-gate.ts:90-95 は「close_ready/terminal/defer/classify は operator 必須・driver は deny」と述べるが、HitchOrchestrator はループ中の needs_classification を自動 classify（orchestrator.ts:76-83）・defer_followups を自動 defer（:84-88）。course 層は needs_classification を BLOCKED で subtree 隔離（orchestrate-dispatch.ts:9-14,40-48）。同 decision が三層で異なる扱い（決定論・fail-closed で違反ではないがコメント誤記）。

**変更内容**: コード変更なし（コメント+spec）: (1) mutation-gate.ts:90-95 を「entry を deny。ループ中 classify/defer は決定論 dispatch が runner で自動処理し本 gate 対象外。close_ready の close/PR と分類不能のみ operator 必須」に。(2) orchestrate-dispatch.ts の BLOCKED_DECISIONS に註記。(3) docs/specs/hitch-convergence.md に三層表追記。

**対象ファイル**: src/hitch/mutation-gate.ts:85-101 / src/roadmap/orchestrate-dispatch.ts:9-14 / docs/specs/hitch-convergence.md

**挙動・互換性**: 変化なし。

**安全境界考慮**: 誤設計表明の除去のみ。

**テスト**: なし（docs/コメント）。既存緑維持。

**規模**: 小

### #124 [P2] runMcpMutationOperation / runMcpOperation の重複統合
**現状**: src/mcp/tools/operation-wrapper.ts:29-123 と :125-220 が ~90 行ほぼ同一（差分は引数形のみ・エラー mapping 完全重複）。利用: hitch-tools(runHitchOperation 1)/course-tools(mutation 7+operation 1)。**第三の** private runMcpOperation が mutation-tools.ts:1307-1423 に別存在（input を redact しない :1341）。

**変更内容**: (1) runMcpOperation を共通コアに、runMcpMutationOperation を薄 adapter に（export 名・シグネチャ維持・呼び出し側無変更）。(2) **codex 改訂（P1）**: private `runMcpOperation`（mutation-tools.ts:1341）が `opts.input` を生で `operations.input_json` に渡し redact しない（wrapper 版は :59,156 で redact）。これは dangerous 系（review.process / pr.create / DB apply）から使われ監査ログに機微混入の可能性。**defer せず本バッチの先行 P1 として #124 に含める**: private 版の input 永続化にも `redactMcpAuditValue` を適用（または共通コアに寄せる）。private 版自体の wrapper 統合（hitchGate/queued/pendingExternalExecutor の機能差あり）は引き続きスコープ外で future-features defer 可。

**対象ファイル**: src/mcp/tools/operation-wrapper.ts:29-220 / src/mcp/tools/mutation-tools.ts:1341（redaction 適用）/ docs/future-features.md

**挙動・互換性**: 応答形不変。監査ログの input が redact されるようになる（機微情報を残さない方向）。

**安全境界考慮**: エラー mapping 片側修正漏れ除去 + 監査ログの機微情報残留を塞ぐ（fail-closed 方向）。

**テスト**: adapter 経由の budget-exceeded/in-flight/replayed-failure の応答形 regression（両版同一 mapping）+ フルスイート緑。

**規模**: 小（~-80 行 + テスト）

## 実装順（Group A）
#119 → #117 → #118 → #114 → #112 →（#112 前提）#121 → #116 → #115 →（#115 後）#113 → #120 →（#113 後 rebase）#122 → #123（docs 最後）→ #124（純 refactor 最後）。replay 非互換(#114)・restriction 方向(#113/#115/#117/#120) は CHANGELOG 必須。
