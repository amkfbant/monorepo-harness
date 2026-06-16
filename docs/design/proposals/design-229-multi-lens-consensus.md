# 実装設計ノート v2 — issue #229「[案B] multi-lens review consensus + 反証 verify」

> これは計画のみ。コードは変更しない。実装は別セッションが dev クローンの
> `origin/main` ベース隔離ブランチで行う（着手順は A→B→C 確定。#229 は2番手・#230 の後）。
> 本ノートの file:line は当初 ops checkout (v0.7.10) で裏取りしたスナップショット。**現在の main は
> v0.7.15（SCHEMA_VERSION=31）以降**で、resolveEffectiveRule 等の review/consensus 系の主要事実は不変だが
> 一部 file:line が drift している（例: orchestrator-runners.ts の runReviewerAgent 呼出が +59 ずれ）。
> **実装着手時は着手ブランチ HEAD で本体全体の file:line を再取得すること**（付録I.0）。
>
> **⚠️ 版番号同期（2026-06-17）**: #230(案A) が **schema v31 を排他取得して先行リリース**（0.7.15）。
> shipped v31 = #230 jury 3表のみ（`jury_classification_proposals` / `jury_classification_refutations` /
> `jury_severity_audits`）で、`review_refute_votes`(#229) / `phases.review_state_version`(#231) は**含まれない**。
> 旧来の「#229/#230/#231 を**単一 v31 に集約**」前提は無効。確定: **#229 `review_refute_votes` = v32 /
> #231 `review_state_version` = v33**（逐次・別 migration。出荷済み v31 statements は不可侵＝後から書き換えると
> 適用済み DB を壊す）。**Phase 1a/1b（multi-lens consensus 中核）は新 table/migration 不要**で v31 と無干渉。
> 決定根拠: [design-230-deliberation-deepened.md](./design-230-deliberation-deepened.md) R12（:124/:511/:661）。

---

## v2 改訂履歴（codex P0/P1 反映）

- **P0-1（`review:` 不正時の DEFAULT 降格 = fail-open）**: `review:` 欠落のみ DEFAULT。`review:` が
  存在して不正なら run 生成を typed error（`ReviewRuleCompileError`）で拒否し fail-closed。
  `compileProfileReviewRule` は invalid を warning+DEFAULT ではなく throw（§3.1/§3.2/§4 P1-B/§5/§6 RED#1a）。
- **P0-2（多レンズが実体なし: `reviewerName` が prompt に届かない）**: 採用ルートを確定 —
  Phase 1 を **Phase 1a『reachable consensus（正直に N reviewer・同一 prompt）』** と
  **Phase 1b『lens 別 prompt 配線（`reviewerName`/lens label を reviewer prompt に実渡し）』** に分割。
  受け入れ条件の表現を Phase 1a では「multi-reviewer consensus（同一 lens）」、Phase 1b 完了時のみ
  「multi-lens」と正直に表現する（§3.0/§3.3b/§4/§6/§8。どちらに倒すかは unresolvedForHuman に明示）。
- **P1-a（pending→stall 経路が未到達）**: `processReviewDecision` の `ReviewGateError`(pending) を
  orchestrator review runner 内で catch し、review cycle を記録してから
  `evaluateConsensusStallForHitch` を **直接呼ぶ**。pending 行は `recordConsensusReEvaluation`
  (reviewer-agent.ts:735) が各 dispatch 後に書く `review_consensus` 行で timeline が成立する
  ことを根拠にする（§3.4 step7/§5/§6 RED#8/#9）。
- **P1-b（allowOverwrite: 1体目も既存 active で止まる）**: orchestrator 管理の lens dispatch では
  **全 reviewer に `allowOverwrite:true`**。dispatch 前に expected reviewer set と既存 active
  proposal set を検証する preflight を追加（§2.5/§3.4 step3.5/§5/§6 RED#7b）。
- **P1-c（profile→rule thread が全入口に届かない）**: `reviewRuleResolution` 値を
  `PreparedProjectRun`→`RunDomainCodingOpts` まで全入口（CLI run/rerun, hitch CLI, MCP orchestrate,
  reviewed-run, orchestrator `projectRuntime`）で thread。入口別 integration test を追加（§3.1/§4 P1-C/§6 RED#7c）。
- **P1-d（reviewed-run が consensus profile で必ず pending fail）**: reviewed-run は consensus rule の
  run を **明示拒否（typed error）** する（Phase 1a の最小選択）。N-dispatch helper 共有は follow-up
  に明記（§3.4b/§4 P1-H/§6 RED#10b）。
- **P1-e（refute の target binding が無い）**: Phase 2 着手前に **target id/hash 付き refute
  input/output DSL** を設計する前提条件として固定。review decision schema は global decision +
  text array のみ（review-decision-schema.ts:11, schema.ts:184）なので、refute 票を対象 finding に
  決定論 bind できる data model を Phase 2-0 として先行（§3.5/§4 P2-0）。
- **P2-determinism（summary.proposals / sourceProposalIds も order 依存）**: `includedRows` /
  `summary.proposals` / `sourceProposalIds` を **reviewer_id, proposal_id の固定順**に揃える。
  order independence test は required_changes だけでなく summary まで見る（§3.6/§6 RED#5）。
- **P2-dispatch上限**: profile rule に `max_reviewers` または explicit `reviewer_ids` を持たせ、
  preflight で dispatch 数を制限/表示する（§3.2/§3.4/§4 P1-A）。
- **P3（severity が close gate に効く訂正は正しい）**: §2.6 維持（追加対処なし、確認のみ）。

---

## 1. 背景と #229 ゴール

レビューの見落としを減らす。`harness hitch orchestrate` で **quorum > 1 の consensus に
実際に到達できる**ようにし、加えて (1) 異レンズ reviewer、(2) 反証 verify、(3) judge
バイアス対策 を入れる。

設計ノート案B が明示するスコープ: quorum>1 到達には **(0)+(1) が両方必須**。
- **(0)** profile-loaded review rules: `resolveEffectiveRule` が profile から
  consensus(quorum>1)+per-group requirements rule を返す。
- **(1)** orchestrator review runner が review process の前に **N reviewer を dispatch**。
- **(2)** review-consensus への lens 設定 + 反証 verify ステップ。
- 集約は既存の決定論 quorum / tie-break のまま。**多数決結果を直接 run.status にしない**。

**Phase 分割（v2: P0-2 反映で 1a/1b に細分）**:
- **Phase 1a = (0)+(1) reachable consensus（同一 prompt の N reviewer）を 1 PR で land**。
  これで #229 の「quorum>1 実到達」「集約決定論」「回帰なし」「spec 更新」を満たす。
  受け入れ条件は **「multi-reviewer consensus」**と表現（"multi-lens" とは言わない）。
- **Phase 1b = lens 別 prompt 配線**（`reviewerName`/lens label/persona を reviewer prompt に実渡し）。
  これで初めて「異レンズ」が本物になる。**"multi-lens" 受け入れ条件はここで満たす**。
- **Phase 2 = 反証 verify**を「登録済み refute reviewer group + target-bound refute DSL による
  第2 consensus requirement」として再設計して land。

委員会推奨 backbone（minimal-vertical-slice + test-architecture の RED-first + profile-and-datamodel
の datamodel 層）を採用しつつ、全 draft が誤った「severity 降格＝反証 verify」案は **棄却**する
(根拠は §3.5 と §5)。

---

## 2. 検証済みの現状 (file:line。当初 v0.7.10 で確認、現 origin/main=6d0a610 で一部 +2〜+8 drift。着手時 HEAD 再取得)

### 2.1 (0) profile→rule ブリッジが欠落

- `src/core/review-rule.ts:116-122` `resolveEffectiveRule(_scope)` は引数 `_scope`(underscore=無視)を
  受けるが **常に `DEFAULT_REVIEW_RULE` を返す**。`DEFAULT_REVIEW_RULE`(:71-81) は
  `mode:"latest-proposal"`, `requirements:[]`。コメント(:11-14)が「profile 読み込みは Phase 14 送り」と明記。
- `src/core/workflow-runner.ts:1080-1102` が **唯一の呼び出し側**。既に
  `projectId`(opts.project.projectId)/`repoId`/`domain` を渡している(:1081-1085) が、
  `source` は **ハードコードで `"default"`**(:1091)。返った rule を `upsertRuleTemplate`→`snapshotForRun`
  で run に凍結(:1086-1094)。失敗は best-effort で握りつぶし(:1095-1102)、欠落時は後段が DEFAULT に fallback。
- **重要**: workflow-runner は run 生成時に **profile body(`ProjectProfile`)を手元に持たない**。
  `opts.project` の型は `RunMeta["project"]`(workflow-runner.ts:254) = provenance metadata のみ。
  profile body は `src/project/run-project.ts:56` の `resolved.profile`(distill 元は :109-122) に在る。
- `ProjectProfileSchema`(`src/project/schema.ts:146-188`) は `version/project_id/description/repo/
  policy/context_packs/commands/mcp/domains` のみ。**`review:` セクションは無い**。schema は
  `.strict()`(:188) なので新フィールドは **optional 宣言必須**(既存 profile を壊さないため)。
- **profile loader は schema violation を `ProjectProfileError` で throw**(profile-loader.ts:42-48)。
  → **P0-1 の fail-closed 化はこの loader 層と整合する**（profile parse は既に fail-closed。
  問題は rule compile 層の DEFAULT 降格だけ）。

### 2.2 (1) orchestrator が 1体しか dispatch しない

- `src/hitch/orchestrator-runners.ts:1096-1160` review runner は `runReviewerAgent` を
  **1回**(:1112)→ 即 `processReviewDecision`(:1119)→ `importReviewProposalToHitch`(:1147)。
  ループ無し・N dispatch 無し。
- consensus rule(quorum>1) だと proposal が1件しか貯まらず、`processConsensusModePath`
  (`src/core/review-processor.ts:163-277`) が `result.status==="pending"` で
  `ReviewGateError` を throw(:208-213) → transaction rollback(fail-closed)。
- **その throw は `processReviewDecision`(:1119) から伝播し、`src/hitch/orchestrator.ts:153` の
  outer catch が即 escalate(:176-182)**。`importReviewProposalToHitch`(:1147) には到達せず、
  そこに wire された `consensusStall`(:1156) も実行されない。**→ P1-a の根拠**。

### 2.3 consensus 機構は完成済み・決定論(中核は変更しない)

- `src/core/review-consensus.ts` `evaluateConsensus`(:99-255) は純粋関数。override(:134-142)
  → latest-proposal/no-requirements(:148-173) → consensus mode(:175-254)。
  tie-break `rejected > changes_requested > approved > pending`。quorum `isQuorumMet`(fail-closed)。
  staleness `filterStaleProposals`(決定論 drop)。
- **`baseSummary.proposals` は `proposals.map(...)`(review-consensus.ts:123) で入力配列順**を保存する
  → **P2-determinism の根拠（後述 §3.6 で固定順を強制）**。
- `processConsensusModePath` は **ONE immediate transaction**(:184, `gate.immediate()` :263)。
  expected-status guard(:191-195)→ active proposals snapshot(:196-201)→ evaluate → pending throw(:208-213)
  → decisive 時のみ insertActive + applyReviewDecision(:237-256)。
- **`includedRows = rows.filter(...)`(review-processor.ts:219) の `rows` は `activeProposalRows`
  (`listForRun` ORDER BY `created_at DESC, proposal_id DESC`, review-proposals.ts:241)** に従う
  → required_changes 集約(:222-226)・`sourceProposalIds`(:244) が **挿入順依存**。→ P2-determinism。

### 2.4 lens proposal の前提

- `src/core/consensus-enrichment.ts` `enrichRows`(:28-44) は `reviewerRepo.findById(p.reviewer)`
  で groupId/type を引く。**未登録 reviewer は groupId=null / reviewerType=`"unknown"`(:37-38)**
  → per-group checks を必ず落とす(安全方向)。
- `evaluateConsensus` の per-group filter は `p.groupId === req.group && p.reviewerId !== null`
  (:181-183)。participants は distinct reviewerId の Set cardinality(:194-198)。
- `src/db/repositories/review-proposals.ts:70-133` `insertProposal` は **同 `(runId, reviewer)`**
  の旧 active を supersede(:92-98)。`failIfSupersedes: !inputs.allowOverwrite`(reviewer-agent.ts:728)。
  → **N proposal には N 個の distinct reviewer_id が必要**(同 reviewer_id は supersede される)。

### 2.5 runReviewerAgent の overwrite guard(N-dispatch の中核制約)

- `src/core/reviewer-agent.ts:395` `runReviewerAgent`。reviewer 名は `inputs.reviewerName ?? "codex-reviewer"`(:532)。
- **preflight overwrite guard**(:493-506): `allowOverwrite` が無いと (a) DB に active proposal が
  あれば throw。この preflight は **`getLatestActiveProposal(runId)`(reviewer 引数なし=グローバル)**
  (:476-478, review-proposals.ts:147-173) を見る。(b) `review-decision.yaml` が non-pending なら throw。
- **→ P1-b: 「1体目は allowOverwrite 不要」は fresh run 限定の誤り**。resume / partial / manual
  proposal が既に1件でもあると、別 reviewer の1体目すら global guard で止まる。非冪等。
- insert 側の supersede は **同一 reviewer のみ**(review-proposals.ts:96 `WHERE reviewer=?`)。
  → 全 reviewer に `allowOverwrite:true` を渡せば `failIfSupersedes:false`(:728) になり、distinct
  reviewerName 同士は互いを supersede しない → **N proposal が全部 active で残る**(正しい)。
- 各 insert 後に `recordConsensusReEvaluation`(:735, 776-828) が consensus mode のとき consensus を
  再評価して **(pending も含め) `review_consensus` 行を insert**(:809-819)。status guard を tx 内で読み
  (:790)、`rule.mode !== "consensus"` は no-op(:796)。**→ P1-a の鍵: pending consensus 行が timeline に
  蓄積されるので、後段で `evaluateConsensusStallForHitch` を直接呼べば stall を検出できる**。

### 2.6 severity マッピングと close-check の実態(P3: 訂正は正しい)

- `src/hitch/review-integration.ts` `proposalFindingSeeds`(:276-344): required_change→**P1固定**(:291) /
  negative_decision→**P1固定**(:310) / non_blocking_comment→**P2固定**(:330) /
  out_of_scope→**P2固定 + forcedScopeStatus:"out_of_scope"**(:339-341)。reviewer 申告 severity は不使用。
- `src/hitch/convergence.ts` は `openInScopeP0/P1/P2` を別集計(:121-123) し、close 判定で
  `noOpenInScopeP1`(:449-471)/`maxOpenInScopeP2`(:473-494) を severity ごとに参照する。
  **P1→P2 降格は close gate の挙動を実際に変える**(P1 は hard block、P2 は閾値以下なら許容)。
- → だからこそ severity 降格を **LLM の refute 自己申告で直接駆動するのは安全境界違反**。
  反証 verify は決定論 gate 経由に限る(§3.5)。**codex P3 がこの訂正を正しいと確認済**。

---

## 3. 中核設計判断

### 3.0 Phase 分割と「lens」表現の正直さ（P0-2 反映）

codex P0-2: 現 `runReviewerAgent` は `reviewerName` を **Codex runner input / prompt に渡していない**
(reviewer-agent.ts:524 `reviewerPrompt = PROMPT_PREAMBLE + reviewerOpsSection` に reviewer/lens identity
無し、:527-531 で runner に渡るのは `worktreePath/prompt/logPaths` のみ、:532 で実行後に stamp)。
→ **同一 prompt の N reviewer は「異レンズ」ではない**。

> **【付録I.0(G0) による上書き・最重要】**: 下記の旧 Phase 分割は『Phase 1a 単独で #229 を close できる』読み方を
> 残すが、**付録I.0(G0) がこれを上書きする**: 同一 prompt-only path は **fixture 専用**で独立完了点ではなく、
> **#229 の close は lens-based consensus（lens land）を必須**とする（headline = lens）。以下の Phase 1a 文言は
> 配管マイルストーンの記述であって close 基準ではない（close 基準は §8 + I.0 を正本とする）。

**採用ルート（確定。close 基準は付録I.0 で上書き）**: Phase 1 を分割する。
- **Phase 1a（reachable consensus・同一 prompt の N reviewer = 配管マイルストーン / fixture）**: (0)+(1) を land。
  配管の受け入れは「multi-reviewer consensus が quorum>1 に実到達／集約決定論／回帰なし」。**"multi-lens" とは
  言わない**。**ただし #229 の close 完了点ではない（I.0/G0）**。
- **Phase 1b（lens 別 prompt）**: reviewer の登録 metadata（後述 §3.3b で `metadata_json` に
  `lens_prompt` / `persona` を持たせる）から **prompt variant** を生成し、`runReviewerAgent` に
  lens label / reviewer_id を渡して prompt に注入する最小配線を入れる。**ここで "multi-lens" を満たす**。

Phase 1a と 1b は依存順（1a→1b）。1b を 1a と同一 PR にするか別 PR にするかは
**unresolvedForHuman Q-A**（配線コストと PR レビュー容易性のトレードオフ。推奨: 別 PR）。
#229 の受け入れ条件文言（"multi-lens"）を満たすには **1b までが必要**である点を人間に明示する。

### 3.1 `resolveEffectiveRule` の署名と profile 解決経路 (0) + P0-1 + P1-c

**判断**: 署名を `profile?` を明示的に受け取る形に拡張する。隠れた DB I/O を避け、決定論・
テスト容易性を確保する。

```ts
// src/core/review-rule.ts
export class ReviewRuleCompileError extends Error {}   // NEW (typed, fail-closed)

export function compileProfileReviewRule(
  profile: ProjectProfile,
  domain?: string,
): ReviewRule {
  // profile.review が無ければ呼ばない（呼び出し側で分岐）。
  // 不正なら ReviewRuleCompileError を throw。warning+DEFAULT には絶対に落とさない。
}

export function resolveEffectiveRule(scope: {
  projectId?: string;
  repoId?: string;
  domain?: string;
  profile?: ProjectProfile | null;   // NEW: 呼び出し側が読み込んで渡す
}): { rule: ReviewRule; source: "default" | "project-profile" }
```

**P0-1 の fail-closed 化（最重要）**:
- `scope.profile?.review` が **欠落** → `{ rule: DEFAULT_REVIEW_RULE, source: "default" }`（後方互換）。
- `scope.profile?.review` が **存在して有効** → `compileProfileReviewRule` で変換し
  `{ rule, source: "project-profile" }`。
- `scope.profile?.review` が **存在して不正** → `ReviewRuleCompileError` を **throw**（DEFAULT に落とさない）。
  - 理由: DEFAULT は `latest-proposal` / requirements 空（review-rule.ts:71-81）なので、意図した
    quorum>1 を **単一 reviewer path に静かに降格** してしまう = fail-open。これは安全境界違反。
  - この throw は **run 生成を拒否**する（§3.1 の供給経路で run-project.ts/workflow-runner が捕まえ、
    typed error として CLI/MCP に exit 1 で返す。best-effort の握り潰し（workflow-runner.ts:1095-1102）は
    **`source==="project-profile"` で review が宣言されている run では行わない**）。
  - schema violation（zod）は `compileProfileReviewRule` 到達前に profile-loader.ts:42 で既に弾かれる。
    `compileProfileReviewRule` の throw は「zod は通ったが意味的に不整合（例: requirement の group が
    どの reviewer group とも一致せず quorum 充足不能、min_approvals > 期待 group size）」を担う。
    → **MECE: 構文不正=loader / 意味不正=compile / 欠落=DEFAULT**。

**profile body の供給（P1-c: 全入口 thread）** — open Q1 は **案A 採用（人間批准済み）**:
- rule 解決を **profile を持つ層(`src/project/run-project.ts`)で行う**。`prepareProjectRun` が
  `compileProfileReviewRule`/`resolveEffectiveRule` を呼び、**`reviewRuleResolution: { rule, source,
  ruleSha256 }`** を `PreparedProjectRun`(run-project.ts:32-43) の新フィールドとして返す。
  `resolveEffectiveRule` は profile を引数で受ける **純関数**のまま（隠れ I/O なし、決定論テスト容易）。
- **P1-c: thread すべき全入口を列挙**（`reviewRuleResolution` を端から端まで運ぶ）:
  1. `PreparedProjectRun`(run-project.ts:32) に `reviewRuleResolution` 追加。
  2. `RunDomainCodingOpts`(workflow-runner.ts:248-270) に `reviewRuleResolution` 追加。
     workflow-runner.ts:1080-1102 の snapshot は **opts.reviewRuleResolution があればそれを凍結**し、
     `source` をその値（`"default"`/`"project-profile"`）に分岐。無ければ従来どおり default。
  3. `ReviewedRunWorkflowOpts.projectRun`(reviewed-run-workflow.ts:71-75) に `reviewRuleResolution` 追加 →
     `projectRunFields`(reviewed-run-workflow.ts:85+) で各 coder run に spread。
  4. orchestrator `ProjectRuntimeDeps`/`projectRuntime`(orchestrator-runners.ts:155 周辺,
     mutation-tools.ts:522-528) に `reviewRuleResolution` 追加。
  5. CLI run/rerun（`harness run --project` / `harness workflow reviewed-run` の prepare 経路）。
  6. MCP orchestrate（mutation-tools.ts:508-533 が `prepared` を `projectRuntime` に詰める箇所）。
  7. hitch CLI orchestrate（同じ orchestrator runner factory を通る）。
- **入口別 integration test を追加**（§6 RED#7c）: 各入口で profile consensus rule の run が
  正しく `source="project-profile"` の snapshot を凍結することを検証。

**スナップショット凍結は不変**: rule は run 生成時に `run_review_rule_snapshots` に凍結され、後の
profile 編集は in-flight run に retroactive に効かない。

### 3.2 profile `review:` schema（+ P2: dispatch 上限）

`src/project/schema.ts` の `ProjectProfileSchema.object({...})` に **optional** `review` を追加。
`ReviewRule` interface(review-rule.ts:37-61) に 1:1 対応する zod schema。
**`ReviewRuleRequirement` 型拡張（必須）**: 現状 `{ group, minApprovals, blockingDecisions, quorum? }`
（review-rule.ts:37-44）に **`reviewerIds?: string[]` と `lensAxes?: string[]`（共有 lens 語彙型）を additive 追加**する。
`compileProfileReviewRule` が YAML の `reviewer_ids` / `lens_axes` をこの 2 フィールドへ写し、`snapshotForRun` →
`rule_json` に serialize される。これが無いと C4 の「frozen set は rule_json の explicit reviewer_ids で完結＝migration
不要」（§I.2.4 step1）が型レベルで成立しない（reviewer_ids を rule に詰められない）。`multiReviewerRequired`→
reviewer_ids/lens_axes 必須の compile gate もこの 2 フィールド上で検証する。

```yaml
review:
  mode: consensus            # 'latest-proposal' | 'consensus'
  max_reviewers: 4           # NEW (P2): group ごとの dispatch 上限（省略時は明示 reviewer_ids 必須 or default 上限）
  requirements:
    - group: humans          # reviewer.group_id
      min_approvals: 1             # injection 耐性が要る consensus は >1 にする（C1: min_approvals:1 は単一 approve が decisive になり得る）
      blocking_decisions: [changes_requested, rejected]
      quorum: { min_participants: 2 }
      lens_axes: [correctness, security]   # NEW (G0c/G1): multiReviewerRequired(min_participants>1 or min_approvals>1) は lens 宣言必須（無いと ReviewRuleCompileError）
      reviewer_ids: [alice, bob]   # NEW: multiReviewerRequired requirement では必須（欠落=ReviewRuleCompileError）。len <= max_reviewers(hard cap)。listByGroup 自動解決 consensus は #229 外 follow-up
  overrides: { allowed_reviewers: [], require_reason: true }   # optional
  stale_proposal: { reject_superseded: true }                  # optional
```

zod 検証(fail-closed): `quorum.min_participants >= 1`（0 は許さない）, `blocking_decisions ⊆ {changes_requested, rejected}`,
`group` 非空文字列, `max_reviewers >= 1`, **`reviewer_ids` は重複を reject**（`[alice,alice]` 等。distinct reviewer が participant 分母＝`insertProposal` は reviewer ごとに active 1件のため、重複は len チェックを通過しても frozen set が 1 participant しか生まず pending/stall になる。**以降の数チェックは重複 reject 後＝distinct 数で評価**。codex #257）, **`len(reviewer_ids) <= max_reviewers`（明示リストも hard cap＝DoS bound を破らせない）**,
**`len(reviewer_ids) >= max(min_participants ?? 1, min_approvals ?? 1)`（充足不能 profile を compile で fail-fast。distinct reviewer 数 < min_approvals だと `approvals >= minApprovals` が永久未達で pending/stall を浪費するため。codex #257）**。
**`multiReviewerRequired`**（＝複数の distinct reviewer が実効的に必要 = `(min_participants ?? 1) > 1` **または**
`(min_approvals ?? 1) > 1`）が真の consensus requirement は **(i) `lens_axes` 必須（G0c/G1）かつ (ii) `reviewer_ids` 必須**
（#229 Phase 1。frozen set を rule_json で完結＝migration 不要。どちらか欠落は `ReviewRuleCompileError`）。
**`min_participation_rate` / `group_size`（rate-based quorum）は #229 profile schema に含めない（follow-up）**＝`.strict()`
で reject。これにより rate 経由で lens/reviewer_ids ゲートを bypass する穴を作らない（runtime の `evaluateConsensus` は
rate を引き続きサポートするが #229 では profile から宣言不可）。
`.strict()` 配下なので未知キーは reject。`review` 欠落 = `DEFAULT_REVIEW_RULE`(後方互換)。
**新 table / migration は不要**(`review_rules.source` が既に `"project-profile"` をサポート、
`run_review_rule_snapshots` も既存)。

**P2 dispatch 上限**: orchestrator は group の登録 reviewer を **全員無制限に dispatch しない**。
`reviewer_ids` があればそれを使う（ただし **`len(reviewer_ids) > max_reviewers` は compile/preflight で reject**＝
明示リストも hard cap）、無ければ `listByGroup ∩ max_reviewers`（reviewer_id 字句順で上位
`max_reviewers` 体）。preflight で dispatch 予定数を表示し、`quorum.min_participants` 未満なら
**事前に escalate（fail-silent 防止）**。

### 3.3 reviewer group 登録経路（Phase 1a）

- Phase 1a の reviewer = **distinct reviewer_id + group_id（同一 prompt）**。これは「異レンズ」ではなく
  「N reviewer consensus」。**異レンズは Phase 1b（§3.3b）**。
- 既存 CLI `harness review reviewers add <id> --group <g> --type <t> --display-name <n>`
  (`src/cli/run.ts` の reviewers add, `reviewers.ts:83 add(groupId)`) で N 体登録。
  **`--type` の許容値は `human|codex|external|system`**（reviewers.ts:13。設計 v1 の `--type <t>` 一般化は
  この union に従う）。
- **新規 `ReviewerRepository.listByGroup(groupId)` を追加**(検証済: 現状 `list()/findById()/
  resolveOrThrow()/add()` のみ。reviewers.ts:48-114)。reviewer_id 字句順で distinct。
  orchestrator が requirement の group ごとに登録済み reviewer を引いて dispatch する。
- 未登録 reviewer は groupId=null で per-group check を落とす(安全方向、変更なし)。

### 3.3b lens 別 prompt 配線（Phase 1b — P0-2 を本物にする）

- reviewer 登録時の `metadata_json`（reviewers.ts:22, 既存カラム）に **`lens` メタ**を持たせる:
  例 `{ "lens": "security", "lens_prompt": "Focus on auth, secrets, injection..." }`。
- `runReviewerAgent` に **`lensPrompt?: string` / `reviewerName` を prompt に注入**する配線を追加:
  `reviewerPrompt = PROMPT_PREAMBLE + lensSection(reviewerName, lensPrompt) + reviewerOpsSection`
  （reviewer-agent.ts:524 を拡張）。`promptSha256`(:525) は lens section 込みで再計算され、
  `prompt_provenance_json`(:724-727) に lens 由来が記録される（監査性）。
- orchestrator は dispatch 時、`listByGroup` で引いた各 reviewer 行の `metadata_json.lens_prompt` を
  `runReviewerAgent({ reviewerName: reviewer_id, lensPrompt, allowOverwrite: true })` に渡す。
- **安全境界**: lens prompt は **proposal（入力）を多様化するだけ**で、集約は依然
  `evaluateConsensus`（決定論）。lens 自己申告は状態遷移の根拠にならない。
- **Phase 1b を #229 の "multi-lens" 受け入れ条件に割り当てる**。Phase 1a 単独では受け入れ条件文言を
  「multi-reviewer」に正直化する（誇張しない）。

### 3.4 orchestrator N reviewer dispatch (1) + P1-a + P1-b

`src/hitch/orchestrator-runners.ts:1096-1160` review runner を改修:
1. run snapshot rule を `ReviewRulesRepository.findSnapshotByRun(runId)` で読む。
2. `rule.mode==="consensus"` かつ requirements あり → 各 requirement の dispatch 対象 reviewer を確定
   （`reviewer_ids` 明示〔**`len <= max_reviewers` を compile/preflight で強制**〕 or `listByGroup(group) ∩ max_reviewers`、reviewer_id 字句順）。
   latest-proposal mode(=DEFAULT, 後方互換) は **従来どおり 1体 dispatch**（else 分岐）。
3. **preflight（P2 fail-silent 防止）**: dispatch 対象数が各 requirement の **`max(quorum.min_participants, min_approvals)`**
   未満なら、dispatch 前に **決定論 escalate**（reason に `group`/`required(=max(min_participants,min_approvals))`/`registered` を含む）。
   **min_approvals も照合する**理由: `min_approvals > dispatch 数`だと `approvals >= minApprovals` が永久未達で pending/stall を
   浪費する（min_participants だけ見ると見逃す。codex #257。compile 側 fail-fast=§3.2 と二重ゲート）。
   **P1-b preflight**: 現在の active proposal set を読み、expected reviewer set と照合（resume / 手動
   proposal による既存 active を検出してログ）。
3.5. 各 reviewer を `runReviewerAgent({..., reviewerName: reviewer_id, lensPrompt?, allowOverwrite: true})`
   で **逐次** dispatch（parallel ではない、§3.6）。**P1-b: 全 reviewer に `allowOverwrite:true`**
   （1体目も既存 active で止まらないように。distinct reviewerName 同士は supersede しない）。
   **【Phase 1a 前提】per-reviewer artifact 分離**: `runReviewerAgent` の runDir は現状 runId のみで keyed
   （reviewer-agent.ts:405）、`review-decision.yaml` / reviewer log を固定 path に書く（:418,512-516）。逐次 N-dispatch
   では (1) reviewer#2 の `snapshotRunDir` が #1 の artifact を pre-existing と見て `verifyArtifactsUnchanged` が
   誤 tamper、(2) 後続が先行 artifact を上書き/読取りして独立性を破壊する。→ **runDir/decisionPath/log を
   `runDir/reviewers/<path-safe reviewer_id>/…` の per-reviewer subdir に分離**し、**その subdir prefix の write を
   許可に加える**。ただし現 `REVIEWER_WRITE_ALLOWLIST`（reviewer-agent.ts:104）は **exact relative-path Set**
   （`snapshotRunDir` が `has(rel)` で照合）なので、ディレクトリ名を1個足すだけでは `reviewers/alice/reviewer-agent.out.log`
   等の **nested file を exempt できない**→ **prefix-aware 照合**（`rel` が `reviewers/<id>/` 配下かを startsWith 判定）に
   拡張する（codex #257）。`snapshotRunDir`/`verifyArtifactsUnchanged` の baseline は **runDir 全体のまま**に保ち（共有 run
   artifact＝meta.json / diff / materialized files の tamper 検知を維持。per-reviewer subdir prefix の改変のみ exempt）、
   **baseline を subdir に narrow しない**（narrow すると sandbox/runner 誤設定で共有 artifact が改変されても検知できなく
   なる defense-in-depth 欠落。codex #257）。**さらに『後続 reviewer が先行 verdict を読めない』独立性**は artifact の write
   先を移すだけでは不十分（reviewer の `codexRunner.run({worktreePath})` が parent runDir のままだと sibling の
   `reviewers/<other>/review-decision.yaml` を read できる）→ **reviewer の sandbox/worktreePath root を per-reviewer subdir
   に scope** するか、各 reviewer に **隔離入力を materialize** して sibling subdir を露出しない（codex #257）。**reviewer_id は path component に
   使う前に path-safe 化必須**（`reviewers.add()`
   は任意文字列を受けるため、`/`・`..` 等で subdir を escape/alias されないよう **`reviewers.add()` 登録時に path-safe
   id を強制**する＝許可文字集合に制約し不正は ValidationError。既存 `slugify`（knowledge-promoter.ts:170-179、base +
   sha1 短縮で衝突 discriminate）を流用可。path と DB business-key の両方で同一 safe id を使い、既存非-safe id は path
   構築時に reject、seed id（human/codex/system）は既に path-safe＝migration 不要）。N-dispatch と同時に必要なので
   **Phase 1a の前提**（C1 対処4 の artifact 隔離をここで land、lens 配線=Phase 1b より前）。
4. 全 N proposal が貯まった後に `processReviewDecision` を **1回**。これで quorum>1 が first call で
   充足 → pending throw を回避 → escalate しない。
5. **P1-a（pending fail-closed 経路を本物にする）**: `processReviewDecision` が `ReviewGateError`(pending)
   を throw した場合、orchestrator review runner が **その throw を catch** し:
   - review cycle を記録（`startReviewCycle`/`completeReviewCycle`, orchestrator-runners.ts:1136-1144 と同様）。
   - **`evaluateConsensusStallForHitch` を直接呼ぶ**（consensus-stall-check.ts:40）。
     `dbConsensusSnapshotProvider`(同 :118) は `recordConsensusReEvaluation`(reviewer-agent.ts:735, 809)
     が各 dispatch 後に書いた **pending `review_consensus` 行**から timeline を再構築できる（§2.5）。
   - stall（既定 `stallAfterSnapshots=3`）なら決定論 escalate（harness-only state transition、fail-closed）。
     stall 未満でも **(i) 真 pending（frozen reviewer 全員 landed ∧ 進展余地なし: 例 全員 landed・**blocking decision
     なし**・`approvals < min_approvals` で全員 landed 済みのため approve 増加余地が無い）は即 escalate**（再 dispatch
     しても同票で進展せず stall 窓を待つ意味が無い）。**注意: `changes_requested`/`rejected` 等の blocking decision は
     `evaluateConsensus` が approval/quorum 判定より先に decisive blocking を返す（review-consensus.ts:175「check
     blocking decisions first」）ため、そもそも pending にならず本 catch に来ない**＝この (i) は非 blocking の
     approval-pending に限る（codex #257）。**(ii) 進展余地 pending
     （未 landed reviewer が残る）は「pending・継続」を返し outer catch の即 escalate(orchestrator.ts:183) に伝播
     させない**（cycle 記録して次 step へ）。『継続』は convergence が次 review action を再発行する前提
     （N×`stallAfterSnapshots` の codex 再実行コストは §9/budget 参照）。
   - この catch→直接 stall 経路により、codex P1-a の「pending で stall detector に届かない」を塞ぐ。
6. required_changes / summary / sourceProposalIds 集約の決定論は §3.6（P2）で固定。

`runReviewerAgent` は `reviewerName`(:184) を既にサポートするので Phase 1a の dispatch 自体は
agent コード変更不要。**ただし per-reviewer artifact 分離（§3.4 step3.5・runDir/decisionPath/log の subdir 化）は
`runReviewerAgent` 内の固定 path 構築を変えるため、Phase 1a で `reviewer-agent.ts` の変更が必要**（orchestrator
ループだけでは共有 artifact / 誤 tamper が残る）。lens prompt 注入は Phase 1b の §3.3b で追加。

### 3.4b reviewed-run の consensus profile 扱い（P1-d）

- `runReviewedRunWorkflow`(reviewed-run-workflow.ts) は `runReviewerAgent` 1回(:202)→
  `processReviewDecision` 1回(:231) で **N dispatch しない**。consensus(quorum>1) profile を
  そのまま適用すると **必ず pending fail**（fail-closed なので安全だが、運用上は dead-end）。
- **Phase 1a の判断: reviewed-run は consensus rule の run を明示拒否（typed error）する**。
  `reviewRuleResolution.rule.mode === "consensus"` を検出したら、run を始める前に
  `ReviewWorkflowUnsupportedError`（"reviewed-run does not support consensus rules; use `hitch
  orchestrate`"）を返す。これで「片方の入口だけ静かに半壊」を防ぐ。
- N-dispatch helper（orchestrator と reviewed-run で共有）化は **follow-up（§9）**に明記。Phase 1a は
  orchestrator のみが consensus を駆動できる、と spec で正直に書く。

### 3.5 反証 verify 機構(Phase 2。全 draft の severity 降格案を棄却 + P1-e target binding)

**棄却する案**(safety-and-determinism / refute-verify-and-lenses): 「過半 refute で finding を
P1→P2 に降格」。理由は §2.6 の通り（LLM 自己申告で close gate を動かす安全境界違反）。動的ハッシュ
由来の未登録 refute reviewer_id は登録不変量に反する。新 `review_refutes` table で監査ゲート外に
quorum 再実装するのは duplication で禁止。

**採用する案**: 反証 verify を **登録済み reviewer GROUP による第2 consensus requirement** として
モデル化する。refute group の reviewer は「この required_change は本当に approval を block するか?」を
判定する別 prompt の reviewer agent variant（distinct reviewer_id で登録）。集約は **既存
`evaluateConsensus` の決定論ロジックに通す**。降格効果は `evaluateConsensus` の出力として現れ、
`processConsensusModePath` の expected-status(needs_review) ゲートを通って run.status に反映される。
**severity フィールドの mutation は経由しない**。fail-closed: refute 票が集まらない/判定エラー時は
元の blocking requirement のまま。

**P1-e（target binding の data model を Phase 2-0 として先行）**:
- 現 data model には **「どの required_change を refute したか」を表す構造が無い**。review decision
  schema は `decision/required_changes/non_blocking_comments/out_of_scope_suggestions` のみ
  (review-decision-schema.ts:11)、required changes DB も `idx/change_text` のみ(schema.ts:184)。
  → このままでは refute group の票を **対象 finding に決定論 bind できない**。
- **Phase 2-0（Phase 2 着手の前提条件）**: target id / hash 付き **refute input/output DSL** を設計する。
  - 各 required_change に **安定 target id**（例: `(runId, normalized_change_text) の sha256` or
    `finding` への FK）を付与する data model 拡張。→ **付録I.1.2(G2) で content-hash（`target_change_hash =
    sha256(normalizeChangeText(change_text))`、FK なし）に確定**。
  - refute reviewer の出力は `{ target_id, refute_verdict }` の構造を持ち（→ 付録I.1.3(G3) で
    `{ target_change_hash, refute_verdict ∈ uphold|refute|inconclusive, refute_reason, … }` に確定）、harness 側で
    **既存 consensus requirement に入る前に target binding を決定論検証**する（未知 target / hash
    不一致は fail-closed で reject）。
  - この DSL と binding 検証ができて初めて、refute 票を「対象 finding に効く第2 consensus
    requirement」として `evaluateConsensus` に通せる。
- **#229 の受け入れ条件「反証 verify が finding を advisory に降格できる経路のテスト」**は、この
  第2 consensus requirement 経路の **決定論テスト**で満たす（severity テストではない）。

### 3.6 バイアス対策 + 決定論（P2-determinism 反映）

- **dispatch 順は reviewer_id 字句順で固定**(§3.4 step2)。`evaluateConsensus` は集合濃度ベースの
  quorum / 固定 tie-break order なので **提示順に依存しない**。
- **seeded shuffle は導入しない**（safety-and-determinism / refute-verify draft の shuffle 案は棄却）。
- **P2-determinism（required_changes だけでなく summary / sourceProposalIds も固定順に）**:
  `evaluateConsensus` の `baseSummary.proposals = proposals.map(...)`(review-consensus.ts:123) は
  **入力配列順**を保存する。`processConsensusModePath` の `includedRows`(review-processor.ts:219) は
  `activeProposalRows`(`listForRun` ORDER BY `created_at DESC, proposal_id DESC`) 由来で **挿入順依存**。
  → **単一の sort source**: `enrichRows`/`evaluateConsensus` に渡す前の `rows` を reviewer_id, proposal_id 昇順に
  ソートすれば、`summary.proposals`(入力順を保存) と `includedRows`(同 `rows` の filter で順序継承) は自動的に固定。
  下記 1-3 は **同一 source（ソート済み rows）由来**であることの明示であって、3 箇所を独立にソートする意味ではない:
  1. `processConsensusModePath` が `evaluateConsensus` に渡す proposals を **reviewer_id, proposal_id
     昇順にソート**してから渡す（→ `summary.proposals` が固定順）。
  2. `includedRows`(:219) を同じ固定順にソート → required_changes 集約(:222-226) が dispatch/挿入順非依存。
  3. `sourceProposalIds`(:244) と `recordConsensusReEvaluation` の `sourceProposalIds`(reviewer-agent.ts:818)
     も同じ固定順。
  - `dedupeStrings`(review-processor.ts:222) は固定順の包含集合に対して安定。
- order independence test（§6 RED#5）は **required_changes に加え `summary.proposals` /
  `sourceProposalIds` まで**入替不変を検証する。
- 並行 review との競合は不変: `processReviewDecision` は N reviewer 完了後に1回のみ呼ぶので、
  全 proposal が単一 transaction の snapshot に見える(review-processor.ts:184 immediate)。

---

## 4. work item DAG (依存順 / サブPhase / 触るファイル)

### Phase 1a — reachable consensus（同一 prompt の N reviewer。1 PR で land）

| id | title | files | depends |
|----|-------|-------|---------|
| P1-A | `review:` schema を `ProjectProfileSchema` に optional 追加 + zod 検証 + `max_reviewers`/`reviewer_ids`(P2) | src/project/schema.ts | — |
| P1-B | `compileProfileReviewRule`(invalid=**throw `ReviewRuleCompileError`**) + `resolveEffectiveRule(profile?)` が `{rule,source}` を返す。**欠落=DEFAULT、不正=throw（P0-1 fail-closed）** | src/core/review-rule.ts | P1-A |
| P1-C | profile→rule の **全入口 thread**(P1-c): `reviewRuleResolution` を `PreparedProjectRun`→`RunDomainCodingOpts`→reviewed-run.projectRun→orchestrator projectRuntime→MCP→CLI run/rerun。workflow-runner snapshot source 分岐。**review 宣言済 run では snapshot 失敗を握り潰さない** | src/project/run-project.ts, src/core/workflow-runner.ts, src/core/reviewed-run-workflow.ts, src/hitch/orchestrator-runners.ts, src/mcp/tools/mutation-tools.ts, src/cli/run.ts | P1-B |
| P1-D | `ReviewerRepository.listByGroup(groupId)`(reviewer_id 字句順 distinct) | src/db/repositories/reviewers.ts | — |
| P1-E | orchestrator review runner: consensus mode で N reviewer 逐次 dispatch(**全 `allowOverwrite:true`** P1-b, **preflight で expected/registered/quorum 照合** P1-b/P2)→1回 processReviewDecision。**pending throw を catch→cycle 記録→`evaluateConsensusStallForHitch` 直接呼び（P1-a）**。escalate メッセージに group/required/registered | src/hitch/orchestrator-runners.ts | P1-C, P1-D |
| P1-F | CLI `reviewers list --group`(listByGroup) / `add --group` の spec 整合 + 効果検証 | src/cli/run.ts | P1-D |
| P1-G | consensus 集約の決定論固定(P2): `processConsensusModePath` の proposals/includedRows/sourceProposalIds を reviewer_id,proposal_id 昇順に。`recordConsensusReEvaluation` も同順 | src/core/review-processor.ts, src/core/reviewer-agent.ts | P1-E |
| P1-ISO | **per-reviewer artifact 隔離（C1/C4 前提・§3.4 step3.5・C1 対処4-4）**: runDir/decisionPath/log を `runDir/reviewers/<path-safe reviewer_id>/` の subdir 化（reviewer_id は path 化前に `reviewers.add()` で path-safe 強制）、per-reviewer subdir を `REVIEWER_WRITE_ALLOWLIST` に追加し `verifyArtifactsUnchanged` の baseline は **runDir 全体を維持**（共有 artifact の tamper 検知を失わない・§3.4 step3.5）。runId-keyed 共有 runDir の衝突・誤 tamper を回避 | src/core/reviewer-agent.ts, src/db/repositories/reviewers.ts | P1-E, P1-D |
| P1-H | reviewed-run は consensus rule を**明示拒否(typed error)**（P1-d） | src/core/reviewed-run-workflow.ts | P1-C |
| P1-SPEC | docs/specs 同コミット更新(§7) | docs/specs/{project,workflow,db,cli}.md, docs/future-features.md | P1-B, P1-E |
| P1-TEST | RED→GREEN テスト群(§6) | tests/unit/**, tests/integration/** | 各実装 item |

### Phase 1b — lens 別 prompt（"multi-lens" を本物にする。別 PR 推奨）

| id | title | files | depends |
|----|-------|-------|---------|
| P1b-A | reviewer `metadata_json` に `lens`/`lens_prompt` を持たせる（既存カラム活用） + CLI で設定可能に | src/cli/run.ts, src/db/repositories/reviewers.ts | Phase 1a |
| P1b-B | `runReviewerAgent` に `lensPrompt?`/`reviewerName` を **prompt 注入**(reviewer-agent.ts:524 拡張)。promptSha256/prompt_provenance に lens 反映 | src/core/reviewer-agent.ts | P1b-A |
| P1b-C | orchestrator が dispatch 時に各 reviewer の lens_prompt を渡す | src/hitch/orchestrator-runners.ts | P1b-B |
| P1b-SPEC | docs/specs/{project,workflow}.md に lens prompt + multi-lens を明記 | docs/specs/** | P1b-A..C |
| P1b-TEST | 異 lens prompt が proposal に反映され集約が決定論 / lens 別 promptSha256 | tests/** | P1b-A..C |

### Phase 2 — 反証 verify（別 PR。Phase 1 land 後。Phase 2-0 が前提）

| id | title | files | depends |
|----|-------|-------|---------|
| P2-0 | **refute target binding data model + DSL**(P1-e): required_change に安定 target id/hash、refute output `{target_id,refute_verdict}`、harness 側 binding 決定論検証(未知 target/hash 不一致=reject)（→ 付録I.1.2/I.1.3 で `target_change_hash` / `uphold\|refute\|inconclusive` に契約確定）。**`review_refute_votes` table は #230 の v31 単独出荷により v32 で作成するが、その v32 migration は impl-roadmap SP-1 が所有（design-db §3.1）。P2-0 が足すのは binding ロジックのみ（normalizeChangeText / verifyRefuteBinding / 集約投入）＝新 migration ではない（table は SP-1 の v32 で建立済を利用）** | src/core/review-decision-schema.ts, src/core/review-rule.ts | Phase 1, v32(SP-1) |
| P2-A | refute requirement の rule 表現(DSL) + schema(`review.refute`) | src/project/schema.ts, src/core/review-rule.ts | P2-0 |
| P2-B | refute reviewer agent variant(別 prompt, distinct registered reviewer_id) | src/core/refute-agent.ts(新) or reviewer-agent.ts flag | P2-A |
| P2-C | refute 票を `evaluateConsensus` の決定論集約に通す(target-bound 第2 requirement として) | src/core/review-consensus.ts | P2-0, P2-A |
| P2-D | orchestrator: consensus pending→refute group dispatch→再 processReviewDecision | src/hitch/orchestrator-runners.ts | P2-B, P2-C |
| P2-SPEC | docs/specs/{hitch-convergence,project,workflow}.md 更新 | docs/specs/** | P2-0..D |
| P2-TEST | refute→決定論 advisory 降格経路テスト(target binding 込み) + 回帰 | tests/** | P2-0..D |

**Phase 境界の妥当性**: (0)+(1) は **Phase 1a で land 必須**（どちらも単独では headline 受け入れテストが
半機能）。**lens 実体（1b）を 1a と分けた**のは、P0-2 の通り「異レンズ」は prompt 配線を要し、1a の
"reachable consensus" とは独立にレビューできるため。refute(P2)は **P2-0 の target binding data model が
前提**で、proven core から完全分離する。

---

## 5. 安全境界マッピング(各 item が不可侵境界を侵さない理由)

| 不可侵境界 | 該当コード | 設計でどう守るか |
|-----------|-----------|----------------|
| policy 検証は事後 git diff ベース | (本変更は review 層のみ) | review rule / consensus は policy gate と直交。触らない。 |
| LLM 出力を状態遷移の根拠にしない | review-processor.ts:191-213, reviewer-agent.ts:524 | (1) N 体の verdict は **proposal 行(入力)**。集約は `evaluateConsensus`(決定論)。**lens prompt(1b) も proposal を多様化するだけ**で状態遷移に直接効かない。(2) refute 票も入力に過ぎず、§3.5 で **severity mutation を経由せず** `evaluateConsensus` の決定論 requirement に通す。target binding(P2-0) も harness 側で決定論検証。run.status は harness gate のみ。 |
| 状態遷移は harness のみ | **`RunRepository.applyReviewDecision`(runs.ts:778, `status='needs_review'` CAS guard。review-processor.ts:246 はその呼び出し側)**, convergence.ts, consensus-stall-check.ts | run/finding/consensus の promote は `applyReviewDecision`/expected-status guard 経由のまま。**P1-a の stall escalate も `evaluateConsensusStallForHitch`(harness-only, fail-closed) 経由**で、LLM 出力ではなく persisted `review_consensus` 行のみが入力。N-dispatch は proposal を貯めるだけ。 |
| expected-status(needs_review) guard 不可迂回 | review-processor.ts:191-195, reviewer-agent.ts:790 | N-dispatch も最終 `processReviewDecision` 1回がこのガードを通る。各 insertProposal も needs_review/db-first を検証(review-proposals.ts:82-88)。`allowOverwrite:true`(P1-b) は **同 reviewer の supersede 抑止を外すだけ**で、status guard・db-first guard は無効化しない。 |
| pending で fail-closed | review-processor.ts:208-213 | quorum 未充足は throw→rollback のまま。**P1-a: throw を catch しても run.status は promote しない**（catch は cycle 記録 + stall 評価のみ。decisive にするのは次サイクルで quorum が揃ったときだけ）。group 未充足の真の pending は stall 検出器経由で決定論 escalate。 |
| 反証 verify の過半 refute も決定論集約 | review-consensus.ts(Phase 2), P2-0 binding | refute は **登録済み reviewer group の決定論票**で、**target id/hash で対象に決定論 bind**してから `evaluateConsensus` に通す。動的未登録 reviewer_id / 外部 quorum 再実装 / severity 直接 mutation は **禁止**。binding 不一致は fail-closed reject。 |
| 提示順シャッフル等も決定論 | orchestrator-runners.ts(dispatch 順), review-processor.ts:218-226, review-consensus.ts:123 | dispatch は reviewer_id 字句順固定。**集約(required_changes / summary.proposals / sourceProposalIds)を reviewer_id,proposal_id 昇順に固定(P1-G, P2-determinism)**。seeded shuffle は導入しない。 |
| 迷ったら fail-closed | review-rule.ts(profile compile), consensus quorum | **review 欠落→DEFAULT、review 不正→throw(run 拒否, P0-1)**。quorum 不正→false。dispatch 数<quorum→preflight escalate。refute 不成立/binding 不一致→元 blocking 維持。 |
| MCP confirmation を shell で迂回しない | (本変更は MCP confirmation 経路を触らない) | MCP orchestrate(mutation-tools.ts:508) は `reviewRuleResolution` を thread するだけ。confirmation モデルは不変。 |

---

## 6. TDD テスト計画

### RED 一覧(失敗テストを先に書く)

**Unit**
1. `resolveEffectiveRule({profile})`: profile.review から consensus(quorum>1) rule + `source="project-profile"` /
   profile=null or review 欠落で `{DEFAULT, "default"}` / 同入力→同 ruleSha256(決定論)。
   **1a. P0-1: review が存在して不正なら `compileProfileReviewRule`/`resolveEffectiveRule` が
   `ReviewRuleCompileError` を throw（DEFAULT に落ちない）。特に `quorum.min_participants ∉ [1,∞)` を schema と compile 両層で reject**。
   **1b. serialize round-trip（C4 frozen-set の結節点・Phase 1a）: `lens_axes`+`reviewer_ids` 宣言済み profile
   consensus rule を `compileProfileReviewRule`→`snapshotForRun` し、`rule_json` を parse して
   `ReviewRuleRequirement.reviewerIds`/`lensAxes` が round-trip すること（C4 はこの rule_json の reviewer_ids を分母
   基準に読むため、compile→serialize 経路を Phase 1a で単体検証）**。
   `tests/unit/core/review-rule.test.ts`。
2. `ProjectProfileSchema` の review 検証: 不正 quorum(`min_participants < 1`/neg/NaN) / 不正 blocking_decisions /
   空 group / `max_reviewers<1` / `len(reviewer_ids) > max_reviewers` / **重複 `reviewer_ids`（`[alice,alice]`＝distinct < 宣言数。frozen set が 1 participant しか生まない・codex #257）** / **`distinct(reviewer_ids) < max(min_participants, min_approvals)`（充足不能 profile＝reviewer 数 < min_approvals で `approvals >= minApprovals` 永久未達。compile fail-fast。preflight 側=§3.4 step3 でも `max(min_participants, min_approvals)` 照合。codex #257）** を reject。`min_participation_rate` / `group_size`
   キーは `.strict()` で reject（rate-based quorum は #229 profile 非対応・follow-up）。**review 欠落 profile が通る**
   (後方互換)。`tests/unit/project/*`。**特に** `min_participants=0` が reject されることを検証。
   **2b. G0c/P0: `multiReviewerRequired`（`min_participants > 1` or `min_approvals > 1`）∧（`lens_axes` 未宣言
   または `reviewer_ids` 未宣言）→ `ReviewRuleCompileError`（schema/compile 両層、fail-closed）。`multiReviewerRequired`
   が偽（`min_participants <= 1` ∧ `min_approvals <= 1`）/ latest-proposal は no-op（後方互換）**。
3. `ReviewerRepository.listByGroup`: reviewer_id 字句順 distinct / 空 group→空 / 未登録 group→空(非エラー)。
   `tests/unit/db/reviewers.test.ts`。
4. `evaluateConsensus` 回帰: tie-break / override / latest-proposal / quorum / staleness /
   **proposal 配列順入替で status 不変**。`tests/unit/core/review-consensus.test.ts`(既存に追加)。
5. **P2-determinism: 集約の決定論**: 2 reviewer が重複・順序違いの required_changes を出しても、
   **required_changes 集約 ∧ `summary.proposals` ∧ `sourceProposalIds` が dispatch/挿入順に依らず同一**。
   `tests/unit/core/review-processor-consensus.test.ts`。
6. enrichRows: 未登録 reviewer→groupId=null→per-group check を落とす(安全方向)。

**Integration — quorum>1 実到達(ヘッドライン, Phase 1a)**
7. `tests/integration/hitch-orchestrate-consensus.test.ts`(新) — **配管 fixture（lens-free）**:
   - **rule snapshot を直接注入**（`review: consensus, requirements:[{group:reviewers, min_approvals:1, quorum:{min_participants:2}, reviewer_ids:[alice,bob]}]` 相当）。**`reviewer_ids` を含める**（C4 の frozen set は rule_json の explicit reviewer_ids 由来なので、fixture も同じ frozen-set 経路を通す）。
     **profile review: は経由しない**（lens-free quorum>1 profile は G0(c) で compile-reject されるため、profile 経由では
     この fixture が成立しない）。N-dispatch / allowOverwrite / quorum 到達 / 集約決定論の**配管のみ**を検証する。
   - reviewer alice/bob を groupId=reviewers で登録。
   - `createFakeCodexRunner` で reviewer_id→runner の Map(各 distinct YAML)を作る `FakeMultiReviewerRunner`
     fixture(`tests/fixtures/fake-codex-multi-reviewer.ts` 新)。**`reviewerName` で出力を切り替える wrapper**。
   - orchestrate review step: **runReviewerAgent が 2回(alice/bob)**、2 proposal が active で貯まり、
     `processReviewDecision` が **1回**で `approved` に promote。run.status==='approved'。
   - 直接注入のため source は fixture 値。**profile→snapshot freeze（`source='project-profile'` / ruleSha256 一致）の
     検証は lens 宣言込みの headline テスト（RED#12 / 7c）が担う**（lens-free profile は compile されないので RED#7 では検証しない）。
   - **7b. P1-b: 1体目 dispatch 前に既存 active proposal(resume/manual)が1件あっても、全 `allowOverwrite:true`
     で 2体目まで dispatch が落ちない。preflight が expected/registered/quorum を照合する**。
   - **7c. P1-c: 入口別 thread**: CLI run / reviewed-run prepare / MCP orchestrate / hitch CLI の各入口で
     profile consensus rule の run が `source='project-profile'` snapshot を凍結する（入口ごとに小テスト）。
8. **P1-a pending fail-closed → stall 経路**（stall detector の 3-snapshot 要件と整合させ分割。1 dispatch=1 pending
   `review_consensus` 行=1 snapshot。consensus-stall.ts:100-113 は `snapshots.length>=stallAfterSnapshots` を要求）:
   - **8a（単一サイクル pending=継続）**: quorum=2, 1体のみ approved → `processReviewDecision` が ReviewGateError →
     orchestrator が catch し cycle 記録 + `evaluateConsensusStallForHitch` 直接呼び。snapshot 蓄積が
     `stallAfterSnapshots` 未満なら **run.status は needs_review のまま「継続」**（escalate しない）ことをアサート。
   - **8b（stall 到達=escalate）**: participants/approvals 非増加の **3 distinct pending snapshot** を fixture で直接
     構築（または同一 reviewer の review action を 3 サイクル駆動）→ `stallAfterSnapshots=3` 到達で決定論 escalate
     （harness-only state transition）をアサート。pending `review_consensus` 行が recordConsensusReEvaluation 由来で
     timeline に蓄積されることも DB アサート。
   - **8c（継続→進捗）**: 8a の「継続」後、次サイクルで未 landed reviewer が dispatch され quorum 充足 → decisive に
     進む（継続が dead-end でなく進捗に繋がることを実証。§3.4 step5(ii)）。**注意（follow-up）**: 継続分岐は
     review cycle を消費するため、`maxReviewCycles`（既定 3=repository.ts:516, 比較 convergence.ts:415/569）が `stallAfterSnapshots`
     （既定 3）より先に尽きると stall でなく `budget_exhausted` で終端しうる。両予算の合成は §9/budget で確定する。
9. **escalate メッセージ内容**: required group に 1体しか登録が無い(quorum=2)→ preflight or 反復 pending →
   escalate reason に group 名 + required=2/registered=1 が含まれる。

**Regression**
10. latest-proposal(DEFAULT)後方互換: review 欠落 profile / --project なし run → 1体 dispatch、
    最新 proposal で promote、consensus 評価に入らない。`tests/integration/cli-review-process.test.ts` 系。
    **10b. P1-d: consensus rule の run を reviewed-run に流すと typed error で拒否される**。
11. **override × consensus**: consensus rule の run に per-run override をかけた時の挙動(override が
    consensus を short-circuit する。review-consensus.ts:134-142)を明示テスト。

**Phase 1b（別 PR）**
12. 異 `lens_prompt` を持つ alice/bob を dispatch すると、各 proposal の `prompt_sha256` が異なり、
    `prompt_provenance_json` に lens 由来が残る。集約は決定論(order 非依存)。
13. **G1 lens MECE preflight（決定論データのみ）**: (a) `multiReviewerRequired` group で全 reviewer 同一/空 lens →
    決定論 escalate（退化検出）、(b) 宣言 `lens_axes` の一部未カバー → escalate（missing axis）、(c) lens 重複 →
    escalate。reason に `required_axes`/`covered_axes`/`missing`/`duplicates`。LLM 出力は見ない。`lens_axes` 未宣言
    （multiReviewerRequired 偽）は no-op（後方互換）。

### quorum>1 実到達テストの組み方の要点
- FakeCodexRunner を **reviewer_id ごとに分岐**させる fixture が肝（`reviewerName` で出力を切替える wrapper）。
- `allowOverwrite:true` が全 reviewer に伝播し、既存 active があっても 2体目以降 dispatch が guard で
  落ちないことを検証。
- N proposal が `insertProposal` で全部 active(supersede されない)ことを DB アサート。

### 決定論テストの方針
- 同一(profile, proposals)→同一 rule_sha256 + 同一 consensus decision + 同一(required_changes /
  summary.proposals / sourceProposalIds)。proposal 配列順 / dispatch 順を入れ替えても不変。

### 緑化規律
- サブ Phase = 関連テスト + typecheck 緑。大 Phase = フルスイート + typecheck 緑。
- テストを弱める/skip する緑化は禁止。

---

## 7. docs/specs 更新一覧(同コミット)

| ファイル | 追記内容 | Phase |
|---------|---------|-------|
| docs/specs/project.md | `review:` セクション schema(`mode/requirements/quorum/max_reviewers/reviewer_ids`) + 例。後方互換(欠落=DEFAULT)。**review 不正は run 拒否(fail-closed)**。repo-level のみ(per-domain は future) | 1a |
| docs/specs/workflow.md | resolveEffectiveRule が profile から `{rule,source}` を返す→ snapshotForRun 凍結。**全入口 thread**。consensus mode で orchestrator が N reviewer 逐次 dispatch(全 allowOverwrite:true)→1回 processReviewDecision。**pending=fail-closed→catch→stall escalate 経路**。determinism(required_changes/summary/sourceProposalIds 固定順)。**reviewed-run は consensus 非対応(明示拒否)** | 1a |
| docs/specs/db.md | review_rules.source='project-profile' の使用。**Phase1 は新 table/migration 不要**。run_review_rule_snapshots 凍結。recordConsensusReEvaluation が pending consensus 行を蓄積し stall timeline を成す | 1a |
| docs/specs/cli.md | `reviewers add --group`(type 値は human/codex/external/system) / 新 `reviewers list --group`(listByGroup) | 1a |
| docs/future-features.md | （G0 反映）同一 prompt N reviewer は **fixture であって独立完了点ではない**。headline 完了 = lens-based consensus（Phase1b 含む）。N-dispatch helper 共有(reviewed-run) / persona / 異モデル / per-domain cascade / dashboard・MCP 露出 / **listByGroup 自動解決 consensus** / **rate-based quorum(profile)** を follow-up として記載 | 1a |
| docs/specs/project.md / workflow.md | lens prompt(metadata.lens_prompt)→reviewer prompt 注入。"multi-lens" の正確な定義 | 1b |
| docs/specs/hitch-convergence.md | 反証 verify = 登録済み refute group の **target-bound** 第2 consensus requirement。決定論集約。severity 経由しない | 2 |
| docs/specs/{project,workflow}.md | (G1) lens 軸 zod 宣言 + orchestrator preflight の決定論 MECE 検査。(C1) lens_prompt=untrusted・per-reviewer artifact 隔離・他 reviewer proposal 非伝播 | 1a/1b |
| docs/specs/{db,workflow}.md | (C2/PM-1) processMetrics を `review_consensus.summary_json` に記録（集約に効かない観測層） | 1a/1b |
| docs/specs/{hitch-convergence,workflow}.md | (C3) consensus escalate の決定論要約 projection を payload に。(C4) expected reviewer set freeze + 部分失敗 fail-closed | 1a |

---

## 8. 受け入れ条件(#229)対応表

| 受け入れ条件 | 対応 work item / テスト |
|-------------|----------------------|
| resolveEffectiveRule が profile から consensus(quorum>1) rule を返すテスト | P1-A/P1-B + RED #1（+ **#1a: review 不正=throw, P0-1**） |
| (0)+(1) が揃った状態で hitch orchestrate が quorum>1 consensus に**実際に到達**するテスト | P1-C/P1-D/P1-E + RED #7（**配管 fixture: lens-free・profile compile 非経由**）+ #7b(allowOverwrite) + #7c(入口別 thread) |
| 異レンズ proposal の集約が決定論(同入力→同出力)。**lens land が #229 close の必須（headline）** | Phase 1a 配管: P1-G + RED #4/#5(order 非依存, summary まで)。**headline = multi-lens consensus** = P1b-B/C + RED #12 + #13(lens MECE preflight) + #2b(`multiReviewerRequired` ∧ lens 未宣言→compile reject)。#229 close は lens land 必須 |
| 反証 verify が finding を advisory に降格できる経路のテスト | **Phase 2**: P2-0(target binding)→P2-A..D + 第2 consensus requirement 経路の決定論テスト(severity 経由しない) |
| 既存 consensus の tie-break / override / latest-proposal に回帰なし | RED #4/#10/#11(回帰禁止) |
| docs/specs/* を同コミットで更新 | P1-SPEC / P1b-SPEC / P2-SPEC |
| (P1-a) pending consensus が escalate ではなく stall 経路で扱われる | RED #8/#9 |
| (P1-d) reviewed-run が consensus profile を安全に拒否 | RED #10b |

---

## 9. スコープ外 / follow-up(その場で直さない)

- per-domain review rule cascade(domain>repo>default)。署名は domain を受けるが Phase1 は repo-level top-level のみ。
- **N-dispatch helper を orchestrator と reviewed-run で共有**（Phase 1a は reviewed-run を consensus
  非対応で明示拒否。共有 helper 化は budget/timeout 設計が前提）。
- lens persona / 異モデル procurement（ReviewerType に model field 無し、reviewerRunner は単一 DI）。
  Phase 1b は同一 runner + lens prompt 変化まで。**異モデル調達は別 Phase**。
- parallel N-reviewer dispatch(budget/timeout 設計が前提)。Phase1 は逐次。
- dashboard / MCP の N-proposal・consensus 露出(docs/specs/dashboard.md / mcp.md は単一 reviewer 形状前提)。
- N=N codex の budget/コスト計上単位(run_usage per-invocation は既存、wire は follow-up)。
- `harness project check` で「required group に quorum 分の reviewer 登録済みか」検証(fail-silent 防止)。
  Phase1 は orchestrator preflight(§3.4 step3)で escalate するが、run 生成時の事前検証は follow-up。

**【round10 独立多角監査の助言（codex App 非依存。要人間判断）】**

- **Phase 1a の PR 物理分割**: Phase 1a は「配管」の語感に反し、schema 新設 + compile 層 + 7 入口 thread +
  per-reviewer artifact 隔離(P1-ISO) + freeze + frozen-set filter 共有純関数化 + determinism 固定 + C4 例外境界を
  1 PR に抱える（codex 反復指摘 P1-a〜e/C1/C4 を全て Phase 1a に積んだ局所最適の累積）。**(PR-1) rule 解決経路
  land（profile review schema + compile 層 + 7 入口 thread + reviewed-run 拒否、N-dispatch なし）/ (PR-2) N-dispatch +
  allowOverwrite + preflight + artifact 隔離 + determinism + C4** の 2 物理 PR への分割を推奨（各単独で
  typecheck+関連テスト緑、レビュー面積半減）。#229 スコープ内のまま PR を割る（付録H H1 で人間批准）。
- **convergence 予算の合成（要確定）**: `maxReviewCycles`(既定 3=repository.ts:516, 比較 convergence.ts:415/569) と
  `stallAfterSnapshots`(既定 3, consensus-stall.ts:100) は独立予算。P1-a「進展余地 pending=継続」(§3.4 step5(ii)) は
  review cycle を消費するため、stall 窓到達前に max-review-cycles が尽きると stall でなく `budget_exhausted` で
  終端しうる（RED#8b/8c 参照）。両予算の合成と、convergence が consensus-pending run に同一 review step を再 dispatch
  する決定論契約（step5(ii) が依存）を docs/specs/hitch-convergence.md に明記する（未固定）。
- **dashboard / MCP の N-proposal 誤表示（露出でなく correctness）**: Phase 1a land 後は 1 run に N active proposal が
  共存（review-proposals active partial-unique は per-reviewer）。既存の単一 proposal 前提 read（`getLatestActiveProposal`
  global / `proposals[0]`）が**誤/部分表示**しうる。露出（上記 follow-up 既出）とは別に、既存 read surface が N proposal
  下でも correct であることを #229 受け入れに含めるか検討。
- **operator 起動 UX（fail-closed 初回 hard-stop）**: consensus 有効化に pre-flight validate 経路が無く（project check は
  follow-up）、初回 orchestrate が fail-closed 群の発見器になる→ in-flight ops drive を hard-stop しうる。最小の
  validate-only 経路を #229 に入れるか follow-up か判断。
- **逐次 N-dispatch の latency / lease 干渉**: 逐次 dispatch は 1 cycle 最悪 N×(codex timeout)。hitch/course lease
  timeout・#132 abort-on-lease-loss と干渉しうる。per-cycle dispatch time budget の要否を判断。

---

# 付録C: 反証検証した主要アーキ前提

### 前提1 — **confirmed**
- 主張: resolveEffectiveRule(review-rule.ts:116) is the run's review mode's sole determinant. Currently it always returns DEFAULT_REVIEW_RULE (latest-proposal, no requirements). The rule is frozen onto each run at creation time (workflow-runner.ts:1080-1094), and later profile changes don't retroactively alter the run's review semantics. The orchestrator review runner (orchestrator-runners.ts:1112) dispatches exactly one `runReviewerAgent` per review cycle, immediately followed by `processReviewDecision` (1119). In consensus mode, a single proposal cannot satisfy quorum>1, so processReviewDecision fails closed on pending (review-processor.ts:208-213) and orchestrator escalates.
- 根拠: 

### 前提2 — **confirmed**
- 主張: orchestrator-runners.ts:1096-1159 dispatches exactly 1 reviewer per review cycle via a single runReviewerAgent call (not a loop), and when consensus mode is active (rule.mode==="consensus"), processReviewDecision throws ReviewGateError on pending consensus (quorum unmet), causing the orchestrator to escalate on the first cycle. Thus current code cannot reach quorum>1 consensus without additional dispatcher logic.
- 根拠: 

### 前提3 — **confirmed**
- 主張: The architectural premise that "consensus per-group requirements are aggregated by reviewer.group_id (from reviewers registry), unregistered reviewers get groupId=null→fail per-group checks, insertProposal supersedes same reviewer_id rows (1 active per reviewer), and N consensus proposals require N distinct reviewer_ids" is sound and cannot be bypassed.
- 根拠: src/core/review-rule.ts:116-122 — resolveEffectiveRule ALWAYS returns DEFAULT_REVIEW_RULE(mode: latest-proposal), is the sole entry point via src/core/workflow-runner.ts:1081. Consensus rules only via upsertRuleTemplate(:1087). No other code constructs ReviewRule with mode="consensus".

### 前提4 — **confirmed**
- 主張: Project profile schema (src/project/schema.ts) currently has no `review` rule section. The `ReviewRulesRepository` supports `source: "project-profile"` but with no mechanism to load the rule from the profile. The reviewer registration CLI (`harness review reviewers add --group`, cli/run.ts:1461,1505) exists and fully supports `groupId` assignment. However, `resolveEffectiveRule` (review-rule.ts:116) unconditionally returns `DEFAULT_REVIEW_RULE` regardless of input parameters—the call signature carries projectId/repoId/domain for future Phase 14 integration, but the rule is never loaded from the profile today. This blocks consensus mode (which requires quorum>1) from being reached via the orchestrator's single-reviewer dispatch (orchestrator-runners.ts:1112-1124).
- 根拠: 

### 前提5 — **confirmed**
- 主張: 反証 verify による「blocking finding の advisory 降格」を入れる場合、review-processor の expected-status(needs_review)ガードと processConsensusModePath の決定論集約を迂回してはならない。現状 severity は review-integration.ts で required_changes→P1固定 / non_blocking→P2固定 であり reviewer 申告 severity は使われていない。
- 根拠: 

---

# 付録F: codex exec gpt-5.5 xhigh レビュー（v1 設計への指摘 = v2 の改訂根拠）

結論: **NO-GO as written**。§2 の現状分析は大半が実コードと一致しますが、Phase 1 設計には P0/P1 の修正が必要です。GitHub issue 本文そのものは未検証で、ここでは提示された設計ノートと ops checkout の実コードを照合しました。

**P0**
- 該当: §3.1/§3.2 `profile.review` parse/compile 失敗時の DEFAULT fallback
  問題: `review:` が存在するのに不正な場合に `DEFAULT_REVIEW_RULE` へ落とすのは fail-closed ではありません。DEFAULT は `latest-proposal` かつ requirements 空なので、意図した quorum>1 を単一 reviewer path に降格します。
  根拠: DEFAULT は latest-proposal/no requirements ([review-rule.ts](/Users/kn/ops/monorepo-harness/src/core/review-rule.ts:71))、現 `resolveEffectiveRule` も常に DEFAULT ([review-rule.ts](/Users/kn/ops/monorepo-harness/src/core/review-rule.ts:116))。profile loader は schema violation を `ProjectProfileError` で止める設計 ([profile-loader.ts](/Users/kn/ops/monorepo-harness/src/project/profile-loader.ts:42))。
  推奨: `review` 欠落だけ DEFAULT。`review` が存在して不正なら run 作成を拒否する。`compileProfileReviewRule` も invalid は warning+DEFAULT ではなく typed error にする。

- 該当: §3.3/§3.4/§6 「異レンズ」「FakeLensRunners fixture」
  問題: 現 `runReviewerAgent` は `reviewerName` を Codex runner input/prompt に渡していません。runner は reviewer_id で出力を切り替えられず、実運用でも全 reviewer が同一 prompt の同一 lens です。Phase 1 が「異レンズ集約決定論」を満たすとは言えません。
  根拠: `codexRunner.run` に渡るのは `worktreePath/prompt/logPaths` のみ ([reviewer-agent.ts](/Users/kn/ops/monorepo-harness/src/core/reviewer-agent.ts:527), [codex-exec-runner.ts](/Users/kn/ops/monorepo-harness/src/codex/codex-exec-runner.ts:1))。`reviewer` は runner 実行後に stamp される ([reviewer-agent.ts](/Users/kn/ops/monorepo-harness/src/core/reviewer-agent.ts:532))。prompt に reviewer/lens identity は無い ([reviewer-agent.ts](/Users/kn/ops/monorepo-harness/src/core/reviewer-agent.ts:221))。
  推奨: runner input または prompt に reviewer_id/lens metadata を明示的に渡す。登録 reviewer metadata から prompt variant を作る。Phase 1 でそこまでやらないなら「multi-lens」受け入れ条件から外す。

**P1**
- 該当: §3.4 step 7 / §6 RED #8/#9
  問題: pending consensus 時に stall detector へ到達する、という記述は現コード経路と合いません。`processReviewDecision` が throw すると `importReviewProposalToHitch` は呼ばれず、そこに wire された `consensusStall` も実行されません。
  根拠: orchestrator は `runReviewerAgent` 後すぐ `processReviewDecision` を呼ぶ ([orchestrator-runners.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator-runners.ts:1112))。import/stall はその後 ([orchestrator-runners.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator-runners.ts:1147))。throw は outer catch で即 escalate ([orchestrator.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator.ts:153))。stall check は import 内だけ ([review-integration.ts](/Users/kn/ops/monorepo-harness/src/hitch/review-integration.ts:184))。
  推奨: consensus pending を catch し、review cycle を記録して `evaluateConsensusStallForHitch` を直接呼ぶ経路を設計する。future-features もその必要性を書いています ([future-features.md](/Users/kn/ops/monorepo-harness/docs/future-features.md:185))。

- 該当: §2.5/§3.4 allowOverwrite
  問題: 「1体目は allowOverwrite 不要」は fresh run だけに依存します。既存 active proposal が1件でもあると、reviewer が別でも global guard で1体目が止まります。resume/partial/manual proposal があると N-dispatch が非冪等になります。
  根拠: preflight は reviewer 指定なし `getLatestActiveProposal(runId)` ([reviewer-agent.ts](/Users/kn/ops/monorepo-harness/src/core/reviewer-agent.ts:473), [review-proposals.ts](/Users/kn/ops/monorepo-harness/src/db/repositories/review-proposals.ts:147))。guard は active があれば拒否 ([reviewer-agent.ts](/Users/kn/ops/monorepo-harness/src/core/reviewer-agent.ts:493))。insert 側の supersede は同一 reviewer だけ ([review-proposals.ts](/Users/kn/ops/monorepo-harness/src/db/repositories/review-proposals.ts:92))。
  推奨: orchestrator 管理の lens dispatch では全 reviewer に `allowOverwrite:true` を渡し、事前に expected reviewer set と既存 proposal set を検証する。

- 該当: §4 P1-C work item DAG
  問題: profile→rule の thread 対象ファイルが足りません。`PreparedProjectRun` に rule/profile を追加するだけでは、CLI run/rerun、hitch CLI、MCP orchestrate、reviewed-run workflow、orchestrator `projectRuntimeFields` まで全入口に伝播しません。
  根拠: `PreparedProjectRun` は現在 policy/project/context packs のみ ([run-project.ts](/Users/kn/ops/monorepo-harness/src/project/run-project.ts:32))。reviewed-run の `projectRun` も同じ ([reviewed-run-workflow.ts](/Users/kn/ops/monorepo-harness/src/core/reviewed-run-workflow.ts:71))。orchestrator `ProjectRuntimeDeps` も同じ ([orchestrator-runners.ts](/Users/kn/ops/monorepo-harness/src/hitch/orchestrator-runners.ts:155))。MCP も同 fields だけ渡す ([mutation-tools.ts](/Users/kn/ops/monorepo-harness/src/mcp/tools/mutation-tools.ts:520))。
  推奨: `reviewRuleResolution` のような値を `PreparedProjectRun` から `RunDomainCodingOpts` まで全入口で thread し、入口別 integration test を追加する。

- 該当: §4/§6 reviewed-run
  問題: profile consensus rule を全 run に適用すると、`runReviewedRunWorkflow` は 1 reviewer しか dispatch しないため quorum>1 profile で必ず pending fail します。
  根拠: reviewed-run は `runReviewerAgent` 1回 ([reviewed-run-workflow.ts](/Users/kn/ops/monorepo-harness/src/core/reviewed-run-workflow.ts:202))、その後 `processReviewDecision` 1回 ([reviewed-run-workflow.ts](/Users/kn/ops/monorepo-harness/src/core/reviewed-run-workflow.ts:231))。
  推奨: N-dispatch helper を orchestrator と reviewed-run で共有するか、reviewed-run は consensus profile 非対応として明示的に拒否する。

- 該当: §3.5 Phase 2 refute verify
  問題: 安全境界の方向性は良いですが、現データモデルでは「どの required_change を refute したか」を表す構造がありません。既存 YAML は global decision と text arrays だけなので、このままでは refute group の票が対象 finding に deterministic に bind できません。
  根拠: review decision schema は `decision/required_changes/non_blocking_comments/out_of_scope_suggestions` のみ ([review-decision-schema.ts](/Users/kn/ops/monorepo-harness/src/core/review-decision-schema.ts:11))。required changes DB も `idx/change_text` のみ ([schema.ts](/Users/kn/ops/monorepo-harness/src/db/schema.ts:184))。
  推奨: Phase 2 前に target id/hash 付き refute input/output DSL を設計し、既存 consensus requirement に入る前の binding を harness 側で検証する。

**P2**
- 該当: §3.6/§6 determinism
  問題: `required_changes` だけでなく consensus summary/source proposal ids も proposal order に依存します。`evaluateConsensus` は summary.proposals を入力順で保存し、`processConsensusModePath` も DB order の includedRows を使います。
  根拠: summary proposals は `proposals.map` ([review-consensus.ts](/Users/kn/ops/monorepo-harness/src/core/review-consensus.ts:123))。active rows は `created_at DESC, proposal_id DESC` ([review-proposals.ts](/Users/kn/ops/monorepo-harness/src/db/repositories/review-proposals.ts:236))。required changes aggregation も現状 includedRows order ([review-processor.ts](/Users/kn/ops/monorepo-harness/src/core/review-processor.ts:218))。
  推奨: includedRows、summary proposals、sourceProposalIds を reviewer_id/proposal_id の固定順に揃える。order independence test は summary まで見る。

- 該当: §3.4 dispatch all registered reviewers
  問題: group 内 reviewer を全員 dispatch する設計は cost/budget/latency が登録数に比例して無制限に増えます。
  根拠: reviewer usage は invocation ごとに `kind="reviewer"` で記録される ([reviewer-agent.ts](/Users/kn/ops/monorepo-harness/src/core/reviewer-agent.ts:62)) が、orchestrator 側の N 上限設計はありません。
  推奨: profile rule に max reviewers または explicit reviewer ids を持たせる。最低でも preflight で dispatch count を表示/制限する。

**P3**
- 該当: §2.6
  確認: severity が close gate に効く、という設計ノートの訂正は正しいです。review import は required_change/negative を P1、non_blocking/out_of_scope を P2 に固定 ([review-integration.ts](/Users/kn/ops/monorepo-harness/src/hitch/review-integration.ts:276))。convergence は P1/P2 を別 gate で見る ([convergence.ts](/Users/kn/ops/monorepo-harness/src/hitch/convergence.ts:449))。

**総合判定**
Phase 1 を「この設計のまま」実装着手するのは **NO-GO**。P0 を直し、P1 の経路設計とテスト計画を更新すれば **GO-with-fixes** にできます。特に `review:` 不正時の扱い、実 lens identity、pending stall 経路、全入口への rule threading は先に設計を確定してください。

---

# 付録G: v2 changeLog（codex finding ごとの対処）

### P0-1
- 対処: review: 欠落のみ DEFAULT。review: が存在して不正なら resolveEffectiveRule / compileProfileReviewRule が新 typed error ReviewRuleCompileError を throw し run 生成を拒否(fail-closed)。best-effort 握り潰し(workflow-runner.ts:1095-1102)は review 宣言済 run では行わない。zod 構文不正=loader / 意味不正=compile / 欠落=DEFAULT の MECE を明記。RED #1a 追加。
- 反映 §: §3.1, §3.2, §4 P1-B, §5(迷ったら fail-closed 行), §6 RED#1a, §7 project.md, §8

### P0-2
- 対処: 現 runReviewerAgent は reviewerName を prompt/runner input に渡さない(reviewer-agent.ts:524,527-531,532 を確認)ため同一 prompt の N reviewer は異レンズではない、を §2.4/§3.0 に明記。Phase1 を Phase1a(reachable consensus・同一 prompt の N reviewer、受け入れ条件文言を multi-reviewer に正直化)と Phase1b(metadata.lens_prompt を reviewer prompt に実注入する最小配線、ここで multi-lens を満たす)に分割。1a/1b の同一PR か別PRかは unresolvedForHuman Q-A(推奨: 別PR)。
- 反映 §: §1, §3.0, §3.3b, §4 Phase1b DAG, §6 RED#12, §7 1b 行, §8(multi-lens 行)

### P1-a (pending→stall 未到達)
- 対処: processReviewDecision の pending throw は orchestrator.ts:153 outer catch で即 escalate し importReviewProposalToHitch(:1147) の consensusStall に到達しないことを §2.2 で確認。修正: orchestrator review runner が ReviewGateError(pending) を catch→review cycle 記録→evaluateConsensusStallForHitch を直接呼ぶ。recordConsensusReEvaluation(reviewer-agent.ts:735,809)が各 dispatch 後に pending review_consensus 行を書くため dbConsensusSnapshotProvider が timeline を再構築できる、を根拠に明記。stall 未満は継続、到達で決定論 escalate。
- 反映 §: §2.2, §2.5, §3.4 step5, §5(pending fail-closed / 状態遷移行), §6 RED#8/#9, §8

### P1-b (allowOverwrite 1体目も止まる)
- 対処: preflight guard が getLatestActiveProposal(runId)(reviewer なし=グローバル, reviewer-agent.ts:476)を見るため、既存 active が1件でもあると別 reviewer の1体目も止まる(非冪等)、を §2.5 で確認。修正: orchestrator 管理 dispatch では全 reviewer に allowOverwrite:true。dispatch 前に expected reviewer set と既存 active proposal set を照合する preflight を追加。insert 側 supersede は同一 reviewer のみ(:96)なので distinct reviewerName は互いを supersede しない。
- 反映 §: §2.5, §3.4 step3/3.5, §5(expected-status guard 行), §6 RED#7b

### P1-c (profile→rule thread が全入口に届かない)
- 対処: PreparedProjectRun は policy/project/context packs のみ(run-project.ts:32)で reviewRuleResolution が CLI run/rerun・reviewed-run・orchestrator projectRuntime・MCP まで伝播しない、を §2.1/§3.1 で確認。修正: reviewRuleResolution{rule,source,ruleSha256} を PreparedProjectRun→RunDomainCodingOpts→reviewed-run.projectRun→orchestrator ProjectRuntimeDeps→MCP mutation-tools→CLI の全7入口で thread。入口別 integration test(RED#7c)。
- 反映 §: §2.1, §3.1(P1-c 列挙), §4 P1-C, §6 RED#7c

### P1-d (reviewed-run が consensus で必ず pending fail)
- 対処: runReviewedRunWorkflow は runReviewerAgent 1回(:202)→processReviewDecision 1回(:231)で N dispatch しないため quorum>1 profile で必ず pending fail、を §3.4b で確認。修正(Phase1a): reviewed-run は consensus rule の run を ReviewWorkflowUnsupportedError で明示拒否。N-dispatch helper 共有は follow-up(§9)に明記。RED#10b。
- 反映 §: §3.4b, §4 P1-H, §6 RED#10b, §9

### P1-e (refute の target binding が無い)
- 対処: review-decision schema は global decision + text array のみ(review-decision-schema.ts:11)、required changes DB も idx/change_text のみ(schema.ts:184)で refute 票を対象 finding に決定論 bind できない、を §3.5 で確認。修正: Phase2-0 として target id/hash 付き refute input/output DSL + harness 側 binding 決定論検証(未知 target/hash 不一致=fail-closed reject)を Phase2 着手の前提条件に固定。受け入れ条件は第2 consensus requirement 経路の決定論テストで満たす(severity 経由しない)。
- 反映 §: §3.5, §4 P2-0, §5(反証 verify 行), §8

### P2-determinism (summary.proposals/sourceProposalIds も order 依存)
- 対処: baseSummary.proposals=proposals.map(review-consensus.ts:123)が入力順保存、includedRows(review-processor.ts:219)が activeProposalRows(listForRun ORDER BY created_at DESC,proposal_id DESC)由来で挿入順依存、を §2.3 で確認。修正: processConsensusModePath が evaluateConsensus に渡す proposals / includedRows / sourceProposalIds と recordConsensusReEvaluation の sourceProposalIds を reviewer_id,proposal_id 昇順に固定。order independence test を summary まで拡張(RED#5)。
- 反映 §: §2.3, §3.6, §4 P1-G, §5(提示順シャッフル行), §6 RED#5

### P2-dispatch 上限
- 対処: group 内 reviewer 全員 dispatch は cost/latency が登録数比例で無制限、を反映。修正: profile rule に max_reviewers / explicit reviewer_ids を追加。orchestrator は reviewer_ids 明示 or listByGroup∩max_reviewers(字句順上位)を dispatch。preflight で dispatch 数を表示し quorum 未満は事前 escalate(fail-silent 防止)。
- 反映 §: §3.2, §3.4 step2/3, §4 P1-A

### P3 (severity が close gate に効く訂正は正しい)
- 対処: codex が §2.6 の訂正(required_change/negative=P1, non_blocking/out_of_scope=P2 固定; convergence が P1/P2 を別 gate で参照)を正しいと確認。追加対処不要。severity 降格を LLM 自己申告で駆動しない方針(§3.5)の根拠として維持。
- 反映 §: §2.6, §3.5

---

# 付録H: v2 残件（人間批准が要る）

## H1. P0-2 の採用ルート: Phase1b(lens 別 prompt 配線)を Phase1a と同一 PR に入れるか、別 PR にするか。#229 の受け入れ条件文言は "multi-lens" だが、Phase1a 単独では同一 prompt の N reviewer(=multi-reviewer)に留まり "multi-lens" を満たさない。1a だけ land して受け入れ条件文言を "multi-reviewer consensus" に正直化し、"multi-lens" を 1b で満たす運用で良いか。
推奨: 別 PR を推奨。1a(reachable consensus)は prompt 配線を含まず独立にレビュー可能で land リスクが低い。1a の受け入れ条件は "multi-reviewer consensus が quorum>1 実到達" と正直に表現し、#229 を閉じる前に 1b(lens prompt 注入)まで land して "multi-lens" を満たす。1a と 1b を同一 issue #229 のスコープに留め、PR は2本に分ける。誇張(1a 完了時点で multi-lens 達成と書く)は避ける。

## H2. #229 のクローズ条件に反証 verify(Phase 2)を含めるか、別 issue に切り出すか。受け入れ条件は "反証 verify が finding を advisory に降格できる経路のテスト" を含むが、安全な機構は P2-0(target id/hash binding data model + DSL)の追加設計を要し、proven core(Phase1)とは分離して land すべき。
推奨: 別 issue 切り出しを推奨。Phase1(a+b)だけで主要受け入れ条件(quorum>1 実到達・異レンズ集約決定論・回帰なし・spec 更新)を満たし独立にレビュー可能。refute は P2-0 の target binding data model が前提で、Phase1 land 後に follow-up issue として設計する方が安全。ただし #229 のクローズ条件は人間批准事項なので、#229 を Phase1 で閉じ refute を新 issue にするか、#229 を Phase2 まで開き続けるかを明示的に決めてほしい。

## H3. P0-1 fail-closed の挙動確定: review: が存在して意味的に不正(例: requirement.group がどの reviewer group とも一致せず quorum 充足不能、min_approvals > 登録 reviewer 数)な profile で run を作ろうとしたとき、CLI/MCP/orchestrate の各入口で run 生成を typed error(exit 1)で完全拒否する設計で良いか。それとも『不正 review は無効化して DEFAULT に落とすが stderr で強警告』のような緩和を許すか。
推奨: 完全拒否(typed error, exit 1)を推奨。DEFAULT 降格は quorum>1 を単一 reviewer path に静かに落とす fail-open であり安全境界違反。意味的不正(group 不一致/充足不能)は profile のバグなので fail-closed で運用者に直させるのが正しい。ただし『どの程度の意味検証を compileProfileReviewRule に持たせるか(登録 reviewer との突合まで run 生成時にやるか、それは scope を広げる follow-up とするか)』は判断が割れる。推奨は『compile では rule 内部整合(quorum/min_approvals/blocking_decisions の形)のみ検証して throw、登録 reviewer 数との突合は orchestrator preflight(§3.4)に委ね、run 生成時の事前突合は follow-up(§9 project check)』とし、人間に確定してもらう。

> **更新（付録I.3）**: H1/H2/H3 の現状は付録I（特に I.0 = G0 の lens 中核化）で精緻化された。詳細は I.3 を参照。


---

# 付録I: 8論点の深掘り再構成（lens 中核化 + 詰め残し + 新規論点）

> 本付録は、付録F の codex P0/P1 と付録H の残件を踏まえ、(1) Phase 構成の組織原理を
> **lens 中核化**に組み替える意思決定（G0）を冒頭に置き、(2) その前提で G1〜G3（詰め残し）と
> C1〜C4（新規論点）を節立てする。file:line は当初 `origin/main`(6d0a610) で裏取り、その後の round で追加参照した行
> （`recordConsensusReEvaluation` swallow=reviewer-agent.ts:784-831 / `ReviewGateKind`=reviewer-agent-errors.ts:8 /
> `applyReviewDecision`=runs.ts:778 / `verifyArtifactsUnchanged`=reviewer-agent.ts:150-165）は現 HEAD で再取得済み。
> **実装着手時は着手ブランチ HEAD で全 file:line を再取得すること**（行番号は版でずれる）。**安全境界（§5）は不可侵**で、
> 本付録のいずれの推奨も `evaluateConsensus`（ラベル集合濃度 quorum + 固定 tie-break = 凍結契約）と
> 状態遷移ゲートを書き換えない。各論点末尾に in-scope / follow-up を明記する。

## I.0 組織原理 — G0: Phase 構成を lens 中核に組み替える

§3.0 の P0-2 対処は「同一 prompt の N reviewer を multi-lens と誇張しない」点で正しいが、その帰結
として **『Phase 1a = 配管 only（同一 prompt N 体で quorum>1 到達）』を独立 land 完了点**にしていた。
これを本付録の組織原理として改める。

**論証（同一 prompt-only path の格下げ根拠）**: 同一基盤モデル・同一 prompt の N reviewer は
Condorcet 的独立投票者ではなく（M02, [deliberation.md](../deliberation.md):33,83-85）盲点を共有する。
#163 実証（[deliberation.md](../deliberation.md):86-87）= 単一 xhigh が efficacy 欠陥を見逃し
multi-angle のみ検出。現コードでは `reviewerPrompt = PROMPT_PREAMBLE + reviewerOpsSection`
（[reviewer-agent.ts](../../../src/core/reviewer-agent.ts):526）に lens identity が無く、`reviewerName`
（:184）は prompt に届かない（:529-534、`promptSha256` は :527）ので、同一 prompt N 体は全部同じ
盲点で同方向に票を入れ得る。→ quorum>1 という**数値条件**は満たすが、#229 の真のゴール（§1 見落とし
削減）に対する**実価値はほぼ無い**。よって配管 only land を独立完了点としない。

なお同一 prompt-only path の格下げ根拠に用いた研究 `tmp/consultant/ai_gougisei_research_ja.md`
（:105,251,441「同一モデルの疑似多様性＝表現は違うが盲点が同じ」）は、対象 worktree には存在しない
（ops checkout のみ・git 非追跡）。本付録では研究参照として扱い、現コード状態の根拠には混ぜない。

**採用ルート（確定。(a)+(b)+(c) を重ねる）**:

- **(a) headline land 単位 = lens-based consensus**。配管（profile→rule thread / N dispatch /
  pending stall / 決定論集約固定）＋ lens 注入（§3.3b）を **#229 の close 条件に両方含める**。
  配管 only PR を独立完了点と見なさない（物理 2 PR チェーンは可、close は lens land 必須）。
- **(b) 同一 prompt-only consensus path は後方互換・test fixture 専用に格下げ**。`latest-proposal`
  (DEFAULT) は不変の後方互換。consensus mode かつ lens 未宣言の path は production 到達点ではなく、
  `FakeMultiReviewerRunner`（§6 RED#7）で quorum 配管（allowOverwrite/determinism）を検証する fixture
  用と位置づける。
- **(c) profile review schema が lens 宣言を要求**。**`multiReviewerRequired`**（複数 distinct reviewer が実効的に
  必要 = `(min_participants ?? 1) > 1` **または** `(min_approvals ?? 1) > 1`）の requirement で `lens_axes` 宣言が
  無いなら、zod（§3.2）と `compileProfileReviewRule`（§3.1）両層で **`ReviewRuleCompileError` を throw（fail-closed）**。
  production で疑似多様性 consensus が成立不能になる。`min_approvals > 1` も複数 approval＝複数 reviewer を要するので
  含める（approvals と quorum は別判定: review-consensus.ts:234-235）。rate-based quorum（`min_participation_rate`）は
  #229 profile から宣言不可（§3.2、follow-up）なので bypass 経路を作らない。
  MECE: 構文不正=loader / 意味不正(lens 未宣言含む)=compile / review 欠落=DEFAULT。
  **前提**: 現 `ProjectProfileSchema`（[schema.ts](../../../src/project/schema.ts):146-188, `.strict()`）に
  `review:` セクションは無く、`ReviewRuleCompileError` / `compileProfileReviewRule` もコードに不在。
  本 PR で **review schema 自体・compile 層・compile error 型を新設**する作業であり「1 条足すだけ」ではない
  （schema 新設＋compile 層追加＋fail-closed 検証の 3 点が #229 内 in-scope）。

**付録H1 との関係（棄却ではなく精緻化）**: 付録H1 の close 条件（#229 を閉じる前に lens prompt 注入まで
land して multi-lens を満たす / 1a と 1b を同一 issue #229 のスコープに留める / 1a 完了時点で multi-lens
達成と書く誇張は避ける）は**踏襲する**。本 G0 が追加するのは「**1a 配管 only を独立完了点と見なさない**」
という headline land 単位の組み替えであって、close 条件の反転ではない。

**安全境界（不可侵・無改修）**: lens は proposal（入力）を多様化するだけで、`evaluateConsensus` は
凍結契約のまま無改修。run.status 遷移は `processConsensusModePath` の expected-status guard（決定論）が
握る。lens 宣言は profile 側の静的メタで、LLM 自己申告 severity/confidence を票減点・参加除外に使わない。
fail-closed: lens 宣言不正/欠落の consensus rule は run 拒否。

**受け入れ条件・PR 分割への影響（付録H1 精緻化）**:
- §8 受け入れ条件対応表の「異レンズ proposal の集約が決定論」は **lens 配線込み**で 1 条件に統合
  （lens 別 promptSha256 + order 非依存 + 同入力→同出力）。現 RED#12 を headline に昇格、現 RED#7（lens
  無し）は**配管 fixture（rule snapshot 直接注入・profile compile 非経由）**へ格下げ。新 RED: multiReviewerRequired
  requirement で lens 未宣言を compile/schema が reject（(c)）。
- §3.3b 本体の reviewer-agent 行参照は v0.7.10 当時の `:524/:525` 表記。現行（6d0a610）コードでは
  **`:526`(reviewerPrompt) / `:527`(promptSha256)** であり、本付録の file:line は現行で再取得済み（本体側の
  v0.7.10 表記は当時のスナップショットとして残す。実装着手時に本体を現行行へ追従させる）。
- **refute(Phase 2)依存**: refute reviewer の別 prompt は lens 注入機構（reviewer-agent.ts:526 拡張）の
  再利用。lens を #229 の中核 land（headline）に入れることで「refute は lens 後」が自然に整理され、Phase 2 の前提は
  Phase 2-0(target binding)のみに純化する。

**G0 スコープ**:
- **#229 内（in-scope）**: lens 宣言 schema 新設 + `multiReviewerRequired`→lens+reviewer_ids 必須の fail-closed
  （compile/zod 両層）+ 最小 prompt 注入機構（metadata.lens_prompt → reviewerPrompt、既存 reviewerName:184 /
  metadata_json 活用）+ promptSha256/provenance への lens 反映 + **per-reviewer artifact 隔離（N-dispatch 前提・
  Phase 1a）** + land 単位の組み替え。
- **follow-up（[docs/future-features.md](../../future-features.md)）**: lens persona ライブラリ / 推奨
  lens セットのプリセット化、異モデル調達（runner DI 改修）、lens 多様性の定量評価・外部正解較正・全
  proposal 証拠採点(M15)、dashboard/MCP の lens 露出。

---

## I.1 詰め残し（G1〜G3）

### I.1.1 G1 — lens 軸の宣言と決定論 MECE preflight（M01: lens 自由文一本足を塞ぐ）

§3.3b は lens を reviewer 登録 `metadata_json` の自由文 `lens_prompt` で注入するが、(a) lens 軸の語彙が
固定されず、(b) 同一 group の dispatch reviewer 群で lens が重複/欠落しても、(c) multiReviewerRequired group が
同一/空 lens（＝同一 prompt N reviewer への退化, P0-2）でも、**decision-determining gate が一切検査
しない**。lens は集約に不参加の純入力概念（[review-consensus.ts](../../../src/core/review-consensus.ts):180-198
は groupId と distinct reviewerId 濃度のみ参照、lens 次元なし）なので、**lens の品質を gate にするのは
過大（凍結契約／安全境界違反）**だが、**lens が宣言され実体化されたかの構造検査は registry/profile という
決定論データのみで閉じる**。これを G0(c) と一体で Phase 1b に追加する。

**判断**: lens 軸を型として宣言し、orchestrator の §3.4 既存 preflight（C2 連携先）に決定論 MECE 検査を
一段足す。集約（`evaluateConsensus`）には一切触れない。

1. **reviewer 登録の lens 宣言**（[reviewers.ts](../../../src/db/repositories/reviewers.ts):22 の
   `metadata_json` 上、新 table/migration 不要）。`metadata_json.lens` を zod 検証する: 許可 enum
   `correctness | security | regression | efficacy | spec_compliance` ＋任意拡張 axis（非空文字列）。
   **この lens 語彙（5 enum ∪ 非空 custom axis 文字列）は profile requirement の `lens_axes` と同一**（単一の共有
   zod 定義 = enum union 非空 string）。MECE preflight の `lens_axes ⊆ {dispatch reviewer の lens}` は文字列 distinct
   集合の包含で判定する。`lens_prompt` は従来通り自由文。`add()`（[reviewers.ts](../../../src/db/repositories/reviewers.ts):108-109
   の素通し）は lens schema 不正を **reject**（fail-closed）。
2. **profile review requirement の lens_axes 宣言**（§3.2 schema に optional 追加、`.strict()` 配下）。
   ```yaml
   requirements:
     - group: reviewers
       quorum: { min_participants: 2 }
       lens_axes: [correctness, security]   # NEW(M01, optional): この group が要求する軸集合
   ```
   `lens_axes` 欠落＝**`multiReviewerRequired` が偽（min_participants<=1 ∧ min_approvals<=1）/ `latest-proposal` の互換ケースに限り**検査 no-op
   （後方互換。§3.1 P0-1 の「欠落=DEFAULT」と同型 MECE）。**`multiReviewerRequired` requirement での lens 宣言欠落は
   G0(c) の `compileProfileReviewRule` が reject**（fail-closed・疑似多様性を schema/compile 層で禁止）するため、
   multiReviewerRequired でここが no-op になることはない（G0(c) と矛盾しない）。
3. **orchestrator preflight の決定論 MECE 検査**（§3.4 step3 の preflight＝C2 に一段追加）。dispatch 対象
   reviewer 集合に対し決定論的に:
   - **multiReviewer 必須**: **`multiReviewerRequired`**（`min_participants > 1` or `min_approvals > 1`）の
     group は全 dispatch reviewer が**非空 lens** を持つ（持たない＝同一 prompt 退化）。
   - **宣言カバレッジ**: `lens_axes ⊆ {dispatch reviewer の lens}`（不足 axis あり＝escalate）。
   - **重複なし**: dispatch reviewer の lens 多重集合に重複が無い。
   いずれか不充足なら **dispatch 前に決定論 escalate**（reason に `group` / `required_axes` /
   `covered_axes` / `missing` / `duplicates`）。**LLM 出力は一切見ない**（registry/profile のみ入力）
   → 安全境界内。
4. **監査 stamp**: 注入 lens を `prompt_provenance_json`（DB カラムは
   [schema.ts](../../../src/db/schema.ts):1683 で ADD、値は [reviewer-agent.ts](../../../src/core/reviewer-agent.ts):727
   の `insertProposal` の `promptProvenance` で書込、現フィールドは `{ template, knowledge }`。lens は
   **additive に 1 フィールド追加**で既存を破壊しない）と proposal metadata に stamp し、proposal 単位で
   「実際にどの lens 別 prompt だったか」を事後検証可能にする。

**安全境界**: lens は入力多様化のみ。集約（quorum＋固定 tie-break）は不変。lens 検査は集合演算（決定論）で、
不充足は fail-closed escalate。lens を票の重み/除外に効かせる案、lens 品質を LLM judge で検査する案は
**#229 外 / 安全境界違反として棄却**（follow-up）。

**受け入れ条件（§8 の "multi-lens"＝Phase 1b 行に下記 RED を追加）**:
- multiReviewerRequired group で全 reviewer 同一/空 lens → 決定論 escalate（退化検出）。
- 宣言 lens_axes の一部未カバー → escalate（missing axis）。
- lens 重複 → escalate。
- lens_axes 未宣言 ∧ `multiReviewerRequired` が偽（`min_participants <= 1` ∧ `min_approvals <= 1`）（または
  `latest-proposal`）→ 検査 no-op で従来 dispatch（後方互換）。**`multiReviewerRequired` ∧ lens 未宣言は G0(c) で
  compile reject**（同一 prompt 多数決を production path に残さない＝no-op を非 multiReviewer 経路に限定。
  min_approvals>1 のみのケースも取りこぼさない）。
- lens 値が **grammar 外（空文字列 / 非文字列 / 型不正）** → `add()`/schema で reject。**5 enum ＋非空 custom axis は受理**（custom axis は profile の `lens_axes` と突合可能。enum-only ではないので custom 軸が永久未充足にならない）。
- 注入 lens が provenance＋proposal metadata に stamp される。
これらは決定論データ入力のテストで、`evaluateConsensus` の凍結契約テスト（tie-break / quorum / order
非依存）に回帰を与えない（lens は集約に不参加）。

**G1 スコープ**:
- **#229 内（Phase 1b）**: reviewer metadata の lens を zod 宣言・検証（enum 5 軸＋任意 axis、`add()` で
  reject、metadata_json 上で migration 不要）/ profile review requirement に optional lens_axes 追加 /
  orchestrator preflight に決定論 MECE 検査（不充足 fail-closed escalate）/ 注入 lens を
  prompt_provenance_json＋proposal metadata に stamp / RED→GREEN + docs/specs/{project,workflow}.md 更新。
- **follow-up**: lens を ReviewerRow 第一級カラム化＋migration / lens 集約反映（票多様性ボーナス＝凍結契約
  書換、禁止）/ lens 品質の LLM judge / lens×異モデル / run 生成時の事前 lens 充足検証（project check 拡張）/
  dashboard・MCP への lens カバレッジ露出。

### I.1.2 G2 — refute target binding を content-hash に pin（M10/P1-e の二択を確定）

§3.5/§4 P2-0 では各 required_change の安定 target id を『`(runId, normalized_change_text)` の sha256
or `finding` への FK』の **二択・例示**で残していた。本節でこれを **content-hash 一本に確定**し、
design-db-persistence.md §3.1（`review_refute_votes.target_change_hash TEXT NOT NULL`、
`= sha256(normalizeChangeText(change_text))`、FK 一切なし）と一致させる。

**確定: target id = `target_change_hash = sha256(normalizeChangeText(change_text))`（app 層計算）**
- `target_change_idx` は記録時点の idx を **advisory** として持つのみ。**binding には使わない**（idx は
  import で再番号される: `review_required_changes` は RESET_CHILD、import-files.ts:71）。
- **FK は一切張らない**（design-db P1-1）。`openDb` は `foreign_keys=ON`（connection.ts:44）。finding 表
  `hitch_findings`（[schema.ts](../../../src/db/schema.ts):1342 = `CREATE TABLE goal_findings` の定義、v20 で
  `hitch_findings` に rename: :1538/:1546）は親 FK
  `goal_id/hitch_id → goal_sessions/hitch_sessions ON DELETE CASCADE`（[schema.ts](../../../src/db/schema.ts):1344）を
  持ち、かつ import reset の `RESET_CHILD_TABLES`（import-files.ts:67-77）に含まれない（＝finding は run の子
  ではなく session の子）。よって refute が `finding_id` を FK 参照すると、(1) session 親 purge 時に CASCADE
  で audit 行が巻き添え削除され append-only audit が成立しない、(2) export-backed の
  `review_required_changes`（RESET_CHILD: import-files.ts:71）の idx 再番号と組み合わさり binding が orphan
  化する。`run_id`/`finding_id` は **advisory ID**（FK にしない）。

**finding FK 案を棄却する理由**: finding の `sourceRef` は
`review_decision:${runId}:required_change:${index}`（[review-integration.ts](../../../src/hitch/review-integration.ts):293-298、
`canonicalBlocking` 分岐でのみ設定）で **index ベース**。FK にしても安定性は content-hash より弱く、refute の
対象は『required_change という主張』であって、それを P1 化した **下流投影の finding** ではない（finding 化は
review-integration.ts:287-298）。content（change_text）に bind するのが意味的に正しい。

**`normalizeChangeText` の決定論仕様（design-db 付録B の未定義リスクを閉じる）**: binding は app 層計算なので
（SQLite に sha256 無し）、正規化規則が決定論でないと環境差で hash がブレて binding が壊れる。既存ハッシュ
規約（`canonicaliseRule` の whitespace-free JSON: [review-rule.ts](../../../src/core/review-rule.ts):88、
`slugify` の NFKC: [knowledge-promoter.ts](../../../src/core/knowledge-promoter.ts):170-171。なお同 `contentHash`:158 は
JSON+sha256 で normalize しない）に倣い、**純関数・依存なし**で以下に固定する:
1. Unicode 正規化 **NFC**（NFKC ではない: 全角→半角等の意味折りを避け、過剰正規化で別 change を同一視しない）。
2. 改行正規化: `CRLF`/`CR` → `LF`。
3. 各行の trailing whitespace 除去 + 行内の連続空白（tab/space）を単一スペースに畳む。
4. 文書全体の先頭/末尾の空行を trim。
5. **case 折りはしない / 句読点除去もしない**（意味差は別 target として残す。安全境界: 迷ったら fail-closed）。
6. 上記文字列を UTF-8 で `sha256` → hex。
実装は `src/core/` の純関数 + 専用テスト（whitespace/CRLF/NFC 差が同一 hash に畳まれ、語句・大小文字差は別
hash になること、同一入力の安定性、別入力の非衝突）。

**binding 決定論検証（未知 target / hash 不一致 = fail-closed reject）**: refute reviewer 出力
`{ target_change_hash?(or target_change_text), refute_verdict }` を `evaluateConsensus` に入れる前に、
harness が **100% 決定論**で検証する:
1. **候補集合 H の構築**: 対象 run の active proposal が確定した required_changes 集合 C を読み、各
   `change_text` に `normalizeChangeText`→`sha256` を施した有効 hash 集合 `H = { h_i }` を作る。
2. **binding**: refute 出力が `target_change_text` を持つ場合は **harness 側で再計算**する。LLM 申告の
   `target_change_hash` は **権威にしない**（安全境界: LLM 自己申告を状態根拠にしない）。
3. **未知 target**: 計算した `h ∉ H` → その refute 票を **reject（drop）**。binding できない票は集約に一切
   入れない（fail-closed: 元の blocking requirement を維持）。
4. **hash 不一致**: LLM が `target_change_hash` を申告し、harness 再計算値と食い違う → **reject**（harness
   再計算値のみが権威）。
5. **集約投入**: binding 成立かつ `validation_status='passed'` **∧ `refute_verdict ∈ {uphold, refute}`** の票のみ
   （**`inconclusive` は passed でも quorum に数えない＝fail-closed 除外**）を `target_change_hash` で group 化し、§3.5 の『第2 consensus requirement』
   として `evaluateConsensus`（quorum + 固定 tie-break = **凍結契約**）に渡す。降格効果は `evaluateConsensus`
   出力 → expected-status(needs_review) guard → `run.status` の決定論経路でのみ現れる。**severity フィールドの
   mutation は経由しない**。
6. **DB 記録**: **全 refute 票を `validation_status`（`passed` / `rejected`）＋ rejected 時は `reject_reason` 付きで**
   `review_refute_votes` に append。**`passed` のみ `(run_id, target_change_hash, reviewer_id, prompt_sha256)` で
   部分 unique**（集約入力の一意性）。**`rejected` は append-only**（`source_sha256` 違いの複数失敗試行を共存させ、
   完全重複のみ dedup）＝rejected 監査行が後の passed retry も複数 reject 試行も塞がない（design-db §3.1）。reject 票も
   監査に残し fail-closed 判断を追跡可能にする。**participant set / 集約に
   渡すのは `validation_status='passed'` ∧ `refute_verdict ∈ {uphold, refute}` のみ**（inconclusive は除外）。binding
   不一致/未知 target の票は **`target_change_text` の harness 再計算 hash（`sha256(normalizeChangeText(...))`）を
   target_change_hash に用いる**（異なる未知 target が同一 sentinel に collapse して rejected dedup 行が誤って畳まれる
   のを防ぐ）。`target_change_text` 自体が欠落（missing_field）の票のみ定数 sentinel を用い、`reject_reason` で区別する。
   いずれも監査トレースを欠落させない。

本 P2-0 は `review-decision-schema.ts` / `review-rule.ts` のみを触り（`review_refute_votes` の v32 migration 自体は impl-roadmap SP-1 が所有。v31 は #230 が排他済）、
`evaluateConsensus`（[review-consensus.ts](../../../src/core/review-consensus.ts):99, quorum + 固定 tie-break =
凍結契約）も `refute_verdict(uphold/refute/inconclusive)→consensus label` の決定論マッピングも**改変しない**。
マッピングと「第2 requirement への投入経路」は P2-A/P2-C の責務（本論点はその前提となる binding の確定のみ）。

→ #229 受け入れ条件『反証 verify が finding を advisory に降格できる経路のテスト』は、この binding 込みの
**第2 consensus requirement 経路の決定論テスト**で満たす（severity テストではない）。

**G2 スコープ**:
- **#229 Phase 2-0（前提・本論点のスコープ）**: target id content-hash 確定（§3.5/§4 P2-0 を content-hash に
  書き換え design-db §3.1 と一致）/ `normalizeChangeText` 仕様+純関数+単体テスト / `review_refute_votes.target_change_hash`
  + harness 側 binding 決定論検証（未知/不一致=reject）。**binding 確定までが P2-0** で、`evaluateConsensus` /
  `review-processor.ts` には触れない。
- **follow-up**: binding 成立票を第2 consensus requirement に通す経路（**P2-C** = `review-consensus.ts` /
  `review-processor.ts` 変更を伴う Phase 2 実装。本 P2-0 の binding 確定とは別レイヤー）/ reject 票の入力監査記録の
  形式 / refute reviewer agent の異モデル調達（runner DI・異モデルは
  #229 外）/ change_text への per-id schema 逆輸入（content-hash で足り dashboard/MCP 露出時に検討）/
  normalizeChangeText の追加緩和（Markdown 整形吸収等は過剰正規化リスクで要件確定後）。

### I.1.3 G3 — refute output DSL の構造化必須フィールド（儀式化対策）

§3.5 の refute output DSL は `{ target_id, refute_verdict }` だけでは**「批判の儀式化」**
（[deliberation.md](../deliberation.md):147「表面的懸念のみ → 反証条件・最悪ケース・
棄却基準を要求」。元の合議制リサーチは I.0 注記のとおり worktree 非追跡のため、写像先の deliberation.md を引く）を防げない。decision ラベル（refute_verdict）だけでは harness は中身ゼロの反対票と実質
反証を**決定論で区別できない**。

**判断**: 証拠で票を締める規律を **refute DSL に限定して畳む**（全 proposal=M15 は**不可**。M15 は
`evaluateConsensus` のラベル集合濃度 quorum + 固定 tie-break の**凍結集約契約**を書き換える＝#229 過大・
不可侵境界違反。§3.5 棄却方針・付録H H2 と整合）。refute 票は Phase2 で新設する**別 layer**なので、凍結
された通常 reviewer path（[review-decision-schema.ts](../../../src/core/review-decision-schema.ts):11-22,
`.strict()`（decision + 3 text array = レビュー内容 4 項目、メタ含め計 8 フィールド））を一切触らずに refute
専用 schema を追加できる。

元 §3.5/§4 P2-0 は `{target_id, refute_verdict}` のみだったので、G3 でリサーチ正本（反証条件/撤回条件/棄却
基準）に 1:1 写像する 4 フィールド（refute_reason / counter_evidence_ref / refute_condition / retract_condition）を
P2-0 DSL に**新規追加**する。

| field | 必須 | 決定論評価（観測可能なもののみ） |
|---|---|---|
| target_change_hash（or target_change_text、harness 再計算） | 必須 | 既存 required_change への binding 検証（hash 不一致=reject）。G2 / design-db §3.1 と契約名を統一 |
| refute_verdict | 必須 | `uphold` \| `refute` \| `inconclusive`（design-db §3.1 の CHECK と統一）。participant カウントは uphold/refute のみ |
| refute_reason | 必須(refute) | presence + min length のみ（**質は評価しない**＝LLM 自己申告不使用）。uphold/inconclusive は不要 |
| counter_evidence_ref | 必須(refute) | refute DSL の**新フィールド**（既存 close-condition kind ではない。**実証拠 diff/test は降格票 `refute_verdict='refute'` の passed のみ必須**。uphold/inconclusive は `kind='none'`/NULL 可）。`{ kind: diff\|test\|none; ref }`（`diff`=run の final-diff.patch 内 hunk、`test`=run のテスト出力 artifact）。kind!=none は ref が **run 成果物**に実在するかを **refute layer 専用の決定論 verifier（run artifact の file 存在 + hunk/test 出力の照合を直接確認）** で検査する。**close-condition kind の `artifact_exists` は external evidence(ask_human) 経路で決定論 auto-check ではないため使わない**（`command`/`finding_policy` も diff hunk 存在確認には不適）。**`spec_line`（repo/spec source 参照）は run 成果物でなく専用 resolver を要するため #229 では受理 kind から除外**（follow-up） |
| refute_condition | 必須(refute) | presence のみ（[deliberation.md](../deliberation.md):147「反証条件 / 最悪ケース」）。uphold/inconclusive は不要 |
| retract_condition | 必須(refute) | presence のみ（同 deliberation.md:147「反証されたら撤回する条件」）。uphold/inconclusive は不要 |

**欠落/不成立 refute 票の決定論的扱い（fail-closed）**:
1. **refute layer（集約前）**で DSL 構文 + target binding + counter_evidence artifact 実在を検証。disposition は
   **verdict 別**（証拠強制は降格を駆動する `refute` 票にのみ要る＝fail-closed）:
   - `refute_verdict='refute'`（降格票）: 必須フィールド欠落 / binding 不一致 / artifact 不在 / `kind='none'`（実証拠なし）
     → **無効化（rejected・participant 除外）**。証拠なしの降格票は降格を駆動させない。
   - `refute_verdict∈{uphold,inconclusive}`（finding 維持/未判定で降格を駆動しない）: target binding が有効なら
     `kind='none'`/NULL でも **passed として有効**（counter_evidence / refute_condition / retract_condition は不要）。
     binding 不一致 / 未知 target のみ rejected。
   無効票（rejected）は監査のため `review_refute_votes`（design-db §3.1）に
   `validation_status` / `reject_reason` を添えて記録し、**`review_proposals` には入れない**（review_proposals は
   通常 reviewer consensus の active 入力で、`reviewer-agent.ts`:715-738 が insert 後に consensus を再評価するため、
   refute 票を混ぜると通常 consensus を汚染する）。無効票の `refute_verdict` は第2 consensus requirement の
   participant set に渡さない。新 `review_refutes` table で監査ゲート外に quorum を再実装するのは §3.5 が禁止済み。
2. **有効化済み refute 票だけ**を `evaluateConsensus` の第2 requirement に投入。`evaluateConsensus` 本体
   （ラベル集合濃度 quorum + 固定 tie-break）は**不変**。これは既存
   [consensus-enrichment.ts](../../../src/core/consensus-enrichment.ts) の「未登録 reviewer→groupId=null→
   per-group check 落とし」と同型の**安全方向 filter**であり、集約器の中で票を減点する M15 とは機構が異なる。
3. 有効 refute 票が quorum 未満 → 元の blocking requirement のまま（advisory 降格しない）。

**安全境界**: 評価対象は「必須フィールドの presence」「artifact 実在」「target binding hash 一致」のみ＝全て
観測可能=決定論。**refute_reason の説得力 / 証拠の質は harness も LLM-judge も評価しない**（LLM 自己申告
severity/confidence を状態遷移根拠にしない境界のまま）。run.status 遷移は processConsensusModePath の
expected-status guard 経由（不変）。

**受け入れ条件への反映（§8「反証 verify が finding を advisory に降格できる経路のテスト」）**:
(a) 必須フィールド欠落/artifact 不在 refute 票が決定論無効化され降格が起きない（fail-closed）、
(b) 全フィールド充足 + binding 一致 + artifact 実在 + quorum 充足で第2 requirement 経由降格（severity
mutation 不経由・evaluateConsensus 不変を DB アサート）、(c) `kind='none'`（証拠なし明示）の disposition を verdict 別に
検証する RED:
  - (c-1) `refute_verdict='refute'` ∧ `kind='none'` → **rejected（`reject_reason=evidence_none`）**＝証拠なし降格票は
    passed CHECK を満たせず集約入力に入らない（fail-closed・降格を駆動しない）、
  - (c-2) `refute_verdict='uphold'` ∧ `kind='none'` → **passed（有効）**かつ participant に数える（finding 維持票が
    証拠強制で誤って分母から脱落しないことを DB アサート）、
  - (c-3) `refute_verdict='inconclusive'` ∧ `kind='none'` → **passed だが participant カウントから除外**（presence は満たすが
    inconclusive は uphold/refute でないため集計外）、
を含める。

**G3 スコープ**:
- **#229 内（設計のみ）**: 本節（§3.5 / §4 P2-0 の refute DSL 定義の inline 確定）。実コード変更は #229 内
  では不要（refute DSL は未実装、Phase2/付録H H2 は別 issue 切り出し推奨）。
- **follow-up**: refute DSL の実装本体（schema 追加 / binding 検証 / counter_evidence artifact 実在検証の
  automatic verification kind 配線 / refute layer の participant 除外ロジック）= Phase2。**M15（全 proposal
  証拠採点）は凍結集約契約侵害として恒久的に #229 外**（採用しない理由を future-features に記録）。

---

## I.2 新規論点（C1〜C4）

### I.2.1 C1【高】多エージェント tool/MCP 攻撃面の拡大（1→N + lens prompt 注入面）

> 研究 §5.5（MCP とセキュリティ）/ §9（権限過大）反映。本節は「#229 が *新規に* 作る攻撃面」だけを扱う。
> 集約・状態遷移の安全は §5 の不可侵境界マッピングで既に担保される。

**脅威モデル（#229 で増える分だけ・実コード裏取り）**:

| 脅威 | #229 での実態 | 増分か |
|------|--------------|--------|
| prompt injection（lens 経由） | Phase1b が [reviewer-agent.ts](../../../src/core/reviewer-agent.ts):526 の `PROMPT_PREAMBLE + reviewerOpsSection` に lensSection を連結。lens_prompt は新規 untrusted 注入テキスト | **増分（唯一の新規面）** |
| tool poisoning | reviewer 経路の実 runner [codex-cli-runner.ts](../../../src/codex/codex-cli-runner.ts) に mcp_servers 注入は無く、`--ignore-rules`(:87) で target .rules も無視。reviewer は tool を持たず diff を読むだけ | 増えない |
| 権限過大 | reviewer runner は全入口で `sandbox:"read-only"` 固定（cli/run.ts:585-587, cli/hitch.ts:832/1204/1335, mcp/tools/mutation-tools.ts:516, roadmap/course-orchestrate-runtime.ts:103-105） | 増えない（N 倍化のみ） |
| 秘密流出 | env は `DEFAULT_CODEX_ENV_ALLOWLIST`（codex-cli-runner.ts:29-39）で OPENAI_*/AWS_* を strip。codex に機密 env は見えない | 増えない |
| 票の独立性汚染 | reviewer prompt に **他 reviewer の proposal は渡さない**。ただし**逐次 N-dispatch は同一 `runDir` を共有**し、先行 reviewer の `review-decision.yaml` / reviewer log artifact が次 dispatch まで残るため、後続 read-only reviewer が**先行 verdict / log を読めてしまう**（独立性・lens 隔離の穴）。→ **per-reviewer の artifact path / workdir 分離を #229 内で必須化**（sidecar 単純削除 cleanup は gate 誤判定で不可、下記対処 4） | **要対処（増分）** |

（脅威表の「tool poisoning」行注記: reviewer は **MCP/tool 注入も write capability も持たず**、`codex exec` の
read-only artifact-scoped 実行で diff を読む。read 系能力自体は持つが、write / MCP wire は追加しない。）

**核心（方向で非対称）**: lens injection が変えられるのは **その reviewer の decision 票（=入力）まで**で、集約
`evaluateConsensus`（凍結契約）は proposal の説得力も自己申告 severity も見ない。ただし **approve 方向と block
方向で非対称**である:
- **approve 方向（`min_approvals > 1` のときのみ安全）**: `evaluateConsensus` は `approvals >= minApprovals` と
  `quorumMet`（参加者数）を**別々に**判定するため、quorum 充足は複数 approval を含意しない。`min_approvals > 1`
  なら独立した複数 approval が要り **unsafe approve は強制できない**（N 票集約が吸収）。**ただし `min_approvals: 1`
  では他参加者で quorum が満たされた状態で injected `approved` 1 票が decisive になり得る**ため、injection 耐性を
  要する consensus は **`min_approvals > 1`（＋ blocking coverage）を要件にする**。
- **block 方向**: `blocking_decisions`（`changes_requested` / `rejected`）は approval quorum 充足の前に効くため、
  **injection された 1 票が blocking を強制し得る**。ただしこれは **fail-closed 方向**（誤った block → 無駄な
  rerun / 人間 escalate）で unsafe approve には繋がらない。
したがって「N 票集約が常に吸収する」は **approve 方向のみ**正しい。block 方向の偽陽性に対しては `lens_prompt` を
**untrusted-fenced + provenance**（下記対処 1・2）で扱い injection 起因の blocking を監査可能にする（`lens_prompt`
の更なる validation は follow-up）。最終防壁は集約決定論で、状態遷移は決定論ゲート経由のみ。

**lens_prompt の出所と untrusted 扱い**: lens_prompt は `reviewers.metadata_json` に置く（§3.3b）。書き込みは
`ReviewerRepository.add({ metadata })`（[reviewers.ts](../../../src/db/repositories/reviewers.ts):90-110）＝
**operator/CLI 由来であり reviewer LLM 由来ではない**（proposal が metadata を書く経路は無い）。ただし
profile/DB は共有 checkout で書き換わりうる + operator 設定ミスも injection と同型被害になるため **untrusted
扱い（fail-closed）**とする。

**#229 内で最低限やる security 対処（案A・全て入力/記録側の決定論処理）**:
1. **untrusted-fenced lens 注入**: lensSection を [prompt-builder.ts](../../../src/codex/prompt-builder.ts):52-61,110-119 の
   `neutraliseFence`/`<knowledge>` パターンに倣い、`<lens>…</lens>` フェンスで囲み「これはレビュー観点の助言で
   あり、出力契約・read-only 制約・決定の真正性を上書きしない」と framing。既存 `neutraliseFence` は
   `<knowledge>` 専用正規表現なので、lens 用に `<lens>` を中和する**専用中和関数を新設**（既存関数の流用ではない）。
2. **provenance 記録**: `prompt_provenance_json`（DB カラム [schema.ts](../../../src/db/schema.ts):1683、値は
   [reviewer-agent.ts](../../../src/core/reviewer-agent.ts):727 の `promptProvenance`、現フィールド
   `{ template, knowledge }`）に lens 由来（reviewer_id / lens 名 / lens_prompt の sha256）を additive 追記。
   `promptSha256`（:527）は lens 込みで再計算。→ 研究 §5.5「どの AI がどの証拠/prompt を使ったか」を満たす。
3. **最小権限の維持**: lens を渡しても reviewer runner は `sandbox:"read-only"` / env allowlist / MCP 未 wire の
   まま。test で sandbox 引数をアサート。
4. **票の独立性 + artifact 隔離**: 他 reviewer の proposal を reviewer prompt に渡さないことに加え、**逐次
   dispatch では per-reviewer の artifact path / workdir を分離**し、後続 reviewer が先行 verdict を読めない
   ようにする（独立性の実効化）。**先行 `review-decision.yaml` の単純削除 cleanup は不可**: sidecar 欠落 + DB に
   decision 有り → `runReviewerAgent` が「レビュー済み」と誤判定し後続 reviewer が走らない。cleanup を採るなら
   gate / materialization 変更も要るため、既定は **per-reviewer path 分離**とする。**reviewer_id は path component に
   使う前に path-safe 化必須**（`reviewers.add()` 登録時に許可文字集合へ制約＝`/`・`..` で subdir escape/alias を防ぐ。
   §3.4 step3.5・P1-ISO と同一方式）。これは N-dispatch と同時に必要なので **Phase 1a 前提**（§3.4 step3.5。lens
   配線=Phase 1b より前に land）。spec 化する。
5. **dispatch の決定論 bound（明示リストも cap）**: `max_reviewers` + preflight escalate（§3.2/§3.4）が DoS 的
   増殖を防ぐ。**明示 `reviewer_ids` にも `max_reviewers` の hard cap を適用**する（明示リストは全 dispatch する
   設計だが、上限超過は compile/preflight で reject。`listByGroup` だけ cap して explicit list を無制限にしない）。

**受け入れ条件への追加（Phase1b、検証可能項目）**:
- フェンス閉じ記号や PROMPT_PREAMBLE の artifact 列挙行・`<knowledge>`/`<context-pack>` フェンス記号を含む
  lens_prompt でも `PROMPT_PREAMBLE` 出力契約を early-close できない unit test。
- 異 lens_prompt → 異 `promptSha256` かつ `prompt_provenance_json` に lens 由来が残る test（RED#12 を
  provenance まで拡張）。
- lens を渡しても reviewer runner が `sandbox:"read-only"` で起動する test。
- **injection された 1 票では unsafe approve を強制できない**ことを検証する test。**ただし `min_approvals > 1` 前提**
  （approvals と quorum は別判定 review-consensus.ts:234-235 のため、`min_approvals: 1` では他参加者が quorum を
  満たすと injected approve 1 票が decisive になり得る）。**負ケースも明示**: `min_approvals: 1` では単一 approve が
  decisive になり得ることをテストし、injection 耐性は `min_approvals > 1`（= `multiReviewerRequired` の approval 側）
  でのみ保証されると示す。**block 方向の偽陽性は fail-closed に倒れる**（境界 2: approve は N 票集約が吸収、block は
  fail-closed＝unsafe approve に繋がらない）。
- **逐次 dispatch で先行 reviewer の `review-decision.yaml` / log が後続 reviewer から読めない**（per-reviewer path /
  workdir 分離）ことを検証する test（独立性の実効化）。

**C1 スコープ**:
- **#229 内（Phase1b に内包）**: 上記 1〜5（untrusted-fence / provenance / 最小権限 / **per-reviewer artifact path/workdir 分離** /
  **明示 reviewer_ids も max_reviewers cap**）+ spec（docs/specs/workflow.md, project.md）に「lens は proposal を
  多様化する入力に過ぎず集約・遷移には効かない（ただし block 方向は injection で偽陽性になり得る＝fail-closed）／
  lens_prompt は untrusted／他 reviewer proposal は渡さず先行 artifact も隔離する」を明記。
- **follow-up**: lens enum/許可リスト構造化（案B）/ per-reviewer 別 worktree 物理分離（案C）/ reviewer codex への
  MCP/tool 付与時の per-reviewer 最小権限 + 承認ゲート（現状 tool 無しなので #229 では不要）/ M15 全 proposal 証拠
  採点 / 異モデル調達 / dashboard・MCP への lens provenance 露出。

**棄却案（不可侵境界違反）**: proposal 本文の証拠有無/injection 痕跡で票を減点・除外する案は
`evaluateConsensus` 凍結契約の書き換え＝境界違反。LLM 出力本文を遷移根拠にする（境界 2 違反）ため採用しない。
**集約の決定論性そのものが injection 耐性である**、という設計を維持する。

### I.2.2 C2 — 合議プロセス品質メトリクス（論点 PM-1: preflight は quorum 数しか見ない）

§3.4 step3 の preflight は dispatch 数 ≥ `quorum.min_participants` の『頭数』だけを決定論判定する（fail-silent
防止）。だが研究 §8.2「合議プロセス品質」(独立性 / 多様性 / 反証の強さ / 追跡ログ) と
[deliberation.md](../deliberation.md):81-91「疑似多様性の罠」が要求する **lens 多様性が実体として担保されたか**は
観測しない。Phase 1a は同一 prompt の N reviewer（lens 多様性ゼロ）でも quorum>1 を満たし、Phase 1b で lens を
宣言しても宣言と実参加の乖離を誰も観測しない。これを **記録 + warning** で観測可能化する。

> 注: `evaluateConsensus` 既存コメント（[review-consensus.ts](../../../src/core/review-consensus.ts):12-16）が
> §C1/§C2 を override/tie-break の意味で使うため、本論点は記号衝突回避で **PM-1** とする。

**安全境界（最重要・不可侵）**: メトリクスは **集約結果（quorum / tie-break / status 遷移）に一切影響させない**。
`evaluateConsensus` は**凍結契約**で書き換えない。メトリクスはその出力（`participants` 等）と reviewer 登録
metadata を入力に取る**別の決定論純関数 `computeProcessMetrics`** が算出し、記録と warning のみに使う。LLM 自己
申告・proposal 本文の内容判定は入力にしない。

**決定論算出可能なメトリクス（harness 由来データのみ）**:
- `participation`: active proposal を出した distinct `reviewer_id` 数（合議全体値）。根拠は
  [review-consensus.ts](../../../src/core/review-consensus.ts):194-198 の per-group participants の合議横断拡張。
- `declaredLensCardinality`: dispatch 対象 reviewer の `reviewers.metadata_json.lens`
  （[reviewers.ts](../../../src/db/repositories/reviewers.ts):16-25）の distinct 個数。proposal 本文ではなく
  **登録 metadata** 由来。Phase 1a（lens 未配線、現状 src/ に lens 参照ゼロ）では **1**（reviewer 登録 metadata に
  lens なし時の決定論 fallback）。
- `lensCoverage`: 実参加 reviewer の distinct lens 数 / 宣言 lens 数。登録 metadata × 参加 `reviewer_id` 突合のみ。
  **Phase 1b で実値化**。
- `refuteEngagedRatio`: target-bound refute 票が立った required_change 数 / 総数。**Phase 2 のみ**（P2-0 target
  binding の決定論検証済みカウント。verdict 真偽は判定しない）。
- `bypassedByOverride`: `decisionPath==="override"`（[review-consensus.ts](../../../src/core/review-consensus.ts):134-142,
  C1 連携）のとき true。

**算出不能 → スコープ外**: 「初期回答の独立性」を**実体**で測る（回答間の意味的類似度・盲点共有度）には proposal
本文の相互比較が要り LLM 内容判定になる。#229 は `declaredLensCardinality` を独立性の**宣言ベース proxy** とする
に留める。本物の独立性測定・反証の**強さ**（論拠の質）は follow-up。

**記録先**: `ConsensusSummary` に optional `processMetrics` を同梱する。`review_consensus.summary_json` は既に JSON
（[schema.ts](../../../src/db/schema.ts):720-732）なので **新 table / migration は不要**（§7 と整合）。記録経路は
`recordConsensusReEvaluation`（[reviewer-agent.ts](../../../src/core/reviewer-agent.ts):779-822、insertActive は
:812-822）と `processConsensusModePath` の既存 insertActive を流用。`review_decisions` 側には持たせない（合議
プロセスの時系列は `review_consensus` が正本）。

**健全性 gate（fail-closed の倒し方）**:
- profile review rule に lens 多様性下限を**宣言した requirement のみ**、`declaredLensCardinality` /
  `lensCoverage` の下限割れで **決定論 warning**（status は動かさない）。
- 既存 preflight escalate（§3.4 step3）への participation/lens 下限の追加は、**未宣言 requirement への拡大は過剰
  escalate（既存運用を止める）**ため #229 では行わず follow-up。

**G0/G1/C1 連携**: preflight に participation/lens メトリクスを供給可能にしつつ、**算出は `evaluateConsensus` 内に
押し込まない**（凍結契約を侵さない）。C1 override 時は `bypassedByOverride:true` で「合議をバイパスした」を
decisionPath と併せて記録する。

**work item（PM-1 最小コア。Phase 割当は §4 に従う）**:
| id | title | files | phase |
|----|-------|-------|-------|
| PM-1-A | `ConsensusSummary.processMetrics`（optional）型 + `computeProcessMetrics` 決定論純関数（`evaluateConsensus` 不変） | src/core/review-consensus.ts（型のみ追加） | 1a |
| PM-1-B | 記録経路で summary に同梱（participation / declaredLensCardinality=1 を Phase1a で記録） | src/core/reviewer-agent.ts, src/core/review-processor.ts | 1a |
| PM-1-C | lens cardinality / coverage の実値化（reviewer metadata.lens × 参加突合） | src/hitch/orchestrator-runners.ts, src/db/repositories/reviewers.ts | 1b |
| PM-1-D | lens 多様性下限を宣言した requirement の決定論 warning（status 不変） | src/core/review-processor.ts | 1b |
| PM-1-SPEC | docs/specs/{db,workflow}.md に processMetrics 記録を明記 | docs/specs/** | 1a/1b |

**RED（§6 に追加。集約結果不変を必須アサート）**:
- `computeProcessMetrics` 決定論: 同一(proposals, 登録 lens)→同一 metrics / proposal 順入替不変。lens 未配線の
  Phase1a では `declaredLensCardinality=1`（決定論 fallback）として記録し、fallback 自体が決定論（同一入力→同一値）
  であることをアサート。
- Phase 1a: review_consensus.summary_json に `processMetrics.participation` 記録、`declaredLensCardinality=1` を
  DB アサート。**status/required_changes/sourceProposalIds が processMetrics 導入で変わらない回帰アサート**
  （メトリクスが票に効かない証明）。
- Phase 1b: lens prompt 配線後に `declaredLensCardinality>1` / `lensCoverage` 記録 + 下限割れ warning。

**C2 スコープ**:
- **#229 内（optional observability・#229 の close blocker ではない）**: PM-1-A〜PM-1-SPEC（最小コア）。これらは
  集約結果（票 / status）に一切効かない観測層で、acceptance を阻害しない。最小実装が重い場合は丸ごと follow-up 化可。
- **follow-up**: escalate を伴う厳格な多様性 gate の未宣言 requirement 拡大 / `refuteEngagedRatio` の実値
  （Phase 2 / P2-0 前提）/ 本物の独立性測定（埋め込み類似度・盲点共有度）/ 新 table `review_process_metrics` 化 +
  dashboard・MCP 露出 / 異モデル procurement 連動の独立性メトリクス。

### I.2.3 C3 — consensus escalate 要約 projection（ログ過多 / M14 dissent を使える形に）

研究 §9（ログ過多: 要点が埋もれる→判断ログ/差分ログ/要約レイヤー）・§4.4（情報流の設計）対応。
**安全境界: 状態遷移非関与の決定論監査支援**（run.status / finding severity / consensus status を一切書き換えない
読み取り専用 projection）。

**膨張の定量**（N=requirement group の dispatch reviewer 数, C=escalate までの review cycle 数）:
- `review_proposals`: active は distinct reviewer ごとに最大 1 本（`insertProposal` が
  `WHERE run_id=? AND reviewer=? AND superseded_at IS NULL` で同一 reviewer の prior active を supersede。
  [review-proposals.ts](../../../src/db/repositories/review-proposals.ts):92-98、insert は :105-130）→ active は
  最大 N 本。膨張するのは superseded 行を含む history（規模 〜N×C）。
- `review_consensus`: 約 (N+1)×C 行（各 dispatch 後 `recordConsensusReEvaluation` が 1 行 + 確定で 1 行。
  [reviewer-agent.ts](../../../src/core/reviewer-agent.ts):802-821 / review-processor.ts:237-245）。active は常に
  1 本だが `listHistory`（review-consensus.ts:99-111）は全 superseded 行を返す。
- finding: **N× ではない**。consensus 確定は `processReviewDecision` を 1 回だけ呼び `reviewer="consensus"` の単一
  canonical decision を作り、required_changes を `dedupeStrings` で union する（review-processor.ts:217-256）。
  finding は union 1 セット由来で cycle 毎に再評価される（review-integration.ts:276-344）。
- escalate payload: stall escalate は reason 文字列＋数値 metrics のみ（consensus-stall-check.ts:91-104,
  types.ts:365-384）。**決定的票 / 未解決 P0・P1 / dissent が埋もれる** = 本論点の本質。

**判断（A案採用）**: 新 table/migration を足さず（生データは `review_consensus.summary_json`
（[review-consensus.ts](../../../src/core/review-consensus.ts):72-92。proposal id/reviewer/group/decision を持つ）、
finding registry、**および pending 時は active な `review_proposals` 行の `required_changes_json`**（summary_json には
required_change 本文/件数が無く、`review_required_changes` は `(run_id, idx)` keyed で `applyReviewDecision` 後にしか
populate されず、finding registry も import 前は空。よって `unclassifiedPendingCount` は **active proposal 行の
`required_changes_json` から直接**数える）に既に persist 済み）、
**純関数 projection** で要約を抽出し escalate payload に添付する。`materialize`（新 table）と LLM 要約は棄却
（前者は §7『Phase1 は新 table/migration 不要』に反しスコープ過大かつ膨張源を増やす、後者は LLM 出力を人間判断の
正本に混ぜ安全境界違反）。

```ts
// src/hitch/consensus-escalation-summary.ts (新, 読み取り専用 reducer)
export interface ConsensusEscalationSummary {
  decisiveVotes: Array<{ reviewerId: string | null; groupId: string | null; decision: ConsensusStatus | "pending" }>;
  requirementStatus: ConsensusRequirementCheck[];   // 型: review-consensus.ts:54-64 / 構築: 同:208-220
  unresolvedBlocking: { p0Count: number; p1Count: number; findingIds: string[]; unclassifiedPendingCount: number };  // p0/p1 は in-scope 確定値(finding registry, convergence.ts:121-123 由来) / unclassifiedPendingCount は pending stall 時の scope 未判定 required_changes 候補数(下記注記。in-scope に混ぜない)
  dissentingProposals: Array<{ reviewerId: string | null; groupId: string | null; decision: ConsensusStatus }>;
  stallCycles: { unresolvedStreak: number; stallAfterSnapshots: number };
}
// LLM 不使用。reviewer_id, proposal_id 昇順固定（§3.6 P2-determinism と同順）で order 非依存。
```

**`dissentingProposals` の定義（投票数ベース。consensus status は使わない）**: `blocking_decisions` が有効だと
`evaluateConsensus` は in-group の blocking 票が 1 つでもあれば approval 数を見る前に `changes_requested` / `rejected`
を返す（例: approve 2 + blocking 1 → status=changes_requested）。よって **active consensus status を多数派にすると
approver が dissenter にされ、本当の少数 blocker が隠れる**。→ 多数派は **proposal の decision 票の最頻（vote
count）** で決め、それと異なる decision を dissent とする（status ラベルは使わない）。**最頻が同数で割れたとき**
（例: approved 1 / changes_requested 1）は `evaluateConsensus` と同じ固定 tie-break order
（`rejected > changes_requested > approved > pending`）で**一意に**多数派を選ぶ。pending は abstained と扱う。
decisive / 少数は `requirementStatus`（requirement checks）と票数から導く。→ tie-break が完全決定論なので、
dispatch/評価順を入替えても `dissentingProposals` は bit-identical（order 非依存テストを満たす）。

**`unresolvedBlocking` の pending stall 時の算出**: pending consensus stall では `processReviewDecision` が consensus
未確定で、required_changes が hitch findings registry に**未 import**＝**scope 分類（in-scope / out-of-scope /
unknown）も未実行**（§3.4 catch は cycle/stall 記録のみ）。よって (a) findings registry だけから数えると **stall を
起こした proposal の blocker を 0 と誤報**する一方、(b) active proposal 行の `required_changes_json`（pending blocker は
ここに在る。`review_required_changes` は decisive 後 populate なので pending では空/stale）を in-scope P1 と数えると
**out-of-scope/unknown の指摘まで in-scope blocker に誤分類**する。→ stall 時は active proposal の required_changes を
**`unclassifiedPendingCount`（scope 未判定の候補 blocker）** に出し、**in-scope の `p0Count` / `p1Count` には混ぜない**
（in-scope 確定値は finding registry 由来のみ）。確定後に classifier が走れば registry 由来の in-scope 値に解決される。
いずれも決定論で LLM 出力は数えない（required_changes の有無＝観測事実のみ）。`recordConsensusReEvaluation` が書く
pending `review_consensus` 行は consensus decision を持たない（＝findings 未 import と整合）。

**`stallCycles` の注記**: `trailingUnresolvedStreak`（[consensus-stall.ts](../../../src/core/consensus-stall.ts):142-150）は `maxPendingHours` 定義済みの
time-based 経路でのみ使う。既定（未設定）の progress-based stall（同 :100-113）は streak 長でなく
trailing window(`stallAfterSnapshots`) 一致で発火。要約の `unresolvedStreak` は監査参考値で stall trigger とは
別条件。

**配線**:
- `evaluateConsensusStallForHitch` の `escalate()`（consensus-stall-check.ts:75-111）で
  `summarizeConsensusForEscalation` を呼び、`recordConvergenceDecisionWithStatus` の `metrics`（types.ts:413 =
  `Record<string, unknown>`、後方互換）に構造体を、`recommendedNextAction.message` に決定論 1 行サマリを載せる。
- orchestrator review runner の pending-catch（§3.4 step5）から同 projection を通す。
- **fail-closed（projection 失敗が escalate を欠落させない）+ 配線位置の厳密化**: `summarizeConsensusForEscalation`
  は `escalate()`（consensus-stall-check.ts:75-111）内の **`recordConvergenceDecisionWithStatus`(:91) 呼び出し前の
  metrics 拡張ステップでのみ** try/catch する。throw 時は **corrupt-summary sentinel metric を載せて続行**し、
  `recordConvergenceDecisionWithStatus`（＝実際の hitch escalate 記録）は必ず実行する。**`escalate()` が
  『consensus data unreadable』経路（consensus-stall-check.ts:67）から呼ばれた場合は projection を試みない**
  （timeline 再構築不能が確定済みで、同じ破損 summary を再 parse して二重 throw するのを避ける）。
  `recordConvergenceDecisionWithStatus` 自体の throw は従来どおり伝播（fail-closed）。

**M14（dissent 保存）の補完**: dissent は `review_consensus.summary_json.proposals` に保存済みだが「抽出」が
無かった。本 projection の `dissentingProposals` が active status（多数派）と異なる decision の集合を決定論抽出し、
escalate payload で surface する＝『保存→使える形』。

**受け入れ条件追加（#229 内）**: consensus stall escalate 時、payload に `decisiveVotes / requirementStatus /
unresolvedBlocking(in-scope P0/P1) / dissentingProposals / stallCycles` が含まれ、同一 history に対し dispatch/
評価順を入替えても要約が bit 一致する（order 非依存）。close gate（未解決 in-scope P0 ゼロ）には非関与。

**C3 スコープ**:
- **#229 内（optional observability・#229 の close blocker ではない・状態遷移非関与）**: 純関数 `summarizeConsensusForEscalation` 新設 / escalate decision record の metrics +
  recommendedNextAction.message に要約添付 / fail-closed / docs/specs/hitch-convergence.md（or workflow.md）に
  「consensus escalate は決定論要約 projection を payload に載せる／状態遷移非関与」を同コミット追記 / unit +
  integration RED。
- **follow-up**: dashboard / MCP への consensus 要約・差分ビュー露出 / `review_consensus_summary` materialized
  table / cycle 跨ぎ差分ビュー / Phase2 refute 票の要約統合（P2-0 target binding 後）。

### I.2.4 C4 — 部分失敗時の quorum 分母決定論（参加者集合の固定）

**問題**: §3.4 の逐次 N-dispatch 中に 1 体の reviewer が crash / timeout / parse 失敗すると、その proposal が
`review_proposals` に land しない。`evaluateConsensus` の quorum 分母 `participants` は **active proposal を残した
distinct reviewerId 数**から導かれる（[review-consensus.ts](../../../src/core/review-consensus.ts):194-198）ため、
dispatch 開始後に途中で 1 体落ちると landed 集合が運に依存して縮み非決定論に揺れる。最悪は落ちた reviewer 抜きの
少数 approval が `approvals >= minApprovals` を満たし **approved に silent promote**（fail-open / quorum の暗黙
降格）。fail-closed 側に倒れても、再駆動で同じ reviewer が成功/失敗すれば結果が変わり再現性が無い。

**#230 との関係（誤解の是正）**: #230 refute（gate-specs §2 `evaluateRefuteRequirement`）も #229 consensus
（`evaluateConsensus`）も、分母は **landed/active participant 数**（refute 側は `byReviewer.length`、consensus 側は
active proposal の distinct reviewerId 数）であり、**いずれも expected reviewer set の濃度を分母にしていない**。
refute 側は `listByGroupAndExpectedReviewers` で landed 票を expected set で *∩ 絞り込む*（濃度に置換するのでは
ない）。両側の fail-closed 挙動（landed participant が quorum 未満→非昇格/blocking 維持）は既に同一であり、C4 が
解くべきは『分母定義の非対称』ではなく『**dispatch 開始後の途中 crash で landed 集合が運に依存して縮む非決定性**』
である。

**判断（採用）**: expected reviewer set を run に **freeze** し、(i) 集約は frozen set の proposal のみ評価、(ii)
サイクル毎に先行 active proposal を整理、(iii) tamper は継続せず abort、を加える（`evaluateConsensus` の
participants 計算式自体は不変）。

1. **expected 集合の freeze（再現性。#229 Phase 1 は explicit `reviewer_ids` 前提）**: #229 Phase 1 の
   **`multiReviewerRequired`（min_participants>1 or min_approvals>1）の consensus は §3.2 で `reviewer_ids` を必須**にする。これにより frozen set は
   `run_review_rule_snapshots.rule_json`（run 生成時=proposal 前に durable・profile rule と同一なので
   `source_sha256` 一致を壊さない・runId で読める **run-scoped**）だけで**完全決定**＝**新 migration / 新列は不要**。
   `processConsensusModePath` / `recordConsensusReEvaluation`（runId で動く・CLI run/rerun 等の非 hitch 入口を含む）は
   この snapshot から frozen set を読む。`review_consensus` summary は proposal 後にしか書かれないので freeze 用に
   使わない＝全 reviewer が proposal 前に落ちても freeze（rule_json）は残る。再駆動でも freeze 値不変、reviewer
   registry が後から変わっても分母期待値は不変。
   **`listByGroup` 自動解決の consensus は #229 外（follow-up）**: registry 依存の解決リストを run-scoped に durable
   永続する専用列（`run_review_rule_snapshots.resolved_reviewers_json` 等）と v31 migration が要るため、explicit
   `reviewer_ids` 経路を land してから別途設計する（これにより Phase 1 の「新 migration 不要」と整合）。
2. **集約は frozen set の proposal のみ**（freeze だけでは不十分）: `processConsensusModePath` は全 active proposal を
   読む（review-processor.ts:196-207）ため、freeze 後に **frozen reviewer ID 集合外の active proposal**（resumed run /
   手動 / registry 変更由来）が quorum・blocking に効きうる。→ consensus 評価の前に **active proposal を frozen set で
   filter** し、集合外票を除外する（評価対象を frozen set に固定）。**この frozen-set filter（と item 3 の cycle
   filter）は `processConsensusModePath` だけでなく `recordConsensusReEvaluation`（各 dispatch 後に `review_consensus`
   行を書き、pending/stall path が消費）にも適用する**。さもないと集合外/stale 票が persisted consensus timeline・
   stall・escalate 判定に効いてしまう。**実装手順（DRY）**: frozen-set filter を **consensus-enrichment 層に
   『frozen reviewer set を引数で受ける純関数』として共有実装**し、`processConsensusModePath` と
   `recordConsensusReEvaluation` の両 call site が同一 filter を呼ぶ（二重実装しない）。`recordConsensusReEvaluation`
   （reviewer-agent.ts:784-831 は全体が `try{ tx=db.transaction(()=>{ status guard + findSnapshotByRun + enrichActiveProposals(:801) + insertActive …}); tx.immediate() }catch{warn}`）
   の **status guard + snapshot 読込 + frozen-set 解決/filter + insertActive を現状どおり同一 immediate tx 内に保つ**
   （**tx の外に snapshot を読み出さない**: 外読み後〜遅延 insert 前に concurrent な review-auto が run を promote し
   final consensus を書く race を再開させ、stale snapshot が final consensus を supersede する＝この status-guard
   コメントが明示的に避けている race。codex #257）。**ただし外側 try/catch は本体を best-effort で握り潰す
   （reviewer-agent.ts:784,824-830）**ので、frozen-set/cycle filter の失敗を**この swallow に飲ませない**:
   filter throw（rule_json 欠落 / snapshot 破損 / frozen-set parse 失敗）が pending `review_consensus` 行を黙って
   drop すると P1-a の stall timeline が壊れ fail-open になる。→ **frozen-set parse/解決の失敗は tx 内で typed error
   （`consensus_reeval_failed`）を throw**（tx を abort）し、**外側 catch ではこの error class だけ swallow せず再 throw**
   して fail-closed 伝播させる（良性 transient は従来どおり warn-continue）。
   ただし伝播先は P1-a の pending-catch ではない: recordConsensusReEvaluation の throw は呼び出し元 `runReviewerAgent`
   （reviewer-agent.ts:738→:743 rethrow）を貫通し **orchestrator-runners.ts:1120 から伝播 → C4 item4 の per-reviewer
   dispatch try/catch** が受ける（P1-a catch は processReviewDecision:1128 の ReviewGateError 専用の別ステップで、
   :1120 の throw はここに届かない）。frozen-set/snapshot 破損は recognized エラーカテゴリ（例 `consensus_reeval_failed`）
   として **明示分類し fail-closed escalate**（non-participant 継続にしない・暗黙 default 落ちに頼らない）。pending 確定
   経路（真 pending / 進展余地 pending）の評価は別途 processReviewDecision の P1-a catch が担う。
3. **サイクル毎に先行 active proposal を整理**（resumed cycle の stale 票封じ）: 同一 reviewer が前サイクルの active
   proposal を残したまま今サイクルで `runReviewerAgent` が crash すると、insert/supersede が起きず**旧 active 行が
   残って `participants` に計上**され、"失敗 = non-participant" が破れて stale 票で approve しうる。→ 各 dispatch
   サイクル開始時に **frozen reviewer の現 active proposal の `superseded_at` を set して一括 retire する決定論前処理**を
   入れ、「今サイクル=この前処理以降に insert された active」と定義する。**active から外すには `superseded_at` を set 必須**:
   active partial unique・`getLatestActiveProposal` の active 述語は **`superseded_at IS NULL`**（schema.ts:556 /
   review-proposals.ts:96,157）なので、`archived_at`/`lifecycle_status='archived'`(別概念=監査ラベル)を set しても active
   からは外れない（codex #257）。既存列で表現でき **新 cycle 列・migration は不要**。この前処理は冪等で resumed cycle 時に
   二重 retire しない。crash した reviewer は active ゼロで non-participant、成功 reviewer は新 active のみ＝item4 と整合
   （RED-C4f で明示）。
4. **失敗 reviewer = non-participant（fail-closed・ループ継続）。ただし tamper は例外で abort**: dispatch loop は各
   `runReviewerAgent` を try/catch で囲む（spec5 の dispatch ループには現状 per-reviewer 例外境界が無く、throw すると
   [orchestrator.ts](../../../src/hitch/orchestrator.ts):96(try)/:183(catch)/:210-216(escalate flip) まで伝播して
   全捨て即 escalate）。**clean な crash / timeout / parse 失敗のみ non-participant 扱いでループ継続**（ただし clean
失敗も `review-auto-error.json` を共有 runDir に書いてから throw するため、**継続には C1 対処 4 の per-reviewer
artifact / workdir 分離が前提**。分離が無い段階では clean 失敗でも継続せず abort する＝共有 runDir で後続に
error/log を読ませない）。
   **artifact tamper（`verifyArtifactsUnchanged` → `ReviewerAgentGateError`）はループ継続しない**: gate は改変を検知
   するが restore しないため、継続すると後続 reviewer が**汚染 artifact を読む**。tamper / gate error は **当該
   サイクルを abort（artifact restore 後に限り再試行）して escalate** する。**clean 失敗（timeout / nonzero / parse）と
   tamper を決定論的に判別するため、`ReviewerAgentGateError` に kind を付与する**。現状 `ReviewGateKind` は
   `already_decided | run_incomplete` のみ（reviewer-agent-errors.ts:8）で tamper も clean 失敗も kind 無しで混在。
   → **判別ルール（message 一致に依存しない）**: (1) verifyArtifactsUnchanged の throw は全て tamper 専用 kind
   （例 `artifact_tampered`）を持つ → **tamper = abort**。(2) timeout/nonzero/parse の clean 失敗にも明示 kind を付け
   **recognized-clean = non-participant 継続**。**判別は同一例外型内で行う**: tamper も clean 失敗（timeout/nonzero/
   parse）も実コードでは**同一 `ReviewerAgentGateError`** で運ばれる（reviewer-agent.ts に約 20 throw site。
   tamper=verifyArtifactsUnchanged:150/155/163、clean=timeout:599/nonzero:609/parse:636,648 等）。clean 失敗は現状
   `kind` を持たず `sanitizedReason.code`（`reviewer_codex_timed_out` / `reviewer_codex_nonzero_exit` /
   `reviewer_output_unparseable_yaml` 等）で識別される。→ **C4 land 時に全 throw site を tamper / recognized-clean に
   分類**する: tamper 専用 kind を新設し、clean は新 kind 追加でも既存 `sanitizedReason.code` を recognized-clean
   シグナルに使うでもよい（どちらでも fail-closed 不変条件は満たす）。`ReviewGateKind`（現状 already_decided|run_incomplete
   の preflight 用）に tamper/clean メンバを追加する場合は **C4 work item として §4 スコープに昇格**させ「別作業」の
   宙ぶらりんを解消する。kind/code 付与が完了するまでは C4b（継続）を無効化し全失敗 abort のまま（段階導入）。(3) **kind 不明/欠落は fail-closed（abort）**（**tamper kind を持つはずの `ReviewerAgentGateError` で kind 欠落のとき**＝判別不能なら
   安全側）。これが無いと C4b/C4e が安全に実装できない。失敗 reviewer は active proposal を残さない
   ので `participants` に寄与せず、`participants < quorum.minParticipants` で §2.3 の pending throw
   （review-processor.ts:208-213）→ **landed が quorum 未達なら fail-closed**（quorum 充足なら decisive＝C4b）。
   少数 approval での silent promote を構造的に封じる。
5. **escalate reason の区別**: preflight（§3.4 step3）の事前不足 escalate に加え、dispatch 後の participant 不足
   escalate でも reason に `group / expected / landed / failed` を含め、**reviewer crash** / **artifact tamper** /
   **真の quorum 不足** を triage 可能にする。

**§3.4 との非重複**: §3.4 が既規定の N-dispatch / preflight quorum escalate / P1-a catch→stall とは二重に書かない。
C4 固有の差分は **spec5 dispatch ループの per-reviewer try/catch 欠落の補完** + **escalate reason での crash vs 真の
quorum 不足の区別**に限定する。

**M05（順序非依存）との関係**: M05 / P2-determinism（§3.6）は「**成功して active になった proposal 集合**」の内部
順序（required_changes / summary.proposals / sourceProposalIds）を固定する。C4 はその前段、**どの reviewer が成功
集合に入るか（参加者集合の同定）** の決定論を担う。両者は直交・補完: M05(順序)+ C4(集合)= 集約全体の決定論。
`max_reviewers`（§3.2）は expected 集合の上限を一意化し、`reviewer_ids` 明示なら集合は完全決定論、
`listByGroup ∩ max_reviewers` でも字句順 slice で決定論になる。

**安全境界**: `evaluateConsensus` 凍結契約を触らない。LLM の crash/timeout/自己申告は遷移根拠にせず、「期待
reviewer が active proposal を残せたか」という harness 観測事実だけで分母を判定する。部分失敗は **landed
participant が quorum 未達なら** fail-closed pending に倒れ（quorum を満たせば従来どおり decisive＝C4b）、
落ちた reviewer 抜きの少数 approval による silent promote（fail-open）を構造的に封じる（「迷ったら fail-closed」
「状態遷移は harness のみ」に整合）。

**RED 追加（§6）**:
- **C4a（分母固定/fail-closed）**: expected={alice,bob}, `quorum.min_participants=2`、bob を
  `FakeMultiReviewerRunner` で throw させる → alice の proposal は active だが participants=1<2 →
  processReviewDecision が ReviewGateError(pending) → run.status は needs_review のまま（approved に promote
  しない）。escalate reason に expected=2/landed=1/failed=[bob]。
- **C4b（回復性/ループ継続）**: 3 reviewer 中 1 体失敗でも残り 2 体が dispatch・active 化され、2 体で quorum 充足
  なら approved（1 体失敗で全捨て escalate にしない）。
- **C4c（再現性）**: expected 集合 freeze 後に reviewer を add しても、その run の再駆動時の分母期待値は freeze 値
  で不変。
- **C4d（frozen-set filter）**: freeze 後に frozen set 外の同一 group reviewer が active proposal を持っていても、
  consensus 評価は frozen set の票のみを数える（集合外票が quorum / blocking に効かない）。
- **C4e（tamper abort）**: `runReviewerAgent` が artifact tamper の `ReviewerAgentGateError` を投げたら、
  non-participant 継続ではなく当該サイクルを abort/escalate し、後続 reviewer に tampered artifact を読ませない。
- **C4f（resumed cycle の stale 票）**: 前サイクル active proposal を持つ reviewer が今サイクルで crash したとき、
  旧 active 票が `participants` に計上されない（cycle 前処理で `superseded_at` を set し今サイクル landed のみ参加）。
- **C4g（再評価の tx atomicity・codex #257）**: `recordConsensusReEvaluation` の status guard + snapshot 読込 +
  frozen-set filter + insertActive が**同一 immediate tx 内**で行われ、concurrent review-auto promote と insert の間で
  stale snapshot が final consensus を supersede しないこと（tx 外読みの race を作らない）を検証。**frozen-set parse 失敗
  （`consensus_reeval_failed`）は tx を abort し外側 catch で再 throw されて fail-closed**、良性 transient は warn-continue。

**C4 スコープ**:
- **#229 内（Phase 1a）**: dispatch loop の per-reviewer try/catch（**clean 失敗→non-participant / tamper→abort**、
  全捨て escalate にしない）/ expected reviewer set の freeze（分母期待値基準、新 table 不要）/ **consensus 評価を
  frozen set で filter** / **サイクル毎の先行 active proposal 整理（stale 票封じ）** / escalate reason に
  expected/landed/failed + crash/tamper/quorum 区別 / `evaluateConsensus` の participants 式は不触 / RED-C4a〜C4f。
- **follow-up**: 失敗 reviewer の bounded retry（budget/timeout 設計が前提）/ parallel N-dispatch 時の部分失敗集約 /
  run 生成時の事前 reviewer 充足検証（§9 既出の `harness project check`）/ 異モデル procurement 時の failure-domain
  独立性評価 / dashboard・MCP への expected/landed/failed 露出。

---

## I.3 付録H 残件（H1/H2/H3）の更新

付録H の 3 残件は本付録で以下のように更新される。

- **H1**（Phase1b を 1a と同一 PR か別 PR か）: I.0(G0) で**再定義**。H1 の close 条件（#229 を閉じる前に lens prompt 注入まで land して multi-lens を満たす / 1a・1b を同一 issue #229 のスコープに留める / 1a 完了時点で multi-lens 達成と書く誇張は避ける）は**踏襲**したまま、G0 が「1a 配管 only を独立完了点と見なさない」headline land 単位の組み替えを追加する。物理 2 PR チェーンは可（H1 推奨維持）だが、(a) headline land = lens-based consensus、(b) 同一 prompt path は fixture 専用、(c) `multiReviewerRequired`(min_participants>1 or min_approvals>1)→lens+reviewer_ids 必須を fail-closed reject、を重ね「1a だけ land して multi-reviewer に正直化」を独立完了点として扱わない方向に精緻化する（close 条件の反転ではなく重心移動）。I.1.1(G1) と I.2.1(C1) が lens 配線を実体・安全・観測の三面で補完する。
- **H2**（#229 close に Phase 2 = 反証 verify を含めるか別 issue か）: 「別 issue 切り出し推奨／#229 を Phase2 まで開くかは人間批准事項」を**維持**。I.1.2(G2)・I.1.3(G3)・I.2.3(C3 refute 統合)・I.2.2(C2 refuteEngagedRatio) は Phase 2 / P2-0 前提の**設計確定（inline）**であり #229 内の実コード変更を増やさない（G3 は設計のみ in-scope、実装は Phase2 follow-up）。M15（全 proposal 証拠採点）は G3 で恒久的に #229 外（凍結契約侵害）と明記し H2 の安全方針を強化する。
- **H3**（P0-1 fail-closed の意味検証範囲）: G0(c) が H3 に意味不正クラスを 1 つ追加 =「`multiReviewerRequired`(min_participants>1 or min_approvals>1) requirement で lens / reviewer_ids 宣言が無い」を `compileProfileReviewRule` の throw 対象（fail-closed）にする。H3 推奨（compile=rule 内部整合のみ throw / 登録 reviewer 突合は orchestrator preflight / 事前突合は follow-up）と整合: lens 必須は profile 内の静的宣言で完結する内部整合チェックなので compile 層で throw でき、登録 reviewer との lens 突合（G1 の MECE preflight）は preflight 側に置く。H3 の三分割（compile=内部整合 / preflight=登録突合 / 事前突合=follow-up）は本付録でも保たれる。
