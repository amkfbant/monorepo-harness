# orchestrate / convergence reliability fixes (#166,#167,#168,#163,#164,#140,#154,#155,#141)

計画段階の正本（Fable 5 計画 / 2026-06-13）。実装は codex (gpt-5.5 xhigh) が
autonomous に行い、各 PR は codex xhigh の per-hitch レビューを正本ゲートとする。
最後に Fable 5 が全体レビューを行う。各 hitch の `--description` はこの文書の該当
§を凝縮したもの。harness 自身を `domain=self` で self-hosting して直す。

> 安全境界（不可侵）: policy 検証は事後 git diff ベース / LLM 出力を状態遷移の根拠に
> しない / 状態遷移は harness のみ / `confirmation_required` を shell で迂回しない /
> 迷ったら fail-closed。

## 実行順序と衝突クラスタ

- **Phase A — escalation correctness**: #167 → #140 → #166 → #168
  - #167 と #140 は `src/hitch/orchestrator-dispatch.ts:20` の review 強制マップと
    review runner 冒頭を共有 → 直列 or 同ブランチ。
  - #167 は hitch outcome を escalated→pr_created に変える → #168 の course テスト
    前提が変わるため **#167 を #168 より先**。
  - #166 は CLI のみで衝突小（独立）。
- **Phase B — divergence robustness**: #155 → #164
  - #155=誤 diverging の発生頻度↓（repository/review-integration 側）、
    #164=発生後の回復経路（convergence/repository 側）。ファイル衝突はほぼ無いが
    `divergenceReason` の budget 統一で軽い conflict 可能性 → #155→#164 の順。
- **Phase C — workspace/diff correctness**: #154 → #163 → #141
  - 全て `src/git/diff.ts` / `src/core/workflow-runner.ts` を触る → **直列必須**。
  - #154（base を origin/<base> 最新化）を最初に。さもないと #141 の diff budget が
    stale base 由来の「見かけ -1500 行削除」で誤発火し、#163 の累積 diff も狂う。

## #166 domain-lock contention → CLI deferred 化（コアは修正済み）

- **状態**: orchestrator レベルの誤 escalate は **#144 (`aa836b4`) で修正済み**。
  `src/hitch/orchestrator.ts:130-131` が `findTransientLeaseCause(e)` 検知時に
  escalate write（:152-157）の**前で rethrow**する（`tests/unit/hitch/orchestrator.test.ts:183,240`
  が status=open 維持を検証）。coder attempt も `orchestrator-runners.ts:443-453`
  で no-op discard（budget 非消費）。
- **残 root cause**: rethrow された `DomainLockBusyError` を単体経路が拾わない。
  単体 `hitch orchestrate`（`src/cli/hitch.ts:959-1052`）→ `hitchError()` 許容外 →
  `src/cli/run.ts` top-level catch で **exit 2（unexpected 扱い）**。MCP
  `harness.hitch.orchestrate`（`mutation-tools.ts:505`）も generic 失敗で `lease_busy`
  非構造化。course 配下は `course-orchestrator.ts` が `CourseOrchestrateError("lease_busy")`
  → exit 1 に変換済み。
- **修正設計**: orchestrator 層は不変（rethrow 契約維持）。CLI 境界で吸収:
  `orchestrate` / `classify --then-rerun` の catch で `findTransientLeaseCause(e)` を
  判定し `hitch=<id> outcome=deferred reason=lock_busy holder=<runId>` を出力して
  **exit 1**（`--json` 対応）。`hitchError()` に transient lease→exit 1 を追加。
  任意: `--lock-wait <seconds>`（default 0）で holder の `expiresAt` を上限に retry。
  MCP は任意 follow-up で `lease_busy` 構造化。
- **変更ファイル**: `src/cli/hitch.ts`（+任意 `src/hitch/lock-defer.ts`、
  `src/mcp/tools/mutation-tools.ts`）、`docs/specs/roadmap.md`（Compatibility note に
  単体経路の deferred を追記）。
- **テスト**: coder runner が `DomainLockBusyError` を投げる fixture → CLI ハンドラが
  `{outcome:"deferred", exitCode:1}`・hitch status=open 維持。`--lock-wait` の fake
  clock retry。既存 `orchestrator.test.ts:183/240` を GREEN 維持。
- **規模**: S（CLI のみ）〜M（--lock-wait + MCP 込み）。

## #167 approved run + close 条件充足の冪等 re-drive が escalate する

- **root cause（5段連鎖）**:
  1. `src/hitch/convergence.ts:493-496` close_ready に届かない場合の fallback が
     `continue`+`run_close_check`。close-check は鮮度ゲート（`close-checks.ts:106-114`、
     `checkedAt<freshAfter`→pending）を持ち、approved 後の finding 変異（defer 等）で
     passed 済み `review_consensus` が stale 化して close_ready を逃す。
  2. `src/hitch/orchestrator-dispatch.ts:20` が `continue`+`run_close_check` を run の
     状態を見ず無条件で `{kind:"review"}` にマップ。
  3. `src/hitch/orchestrator-runners.ts:470-482` review runner が無条件に
     `runReviewerAgent()`。
  4. `src/core/reviewer-agent.ts:387-395` が `classifyReviewGate()`（`review-gate-classify.ts:43-51`、
     `DECIDED_STATUSES`=approved/changes_requested/rejected/cleaned）で
     `ReviewerAgentGateError(kind:"already_decided")` を throw。
  5. `src/hitch/orchestrator.ts:129-158` の catch-all が一律 escalate。salvage も
     `reviewed-branch-push.ts:139-142` の `PrGateError("...status approved...")` で失敗。
- **修正設計（harness 層のみ・決定論的・fail-closed）**:
  - **A. review runner 事前ゲート（主）**: `runReviewerAgent` 呼出前に DB-canonical で
    最新 run status / 最新 processed proposal decision を確認
    （`RunsRepository.getRun`、`ReviewProposalRepository.getLatestProcessedProposal`）。
    **status decided かつ decision==="approved" のときのみ短絡**: reviewer/codex を
    呼ばず、既存 processed proposal から `review_consensus` close-check を現在時刻で
    再記録（`review-integration.ts` の close-check 記録を export して流用、
    例 `refreshReviewConsensusCloseChecks()`）。**新 review cycle は開始しない**
    （予算・freshAfter を進めない）。`{runId, decision:"approved"}` を返し次ループの
    convergence を close_ready→`close_and_pr` に前進。
  - 最新 check が既に fresh なのに非 close_ready（= 別の required 条件 pending、#140 の
    ケース）は無進捗ループ回避のため pending 条件名入りの明示エラーで escalate
    （fail-closed・有界性維持）。changes_requested/rejected の decided run は短絡せず
    従来どおり throw→escalate。判断材料は DB の runs.status / proposal のみ（LLM 非信用）。
  - **安全性**: approved 後に新 coder run があれば `latestRunId`（`orchestrator-runners.ts:313-325`）
    がその新 run（status=needs_review）を返し通常 review 経路に入る → 未レビューコードが
    close に滑り込む経路は無い。
  - **B. salvage ノイズ除去**: `salvageReviewBranch`（`orchestrator-runners.ts:831-842`）で
    run status が `needs_review` でなければ `null` を返す。
  - **C. 補助**: `review-gate-classify.ts` の `DECIDED_STATUSES` を export / `isDecidedRunStatus()`。
    `orchestrator-dispatch.ts` / `convergence.ts` は触らない（#164 衝突回避・最小差分）。
- **変更ファイル**: `src/hitch/orchestrator-runners.ts`, `src/hitch/review-integration.ts`,
  `src/core/review-gate-classify.ts`（, 必要なら `src/hitch/orchestrator-types.ts`）。
- **テスト**: orchestrator-runners.test（approved+proposal=approved で reviewer 非呼出・
  close-check 再記録・decision=approved・review cycle 不増・fresh+非 close_ready で
  記述的 throw・changes_requested は従来 throw・salvage が approved run で null）、
  orchestrator.test（approved 短絡→次 step で close_and_pr、escalate しない）、
  **hitch-orchestrate.test（本丸: approved run+passed close-check+その後の finding 変異で
  stale 化 → 再 orchestrate が escalate でなく close/PR へ前進、冪等）**。
- **規模**: M（src 100-150 / test 250-350 行）。

## #140 command-kind close-check を autonomous orchestrate で決定論的に充足

- **root cause**:
  - `src/hitch/convergence.ts:493-496` command close-check が pending
    （`close-checks.ts:98-104` "no evidence recorded"→pending）だと close_ready に
    届かず fallback `continue`+`run_close_check` に落ちる。pending が「review 待ち」か
    「command evidence 待ち」か区別する構造情報が無い。
  - `src/hitch/orchestrator-dispatch.ts:20` が無条件 `{kind:"review"}` → approved 再 review →
    `already_decided`（#167 と同根の一部）→ salvage 失敗 → escalate。
  - どの runner も command を実行せず evidence（`repository.ts` `recordCloseCheck`→
    `hitch_close_checks`）を書かない。書けるのは CLI `hitch close-check record` のみ。
- **修正設計**: 新 orchestrator action `close_check` を追加し harness 側が決定論的に
  command を実行・evidence 記録（LLM 自己申告は不使用）。
  1. `convergence.ts:493` 付近の fallback で required-pending の `kind==="command"`
     条件 id を `HitchNextAction` の optional `pendingCommandConditionIds?: string[]` に
     付与（additive）。`!reviewPending` のときのみ意味を持つ（review 後に command が
     正しい順序。review cycle 完了は freshness を invalidate するため）。
  2. `orchestrator-dispatch.ts:20`: `pendingCommandConditionIds` 非空 → `{kind:"close_check"}`、
     空 → 従来 `{kind:"review"}`。
  3. 新 runner `closeCheck(hitchId)`: pending command condition の `command` を
     **domain policy の `compiledPolicy` allowlist（`ResolvedCommand`）に解決**（id 一致 or
     表示文字列完全一致のみ）。allowlist 外は実行せず **fail-fast escalate**（"外部 evidence
     が必要: `hitch close-check record …`"）。実行は既存 `runAllowedCommands`
     （`src/core/command-runner.ts`、env allowlist/timeout/tree-kill 済）を再利用、cwd は
     最新 run の worktree。`attemptType:"close-check"`（`convergence.ts:234` が freshness
     計算から除外 → evidence を自己無効化しない）。exit0→passed 記録、非0/timeout→
     failed 記録（次ループで needs_fix→coder rerun に回る）。
  4. **evidence の置き場所（write scope 外）**: 判定の正は DB `hitch_close_checks.evidence_json`。
     command ログは `<runsDir>/<runId>/close-checks/` に出す（repo ツリー = domain write
     scope には一切書かない。#165 の sanctioned out-of-tree location と同じ答え）。
- **変更ファイル**: `src/hitch/types.ts`, `convergence.ts`, `orchestrator-dispatch.ts`,
  `orchestrator-types.ts`, `orchestrator-runners.ts`, `orchestrator.ts`,
  `src/cli/hitch.ts`（dry-run 表示）、`docs/specs/hitch-convergence.md`。
- **テスト**: convergence（command-kind pending のみ列挙 / reviewPending 時は従来）、
  dispatch（ids あり→close_check / なし→review）、runner（allowlist 一致→実行・passed
  記録 / 不一致→実行ゼロで fail-fast escalate / 失敗 exit→failed / attemptType="close-check"）、
  **orchestrator.test（coder→review(approve)→close_check→close_and_pr、review が 1 回のみ・
  escalate しない・salvage 非呼出）**、hitch-orchestrate.test（実 DB・ログが runsDir 配下のみ）。
- **規模**: M（src 150-200 / test 200-250 行）。
- **依存**: #167 と同根の一部。#140 を先に入れると #167 の再現面が縮む。close-check
  evidence 置き場所の規約は #140 で確定し #165 が参照。

## #168 course orchestrate: 上限ぴったり駆動の正常終了が budget_exhausted/exit1

- **root cause**:
  - `src/roadmap/orchestrator-types.ts:32` `CourseStopReason = "completed" | "budget_exhausted"`
    の 2 値のみ。「設定どおり予算を使い切った正常な bounded pass」を表す値が無い。
  - `src/roadmap/course-orchestrator.ts:329-348` が `drivenHitches.length >= maxDrivenHitches`
    の全ケース（phase 境界での綺麗な停止 / phase 途中）を一律 `budget_exhausted`(:345)。
  - `src/cli/course.ts:460-462` が `budget_exhausted` を無条件 `process.exit(1)`。
  - 区別可能な唯一の実シグナルは「現 phase が途中で切られたか」(`phaseDriven.length`)。
- **修正設計**:
  - `CourseStopReason` に第3値 **`"budget_reached"`** を追加（`orchestrator-types.ts:32` の
    union と `course-orchestrator.ts:107-110` の `COURSE_STOP_REASON` const。
    `satisfies Record<...>` でキー追加のみ。stopReason の switch はコードに無いことを確認済）。
  - `course-orchestrator.ts:329-348` の budget 分岐で `phaseDriven.length===0`（phase 境界、
    現 phase は `not_driven`）→ `budget_reached`、`>0`（`partially_driven_budget_exhausted`）
    → 従来 `budget_exhausted`。
  - lease 解放理由（:176-179）に `budget_reached` を分岐（観測性）。
  - CLI（:460-462）は `budget_exhausted` のみ exit 1 のままで `budget_reached` は自然に
    exit 0。MCP は result をそのまま返すだけで変更不要。
  - hitch convergence decision の `budget_exhausted`（別概念）は触らない。
- **変更ファイル**: `src/roadmap/orchestrator-types.ts`, `src/roadmap/course-orchestrator.ts`,
  `src/cli/course.ts`（実質コメントのみ）、`docs/specs/roadmap.md`（:204-209 停止
  セマンティクス、:288-294 Exit codes に `budget_reached`=exit 0）。
- **テスト**: course-orchestrator.test（:685-715 を `budget_reached` に更新＝本丸 /
  :717-744 mid-phase は `budget_exhausted` 維持 / NaN・非正 budget デフォルト 2 件を更新）、
  course-cli.test（2phase×1hitch・--max-driven-hitches 1 → budget_reached/exit0/
  operations succeeded、mid-phase で exit1 の新ケース）。
- **規模**: S（src 15-25 / spec 10-15 / test 60-100 行）。
- **依存**: **#167 を先に**入れてから #168 を検証（hitch outcome 変化で再現条件が変わる）。

## #155 言い換え finding の dedup 素通り → divergence 誤発火

- **root cause**: `src/hitch/stable-key.ts:19-36` `normalizeFindingIdentity` は空白圧縮+
  lowercase のみ、`hitchFindingStableKey` は summary の**完全一致ハッシュ**。review 由来
  finding は `src/hitch/review-integration.ts:220-233` で `filePath`/`symbol` を渡さず
  キーが実質 `category+summary` に縮退。paraphrase は別キー →
  `repository.ts:785-796` の完全一致 SELECT 素通り → `created=true` INSERT →
  `review-integration.ts:107` の `findingsNew` 膨張 → `convergence.ts:548-572`
  `divergenceReason`（`maxNewFindingsPerCycle=5` / `requireNewFindingsDecreaseAfterCycle=2`）
  誤発火。
- **修正設計（決定論的・LLM 非依存。既存 duplicate 機構を再利用）**:
  - 既存の `scope_status="duplicate"` + `duplicate_of` + `promoteDuplicateCanonical`
    （`repository.ts:774-781,805-813,908-979`）を再利用。**migration 不要**。
  - **Tier-1**: stable_key 完全一致（既存ハッシュ不変更 = DB 互換維持）。
  - **Tier-2**: 新 `src/hitch/near-duplicate.ts` の純関数 `findNearDuplicate`。
    ブロッキングキー（同一 hitch + 同一 category +（両者 filePath あれば一致 / 両方 null
    可））→ 正規化（lowercase / パス区切り統一 / 数字列→`#` プレースホルダ / 引用・
    バッククォート内容はトークン保持 / 句読点除去 / トークン化）→ 類似度（トークン集合
    Jaccard ≥ 0.6 **かつ** 単語 bigram Jaccard ≥ 0.5 の AND、正規化後 <5 トークンは
    fuzzy せず完全一致のみ）。ヒット時は新規行を `scopeStatus:"duplicate"` +
    `duplicateOf=canonical` で挿入（破棄しない・監査可）。canonical が fixed なら
    `promoteDuplicateCanonical` で reopen 計上。
  - `review-integration.ts:107` の `findingsNew` を「created かつ非 duplicate」に変更
    （divergence 入力を直接浄化）。
  - 外部 verdict の明示 stableKey パス（`orchestrator-runners.ts:1099` の
    `external-review:`）は Tier-2 スキップ（1-shot ingest 契約維持）。
  - **誤マージ対策**: duplicate 行を物理保持し `duplicate_of` で追跡（人手で in_scope に
    戻せる）/ AND 二重しきい値 + 短文ガード / severity は `moreSevere` で canonical 昇格 /
    policy knob `divergence.nearDuplicateDedup`（default on、緊急 off 可）。判定は全て
    決定論的（LLM テキストを正規化計算するのみ、状態遷移根拠は計算値）。
- **変更ファイル**: `src/hitch/near-duplicate.ts`（新規）、`src/hitch/repository.ts`、
  `src/hitch/review-integration.ts`、`src/hitch/types.ts` / `src/hitch/schemas.ts`（policy knob）。
- **テスト**: near-duplicate.test（正規化・しきい値境界、paraphrase が match / 別 finding
  （同 category・別内容）が match しない両方向、短文 <5 が fuzzy 対象外）、repository.test
  （near-dup を duplicate_of 付き挿入・canonical fixed→reopened 昇格・明示 stableKey で
  Tier-2 スキップ）、review-integration.test（paraphrase 込み proposal で findingsNew が
  duplicate を数えない）、convergence.test（dedup 後メトリクスで divergenceReason=null）。
- **規模**: M（src 150-200 / test 200-250 行）。
- **依存**: #164 と補完（#155=頻度↓ / #164=回復経路）。両 land 推奨。

## #164 diverging が terminal-but-not-reopenable で metrics クリア後も再評価しない

- **root cause**:
  - `src/hitch/convergence.ts:261-267` `decide()` 冒頭 `terminalDecision(session.status)`
    が `status==="diverging"` で即 `diverging`(:536) を返し live metrics（`divergenceReason()`
    :542-575）に到達しない。findingsNew=0 の新サイクル・close-check passed でも再評価なし。
  - `src/hitch/repository.ts:366-370` `REOPENABLE_STATUSES`={closed,budget_exhausted,escalated}
    に `diverging` 無く `reopenSession()`(:513-523) が拒否（意図的: reopen は divergence
    budget を延長しない）。
  - `convergence-status.ts:106-130` reversion 分岐が `close_ready→in_progress` のみで
    `diverging→in_progress` 経路が無い。
  - トリガー性質: `totalNewFindings`（累積和）と `maxReopenCount`（全 findings の MAX）は
    **単調増加＝自然にクリアしない**。`maxNewFindingsPerCycle` / `requireNewFindingsDecreaseAfterCycle`
    は最新サイクル基準＝**新サイクルでクリアし得る**。
- **修正設計（(a) operator reopen + (b) live 再評価、fail-closed 維持）**:
  - **(b) live 再評価**: `decide()` で `status==="diverging"` を無条件 short-circuit から
    外し、`divergenceReason()` を live metrics で再計算 → 非 null なら従来どおり `diverging`、
    **null（クリア）なら通常 decision にフォールスルー**。closed/cancelled/escalated/
    budget_exhausted の terminal 扱いは不変。累積トリガーは自然クリア不能 = 真の暴走は
    terminal のまま。クリアは「新サイクルで findingsNew 減少/0」という実証跡時のみ・決定論的。
  - **status 戻し**: `convergence-status.ts` の `syncHitchStatusForConvergence` に
    `diverging` かつ decision 非 terminal → `in_progress` reversion（既存 close_ready
    reversion と同型、lifecycle event で監査）。
  - **(a) operator reopen**: `REOPENABLE_STATUSES` に `"diverging"` 追加 +
    `ReopenHitchSessionOptions` に `extendTotalNewFindings?: number`（`max_total_new_findings`
    列を加算、schema 変更不要）。CLI `hitch reopen --extend-total-new-findings <n>`（default 0）。
  - **divergence budget の最小再設計**: `divergenceReason()` の policy 側チェックを
    `metrics.totalNewFindings > Math.max(policy.maxTotalNewFindings, session.maxTotalNewFindings)`
    相当に（session 列を runtime 上限の正とする。通常挙動不変、reopen 延長時のみ効く）。
    `maxReopenedPerFinding` トリガーは**変更しない**（churn 暴走は人間判断のまま）。
  - mutation-gate は毎回 `ConvergenceService.evaluate` を呼ぶため変更不要。
- **変更ファイル**: `src/hitch/convergence.ts`, `convergence-status.ts`, `repository.ts`,
  `src/cli/hitch.ts`, `src/mcp/tools/hitch-tools.ts`（reopen 系があれば）、
  `docs/specs/hitch-convergence.md`。
- **テスト**: convergence.test（diverging+新サイクル findingsNew=0+open P1=0 → 前進＝核心 /
  totalNewFindings budget 超過のまま → diverging 維持 / maxReopenCount 超過 → reopen 後も
  diverging 維持）、repository.test（diverging からの reopen 成功・max_total_new_findings
  加算・event detail）、mutation-gate.test（クリア後に allowed）、fixture-matrix.test
  （diverging→修正サイクル→close_ready の回復フィクスチャ）、hitch-cli.test（reopen の CLI）。
- **規模**: M（src 60-90 / spec 20-30 / test 150-250 行）。

## #154 run workspace の base を origin/<base> 最新化して分岐

- **root cause**: `src/git/diff.ts:44-48` `resolveBaseSha` が `git rev-parse --verify <base>`
  のみで local ref を SHA 化、fetch しない。唯一の呼出元 `src/core/workflow-runner.ts:463`
  → stale SHA が `git-worktree.ts:35-38` の `git worktree add -b <branch> <path> <baseSha>`
  に渡る。run 経路に fetch は存在しない（grep 確認）。push 経路は `push -u origin`
  ハードコード = origin 前提は既存。rerun（`rerun.ts:440`）も親 baseBranch で同じ
  resolveBaseSha を通り stale（#163 と整合）。detached/shallow で local `<base>` 無いと
  現状即失敗 → origin 優先解決は改善。
- **修正設計**: 新 `resolveFreshBaseSha`（`src/git/diff.ts` 内 or 新 `src/git/base-ref.ts`）。
  1. `<base>` が 40-hex SHA or `*/*`（明示 remote ref）なら現行 `rev-parse --verify` のみ。
  2. `git remote get-url origin` で有無確認。**origin あり**:
     `git fetch origin +refs/heads/<base>:refs/remotes/origin/<base>`（narrow refspec・
     fetch 専用 timeout）成功 → `rev-parse refs/remotes/origin/<base>`。**fetch 失敗
     （offline）**: 警告 + 既存 tracking ref `refs/remotes/origin/<base>` があればそれ、
     無ければ local `<base>` に fallback。**origin なし**: 現行 local rev-parse に fallback
     （temp repo / standalone 互換）。
  3. local `<base>` が存在すれば `git rev-list --count <localBase>..<resolvedSha>` で behind
     数算出、>0 で警告 + run log イベント。
  4. `workflow-runner.ts:463` を差し替え、`base_resolved`（source: origin/origin-stale-fallback/
     local、behindCount）イベント emit。
  - 安全境界: policy 検証は `collectDiff`（baseSha vs working tree）の事後 diff で、base が
    新しいほど現 main と一致方向（「-1500 行の見かけ削除」解消）。`collectDiff` は不変更。
- **変更ファイル**: `src/git/diff.ts`（or 新 `src/git/base-ref.ts`）、`src/core/workflow-runner.ts`、
  （typed なら `src/logging/run-log.ts`）。
- **テスト**: 新 base-ref.test（bare remote + clone A/B で remote main を進め A の local main
  を stale 化 → 解決 SHA が remote tip と一致＝本命 / origin なし→local fallback / fetch
  不能→tracking ref fallback+警告 / behind 数警告）。fetch は file:// or local path remote の
  みで構成（CI offline 安全）。既存 git-diff.test は local fallback を残す限り無修正。
- **規模**: M（src 80-100 / test 100-150 行）。
- **依存**: #163 と補完。#163 が「rerun は base 解決をスキップして既存 run branch を継続」
  する場合は本 resolver を共用。#141 は本修正後に diff budget の誤発火が消える。

## #163 hitch fix-loop の rerun を前 run branch 継続にする（base から rebuild しない）

- **root cause**: `src/hitch/orchestrator-runners.ts:418-428`(特に :424) coder runner が
  implement/rerun を区別せず `runDomainCoding({..., baseBranch: context.baseBranch})`。
  `prior`(rerun 判定) は goal への findings 注入のみに使われ、前 run の branch も lineage
  （`parentRunId`/`rootRunId`/`rerunAttempt`、opts は存在: `workflow-runner.ts:120-124`）も
  渡さない。`runDomainCoding` は常に新 runId→`runBranchName`→`resolveBaseSha(baseBranch)`→
  `createWorktree({base: baseSha})`(:728)。worktree 起点を base 以外にする手段が
  `RunDomainCodingOpts`(:105-148) に無い → rerun は毎回 base から full rebuild。
- **修正設計**:
  1. `RunDomainCodingOpts` に `startRef?: string`（+ `diffBaseSha?: string`）追加
     （`workflow-runner.ts`）。worktree を `createWorktree({base: startRef ?? baseSha})` に
     （`git-worktree.ts` は任意 commit-ish 可で無変更）。**branch 名は run 毎に新規**
     （前 branch checkout しない → `already used by worktree` 回避・run↔branch 1:1 維持）。
     新 branch は前 run branch の HEAD から生え「既存実装を amend」になる。
     継続時の diff/policy 検証 base は親 run の `runs.base_sha`（DB 保存済、`run-log-db.ts:108`）
     を `diffBaseSha` として渡し chain 全体の累積 diff を検証（前 run で許可済みパスの再検証
     = fail-closed 方向に安全）。`worktree_created` イベントに `base`(=startRef) 記録。
  2. coder runner（`orchestrator-runners.ts:361-470` 付近）: `prior` のとき `codingAttempts`
     から最新 runId（`latestRunId` :313-325 同ロジック）→ 前 branch は `runs.run_branch`
     （`runs.ts:322`）から取得 → `git rev-parse --verify <branch>` 存在確認 → 無ければ
     `origin/<branch>`、それも無ければ baseBranch に fallback + 警告イベント（fail-silent に
     しない）。`parentRunId/rootRunId/rerunAttempt` を渡す（線形 chain なら
     `workflow-runner.ts:455-470` の 1-child ゲート非抵触、テストで担保）。
  3. 前 run の worktree は触らない。`closeAndPr`(:645-) は `latestRunId` の branch を PR に
     するため累積 branch がそのまま PR になり「fix commits が PR branch に乗らない」解消。
     既存 PR への push（reopen ケース）は別 follow-up と明記。
- **変更ファイル**: `src/core/workflow-runner.ts`, `src/hitch/orchestrator-runners.ts`。
  `src/git/diff.ts` は #154 が触るため本 issue では原則不変。
- **テスト**: 実 git repo + fake coderRunner で coder 2 回駆動 →（a）run2 worktree HEAD の
  祖先に run1 branch HEAD（b）run2 累積 patch に run1 のファイル（c）attempts/runs に
  `parent_run_id`/`root_run_id`/`rerun_attempt`。1-child ゲート非抵触 / 前 branch 削除時の
  fallback+警告 / `startRef` 指定で diff base が親 base_sha / initial implement は挙動不変。
- **規模**: M（src 80-120 / test 150-250 行）。
- **依存**: **#154 を先に**（同じ resolveBaseSha 箇所・コンフリクト必至）。本設計の
  「継続時 diff base=親 base_sha」は #154 後に base が進んでも累積 diff に偽の巻き戻しが
  出ないための整合策。#164 の divergence 偽陽性主因（rerun 毎の drift）を潰すので
  #163→#164 の順で効果測定が明確。

## #141 coder run への per-run change budget（diff サイズ/削除量ガード）

- **root cause / 挿入点**: `src/core/workflow-runner.ts:295-342` `diffAndValidate` は
  `validateChangedPaths` に path 集合を渡すのみで行数・削除量を見ない。`src/git/diff.ts:51-70`
  `collectDiff` は `--name-only` と unified patch のみ（`--numstat`/`--shortstat` は repo に
  存在しない＝stat 計測自体が無い）。`workflow-runner.ts:1049-1064` の status 優先順位に
  budget 超過分岐が無く `needs_review` に落ちて review へ進む（review 後は
  `reviewed-run-workflow.ts:176-184` が `needs_review` 以外を即終了 → ここで `failed-*` に
  すれば review 前に止まる）。
- **修正設計**:
  - **stat 収集**: `collectDiff` に `git diff --no-ext-diff --no-textconv --numstat -z <baseSha>`
    を追加、`DiffResult` に `stat:{filesChanged,insertions,deletions,deletedFiles}`。binary
    （numstat の `-`）は行数 0・ファイル数のみ。numstat 失敗は既存 catch で `failed-diff-collection`
    （fail-closed）。
  - **policy schema**（`src/policy/schema.ts`）: `ChangeBudgetSchema`
    ={max_deleted_lines, max_total_changed_lines, max_deleted_files, max_changed_files（各 int
    positive optional）, enforce: boolean default true}。`LimitsSchema`(:21-26 global) と
    `DomainPolicySchema`(:89-102) に `change_budget` 追加（domain が global を上書き＝正当な
    大規模リファクタ domain の逃がし）。デフォルト定数（:159-161）: `DEFAULT_MAX_DELETED_LINES=800`,
    `DEFAULT_MAX_TOTAL_CHANGED_LINES=5000`, `DEFAULT_MAX_DELETED_FILES=20`（未設定でも有効＝
    fail-closed デフォルト）。`ResolvedPolicy.limits.changeBudget` を `src/policy/resolver.ts:89-91`
    で global→domain マージ。
  - **gate 本体**: 新 `src/policy/diff-budget-validator.ts` の純関数 `validateDiffBudget(budget,stat)`
    → `{status:"within"|"exceeded", breaches:[{metric,actual,limit}]}`。
  - **挿入位置**: `diffAndValidate`（:319 直後）で評価。判定は post-command の再収集 dv
    （:890-913）を採用。status 決定（:1056 `failed-policy-violation` の直後・`failed-command`
    の前）に `else if (budgetExceeded) status="failed-budget-exceeded"`。`run-log.ts:6-21`
    `RUN_STATUSES` に `"failed-budget-exceeded"` 追加（DB に status CHECK 制約無し・確認済）。
    超過時も artifact は通常どおり書き出し、summary / review-request / events に diff stat
    （+/- 行・削除ファイル数・超過 metric）を含める。
  - **逃がし**: domain 単位の上限上書き / `change_budget.enforce:false` の明示 opt-out
    （event に `change_budget_disabled` 記録）/ `RunDomainCodingOpts` に run 単位
    `changeBudgetOverride`（CLI `--change-budget-max-deleted-lines` 等、enforce:true 時のみ
    緩和可・無効化は不可）。
- **変更ファイル**: `src/policy/schema.ts`, `src/policy/resolver.ts`,
  `src/policy/diff-budget-validator.ts`（新規）、`src/git/diff.ts`, `src/core/workflow-runner.ts`,
  `src/logging/run-log.ts`, `docs/specs/policy.md`。
- **テスト**: diff-budget-validator.test（各 metric 境界＝上限は通る/+1 で exceeded・未設定は
  デフォルト・binary 扱い）、resolver（global/domain マージ・enforce:false）、git-diff.test
  （collectDiff が insertions/deletions/deletedFiles を返す、削除ファイル fixture）、
  **workflow-fake-codex.test（fake codex に上限超削除 → `failed-budget-exceeded` で commands/
  review に進まない / 上限内は `needs_review` で通る / post-command の超過も止まる）**。
- **規模**: M（src 250-350 / test 250-350 / spec 40 行）。
- **依存**: **#154 を先に**（stale base 由来の見かけ削除で誤発火を避ける）。#163 の
  全面書き直し rerun は diff が膨らみ本 gate に当たりやすい（検出材料にもなる）。
