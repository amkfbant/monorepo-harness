# 実装設計ノート v2 — issue #230「[案A] escalation 決定パケット格上げ / needs_classification jury / severity クロスチェック / [案F] RACI」

> これは**計画のみ**。コードは変更しない。実装は別セッションが dev クローンの
> `origin/main` ベース隔離ブランチで行う。
> **base ref（裏取り元）**: ops checkout `v0.7.10`(HEAD=8c9e6b8, `chore(main): release 0.7.10 (#241)`)。
> 本ノートの file:line はこの checkout で全件再確認済み（v1 の `v0.7.9`/HEAD=a4bcca4 表記は誤り。`src/**` は v0.7.9→v0.7.10 で差分なしのため file:line は有効だが、**docs/design 配下は ref 依存で差分あり**: §2.7/P3-1 参照）。
> **実装 base = `origin/main`**（= 現 `v0.7.10` 相当）。docs/design grounding はこの base で評価する。
> **最終的な home**: 実装 PR 時に dev クローンの `docs/design/proposals/design-230-*.md` 配下へ。

---

## v2 改訂履歴（codex P0/P1 反映）

- **P0**: なし（codex 判定通り）。
- **P1-1（jury split 決定パケットが永続化されない経路）** → §3.1/§3.3/§4(WI-7〜WI-10)/§5.6 を改訂。classify runner の戻り値を構造化（`ClassifyRunnerResult` に `decision`/`recommendedNextAction{decisionPacket}` を追加）し、**orchestrator が classify 失敗時に `recordConvergenceDecisionWithStatus` で `decision:"escalate"` + packet を記録してから return** する設計に変更。orchestrator.ts:87-92 を「記録→return」に直すことを WI-9b として明記。
- **P1-2（async jury を同期 DB callback 内に入れられない）** → §3.1/§4(WI-5/WI-9) を改訂。**DB 内は finding/session の snapshot 取得のみ → DB を閉じる → jury 実行（runner）→ DB 再 open → 『同 finding がまだ unknown/open か』を再検証してから分類**、の 3 フェーズに分解。既存 reviewer path（orchestrator-runners.ts:1112 が DB を閉じてから runner）と同方式。`withManagedDb` 同期 callback 内で `await` しない。
- **P1-3（reviewerRunner 直呼び contract 不足）** → §3.1/§3.5(新設)/§4(WI-5) を改訂。`JuryProposerDeps` に `worktreePath` / `harnessRoot` / `logPaths` 生成規則 / `timeoutMs` / `parseSchema` / `rawLog`・`auditDir` 保存先を定義（`CodexExecRunner.run` の必須入力 worktreePath/prompt/logPaths を満たす。出力は events/stdout ログから parse）。
- **P1-4（severity クロスチェックが #230 受け入れから外れる）** → §3.2/§4(Phase1 に WI-10s/WI-11s 追加)/§8 を改訂。**issue 分割はしない**（確定方針）。**Phase1 に最小の advisory-only severity audit（固定マッピングを上書きしない）+ severity 集約の決定論テストを含める**。Phase1 だけで #230 受け入れ条件を満たす。
- **P2-1（operator-origin filter の意味曖昧）** → §3.1/§5.4/§6 を改訂。確定方針: **operator-origin(human/mcp) の unknown は heuristic も jury も通さず即 manual escalate**。source filter を **heuristic の前**に置く。テストを filter 位置に合わせる。
- **P2-2（"confirmation-required gate" 表現が現状仕様と違う）** → §3.4/§5.6/§7/§9 を改訂。`harness.hitch.classify_finding` は `kind:"mutation"`（dangerous/confirmation-required list 外: mcp.md:613-626）。表現を **「guarded mutation / 権限・audit gate」**に修正。confirmation-required にするのは別途 MCP spec/registry 変更が要るので follow-up。
- **P2-3（fixture-matrix に jury runner 注入できない）** → §4(WI-11)/§6 fixtures を改訂。jury flow は **`orchestrator-runners.test.ts` + `hitch-orchestrate.test.ts` 中心**に置く。`fixture-matrix.test.ts` は convergence-only 回帰に限定（`SimulatedGoalLoop` は `ConvergenceService.evaluate()`+手動 `repo.classifyFinding()` のみで runner 注入口が無い: fixture-matrix.test.ts:28-56）。
- **P3-1（docs/design 存在判定が ref 依存）** → §2.7 を改訂。`origin/main`/`v0.7.10` には `docs/design/deliberation.md` と `docs/design/consulting-frameworks.md` が**存在する**。current main 実装の grounding はこれらも含める。
- **codex PR#246 対応**: unanimous 定義を frozen contract に整合（lens 集合の distinct 要求・proposedScope='unknown'+proposalStatus で未確定を表現・severity diverged/inconclusive は unanimous でも escalate surface・v31 テーブルは Phase1 follow-up 非） → §3.1/§3.2/§4/§5.2/§6.2/§8 改訂。

---

## 1. 背景と #230 ゴール

判断系エスカレーションの質を上げ、人間に飛ぶ頻度を下げつつ、**誤った自動判定は
fail-closed で人間に残す**。epic #228 の案A。案F(RACI 決定権限モデル, Accountable=人間1人)を折り込む。

着手順は **A(#230)→B→C に確定**（#230 が先頭・C を unblock）。issue 分割はしない。

過去に観測した「良性 finding での誤 escalate」「0→1 誤発火」は、決定論ヒューリスティック
分類器が `unknown` を返した finding が即 escalate される(再分類の余地が無い)精度問題。
本案は heuristic 分類器の**後段に多体提案層(jury)を足し**、3体異レンズが独立に scope を
提案 → **決定論集約(全3票一致のみ自動確定、1票でも割れたら人間 escalate)**で、
分類可能な良性 finding を救いつつ、不確実なものは fail-closed で人間に残す。

スコープ4点（全て **Phase1 の 1 PR** に入れる。#230 完了条件を Phase1 だけで満たす — P1-4 反映）:
1. **needs_classification jury**: heuristic がなお unknown を返す **harness-origin** finding を
   3体(correctness / scope-fit / spec準拠)が独立提案 → 決定論集約(unanimous のみ確定)。
2. **severity クロスチェック（advisory-only）**: harness 固定マッピング(P1/P2)の妥当性を多体で audit。
   **固定マッピングは上書きしない**。乖離は **escalate packet に `severityAudit` を記録**するのみ。
   **最終集約・audit 判定は決定論**（同入力→同出力テストを Phase1 に含む）。
3. **決定パケット格上げ**: escalate 出力を統合フォーマット化し、**convergence decision に永続化**。
4. **案F 折込**: 状態遷移ごとの RACI を `docs/specs/` に明文化。

---

## 2. 検証済みの現状 (file:line, v0.7.10 checkout で全件再確認)

### 2.1 分類は決定論ヒューリスティックのみ (LLM なし)
- `src/hitch/classification.ts:89-177` `classifyFindingForHitch(session, finding)` は
  正規表現/パス照合/カテゴリ許可リスト/target mention で `in_scope | out_of_scope | unknown`(:173)を返す。**LLM 不使用**。返り型 `HitchFindingClassification = { scopeStatus, reason }`(:78-81)。
- scope に一致しない全分岐が `unknown` に収束(:173-176)。fail-closed。

### 2.2 classify runner = heuristic 再実行 → 即 escalate（**全部が同期 DB callback 内**）
- `src/hitch/orchestrator-runners.ts:1170-1222` classify runner は **`withManagedDb` の同期 callback 内で完結**（:1171 `withManagedDb({ dbPath }, (db) => { ... })`、await なし）。`scopeStatus:"unknown"` かつ `OPEN_FINDING_LIFECYCLES` の finding を batch(`FINDING_BATCH_LIMIT=200`)で読み(:1181-1184)、`classifyFindingForHitch(session, finding)` を再実行(:1188)。なお unknown のとき `{ resolved:false, escalateReason: "cannot classify finding <id>" }`(:1189-1193)。多体投票・LLM なし。
- **重要(P1-2 根拠)**: 現 callback は同期。`await generateJuryProposals()` をこの中には入れられない（`withManagedDbAsync` に変えても外部 runner 実行中に DB lock/handle を保持してしまう）。既存 reviewer path は **DB 読みを閉じてから runner を呼ぶ**（:1098-1108 で runId 取得 → DB 閉 → :1112 `runReviewerAgent` → 結果を別 `withManagedDb` で fold: :1129）。jury も同方式にする。
- **重要(P2-1 根拠)**: finding row は `source: HitchFindingSource`(repository.ts) を持つが、**現状この runner は source でフィルタしていない**（unknown 全件を loop して heuristic にかける）。CLI も default `human` で heuristic を通す(cli/hitch.ts:647,680)。MCP も `mcp` source を heuristic に通す(mcp/tools/hitch-tools.ts:366,369)。
- `OrchestratorRunnerDeps`(orchestrator-runners.ts:161-167)は `dbPath` / `harnessRoot` / `createdBy` / `reviewerRunner: CodexExecRunner` を既に持つ → jury wire 先・path 導出元(`harnessPaths(deps.harnessRoot)` で runsDir/locksDir/workspacesDir: :909)が在る。

### 2.3 classify runner の戻り型と orchestrator の escalate（**packet が落ちる経路** — P1-1 根拠）
- `OrchestratorRunners.classify` の戻り型は **`{ resolved: boolean; escalateReason?: string }`**(orchestrator-types.ts:30-31)。
- `src/hitch/orchestrator.ts:87-92`: `classify` action → `await runners.classify()`。`!r.resolved` のとき **その場で `{ outcome:"escalated", ..., escalateReason }` を return**(:91)。
- **このとき `recordConvergenceDecisionWithStatus` を呼ばない**。convergence 記録は**ループ先頭の `evaluateConvergenceAndRecordStatus`**(orchestrator.ts:44-50)でしか走らず、その時点では classify 失敗前なので `needs_classification` decision しか残らない。→ **jury split の `decisionPacket` が DB に永続化されない**。
- 永続化先: `recordConvergenceDecisionWithStatus`(convergence-status.ts:55-91)→ `repository.recordConvergenceDecision`(repository.ts:1782-1811)が `recommendedNextAction` を `hitch_convergence_decisions.recommended_next_action` カラムに **JSON serialize**(:1803-1805)。**additive optional フィールドを `HitchNextAction` に足してもスキーマ migration 不要**。

### 2.4 unknown → needs_classification → classify action
- `src/hitch/convergence.ts:428-447` `decide()`: `metrics.openUnknownScope > 0` かつ
  (`stopOnUnknownScope` または `closeRequires.noUnknownScope`)のとき `needs_classification` / `kind:"classify_findings"`(:435-444)。
- `src/hitch/orchestrator-dispatch.ts:27-28` `needs_classification` → `{ kind:"classify" }`(fail-closed switch, :4-40 で unknown action は全部 escalate)。

### 2.5 severity は harness 固定マッピング (reviewer 申告を使わない)
- `src/hitch/review-integration.ts:276-344` `proposalFindingSeeds()`:
  required_change → **P1固定**(:291) / negative_decision → **P1固定**(:310, `forcedScopeStatus:"in_scope"`:318) /
  non_blocking_comment → **P2固定**(:330) / out_of_scope_suggestion → **P2固定**(:339, `forcedScopeStatus:"out_of_scope"`:341)。
- reviewer 出力スキーマに severity フィールドは無い(申告 severity 不使用)。

### 2.6 convergence は P0/P1/P2 カウントで gate（**severity 降格は close gate を動かす**）
- `convergence.ts`: `openInScopeP0>0`→escalate(:326)/`openInScopeP1>0 && closeRequires.noOpenInScopeP1`→needs_fix(:449-452)/`openInScopeP2 > maxOpenInScopeP2`→needs_fix(:474-477)。
- `closeRequirementsSatisfied()`(:697-712): `noOpenInScopeP0`/`noOpenInScopeP1`/`noUnknownScope`/`maxOpenInScopeP2` を見る(:702-708)。→ **severity 自動降格(P1→P2)は close gate を動かす**(:703,707)→ Phase1 でも severity 自動変更は禁止(§3.2)。**audit-only**（乖離は escalate packet 記録のみ）。
- divergence は **harness-origin finding のみ**で算出(`divergenceReason()`:659-695、`harnessOriginNewFindings` 等:664-690)。operator-origin(human/mcp)は除外(types.ts:69-98、#196)。P0 escalate(:326)/budget(:316,403)/diverging(:347-349)は needs_classification より**前**に評価。

### 2.7 migration head / docs/design の事実（**base ref 依存** — P3-1 反映）
- **migration head は V30**(src/db/migrations.ts:197 `MIGRATION_V30_STATEMENTS`)。**次は V31**。Phase1/2 は新テーブル不要(§3.3: additive JSON のみ)。ただし **V31 テーブル(jury_classification_proposals / jury_severity_audits)は将来導入するなら Phase1 follow-up ではなく v31 基盤として設計・確保する** — codex PR#246 指摘・frozen contract 反映。
- **docs/design の存在は ref 依存**: `v0.7.9`(a4bcca4) では `docs/design/proposals/` に `design-229-*` `design-231-*` のみ。**現 base `origin/main`/`v0.7.10` には `docs/design/deliberation.md` と `docs/design/consulting-frameworks.md` が存在する**（P3-1）。
  → 実装は `origin/main` ベースなので、**統合フォーマット(`HitchDecisionPacket`)の grounding は #230 issue 本文 + 兄弟 #229 設計の安全パターン（「LLM verdict は proposal-row 入力、決定論 gate が裁定」）+ 既存 `docs/design/deliberation.md`・`consulting-frameworks.md`** に置く（評価軸マトリクスの語彙を既存 doc に揃える）。
- 兄弟 #229 設計: harness は単一 `reviewerRunner` DI、per-lens model フィールド無し。Phase1 lens は「同一 backend に対する別プロンプト」。spec で正直に書く(異モデルを oversell しない)。
- テスト配置は `tests/unit/hitch/` / `tests/integration/`(`src/hitch/__tests__/` は存在しない)。拡張点は `tests/unit/hitch/orchestrator-runners.test.ts`(jury flow 主)、`tests/integration/hitch-orchestrate.test.ts`(e2e)、`tests/unit/hitch/convergence.test.ts`(回帰)、新規 `tests/unit/hitch/jury-*.test.ts` / `decision-packet.test.ts` / `severity-audit.test.ts`。`fixture-matrix.test.ts` は **convergence-only 回帰**に限定（P2-3）。

---

## 3. 中核設計判断

### 3.1 jury 後段配線（classify runner 内、**3フェーズ DB分離** — P1-2 反映 / source filter は heuristic 前 — P2-1 反映）

**配線位置**: `orchestrator-runners.ts:1170-1222`。現在 1 個の同期 `withManagedDb` で完結している classify runner を、**async runner 化**して 3 フェーズに分解する（既存 reviewer path と同じ「DB 閉じてから runner」方式）:

```
classify: async (hitchId): Promise<ClassifyRunnerResult> => {
  // --- Phase 1: DB open（同期 snapshot のみ。await しない） ---
  const snapshot = withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new HitchRepository(db);
    const session = repo.requireSession(hitchId);
    const unknowns = repo.listFindings({ hitchId, scopeStatus:"unknown",
      lifecycleStatusIn: OPEN_FINDING_LIFECYCLES, limit: FINDING_BATCH_LIMIT });
    // operator-origin(human/mcp) は heuristic も jury も通さない（P2-1）。
    //   → ここで分け、operator-origin unknown が 1 件でもあれば即 manual escalate。
    const operatorUnknown = unknowns.filter(f => !HARNESS_ORIGIN_FINDING_SOURCE_SET.has(f.source));
    const harnessUnknown  = unknowns.filter(f =>  HARNESS_ORIGIN_FINDING_SOURCE_SET.has(f.source));
    // heuristic は harness-origin にだけ適用（既存挙動と同じ純関数）。確定したものは即書込。
    for (const f of harnessUnknown) {
      const c = classifyFindingForHitch(session, f);
      if (c.scopeStatus !== "unknown") repo.classifyFinding({ findingId:f.findingId, ...c });
    }
    // 残り(heuristic でも unknown の harness-origin) と operator-origin を snapshot で返す
    const sessionSnapshot = toJurySessionSnapshot(session);            // scope policy / target* を凍結
    const stillUnknownHarness = harnessUnknown.filter(f => repo.requireFinding(f.findingId).scopeStatus === "unknown");
    return { sessionSnapshot, stillUnknownHarness: toSnapshots(stillUnknownHarness),
             operatorUnknown: toSnapshots(operatorUnknown) };
  }); // ← DB ここで閉じる

  // operator-origin unknown は jury に掛けず即 manual escalate（fail-closed, P2-1 / §5.4）
  if (snapshot.operatorUnknown.length > 0) {
    const packet = buildOperatorOriginPacket(snapshot.operatorUnknown);
    return { resolved:false, decision:"escalate",
             escalateReason: packet.summary,
             recommendedNextAction: { kind:"ask_human",
               findingIds: snapshot.operatorUnknown.map(f=>f.findingId),
               message: packet.summary, decisionPacket: packet } };
  }
  if (snapshot.stillUnknownHarness.length === 0) return { resolved:true };

  // --- Phase 2: DB 閉じた状態で jury 実行（runner、await OK） ---
  const proposerDeps = makeJuryProposerDeps(deps, hitchId);            // §3.5 contract
  const juryResults = [];
  for (const f of snapshot.stillUnknownHarness) {
    const proposals = await generateJuryProposals(f, snapshot.sessionSnapshot, proposerDeps); // 3体・入力専用
    const aggregate = aggregateJuryVotes(proposals);                  // 純関数・決定論
    juryResults.push({ finding:f, proposals, aggregate });
  }

  // --- Phase 3: DB 再 open → 「同 finding がまだ unknown/open か」再検証 → 分類 / packet 生成 ---
  return withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new HitchRepository(db);
    const session = repo.requireSession(hitchId);
    const splits = [];
    for (const r of juryResults) {
      const live = repo.findFinding(r.finding.findingId);
      // 再検証(P1-2): jury 実行中に他経路で分類/close された finding は skip（stale 確定を防ぐ）
      if (live === null || live.scopeStatus !== "unknown" || !OPEN_FINDING_LIFECYCLES.has(live.lifecycleStatus)) continue;
      if (r.aggregate.decision === "unanimous") {
        repo.classifyFinding({ findingId:r.finding.findingId, scopeStatus:r.aggregate.scope,
          reason: `jury unanimous: ${r.aggregate.scope}` });
      } else {
        splits.push(r);                                               // 票割れ → escalate へ
      }
    }
    if (splits.length === 0) {
      // 全部 unanimous で確定。残 unknown を再 count して resolved 判定（既存 progress ロジック流用）
      const remaining = repo.countFindings({ hitchId, scopeStatus:"unknown", lifecycleStatusIn: OPEN_FINDING_LIFECYCLES });
      return remaining === 0 ? { resolved:true }
        : { resolved:false, decision:"escalate",
            escalateReason:`classification did not drain hitch ${hitchId}`,
            recommendedNextAction: buildNoProgressAskHuman(hitchId, remaining) };
    }
    const packet = buildJurySplitPacket(splits);                      // §3.3 統合フォーマット
    return { resolved:false, decision:"escalate", escalateReason: packet.summary,
      recommendedNextAction: { kind:"ask_human",
        findingIds: splits.map(s=>s.finding.findingId), message: packet.summary, decisionPacket: packet } };
  });
}
```

**戻り型の構造化（P1-1 の前提）**: `OrchestratorRunners.classify` の戻り型を
`{ resolved: boolean; escalateReason?: string }` から
**`ClassifyRunnerResult = { resolved: true } | { resolved: false; decision: "escalate"; escalateReason: string; recommendedNextAction: HitchNextAction }`**
に広げる（`recommendedNextAction` が packet を運ぶ）。

**重要な分離**:
- `generateJuryProposals` = LLM-driven proposer。`proposerDeps.reviewerRunner` を使い 3 体別プロンプトで **入力データのみ**生成。DB を書かない・**DB が閉じた状態でのみ走る**（P1-2）。
- `aggregateJuryVotes` = **純関数・決定論**(同入力→同出力)。**frozen contract**: unanimous = proposals.length===3 かつ lens 集合が {correctness,scope_fit,spec_adherence} と完全一致 かつ 全票同一 scope(in/out) かつ 判定不能ゼロ。同一 lens 重複・欠落・4票以上は split(codex PR#246 指摘・frozen contract 整合)。**2-1 / 1-1-1 / いずれかが判定不能（proposedScope='unknown' + proposalStatus∈{complete,timeout,parse_error,inconclusive}）** は全て `split`。
- 状態遷移(`repo.classifyFinding`)は **Phase3 で再検証後・unanimous のときだけ**。
- **confidence float gate は不採用**（LLM 自己申告 confidence を state-transition gate にしない）。confidence/reasoning は packet に advisory 記録するが gate を駆動しない。

**lens 定義(同一 backend・別プロンプト)**:
- **correctness**: finding text の意味的妥当性(future/aspirational 表現か、実 actionable か)。
- **scope-fit**: hitch scope(targetFiles/targetOperations/allowed/excludedCategories/targetSummary)との照合を独立な視点で再述。
- **spec準拠**: finding が domain spec / policy 契約に合致するか。context 欠如時は proposedScope='unknown' + proposalStatus="inconclusive" で表現(fail-closed)。

### 3.2 severity クロスチェック（**Phase1 に含む・advisory-only** — P1-4 反映）

**Phase1 に最小実装を含める**（#230 受け入れ条件を Phase1 だけで満たすため。issue 分割しない）。スコープは厳しく絞る:
- **harness 固定マッピング(review-integration.ts:291/310/330/339)は authoritative・絶対に上書きしない**。convergence を駆動する唯一の severity はこれ。
- jury severity proposer(advisory)が固定 severity と乖離したら、**scope jury が unanimous でも escalate packet に `severityAudit` を記録**して人間に提示するのみ(frozen contract 反映)。**自動で severity を変えない**（P1→P2 降格は close gate(convergence.ts:703,707)を動かすため）。
- **`auditSeverity()` は純関数・決定論**: 入力 `{ harnessSeverity, jurySeverityProposals }` → 出力 `{ harnessSeverity, juryConsensus, status:"aligned"|"diverged"|"inconclusive", escalate:boolean }`。同入力→同出力テストを **Phase1 に含む**(§6.2 / 受け入れ条件②)。
- severity audit の起動は **jury が走る finding（harness-origin unknown）に限定**し、scope jury proposal と同一 runner 呼び出しで severity 提案も同時に得る（呼び出し回数を増やさない: 1 finding = 3 lens 1 ラウンド）。あるいは scope proposal の parse schema に severity フィールドを足し、別呼び出しを増やさない。
- precedence を **docs に 1 箇所**で書く（double-definition drift 防止）: **harness mapping = authoritative（convergence 駆動の唯一）/ jury severity = advisory-only（packet 記録のみ）**。
- `classifyFindingForHitch` の返り型は広げない（scope heuristic の境界を汚さない）。severity は review-integration 由来のまま、audit は別モジュール `severity-audit.ts`。

> 受け入れ条件②「severity 集約が決定論的」は **`auditSeverity()` の純関数テスト**で Phase1 に満たす。固定マッピングの authoritative 性・close gate 不変は §6.5 回帰で守る。

### 3.3 決定パケット永続化（**additive optional JSON・新テーブル無し** + **永続化を orchestrator が必ず行う** — P1-1 反映）

**永続化先 = 既存 `hitch_convergence_decisions.recommended_next_action`(JSON カラム)**。新 migration 不要。
- `HitchNextAction`(types.ts)に **optional `decisionPacket?: HitchDecisionPacket`** を足す(additive)。
- **永続化を確実にする(P1-1)**: classify runner は packet を `recommendedNextAction.decisionPacket` に積んで返すだけでなく、**orchestrator が classify 失敗時に必ず `recordConvergenceDecisionWithStatus` を呼んで記録してから return** する（§4 WI-9b、orchestrator.ts:87-92 改修）。具体的には:

```
if (action.kind === "classify") {
  const r = await input.runners.classify(input.hitchId);
  steps.push({ step:i, decision:finalDecision, action:"classify", detail:String(r.resolved) });
  if (!r.resolved) {
    // P1-1: escalate を返す前に decision + packet を必ず永続化する
    withManagedDb({ dbPath: this.opts.dbPath }, (db) =>
      recordConvergenceDecisionWithStatus({
        repository: new HitchRepository(db),
        hitchId: input.hitchId,
        decision: "escalate",                          // status を escalated に同期
        reason: r.escalateReason,
        metrics: convergence.metrics,                  // ループ先頭で得た metrics を再利用
        recommendedNextAction: r.recommendedNextAction, // ← decisionPacket を含む
        createdBy: input.createdBy,
      }));
    return { hitchId: input.hitchId, outcome:"escalated", steps, finalDecision, escalateReason: r.escalateReason };
  }
  continue;
}
```

  - `recordConvergenceDecisionWithStatus`(convergence-status.ts:55) は `decision:"escalate"` のとき `statusForConvergenceDecision`(:139)経由で hitch status を `escalated` に同期する → 既存 escalate 経路と一貫。
  - **backward-compat 必須**: `kind` / `message` / `findingIds` は常に従来通り populate。`decisionPacket` のみ optional 追加。既存 reader(dashboard read API / MCP / CLI)は壊れない。
  - **message overflow 回避**: packet は `decisionPacket` 構造化フィールドに入れ、`message` は short summary のみ（JSON を message に文字列詰めしない）。

`HitchDecisionPacket` 型（統合フォーマット。grounding = #230 issue + #229 安全パターン + 既存 `docs/design/deliberation.md`・`consulting-frameworks.md`、P3-1）:
```ts
interface HitchDecisionPacket {
  packetVersion: 1;
  decisionKind: "classify_scope" | "severity_audit" | "operator_origin_unknown";
  findings: Array<{ findingId; summary; category; filePath?; severity; scopeStatus }>; // split は複数あり得る
  recommendation: { action: "classify_manually" | "review_split" | "review_severity"; rationale: string };
  evaluationAxes: Array<{
    axis: "correctness" | "scope_fit" | "spec_adherence";
    lensVotes: Array<{ lens; scope; reasoning; confidence? }>;  // confidence は advisory（gate を駆動しない）
    consensus: "aligned" | "split";
  }>;
  rejectedProposals: Array<{ scope; lensCount; reason }>;
  minorityView: { count; scopes; reasoning } | null;
  riskFlags: Array<{ flag; impact; mitigation }>;
  unvalidatedAssumptions: Array<{ assumption; source; verification }>;
  nextActions: Array<{ owner: "operator"; action; verificationMethod }>;
  severityAudit?: { harnessSeverity; juryConsensus; status: "aligned"|"diverged"|"inconclusive"; escalate: boolean }; // §3.2
}
```

### 3.4 RACI 表配置（案F、**override は "guarded mutation/audit gate"** — P2-2 反映）

`docs/specs/hitch-convergence.md` の `## Convergence Decisions` 配下に **`### RACI: Decision Transitions`** を新設（新ファイルを増やさず既存 spec に同居）。**Accountable = 1 行につき人間1ロールのみ**。非 jury 経路(P0/budget/divergence)も網羅。

| 状態遷移 | R(Responsible) | A(Accountable) | C(Consulted) | I(Informed) |
|---|---|---|---|---|
| heuristic: unknown 判定(harness-origin) | classification.ts(決定論) | harness convergence | session scope policy | operator |
| operator-origin unknown を heuristic/jury に通さない | classify runner(source filter, snapshot 段) | **operator(人間1名)** | — | audit trail |
| needs_classification gate 発火 | convergence.decide() | harness convergence | closeRequires.noUnknownScope | operator |
| jury 提案生成(harness-origin unknown, DB閉) | jury proposers(LLM 入力層) | harness classify runner | reviewer context | audit trail(raw log/audit dir) |
| jury 集約 全3票一致 → scope 確定(DB再open再検証後) | aggregateJuryVotes(純関数) | harness classify runner(txn) | session policy snapshot | audit trail |
| jury 票割れ → escalate(packet 永続化) | aggregateJuryVotes + orchestrator(record) | **operator(人間1名)** | harness convergence | dashboard, escalation log |
| severity 乖離(advisory)→ escalate packet 記録 | auditSeverity(決定論) | **operator(人間1名)** | harness mapping(authoritative) | escalate packet |
| operator が unanimous/auto 分類を override | operator(CLI/MCP **guarded mutation**: classify_finding) | **operator(人間1名)** | jury reasoning(packet) | audit trail(created_by/actorNote) |
| P0 open → escalate(非 jury) | convergence(:326) | harness convergence | — | operator |
| budget_exhausted → stop(非 jury) | convergence(:316/403) | harness convergence | — | operator |
| diverging → escalate(非 jury, harness-origin のみ) | divergenceReason(:659) | harness convergence | divergence policy | operator |

> override は `harness.hitch.classify_finding`（`kind:"mutation"`, **dangerous/confirmation-required list 外**: mcp.md:613-626）= **guarded mutation**。`guarded-mutation` client mode + 権限スナップショット + audit(created_by/actorNote)で守られる。shell bypass しない。confirmation-required に格上げするのは別途 registry/spec 変更（§9 follow-up）。

### 3.5 JuryProposerDeps contract（**P1-3 反映・新設**）

`generateJuryProposals(finding, sessionSnapshot, deps: JuryProposerDeps)` の `deps` を明示定義する。`CodexExecRunner.run` は `{ worktreePath, prompt, logPaths:{stdout,stderr,events} }` が必須(codex-exec-runner.ts:1-9)で、結果は `{ exitCode, timedOut, durationMs }` のみ(:11-15)なので **出力本体は events/stdout ログから parse** する必要がある。

```ts
interface JuryProposerDeps {
  reviewerRunner: CodexExecRunner;     // deps.reviewerRunner を流用（同一 backend 別プロンプト）
  harnessRoot: string;                 // deps.harnessRoot
  worktreePath: string;                // 実行 cwd。jury は read-only proposer なので
                                       //   run の worktree（resolveRunContext 経由の workspacesDir 配下）
                                       //   または read-only sandbox を使う。編集しない。
  logPaths: (findingId: string, lens: JuryLens) => { stdout; stderr; events };
                                       // harnessPaths(harnessRoot).runsDir 配下に
                                       //   jury/<hitchId>/<findingId>/<lens>.{stdout,stderr,events} 規則で生成
  timeoutMs: number;                   // lens あたり。超過 → timedOut → proposedScope='unknown' + proposalStatus="timeout"(fail-closed)
  parseSchema: JuryProposalSchema;     // events/stdout の JSON を { lens, scope, reasoning, confidence?, severity? }
                                       //   に厳格 parse。parse 失敗 → proposedScope='unknown' + proposalStatus="parse_error"(fail-closed)
  auditDir: string;                    // raw log + parsed proposal + aggregate を audit 保存（RACI: I=audit trail）
}
```

- **fail-closed 規則**: `exitCode!==0` / `timedOut` / parse 失敗 / context 欠如 → その lens は `proposedScope='unknown' + proposalStatus∈{complete,timeout,parse_error,inconclusive}` で表現(fail-closed、frozen contract 反映)。
- **raw log + parsed proposal を `auditDir` に保存**（決定の監査性。packet は要約、auditDir は原本）。
- worktreePath は **proposer が finding を書き換えないこと**を前提（read-only proposal）。run worktree を共有する場合も jury は mutation しない。

---

## 4. work item DAG (依存順, サブ Phase, 触るファイル)

> **サブ Phase = 関連テスト + typecheck 緑、大 Phase = フルスイート + typecheck 緑**。
> **TDD: 各 WI は RED(失敗テスト)を先に書く**。spec は同コミット更新。
> **Phase 1 = jury scope + 決定パケット + RACI + advisory severity audit を 1 PR で land**（#230 受け入れ条件を全部満たす — P1-4）。

### Phase 1 — needs_classification jury + 決定パケット + RACI + advisory severity audit

| ID | title | files | dependsOn |
|---|---|---|---|
| WI-1 | 型定義: JuryProposal(proposedScope='unknown'\|'in_scope'\|'out_of_scope', proposalStatus∈{complete,timeout,parse_error,inconclusive}) / JuryAggregate / **JuryProposerDeps(§3.5)** / HitchDecisionPacket、`HitchNextAction.decisionPacket?` additive、**`ClassifyRunnerResult`(構造化戻り型, §3.1)** | src/hitch/types.ts, src/hitch/orchestrator-types.ts | — |
| WI-2 | RED: `aggregateJuryVotes` 決定論集約のユニットテスト(unanimous=proposals.length===3∧distinct lens 3個∧全票同一scope∧判定不能ゼロ / 2-1/1-1-1/判定不能混在→split / 同入力→同出力、codex PR#246 整合) | tests/unit/hitch/jury-aggregation.test.ts | WI-1 |
| WI-3 | GREEN: `aggregateJuryVotes` 純関数実装(全3票一致のみ unanimous、lens 集合 distinct 確認・判定不能フィルタ・同入力→同出力、frozen contract 反映、float gate なし) | src/hitch/jury-aggregation.ts | WI-2 |
| WI-4 | RED: jury proposer のユニットテスト(3 lens 別プロンプト・DB 非書込・**fail-closed: timeout/parse 失敗/exit≠0 → proposedScope='unknown' + proposalStatus("timeout"\|"parse_error"\|"inconclusive")**(frozen contract 反映)・logPaths/auditDir 書込) | tests/unit/hitch/jury-proposer.test.ts | WI-1 |
| WI-5 | GREEN: `generateJuryProposals(finding, sessionSnapshot, JuryProposerDeps)` 実装(**§3.5 contract: worktreePath/logPaths/timeout/parseSchema/auditDir**、3体・入力専用、events/stdout から parse、proposedScope+proposalStatus で未確定を表現(frozen contract)、fail-closed) | src/hitch/jury-proposer.ts | WI-4 |
| WI-6 | RED: 決定パケット formatter のユニットテスト(round-trip / additive / message に JSON を詰めない / fallback message / 統合フィールド網羅、severity diverged/inconclusive でも surface) | tests/unit/hitch/decision-packet.test.ts | WI-1 |
| WI-7 | GREEN: `buildJurySplitPacket()` / `buildOperatorOriginPacket()` formatter 実装(scope jury unanimous でも severityAudit diverged/inconclusive なら packet に surface - frozen contract) | src/hitch/decision-packet.ts | WI-6 |
| WI-8 | RED: classify runner の jury 統合フローのユニットテスト(**3フェーズ DB分離**: snapshot→DB閉→jury→DB再open再検証 / unanimous→classify / split→`{resolved:false, decision:"escalate", recommendedNextAction.decisionPacket}` / **operator-origin→heuristic も jury も通らず即 escalate** / **再open 時に finding が分類済→skip** / **scope unanimous でも severityAudit diverged/inconclusive なら packet に surface** - codex PR#246・frozen contract) | tests/unit/hitch/orchestrator-runners.test.ts | WI-2,WI-4,WI-6 |
| WI-9 | GREEN: classify runner を **async 化 + 3フェーズ DB分離 + source filter(heuristic 前) + jury + 集約 + packet**(§3.1、frozen contract)。`ClassifyRunnerResult` を返す。既存 heuristic 確定パスは不変 | src/hitch/orchestrator-runners.ts, src/hitch/orchestrator-types.ts | WI-3,WI-5,WI-7,WI-8 |
| **WI-9b** | **RED+GREEN: orchestrator が classify 失敗時に `recordConvergenceDecisionWithStatus`(decision:"escalate" + decisionPacket) を呼んでから escalate return（P1-1）**。orchestrator.ts:87-92 改修 + 永続化検証テスト | src/hitch/orchestrator.ts, tests/unit/hitch/orchestrator.test.ts | WI-7,WI-9 |
| WI-10 | RED+GREEN: convergence の **直接 escalate 経路**(P0 等)にも decisionPacket を additive で付与可能にする(fallback message/findingIds 常時、既存挙動不変) | src/hitch/convergence.ts, tests/unit/hitch/convergence.test.ts | WI-7 |
| **WI-10s** | **RED: `auditSeverity()` 決定論テスト(harness mapping vs jury severity consensus、aligned/diverged/inconclusive、乖離→escalate flag、同入力→同出力、自動降格しない、scope unanimous でも diverged/inconclusive なら escalate flag - frozen contract・codex PR#246)**（P1-4・受け入れ条件②）** | tests/unit/hitch/severity-audit.test.ts | WI-1 |
| **WI-11s** | **GREEN: severity audit 実装(advisory-only、固定マッピング不変、scope unanimous でも severity diverged/inconclusive なら packet に severityAudit surface - frozen contract・codex PR#246、jury 呼び出し回数を増やさない=scope proposal に severity 同梱)（P1-4）** | src/hitch/severity-audit.ts, src/hitch/jury-proposer.ts, src/hitch/decision-packet.ts | WI-5,WI-7,WI-10s |
| WI-11 | RED: **jury flow 統合テスト(orchestrator-runners.test.ts 中心: unknown→jury unanimous→分類前進 / jury split→escalate+packet / scope unanimous でも severity diverged→packet surface / 良性 finding を unanimous で救済→誤escalate 削減)**。fixture-matrix には置かない(P2-3) | tests/unit/hitch/orchestrator-runners.test.ts | WI-9,WI-9b,WI-11s |
| WI-12 | RED: 回帰テスト(P0/budget/divergence は jury 不通過で従来通り / heuristic 確定は jury bypass / operator-origin は manual / 固定 severity 不変 / severity 自動降格なし、scope unanimous でも severity diverged なら packet記録→escalate なし) | tests/unit/hitch/convergence.test.ts, tests/unit/hitch/fixture-matrix.test.ts(convergence-only), tests/unit/hitch/review-integration.test.ts | WI-9,WI-9b,WI-11s |
| WI-13 | RED: integration(hitch-orchestrate.test.ts)で needs_classification→classify→(fake reviewerRunner で)jury→escalate/continue の e2e + **escalate 時 decisionPacket が DB に永続化される**(P1-1 e2e)、scope unanimous でも severity diverged なら packet に surface(frozen contract) | tests/integration/hitch-orchestrate.test.ts | WI-9,WI-9b,WI-11 |
| WI-14 | docs: hitch-convergence.md に jury flow(3フェーズ) + RACI 表(§3.4) + 決定パケット format + **severity precedence(mapping authoritative / jury advisory-only、scope unanimous でも diverged/inconclusive なら escalate)** | docs/specs/hitch-convergence.md | WI-9,WI-9b,WI-11s |
| WI-15 | docs: workflow.md に jury 起動条件(harness-origin unknown のみ)/ DB 分離方式 / escalate packet 構造 / RACI link、mcp.md・cli.md に **override は guarded mutation(classify_finding)** の 1 行 note(P2-2) | docs/specs/workflow.md, docs/specs/mcp.md, docs/specs/cli.md | WI-14 |

### Phase 2（別 PR・follow-up）— jury vote 正規化テーブル / severity の自動適用 / 異モデル lens 等

> Phase1 で #230 は閉じる。以下は #230 受け入れ条件**外**の発展（§9）。

| ID | title | files | dependsOn |
|---|---|---|---|
| WI-16 | (将来 epic) severity 自動降格を convergence gate に反映（close gate を動かすため要設計） | — | Phase1 |
| **WI-17** | **(将来) jury vote 正規化テーブル = v31 基盤(follow-up ではなく将来設計・確保)** — frozen contract・codex PR#246: DB v31 設計時に review_refute_votes/jury_classification_proposals/jury_severity_audits の schema、FK(無し=advisory)、business key(prompt_sha256 含む)を定義 | src/db/migrations.ts, src/db/schema.ts, src/hitch/repository.ts, docs/specs/db.md | Phase1 後の v31 詳細化 |

---

## 5. 安全境界マッピング（各 item が fail-closed / 決定論 / Accountable=人間 を侵さない理由）

不可侵境界(GOAL_RULES.md §G / CLAUDE.md 安全境界)と各 WI の整合:

1. **分類・severity の最終確定は決定論集約**:
   - jury proposers(WI-5)は **入力データのみ**生成、DB を書かない。**DB が閉じた状態でのみ走る**(§3.1 Phase2)。
   - `aggregateJuryVotes`(WI-3)・`auditSeverity`(WI-11s)は **純関数・決定論**(同入力→同出力テスト WI-2/WI-10s)。`repo.classifyFinding` は **Phase3 で再検証後・unanimous のときだけ**(WI-9)。
   - severity は **harness mapping が authoritative**、jury は **advisory-only**(WI-11s)。**scope unanimous でも severityAudit diverged/inconclusive なら escalate packet に必ず surface**(frozen contract 反映)。LLM 申告で scope/severity を直接確定しない。

2. **jury 不一致は必ず人間 escalate(自動確定しない・fail-closed)**:
   - `aggregateJuryVotes` は **2-1 / 1-1-1 / いずれか proposedScope='unknown'(判定不能) を全て split**(WI-2/WI-3)。多数決自動確定なし。
   - split → `{ resolved:false, decision:"escalate", recommendedNextAction.decisionPacket }`(WI-9)。**orchestrator が `recordConvergenceDecisionWithStatus` で永続化してから escalate return**(WI-9b, P1-1)。テスト WI-8/WI-11/WI-13 が assert。

3. **状態遷移は harness の決定論ゲートのみ**:
   - jury は classify runner 内に封じ込め(入力層)。convergence の needs_classification → escalate ゲート(:428-447)は**ロジック変更なし**。
   - escalate の status 遷移は `recordConvergenceDecisionWithStatus`→`statusForConvergenceDecision`(convergence-status.ts:139)が決定論的に行う(WI-9b)。提案層が finding の scope/severity/status を直接書き換えない。

4. **operator-origin finding を heuristic にも jury にも掛けない(P2-1, fail-open 防止)**:
   - human/mcp 由来の unknown finding は **snapshot 段(heuristic より前)** で `HARNESS_ORIGIN_FINDING_SOURCE_SET`(types.ts:82)を使って分離し、**直接 manual escalate**(WI-9, テスト WI-8/WI-12)。機械(heuristic/jury)が人間提起 finding の disposition を決めることを禁止(#196 継承)。
   - 注: harness-origin の unknown は従来通り heuristic を先に通し、**heuristic でも unknown のものだけ** jury にかける。

5. **既存 divergence / fail-closed 挙動に回帰なし**:
   - divergence(:659, harness-origin のみ)/ P0 escalate(:326)/ budget(:316/403)は needs_classification より**前**に評価され jury を通らない(WI-12)。heuristic 確定(in/out_of_scope)は jury bypass(WI-12)。
   - 固定 severity mapping(review-integration.ts)は不変・close gate(convergence.ts:702-708)は不変。severity 自動降格なし(WI-12)。

6. **決定パケットは additive・advisory・override は guarded mutation(P2-2)**:
   - `HitchNextAction.decisionPacket?` は optional 追加(WI-1)。message/findingIds/escalateReason は常時 populate(WI-7/WI-9b/WI-10)。既存 reader 非破壊。
   - packet は executable instruction でなく、operator が **`harness.hitch.classify_finding`(guarded mutation: `guarded-mutation` mode + 権限スナップショット + audit)** 経由で override する。shell bypass しない。**confirmation-required ではない**ので spec/RACI も「guarded mutation/audit gate」と書く。

7. **迷ったら fail-closed**:
   - lens の context 欠如 / timeout / parse 失敗 / exit≠0 → `proposedScope='unknown' + proposalStatus∈{timeout,parse_error,inconclusive}`(frozen contract)(WI-5)→ 集約 split → escalate。confidence は gate を駆動しない(advisory)。
   - jury 実行中に他経路で分類された finding は **Phase3 再検証で skip**(stale 確定を防ぐ, P1-2)。

---

## 6. TDD テスト計画

> jury runner を注入するテストは **`orchestrator-runners.test.ts`(unit)** と **`hitch-orchestrate.test.ts`(integration)** に置く。**`fixture-matrix.test.ts` は convergence-only 回帰に限定**（`SimulatedGoalLoop` は `ConvergenceService.evaluate()`+手動 `repo.classifyFinding()` のみで runner 注入口が無い: fixture-matrix.test.ts:28-56 — P2-3）。production は `deps.reviewerRunner`、テストは `createFakeCodexRunner()`（events/stdout ログに proposal JSON を書く: fake-codex-runner.ts:60-89）。

### 6.1 不一致 → 人間 escalate (fail-closed, 受け入れ条件①)
- `jury-split-2-1-escalates`(WI-8): proposals=(in_scope, in_scope, out_of_scope) → split → `{resolved:false, decision:"escalate", recommendedNextAction.decisionPacket}`、finding は unknown のまま。
- `jury-1-1-1-escalates`(WI-8): (in_scope, out_of_scope, unknown) → split → escalate。
- `jury-any-inconclusive-escalates`(WI-8): いずれかが proposedScope='unknown'(timeout/parse 失敗) → 票一致でも split → escalate。
- `operator-origin-unknown-skips-heuristic-and-jury`(WI-8, P2-1): source=mcp/human の unknown → **heuristic も jury も通らず**直接 escalate(packet decisionKind="operator_origin_unknown")。
- `jury-runs-with-db-closed`(WI-8, P1-2): proposer が呼ばれる時点で DB handle が解放されていることを assert（同期 callback 内 await が無い）。
- `stale-finding-skipped-on-reopen`(WI-8, P1-2): jury 実行中に他経路で分類された finding は Phase3 で skip され再分類しない。

### 6.2 決定論集約 / severity audit (受け入れ条件②: 同入力→同出力)
- `aggregate-deterministic`(WI-2): 同一 proposals を2回 → 同一 `JuryAggregate`。
- `aggregate-unanimous-requires-distinct-lenses`(WI-2, codex PR#246): proposals.length===3 かつ lens 集合 {correctness,scope_fit,spec_adherence} 完全一致 かつ 全票同一 scope → unanimous。同一 lens 重複 → split。
- `aggregate-no-inconclusive-in-unanimous`(WI-2, frozen contract): 全票 in_scope でも 1 票が proposalStatus="inconclusive" → split(判定不能ゼロ条件)。
- `aggregate-no-float-gate`(WI-2): confidence を変えても decision 不変。
- `severity-audit-deterministic`(WI-10s, P1-4): 同一 `{harnessSeverity, jurySeverity[]}` を2回 → 同一 audit 結果。
- `severity-audit-diverged-escalates`(WI-10s): jury consensus が harness mapping と乖離 → `status:"diverged", escalate:true`（**固定 severity は変えない**）。
- `severity-audit-inconclusive-escalates`(WI-10s): jury severity 不一致 → `status:"inconclusive", escalate:true`。
- `scope-unanimous-severity-diverged-surfaces-audit`(WI-10s, WI-13, codex PR#246・frozen contract): scope jury unanimous でも severityAudit diverged/inconclusive → decision=unanimous に影響なし、packet に severityAudit を surface(escalate しない scope 確定、severity 乖離は escalate packet に記録)。

### 6.3 escalate payload 統合フォーマット (受け入れ条件③)
- `packet-has-integrated-fields`(WI-6): split packet が `recommendation / evaluationAxes(3軸 lensVotes) / rejectedProposals / minorityView / riskFlags / unvalidatedAssumptions / nextActions(owner=operator) / severityAudit?` を満たす。
- `packet-additive-backward-compat`(WI-6): `kind/message/findingIds` 従来通り保持、`decisionPacket` optional、message に JSON を詰めない。
- `packet-roundtrip`(WI-6): JSON.stringify/parse で loss なし。
- `packet-persisted-on-escalate`(WI-9b/WI-13, P1-1): classify 失敗で escalate したとき `hitch_convergence_decisions.recommended_next_action` に `decisionPacket` が serialize されている（DB から読み戻して assert）。

### 6.4 良性 finding 救済 (headline benefit)
- `benign-unknown-rescued-by-unanimous-jury`(WI-11): heuristic が良性 finding を unknown 返し → fake reviewerRunner が 3体 unanimous → 自動分類され**escalate されない**（誤 escalate 削減を実証）。

### 6.5 回帰 (受け入れ条件④: divergence/fail-closed/severity 不変)
- `regression-p0-escalates-before-jury`(WI-12): openInScopeP0>0 → escalate(:326)、jury 不通過。
- `regression-budget-exhausted`(WI-12): budget 超過 → stop(:316/403)、jury 不通過。
- `regression-diverging`(WI-12): harness-origin finding 急増 → diverging(:659)、jury に masked されない。
- `regression-heuristic-confirmed-bypasses-jury`(WI-12): heuristic in_scope → jury 非起動、即確定。
- `regression-fixed-severity-unchanged`(WI-12): required_change=P1 / non_blocking=P2 のまま(review-integration.ts:291/330)、severity audit は escalate flag を立てるだけで mapping 不変、scope unanimous でも severity diverged は escalate packet に記録し escalate しない(frozen contract)。
- `regression-close-gate-unchanged`(WI-12): severity 自動降格なし → close gate(convergence.ts:702-708)不変。
- `regression-existing-suites-green`(WI-12): 既存 convergence.test.ts / fixture-matrix.test.ts 全件緑（テストを弱めない）。

### 6.6 end-to-end (integration, hitch-orchestrate.test.ts)
- `orchestrate-unknown-jury-unanimous-continue`(WI-13): needs_classification → classify(fake reviewerRunner で 3体 unanimous) → loop 継続。
- `orchestrate-unknown-jury-split-escalate-persists-packet`(WI-13, P1-1): jury split → outcome="escalated"、`recommended_next_action.decisionPacket` が DB に残る。
- `orchestrate-scope-unanimous-severity-diverged-surfaces-audit`(WI-13, frozen contract): jury scope unanimous でも severity diverged → scope decision=unanimous で分類確定、DB に保存された packet に severityAudit を含む。

---

## 7. docs/specs 更新一覧（同コミット）

- **docs/specs/hitch-convergence.md**(WI-14):
  - `## Convergence Decisions` 配下に「needs_classification jury」サブセクション（operator-origin filter は heuristic 前 → harness-origin に heuristic → なお unknown を **DB 閉じてから** 3 lens 提案 → 純関数集約 → Phase3 再検証 → unanimous:auto-confirm / split:escalate）。
  - **`### RACI: Decision Transitions` 表**(§3.4、Accountable=人間1名、override は guarded mutation、非 jury 経路も網羅)。
  - 決定パケット統合フォーマット(`HitchDecisionPacket`) + **永続化先(`recommended_next_action`、orchestrator が record)**。
  - **severity precedence(1 箇所、frozen contract 反映)**: harness mapping = authoritative、jury = advisory-only、**scope unanimous でも severityAudit diverged/inconclusive なら escalate packet に必ず surface**(自動確定しない、乖離は escalate packet 記録のみ)、自動降格なし。
- **docs/specs/workflow.md**(WI-15): jury 起動条件(harness-origin unknown のみ、operator-origin は manual)。**DB 分離方式(snapshot→閉→jury→再open再検証)**。escalate packet 構造。RACI link。
- **docs/specs/mcp.md / cli.md**(WI-15, P2-2): operator override は `harness.hitch.classify_finding`(**guarded mutation**、confirmation-required ではない)で行い、決定パケットを read してから classify する旨の 1 行 note。
- **docs/specs/db.md**(将来 WI-17 のみ、frozen contract・codex PR#246): v31 設計時に jury vote 正規化テーブル(review_refute_votes / jury_classification_proposals / jury_severity_audits)の schema・FK(advisory なので無し)・business key(prompt_sha256 含む)を定義。Phase1 では更新不要(additive JSON のみ)。

---

## 8. 受け入れ条件(#230)対応表（Phase1 単独で全充足 — P1-4 反映）

| #230 受け入れ条件 | 対応 WI | 検証テスト |
|---|---|---|
| jury 不一致時は必ず人間 escalate(自動確定しない) | WI-3,WI-9,WI-9b | `jury-split-2-1-escalates`, `jury-1-1-1-escalates`, `jury-any-inconclusive-escalates`, `orchestrate-unknown-jury-split-escalate-persists-packet` (§6.1/6.6) |
| severity 集約が決定論的(同入力→同出力、scope unanimous でも diverged/inconclusive なら surface) | **WI-10s,WI-11s(Phase1)** + WI-3 | `severity-audit-deterministic`, `severity-audit-diverged/inconclusive-escalates`, `scope-unanimous-severity-diverged-surfaces-audit`, `aggregate-deterministic`, `aggregate-no-float-gate` (§6.2) |
| escalate payload が統合フォーマットを満たす **かつ永続化される** | WI-1,WI-7,WI-9b,WI-10 | `packet-has-integrated-fields`, `packet-additive-backward-compat`, `packet-roundtrip`, **`packet-persisted-on-escalate`**(P1-1) (§6.3) |
| 既存 divergence / fail-closed / severity 挙動に回帰なし、scope unanimous でも severity diverged は escalate packet に記録のみ | WI-12 | `regression-p0/budget/diverging/heuristic-bypass/fixed-severity/close-gate`, `scope-unanimous-severity-diverged-surfaces-audit`, 既存スイート緑 (§6.5) |
| docs/specs/* を同コミット更新(RACI / severity precedence・frozen contract 反映 含む) | WI-14,WI-15 | doc レビュー(RACI 表 / jury flow / precedence / guarded mutation・frozen contract 記載) |

---

## 9. スコープ外 / follow-up

- **severity の自動降格適用**(P1→P2 を convergence gate に反映)= 将来 epic(WI-16)。close gate(convergence.ts:702-708)を動かすため `docs/future-features.md` に defer。Phase1 は audit-only。
- **異モデル lens**(per-lens に別 model/backend)= #229 と同様に大改修(単一 `reviewerRunner` DI を多 reviewer 化)。Phase1 は同一 backend 別プロンプト。
- **jury vote 正規化テーブル / drill-down query**(WI-17, v31 基盤・frozen contract・codex PR#246)= v31 設計・確保の follow-up。Phase1 では additive JSON のみで、v31 テーブル(review_refute_votes / jury_classification_proposals / jury_severity_audits)は follow-up ではなく v31 基盤として設計・導入するまで defer。
- **dashboard での決定パケット可視化**(drill-down UI)= follow-up(dashboard-viz course 系)。
- **jury latency / review budget への計上**(run_usage per-invocation telemetry への jury 呼び出し計上、budget で jury 回数を bound)= follow-up(token-usage course と連携)。Phase1 は jury single-shot・per-finding 独立・timeout→escalate のみ実装し、telemetry 統合は後続。
- **classify_finding を confirmation-required に格上げ**(MCP registry/spec 変更)= follow-up(P2-2)。Phase1 は guarded mutation のまま spec を正確化。
- **operator が決定パケットを read / override する CLI/MCP 表面の正式化**= follow-up(read path は既存 listDecisions 流用、専用 UX は後続)。

---

# 付録C: 反証検証した主要アーキ前提

### 前提1 — **confirmed**
- 主張: Architectural premise: `classifyFindingForHitch` is a pure deterministic heuristic (regex/path/category matching, no LLM) that returns `in_scope|out_of_scope|unknown`. This is the sole automatic classification mechanism in harness scope determination, with no LLM-based hidden paths for direct scope/severity confirmation. Post-classifier jury proposals are not yet implemented but are architecturally feasible in the orchestrator classify runner.
- 根拠: 1. **classification.ts:89 is deterministic heuristic only**

### 前提2 — **confirmed**
- 主張: Severity is assigned deterministically via harness mapping rules (required_changes → P1 fixed, non_blocking_comments → P2 fixed), reviewer-provided severity fields are NOT used, and convergence gates on P0/P1/P2 counts via closeRequires metrics — no LLM-based direct scope/severity confirmation exists in the codebase, and unknown findings must be escalated if the heuristic classifier cannot classify them.
- 根拠: 

### 前提3 — **confirmed**
- 主張: The architectural premise that unknown-scope findings converge to needs_classification which routes through the classify runner that re-invokes classifyFindingForHitch (heuristic-only, no LLM), and that upon escalation the payload is a minimal ask_human record with kind/message/findingIds (not an integrated decision matrix), is accurate. Additionally, severity mapping is deterministic (required_change→P1, non_blocking→P2), reviewer scope/severity proposals are not directly trusted, and all classification/severity final decisions are fail-closed: unknown scope and jury disagreement escalate to human rather than auto-confirming.
- 根拠: 1. **Heuristic-only classification (no LLM invocation)**: src/hitch/classification.ts:89 `classifyFindingForHitch` uses purely regex/path matching/allowed-categories heuristics. Returns `in_scope | out_of_scope | unknown` based on scope session rules (lines 99-177). No LLM calls anywhere in the func

### 前提4 — **confirmed**
- 主張: 現状の分類・escalate 経路に LLM(多体)レイヤは存在しない。多体提案層を足す場合、最終確定は決定論集約で、jury 不一致は必ず人間 escalate(自動確定しない)にできる(状態遷移は convergence のみが行う)。
- 根拠: ## 現状確認済み事実

### 前提5 — **partial**
- 主張: 設計前提：「状態遷移（finding scope/severity 確定、run.status、close、escalate）は harness の決定論ロジックのみが行い、LLM 出力やレビュー出力が直接書き換える経路は無い。案F の RACI（Accountable=人間）はこの既存境界の明文化であって新機能ではない。」
- 根拠: 

---

# 付録F: codex exec gpt-5.5 xhigh レビュー（v1 設計への指摘 = v2 の改訂根拠）

検証対象の `src/**` は `v0.7.9` tag と現 checkout 間で差分なしでした。ただし現 checkout は `HEAD=8c9e6b8`, `tag: v0.7.10` で、設計ノート記載の `HEAD=a4bcca4`, `v0.7.9` ではありません。

**P0**
なし。

**P1**
1. §3.3 / WI-7〜10: jury split の決定パケットが永続化されない経路になっている  
問題: 設計は `recommended_next_action.decisionPacket` に永続化するとしているが、jury split は `classify` runner の `resolved:false` と `escalateReason` で返るだけ。現行 orchestrator は分類失敗時にその場で `outcome:"escalated"` を返し、追加の convergence decision を記録しない。  
根拠: convergence 記録は action 前に行われる [orchestrator.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator.ts:44)、classify 失敗は [orchestrator.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator.ts:87) から [orchestrator.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator.ts:91) で即 return。永続化は `recordConvergenceDecisionWithStatus` 経由 [convergence-status.ts](/Users/kn/ops/monorepo-harness/src/hitch/convergence-status.ts:41)、JSON serialize は [repository.ts](/Users/kn/ops/monorepo-harness/src/hitch/repository.ts:1803)。  
推奨修正: `classify` runner の戻り値を構造化し、失敗時に orchestrator が `decision:"escalate"` / `recommendedNextAction:{kind:"ask_human", ... decisionPacket}` を `recordConvergenceDecisionWithStatus` で記録してから返す設計にする。

2. §3.1 / WI-5, WI-9: async LLM jury を同期 DB callback 内へ差し込む設計になっている  
問題: 現 `classify` runner は `withManagedDb` の同期 callback 内で完結する。設計疑似コードの `await generateJuryProposals(...)` はそのままでは成立しないし、`withManagedDbAsync` に変えるだけだと外部 runner 実行中に DB lock/handle を保持する。  
根拠: `withManagedDb` は同期 callback [managed-connection.ts](/Users/kn/ops/monorepo-harness/src/db/managed-connection.ts:99)、async 版は別 API [managed-connection.ts](/Users/kn/ops/monorepo-harness/src/db/managed-connection.ts:111)。現 runner は [orchestrator-runners.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator-runners.ts:1170) から同期 DB 内で [orchestrator-runners.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator-runners.ts:1188) を実行。既存 reviewer path は DB 読みを閉じてから runner を呼ぶ [orchestrator-runners.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator-runners.ts:1112)。  
推奨修正: DB 内では finding/session snapshot 取得だけにし、DB を閉じて jury 実行、再オープン後に「同じ finding がまだ unknown/open か」を再検証して分類する。これを WI に明記。

3. §3.1 / WI-5: `reviewerRunner` 直呼びの contract が不足している  
問題: `CodexExecRunner` は `worktreePath` と stdout/stderr/events の `logPaths` が必須。`generateJuryProposals(finding, session, reviewerRunner)` だけでは実行場所、ログ保存先、出力 parse、audit trail が定義できない。  
根拠: runner 入力型は [codex-exec-runner.ts](/Users/kn/ops/monorepo-harness/src/codex/codex-exec-runner.ts:1) と [codex-exec-runner.ts](/Users/kn/ops/monorepo-harness/src/codex/codex-exec-runner.ts:17)。fake runner も log paths へ書く [fake-codex-runner.ts](/Users/kn/ops/monorepo-harness/src/codex/fake-codex-runner.ts:71)。  
推奨修正: `JuryProposerDeps` に `worktreePath`, `harnessRoot`, `logPaths` 生成規則、timeout、parse schema、raw log/audit の保存先を入れる。

4. §3.2 / §8: severity cross-check が #230 受け入れ条件から外れている  
問題: #230 の要点に severity クロスチェックが含まれる一方、§3.2 は Phase1 では実装しないとしている。§8 も severity 決定論テストを Phase2 に逃がしており、Phase1 PR だけでは #230 完了条件を満たさない。  
根拠: severity 固定 mapping は [review-integration.ts](/Users/kn/ops/monorepo-harness/src/hitch/review-integration.ts:291), [review-integration.ts](/Users/kn/ops/monorepo-harness/src/hitch/review-integration.ts:310), [review-integration.ts](/Users/kn/ops/monorepo-harness/src/hitch/review-integration.ts:330), [review-integration.ts](/Users/kn/ops/monorepo-harness/src/hitch/review-integration.ts:339)。close gate は P1/P2 を見る [convergence.ts](/Users/kn/ops/monorepo-harness/src/hitch/convergence.ts:449), [convergence.ts](/Users/kn/ops/monorepo-harness/src/hitch/convergence.ts:473), [convergence.ts](/Users/kn/ops/monorepo-harness/src/hitch/convergence.ts:697)。  
推奨修正: #230 を Phase1/Phase2 issue に分割するか、Phase1 に最低限の advisory-only severity audit と決定論テストを含める。

**P2**
1. §3.1 / §5.4: operator-origin filter の意味が曖昧  
問題: 疑似コードは heuristic 実行後にだけ source filter を見るため、human/mcp finding でも heuristic が in/out を返せば自動分類される。これは「operator-origin は manual のまま」と読める §5.4 / §6.5 とずれる。  
根拠: source 分類は [types.ts](/Users/kn/ops/monorepo-harness/src/hitch/types.ts:69), [types.ts](/Users/kn/ops/monorepo-harness/src/hitch/types.ts:74)。CLI は default `human` でも heuristic を通す [cli/hitch.ts](/Users/kn/ops/monorepo-harness/src/cli/hitch.ts:647), [cli/hitch.ts](/Users/kn/ops/monorepo-harness/src/cli/hitch.ts:680)。MCP も `mcp` source を heuristic に通す [hitch-tools.ts](/Users/kn/ops/monorepo-harness/src/mcp/tools/hitch-tools.ts:366), [hitch-tools.ts](/Users/kn/ops/monorepo-harness/src/mcp/tools/hitch-tools.ts:369)。  
推奨修正: 「jury だけ除外」なのか「heuristic も含め operator-origin unknown は全て人間分類」なのかを明文化し、source filter の位置に対応したテストを追加する。

2. §5.6 / §7: operator override の "confirmation-required gate" 表現が現状仕様と違う  
問題: `harness.hitch.classify_finding` は MCP mutation だが dangerous/confirmation-required list にはない。CLI classify も confirmation なし。  
根拠: tool 定義は `kind:"mutation"` [tool-registry.ts](/Users/kn/ops/monorepo-harness/src/mcp/registry/tool-registry.ts:1516)。dangerous list は [mcp.md](/Users/kn/ops/monorepo-harness/docs/specs/mcp.md:613) 以降で classify は含まれない。CLI surface は [cli.md](/Users/kn/ops/monorepo-harness/docs/specs/cli.md:391)。  
推奨修正: 「guarded mutation / audit gate」と書くか、本当に confirmation-required にするなら MCP spec/registry 変更を WI に入れる。

3. §6 fixtures: `fixture-matrix` への jury runner 注入は既存ヘルパ形状と合わない  
問題: `SimulatedGoalLoop` は `ConvergenceService.evaluate()` と手動 `repo.classifyFinding()` だけで、orchestrator runner や fake Codex runner を注入する口がない。  
根拠: helper 定義 [fixture-matrix.test.ts](/Users/kn/ops/monorepo-harness/tests/unit/hitch/fixture-matrix.test.ts:28)、評価は [fixture-matrix.test.ts](/Users/kn/ops/monorepo-harness/tests/unit/hitch/fixture-matrix.test.ts:34)、既存 unknown test は手動分類 [fixture-matrix.test.ts](/Users/kn/ops/monorepo-harness/tests/unit/hitch/fixture-matrix.test.ts:399)。  
推奨修正: jury flow は `orchestrator-runners.test.ts` と `hitch-orchestrate.test.ts` 中心に置き、fixture-matrix は convergence-only 回帰に限定するか helper を先に拡張する。

**P3**
1. §2.7: docs/design の存在判定は ref 依存  
問題: `v0.7.9` では不存在で正しいが、現在の `origin/main` / `v0.7.10` では `deliberation.md` と `consulting-frameworks.md` が存在する。実装 PR が current main ベースなら設計ノートの grounding が古い。  
根拠: 現 checkout に [deliberation.md](/Users/kn/ops/monorepo-harness/docs/design/deliberation.md:1) と [consulting-frameworks.md](/Users/kn/ops/monorepo-harness/docs/design/consulting-frameworks.md:1) が存在。`git ls-tree a4bcca4 docs/design` では空。  
推奨修正: 対象 base ref を明記し、current main 実装では既存 docs/design も grounding に含める。

**総合判定**
GO-with-fixes。§2 の主要な現状把握は概ね正しいです。ただし、決定パケット永続化と async runner 配線はこのままだと受け入れ条件を落とす P1 です。Phase1 だけで #230 を閉じる設計なら severity も P1 未充足です。

---

# 付録G: v2 changeLog（codex finding ごとの対処）

### P1-1
- 対処: classify runner の戻り型を ClassifyRunnerResult({resolved:false, decision:"escalate", escalateReason, recommendedNextAction{decisionPacket}}) に構造化。orchestrator.ts:87-92 を改修し、classify 失敗時に escalate return する前に必ず recordConvergenceDecisionWithStatus(decision:"escalate" + recommendedNextAction) を呼んで decisionPacket を hitch_convergence_decisions.recommended_next_action に永続化する設計を WI-9b として新設。永続化を DB から読み戻して assert するテスト packet-persisted-on-escalate を §6.3/§6.6 に追加。
- 反映 §: v2 改訂履歴, §2.3, §3.1, §3.3, §4 WI-1/WI-9/WI-9b, §5.2, §6.3/§6.6, §8

### P1-2
- 対処: classify runner を async 化し、3フェーズに分解: (1) withManagedDb 同期 callback で finding/session snapshot 取得＋heuristic 確定のみ→DB 閉、(2) DB 閉状態で generateJuryProposals を await 実行(既存 reviewer path orchestrator-runners.ts:1112 と同じ DB-閉じてから runner 方式)、(3) DB 再 open し『同 finding がまだ unknown/open か』を再検証してから classify。withManagedDbAsync で DB lock を保持しない理由を §2.2 に明記。stale-finding-skipped-on-reopen / jury-runs-with-db-closed テストを §6.1 に追加。
- 反映 §: v2 改訂履歴, §2.2, §3.1 疑似コード, §4 WI-5/WI-9, §5.1/§5.7, §6.1

### P1-3
- 対処: §3.5 を新設し JuryProposerDeps を定義: reviewerRunner / harnessRoot / worktreePath(read-only proposer の cwd) / logPaths 生成規則(harnessPaths(harnessRoot).runsDir 配下 jury/<hitchId>/<findingId>/<lens>.{stdout,stderr,events}) / timeoutMs / parseSchema(events・stdout の JSON を厳格 parse) / auditDir(raw log+parsed proposal 保存)。CodexExecRunner.run が worktreePath/prompt/logPaths 必須で結果が exitCode/timedOut/durationMs のみ(codex-exec-runner.ts:1-19)なので出力は events/stdout から parse する点を明記。fail-closed(timeout/parse 失敗/exit≠0→proposedScope='unknown'+proposalStatus)を契約に含めた。
- 反映 §: v2 改訂履歴, §3.1, §3.5(新設), §4 WI-1/WI-4/WI-5, §6.1

### P1-4
- 対処: issue 分割せず、Phase1 に最小の advisory-only severity audit を組み込み。§3.2 を『Phase1 に含む・advisory-only』に全面改訂: 固定マッピング(review-integration.ts:291/310/330/339)は authoritative で上書きしない、auditSeverity() は純関数・決定論(aligned/diverged/inconclusive→escalate flag)、**scope unanimous でも乖離は escalate packet に必ず surface**(frozen contract 反映)、乖離は packet の severityAudit 記録のみ、P1→P2 降格は close gate(convergence.ts:702-708)を動かすため自動適用しない、jury 呼び出し回数を増やさず scope proposal に severity 同梱。WI-10s/WI-11s を Phase1 に追加。受け入れ条件②(同入力→同出力)を auditSeverity 純関数テストで Phase1 充足。§8 対応表を Phase1 単独充足に更新。
- 反映 §: v2 改訂履歴, §1, §3.2, §4 WI-10s/WI-11s, §6.2, §8

### P2-1
- 対処: operator-origin(human/mcp) の unknown は heuristic も jury も通さず即 manual escalate に確定。source filter を heuristic 実行の前(snapshot 段)に移動。harness-origin の unknown は従来通り heuristic→なお unknown のものだけ jury。§3.1 疑似コードで operatorUnknown/harnessUnknown を分離。テストを operator-origin-unknown-skips-heuristic-and-jury に改名し filter 位置に合わせた。CLI default human(cli/hitch.ts:647,680)・MCP mcp source(hitch-tools.ts:366,369)が heuristic を通す現状を §2.2 に記録。
- 反映 §: v2 改訂履歴, §2.2, §3.1, §4 WI-8/WI-9/WI-12, §5.4, §6.1

### P2-2
- 対処: classify_finding は kind:"mutation" で dangerous/confirmation-required list 外(mcp.md:613-626)である事実を確認し、v1 の『confirmation-required gate』表現を『guarded mutation / 権限・audit gate(guarded-mutation mode + 権限スナップショット + audit created_by/actorNote)』に全箇所修正。confirmation-required に格上げするには別途 registry/spec 変更が要るため §9 follow-up に明記。RACI 表の override 行・§5.6・docs 更新(WI-15)も表現修正。
- 反映 §: v2 改訂履歴, §3.4 RACI, §5.6, §7, §9

### P2-3
- 対処: SimulatedGoalLoop は ConvergenceService.evaluate()+手動 repo.classifyFinding() のみで orchestrator runner/fake Codex runner の注入口が無い(fixture-matrix.test.ts:28-56)ことを確認。jury flow テストは orchestrator-runners.test.ts(unit 主)と hitch-orchestrate.test.ts(integration)に集約し、fixture-matrix.test.ts は convergence-only 回帰に限定。WI-11 を fixture-matrix から orchestrator-runners.test.ts に移動。
- 反映 §: v2 改訂履歴, §2.7, §4 WI-11/WI-12, §6 冒頭注, §6.4/§6.6

### P3-1
- 対処: base ref を v0.7.10/origin/main に訂正(HEAD=8c9e6b8)。docs/design の存在は ref 依存で、現 base には deliberation.md と consulting-frameworks.md が存在することを §2.7 に記録。HitchDecisionPacket の grounding に #230 issue・#229 安全パターンに加え既存 docs/design の2ファイル(評価軸マトリクス語彙)を含めた。冒頭に実装 base=origin/main を明記。
- 反映 §: 冒頭ヘッダ, v2 改訂履歴, §2.7, §3.3

### codex PR#246 対応
- 対処(frozen contract 整合): unanimous 定義を frozen contract に整合(unanimious = proposals.length===3 ∧ lens 集合 {correctness,scope_fit,spec_adherence} 完全一致 ∧ 全票同一 scope ∧ 判定不能ゼロ、同一 lens 重複・欠落・4票以上は split) / proposer が proposedScope='unknown'+proposalStatus∈{complete,timeout,parse_error,inconclusive} で判定不能を表現(unknown_inconclusive 廃止) / scope unanimous でも severityAudit diverged/inconclusive なら escalate packet に必ず surface(自動確定しない) / jury_classification_proposals/jury_severity_audits は v31 基盤で follow-up ではなく将来設計・確保。§3.1/§3.2/§3.5/§4 WI-1/WI-2/WI-3/WI-4/WI-5/WI-8/WI-10s/WI-11s/WI-12/WI-13 / §6.2/§7/§8/§9 改訂。
- 反映 §: v2 改訂履歴(新規), §2.7, §3.1, §3.2, §3.5, §4 全 WI, §5.1/§5.2, §6.2, §7, §8, §9 WI-17

### base-ref 訂正
- 対処: v1 の『v0.7.9, HEAD=a4bcca4』を実 checkout『v0.7.10, HEAD=8c9e6b8(release 0.7.10 #241)』に訂正。src/** は v0.7.9→v0.7.10 で差分なしのため file:line は有効である旨を注記し、全 file:line を v0.7.10 で再確認した。
- 反映 §: 冒頭ヘッダ, §2 見出し

---

# 付録H: v2 残件（人間批准が要る）

## H1. jury proposer の worktreePath をどこにするか。CodexExecRunner.run は cwd として worktreePath 必須だが、jury は read-only proposal(編集しない)。run の既存 worktree(workspacesDir 配下)を共有するか、専用の read-only sandbox(checkpoint/別 worktree)を切るか。
推奨: Phase1 は run の既存 worktree を共有し、proposer が mutation しない契約(§3.5)+ Phase3 再検証で stale を弾く方式を推奨。専用 sandbox 切り出しは並行安全コスト(workspace lease)が高く、read-only proposal には過剰。並行 jury と coder/reviewer が同 worktree を触る懸念があれば、workspace spec の checkpoint で read-only スナップショットを取る follow-up に切り出す。

## H2. severity audit を scope jury と同一 runner 呼び出しに同梱するか(parse schema に severity フィールド追加)、別 lens 呼び出しにするか。同梱はコスト最小だが scope lens の関心を severity に広げる。
推奨: 同梱(scope proposal の parseSchema に optional severity を足す)を推奨。jury 呼び出し回数を増やさず(1 finding=3 lens 1 ラウンド)、§3.2 の advisory-only 制約とも整合。severity 専用 lens は精度寄与が薄く PR を肥大化させるため follow-up。

## H3. operator-origin unknown が混在するバッチで、harness-origin の unanimous 分類は確定しつつ operator-origin だけ escalate する『部分前進』を許すか、operator-origin が1件でもあればバッチ全体を即 escalate(harness-origin の jury もスキップ)するか。
推奨: 部分前進を許す(harness-origin は jury まで進めて確定 / operator-origin は同一 escalate packet に operator_origin_unknown として束ねる)を推奨。誤 escalate 削減という headline benefit を最大化しつつ、operator-origin の fail-closed は維持できる。ただし packet が複数 decisionKind を運ぶ実装複雑性が増えるため、Phase1 で『operator-origin が在れば即 escalate・harness-origin jury は次ループに回す』の単純案に倒すかは実装者判断。安全側はどちらも同じ(operator-origin は機械分類しない)。
