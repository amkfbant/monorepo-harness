# 実装設計ノート v3（深掘り版）— issue #230「[案A] 合議制 classification jury / severity audit / 決定パケット / [案F] RACI」

> **ステータス**: 計画のみ（コード未変更）。本ノートは凍結済み v2 設計
> （[`design-230-classification-jury-severity-packet.md`](./design-230-classification-jury-severity-packet.md)）を
> **深掘り（deepen）して supersede** する。frozen v2 / [`design-gate-specs.md`](./design-gate-specs.md) v6 /
> [`design-db-persistence.md`](./design-db-persistence.md) v2 を base に、合議制の「熟議の質」を上げる。
> **base ref**: dev クローン `origin/main`（= v0.7.14, HEAD=36b4772）。schema version 30。
> **最終 home**: dev クローン `docs/design/proposals/`。実装は `feat/230-deliberation-jury`（origin/main 基底）。

---

## 0. なぜ v3 か（深掘りの動機）

合議制調査（`tmp/consultant/ai_gougisei_research_ja.md`）の核心:

> **AI 合議制に効く本質は「AI を増やすこと」ではなく、独立性・多様性・反証・評価軸・証拠・
> 意思決定権限・ログを設計すること。単純な多数決や長い議論は、幻覚・同調・冗長化・評価バイアスを増やす。**

凍結 v2 設計の jury を、この 7 本質で採点すると満たすのは 2 つ（独立性・意思決定権限）だけだった:

| 本質 | 研究の要求 | frozen v2 | 判定 |
|---|---|---|---|
| 独立性 | 第1ラウンドは相互に見せない | 3 lens 独立提案 | ✅ |
| 意思決定権限 | RACI / Accountable=人間1名 | 案F | ✅ |
| 多様性 | 異モデル/検索/人間。同一モデル複数は疑似多様性（盲点共有） | 単一 backend・別プロンプトのみ | ❌ |
| 反証 | 独立回答の後に批判ラウンド（事実誤認/推論飛躍/代替仮説/最悪ケース） | 無し（1ショット提案のみ） | ❌ |
| 評価軸 | 採点基準・棄却条件→意思決定マトリクス | lens は軸だが scope を一発投票するだけ | ⚠️ |
| 証拠 | 出典確認・証拠強度で重み付け。出典なき合意を禁止 | reasoning + confidence のみ（証拠要求なし） | ❌ |
| ログ | 採用/不採用/少数意見/未検証前提/次アクション | §3.3 にはあったが gate-specs §5.4 v6 が削いだ | ❌ |

研究 §4.3:「Debate は『本当の熟議』と『単なる多数決・アンサンブル』を区別して評価する必要がある」。
frozen v2 の `aggregateJuryVotes` は unanimous-only（多数決より安全）だが、割れたら即 escalate するだけで
**反証も証拠検証もしない** ＝ アンサンブル投票であって熟議ではない。

**v3 の方針**: 安全境界（決定論ゲートが唯一の裁定者・fail-closed・LLM に状態遷移を駆動させない）を **1mm も緩めず**、
深掘りを **入力層（proposer）と出力（決定パケット）** に入れる。具体的には独立提案を
「**独立 → 証拠決定論チェック → 相互批判 → 敵対反証**」へ拡張し、出力を consultant 級 MCDA パケットに復権し、
**Stage 1–5 全体を監査用に DB 永続化**する。

---

## 1. ゴールとスコープ（Phase 1・#230 単体で受け入れ条件を全充足）

1. **needs_classification 合議パイプライン**: heuristic がなお `unknown` を返す **harness-origin** finding を、
   3 lens（correctness / scope_fit / spec_adherence）が独立提案 → 決定論証拠チェック → 相互批判 → 敵対反証 →
   **決定論ゲート（単調 fail-closed）** で auto-confirm / escalate。
2. **severity クロスチェック（advisory-only）**: `auditSeverity`（純関数・固定マッピング不変・乖離は packet 記録のみ）。
3. **決定パケット格上げ**: consultant 級 MCDA `HitchDecisionPacket`(v2) を `recommended_next_action` に additive 永続化。
4. **案F RACI**: 状態遷移ごとの RACI（Accountable=人間1名）を `docs/specs/` に明文化。
5. **監査永続化（v3 追加）**: Stage 1–5 の入力（提案/証拠/批判/反証/severity 監査）を v31 テーブルに永続化。

**スコープ外（follow-up）**: 真の多モデル多様性（単一 backend の限界は明記）/ severity 自動降格 /
jury telemetry の budget 計上 / DB-only audit の prune コマンド / dashboard packet 可視化 /
classify_finding の confirmation-required 格上げ。

---

## 2. 合議パイプライン（5 ステージ）

classify runner（`src/hitch/orchestrator-runners.ts` の classify runner、v0.7.14 では `classify: async (hitchId) =>`）
内で、**harness-origin かつ heuristic がなお `unknown`** の finding に対してだけ走る。各 finding 独立。

```
[Stage 1: PROPOSE — 独立提案・DB閉・3 lens]
  各 lens が他者を見ずに独立提案 →
    { proposedScope, proposalStatus, evidence[]{citation,kind,claim},
      refutationCondition, uncertainty, reasoning, confidence?, proposedSeverity? }

[Stage 2: EVIDENCE-CHECK — 決定論・LLM不使用・読取のみ]
  harness が各 citation の実在を機械検証:
    kind=file   → repo(worktree) に path 実在（任意で line 範囲）
    kind=spec   → docs/specs/*.md の heading anchor 実在
    kind=policy → compiled policy の scope/category に実在
  解決しない citation = unverifiable → packet の unvalidatedAssumptions へ
  検証可能証拠ゼロの proposal = inconclusive（fail-closed）

[Stage 3: CRITIQUE — 相互批判・条件起動]
  起動条件: R1 が「割れている」または「unanimous だが検証可能証拠が弱い」
    （clean unanimous + 強証拠 なら skip → 直接 Stage4）
  各 lens が他者の提案+証拠を見て批判（事実誤認/推論飛躍/代替仮説/最悪ケース/評価軸欠落）し再評価。
  voteChanged / critique を記録。
  ★収束しても auto-confirm しない: 批判後にもう一度集約し、
     批判後 split → escalate / 批判後 unanimous → Stage 4 へ

[Stage 4: REFUTE — 敵対的・批判後 unanimous かつ 全証拠検証済 のときだけ起動]
  refuter に「全会一致 verdict + 各 proposer の反証条件 + 検証済み証拠 + （収束した場合は）誰が意見を変えたか」
  を渡し壊しにいかせる。「これは同調による偽合意ではないか」を明示精査。
    → { refuteVerdict: uphold | refute | inconclusive, reasoning, counterEvidence? }

[Stage 5: AGGREGATE — 決定論ゲート・単調 fail-closed・唯一の裁定者]
  auto_confirm ⟺ unanimous(批判後) ∧ lens distinct ∧ 判定不能ゼロ
                 ∧ 全員 検証可能証拠あり ∧ refuteVerdict='uphold'
  それ以外は全て escalate（packet 付き）。
  → repo.classifyFinding は Stage5 で auto_confirm のときだけ（Phase3 再検証後）
```

### コスト像（条件起動の根拠）

jury 対象 finding 1 件あたりの codex 呼び出し:
- **clean unanimous + 強証拠**: 3(propose) + 1(refute) = **4**（批判 skip）
- **割れ / 弱証拠**: 3 + 3(critique) + 0〜1(refute) = **6〜7**

batch 全体が unknown のときのみ走り、heuristic 確定分・operator-origin は通らないので対象は元々絞られている。

---

## 3. 安全不変条件（この設計の背骨・不可侵）

1. **単調 fail-closed**: LLM の発話が `split → auto_confirm` を作る経路は **構造的に存在しない**。
   批判ラウンドの収束も refuter ゲートを必ず通る。refuter が言えるのは `uphold`（ゲート通過を妨げない）か
   `refute`/`inconclusive`（veto）だけ。＝ 熟議は安全を **足す** ことしかできず、**減らせない**。
2. **証拠の歯は決定論**: 幻覚 citation は Stage2 で機械的に弾く。LLM の証拠主張に依存しない。
3. **状態遷移は harness のみ**: `repo.classifyFinding` は Stage5 の auto_confirm のみ。
   status 遷移は `recordConvergenceDecisionWithStatus` が決定論的に行う。提案層が finding の
   scope/severity/status を直接書き換えない。
4. **DB は Stage1 snapshot と Stage3後(Phase3) commit のみ open**。LLM 実行（Stage 1/3/4）中は DB を閉じる
   （既存 reviewer path と同方式）。
5. **提案/判定の物理分離**: LLM 出力（提案/票/監査）は append-only **入力テーブル**。判定は既存決定論ゲート出力
   （finding 分類状態 / convergence decision packet）のみ。DB 構造で安全境界を強制（§6）。
6. **severity 自動変更禁止**: `auditSeverity` は harnessSeverity を不変で返す。乖離は escalate flag + packet 記録のみ。

---

## 4. 決定論ゲート関数（純関数・同入力→同出力）

### 4.1 `aggregateJuryVotes`（frozen gate-specs §1・不変）

scope 投票の純粋 primitive。**シグネチャ不変**:
```ts
function aggregateJuryVotes(proposals: JuryClassificationProposal[]): JuryAggregate;
```
unanimous ⟺ `proposals.length===3 ∧ lens 集合 {correctness,scope_fit,spec_adherence} 完全一致(distinct)
∧ 全票同一 scope(in/out) ∧ 判定不能ゼロ`。それ以外は split。
`isInconclusive(p) := p.proposalStatus!=='complete' || p.proposedScope==='unknown'`。
confidence float gate なし。`reason` は固定順 count 文字列。

### 4.2 `aggregateDeliberation`（v3 新規・深掘りゲート・純）

`aggregateJuryVotes` を内部で呼び、その上に証拠ゲートと refuter ゲートを AND する:
```ts
interface DeliberationInput {
  findingId: string;
  proposals: JuryClassificationProposal[];   // 批判後の最終ラウンド
  refuterVerdict?: RefuterVerdict;            // scope unanimous ∧ 証拠OK のときだけ存在
}
interface DeliberationResult {
  decision: 'auto_confirm' | 'escalate';
  scope?: 'in_scope' | 'out_of_scope';        // auto_confirm 時のみ
  reason: string;                             // 固定順・決定論文字列
  gateTrace: {
    scopeUnanimous: boolean; lensDistinct: boolean; noInconclusive: boolean;
    allHaveVerifiedEvidence: boolean; refuterUpheld: boolean | null;  // null=未起動
  };
}
function aggregateDeliberation(input: DeliberationInput): DeliberationResult;
```
**単調 fail-closed**:
- `aggregateJuryVotes(proposals).decision !== 'unanimous'` → 即 `escalate`（refuterVerdict があっても無視）。
- `allHaveVerifiedEvidence===false` → `escalate`。
- `refuterVerdict===undefined`（未起動）または `refuterVerdict.refuteVerdict!=='uphold'` → `escalate`。
- 全条件成立のときだけ `auto_confirm` + scope。
- refuterVerdict は `auto_confirm` を **作れない**（unanimous でないときに uphold が来ても escalate のまま）。

### 4.3 `auditSeverity`（frozen gate-specs §3・不変）

advisory-only。strict majority が harnessSeverity と一致→aligned / 異→diverged(escalate) /
majority 不成立→inconclusive(escalate)。harnessSeverity は不変返却。

### 4.4 `verifyEvidence`（v3 新規・決定論 IO・読取のみ）

```ts
interface EvidenceCheckContext {
  worktreePath: string;             // file:line 解決元（対象 repo）
  compiledPolicy: CompiledPolicy;   // policy 規則解決元
  specDocsGlobs?: readonly string[];// 既定 ["docs/specs/**/*.md"]
}
function verifyEvidence(ev: JuryEvidence, ctx: EvidenceCheckContext): JuryEvidence; // verified/resolvedRef を埋める
```
- file: `worktreePath/<path>` 実在（line 指定があれば行数範囲内）。
- spec: `specDocsGlobs` 内の md に heading anchor が実在。
- policy: compiled policy の scope glob / category に存在。
- 解決不能 → `verified=false`。SQLite に依存しない TS 実装。同入力→同出力。

---

## 5. データ型とモジュール分割（`src/hitch/jury/` 新設・小ファイル）

### 5.1 主要型（`src/hitch/jury/types.ts` + `src/hitch/types.ts` への additive）

```ts
// 提案（frozen JuryClassificationProposal を additive 拡張）
interface JuryEvidence {
  citation: string; kind: 'file' | 'spec' | 'policy'; claim: string;
  verified?: boolean; resolvedRef?: string;   // Stage2 が埋める
}
interface JuryClassificationProposal {
  findingId: string;
  lens: 'correctness' | 'scope_fit' | 'spec_adherence';
  proposedScope: 'in_scope' | 'out_of_scope' | 'unknown';            // frozen CC5
  proposalStatus: 'complete' | 'timeout' | 'parse_error' | 'inconclusive'; // frozen CC5
  evidence: JuryEvidence[];                    // v3
  refutationCondition?: string;                // v3
  uncertainty?: string;                        // v3
  reasoning?: string;
  confidence?: number;                         // advisory（gate 非駆動）
  proposedSeverity?: HitchFindingSeverity;     // severity audit 同梱（呼出増やさない）
  round: 1 | 2;                                // v3: R1 独立 / R2 批判後
  voteChanged?: boolean;                       // v3: R2 で R1 から変えたか
  critique?: string;                           // v3: R2 でこの lens が他者に出した批判
}
interface RefuterVerdict {
  refuteVerdict: 'uphold' | 'refute' | 'inconclusive';   // #229 review_refute_votes と語彙統一
  reasoning: string; counterEvidence?: JuryEvidence[];
}
// 凍結 §3.5 を additive 拡張
interface JuryProposerDeps {
  reviewerRunner: CodexExecRunner; harnessRoot: string; worktreePath: string;
  logPaths: (findingId: string, lens: JuryLens, stage: 'propose'|'critique'|'refute') => { stdout; stderr; events };
  timeoutMs: number; parseSchema: JuryProposalSchema; auditDir: string;
  evidenceCtx: EvidenceCheckContext;
}
// 凍結 §3.1 構造化戻り型
type ClassifyRunnerResult =
  | { resolved: true; severityAuditPacket?: HitchDecisionPacket }   // 分類確定（severity 乖離なら non-escalating packet）
  | { resolved: false; decision: 'escalate'; escalateReason: string; recommendedNextAction: HitchNextAction };
```

### 5.2 決定パケット（drift 解消 + 深掘り）— `packetVersion: 2`

gate-specs §5.4 v6（test-anchored: findings/evaluationAxes/recommendation/nextActions）を base に、
design-230 §3.3 の rich フィールドと v3 deliberation フィールドを統合:
```ts
interface HitchDecisionPacket {
  packetVersion: 2;
  decisionKind: 'classify_scope' | 'severity_audit' | 'operator_origin_unknown';
  findings: Array<{ findingId; summary; detail?; filePath?; severity?; scopeStatus? }>;
  recommendation: { action: 'classify_manually' | 'review_split' | 'review_severity'; rationale: string };
  evaluationAxes: Array<{ axis: 'correctness'|'scope_fit'|'spec_adherence';
    lensVotes: Array<{ lens; scope?; proposalStatus?; reasoning?; confidence?;
      evidence?: JuryEvidence[]; refutationCondition?; uncertainty?; voteChanged? }>;
    consensus: 'aligned'|'split' }>;
  deliberation: { critiqueRan: boolean; refuter: RefuterVerdict | null;
    gateTrace: DeliberationResult['gateTrace'] };
  rejectedProposals: Array<{ scope; lensCount; reason }>;
  minorityView: { count; scopes; reasoning } | null;
  riskFlags: Array<{ flag; impact; mitigation }>;
  unvalidatedAssumptions: Array<{ assumption; source; verification }>;  // unverifiable 証拠がここ
  nextActions: Array<{ owner: 'operator'; action; verificationMethod }>;
  severityAudit?: { harnessSeverity; juryConsensus?; status: 'aligned'|'diverged'|'inconclusive'; escalate };
}
// HitchNextAction.decisionPacket?: HitchDecisionPacket  ← additive optional（migration 不要）
```

### 5.3 モジュール

| ファイル | 責務 | 種別 |
|---|---|---|
| `jury/types.ts` | 上記型 | 型のみ |
| `jury/aggregation.ts` | `aggregateJuryVotes`(凍結) + `aggregateDeliberation`(深掘り) | **純** |
| `jury/evidence.ts` | `verifyEvidence` | **決定論 IO(読取)** |
| `jury/severity-audit.ts` | `auditSeverity`(凍結) | **純** |
| `jury/decision-packet.ts` | `buildJurySplitPacket`/`buildOperatorOriginPacket`/`buildSeverityAuditPacket` | **純** |
| `jury/proposer.ts` | `generateJuryProposals`(Stage1) | LLM・DB閉 |
| `jury/critique.ts` | `runCritiqueRound`(Stage3, 条件起動) | LLM・DB閉 |
| `jury/refuter.ts` | `runClassificationRefuter`(Stage4, unanimous時のみ) | LLM・DB閉 |
| `jury/deliberate.ts` | Stage1–5 統括（メモリ。DB open/close は classify runner） | 統括 |

純関数・決定論 IO（aggregation/severity-audit/packet/evidence）を LLM モジュール（proposer/critique/refuter）から
**ファイルレベルで分離** ＝ LLM 出力が状態遷移に触れる経路がコード構造上存在しない。

---

## 6. DB 永続化（v31・監査）

凍結 [`design-db-persistence.md`](./design-db-persistence.md) v2 の backbone を継承:
**提案/判定の物理分離・FK 一切なし（advisory ID + doctor orphan 検出）・business-key UNIQUE（prompt_sha256 NOT NULL）・
provenance footprint・DB-only（export 非対象・reset で消えない・backup 自動包含）**。raw codex log は `audit_dir_path` の
ファイルに、DB は判断ログ（verdict + reasoning）のみ。

### 6.1 Stage → 保存先

| Stage | アーティファクト | 保存先 | 種別 |
|---|---|---|---|
| 1 PROPOSE | 3 lens 独立提案 | `jury_classification_proposals`（round=1） | 入力 |
| 2 EVIDENCE | citation + verified | 同 row の `evidence_json` | 入力 |
| 3 CRITIQUE | R2 再評価・批判 | `jury_classification_proposals`（round=2, vote_changed, critique_json） | 入力 |
| 4 REFUTE | 敵対 verdict + 反証証拠 | **`jury_classification_refutations`（新表）** | 入力 |
| severity | severity audit 票・判定 | `jury_severity_audits`（凍結どおり・advisory） | 入力 |
| 5 AGGREGATE | 決定論ゲートの**判定** | auto_confirm→ `hitch_findings.scope_status/reason`／escalate→ `hitch_convergence_decisions.recommended_next_action.decisionPacket`（gateTrace 含む） | 判定 |

Stage5 を入力テーブルに書かないのが安全境界の肝。auto_confirm 時の gateTrace は保存済み入力から決定論的に再計算可能。

### 6.2 v31 テーブル（#230 分）

**① `jury_classification_proposals`（凍結 DDL を additive 拡張）**
```sql
-- 凍結列: proposal_id PK AUTOINCREMENT, finding_id(NOT NULL,権威,FKなし),
--   hitch_id(NOT NULL,denorm advisory), run_id, lens CHECK(correctness/scope_fit/spec_adherence),
--   reviewer_id NOT NULL, proposed_scope CHECK(in_scope/out_of_scope/unknown),
--   proposal_status CHECK(complete/timeout/parse_error/inconclusive) DEFAULT 'complete',
--   confidence CHECK(NULL or 0..1), reasoning, model, prompt_sha256 NOT NULL,
--   prompt_provenance_json, usage_kind, usage_seq, audit_dir_path, created_at NOT NULL
-- v3 追加列:
  round                INTEGER NOT NULL DEFAULT 1 CHECK (round IN (1,2)),
  evidence_json        TEXT,    -- [{citation,kind,claim,verified,resolvedRef}]
  refutation_condition TEXT,
  uncertainty          TEXT,
  vote_changed         INTEGER CHECK (vote_changed IN (0,1)),  -- R2 のみ
  critique_json        TEXT     -- R2 のみ
-- business key に round 追加（R1/R2 衝突回避）:
CREATE UNIQUE INDEX jury_classification_proposals_dedup_idx
  ON jury_classification_proposals(finding_id, lens, reviewer_id, round, prompt_sha256);
CREATE INDEX jury_classification_proposals_finding_idx ON jury_classification_proposals(finding_id, lens);
CREATE INDEX jury_classification_proposals_hitch_idx   ON jury_classification_proposals(hitch_id, finding_id);
```

**② `jury_classification_refutations`（新表・Stage4・backbone 準拠）**
```sql
CREATE TABLE jury_classification_refutations (
  refutation_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id     TEXT NOT NULL,            -- 権威キー・FK しない
  hitch_id       TEXT NOT NULL,            -- denorm advisory（insert/doctor で整合検査）
  run_id         TEXT,
  target_scope   TEXT NOT NULL CHECK (target_scope IN ('in_scope','out_of_scope')),
  refute_verdict TEXT NOT NULL CHECK (refute_verdict IN ('uphold','refute','inconclusive')),
  counter_evidence_json TEXT, reasoning TEXT,
  reviewer_id    TEXT NOT NULL, model TEXT,
  prompt_sha256  TEXT NOT NULL, prompt_provenance_json TEXT,
  usage_kind TEXT, usage_seq INTEGER, audit_dir_path TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX jury_classification_refutations_dedup_idx
  ON jury_classification_refutations(finding_id, target_scope, reviewer_id, prompt_sha256);
CREATE INDEX jury_classification_refutations_finding_idx
  ON jury_classification_refutations(hitch_id, finding_id);
```

**③ `jury_severity_audits`** — 凍結どおり（変更なし・advisory・severity CHECK に `info`・`escalate_flag CHECK(0,1)`）。

### 6.3 migration / consistency / doctor

- **v31 statements**: 上記 3 テーブル CREATE + index。`SCHEMA_VERSION→31`、`MIGRATIONS` に append、
  `V31_TABLE_NAMES` 定数 + `ALL_TABLE_NAMES` union 追加。**FK ゼロ**（PRAGMA foreign_key_list で空を assert）。
- **repository**: `JuryClassificationProposalRepository` / `JuryClassificationRefutationRepository` /
  `JurySeverityAuditRepository`。insert 時 `finding_id→hitch_findings.hitch_id` 一致検査（不一致 reject, fail-closed）。
  business-key dedup。
- **doctor 拡張**: orphan（finding/run/hitch 消滅後も残る行）/ hitch_id 整合（stored vs join）/
  **packet↔proposals 整合**（packet が unanimous だが proposals split）/ **refutation↔proposals 整合**。
  DELETE repair は dry-run default + operator 承認 gate（非破壊）。
- **import/export**: 3 表とも DB-only・reset list 非追加・FK なし → 既存 DB の audit 行は import/reset 後も残る
  （空になるのは fresh DB のみ）。backup フル snapshot 自動包含。

### 6.4 凍結 DB 設計からの逸脱（明示）

| 逸脱 | 理由 |
|---|---|
| **#230 が単独で v31 を取り自分の表だけ作る**（凍結の「#229/#230/#231 共有単一 v31」を変更） | 逐次着地（#230 先行）。#229=次版(review_refute_votes)、#231=次々版(phases.review_state_version)。PR merge 順カップリング解消 |
| **`jury_classification_refutations` 新表** | 深掘りの敵対 refute（凍結に classification 用 refute は無かった） |
| `jury_classification_proposals` を round/evidence/批判/不確実性で拡張・business-key に round 追加 | Stage 2/3 の監査永続化 |

すべて backbone 規約（FK なし・footprint・business-key・提案/判定分離・DB-only）に準拠した additive 拡張。

---

## 7. 既存コードへの統合

### 7.1 classify runner（3 フェーズ DB 分離 + deliberation + 永続化）

- **Phase 1（DB open・同期 snapshot・await なし）**: unknown かつ open finding を batch 取得。
  **operator-origin(human/mcp) は heuristic も jury も通さず即 manual escalate**（snapshot 段で分離）。
  harness-origin に heuristic 適用 → 確定は即書込 → なお unknown を jury 対象として snapshot。DB 閉。
- **Phase 2（DB 閉・LLM）**: `deliberate.ts` が Stage 1→2(決定論証拠検証・worktree/policy 読取)→3→4 をメモリ実行。
  `aggregateDeliberation`（Stage5）も純関数でメモリ計算。
- **Phase 3（DB 再 open）**: 「同 finding がまだ unknown/open か」再検証（jury 中に他経路で分類された finding は skip）→
  **全 deliberation 入力行を永続化**（proposals R1/R2 / refutations / severity_audits）→
  auto_confirm なら `classifyFinding`／escalate なら packet を `recommendedNextAction` に積んで返す。

### 7.2 orchestrator（WI-9b: packet を必ず永続化してから escalate return）

`src/hitch/orchestrator.ts` の classify action（v0.7.14: 117-121）を改修。`!r.resolved` のとき、escalate return の前に
`recordConvergenceDecisionWithStatus({ decision:'escalate', reason:r.escalateReason, metrics,
recommendedNextAction:r.recommendedNextAction(decisionPacket 含む), createdBy })` を呼んで永続化。
`resolved:true` でも `severityAuditPacket` があれば non-escalating で 1 回記録（§3.2 WI-9c 相当）。
`kind`/`message`/`findingIds` は常時 populate（後方互換）。

### 7.3 convergence（任意・additive）

P0/budget/divergence 等の直接 escalate 経路にも decisionPacket を additive 付与可能に（既存挙動不変）。

---

## 8. 案F — RACI（`docs/specs/hitch-convergence.md`）

`## Convergence Decisions` 配下に `### RACI: Decision Transitions` を新設。Accountable=1 行につき人間 1 ロール。
非 jury 経路（P0/budget/divergence）も網羅。jury 経路は Stage 別に:

| 状態遷移 | R | A | C | I |
|---|---|---|---|---|
| operator-origin unknown を機械分類しない | classify runner(source filter) | **operator** | — | audit trail |
| Stage1 独立提案生成（DB閉） | jury proposers(LLM 入力層) | harness classify runner | reviewer context | audit(proposals/audit_dir) |
| Stage2 証拠実在検証 | verifyEvidence(決定論) | harness classify runner | worktree/policy/specs | audit(evidence_json) |
| Stage3 相互批判・再評価 | jury proposers(LLM 入力層) | harness classify runner | 他 lens 提案 | audit(round=2 rows) |
| Stage4 敵対反証 | refuter(LLM 入力層) | harness classify runner | 反証条件/検証済証拠 | audit(refutations) |
| Stage5 auto_confirm → scope 確定 | aggregateDeliberation(純関数) | harness classify runner(txn) | session policy snapshot | audit trail |
| Stage5 escalate（packet 永続化） | aggregateDeliberation + orchestrator(record) | **operator** | harness convergence | dashboard, escalation log |
| severity 乖離(advisory) → packet 記録 | auditSeverity(決定論) | **operator** | harness mapping(authoritative) | escalate packet |
| operator が auto/分類を override | operator(CLI/MCP **guarded mutation** classify_finding) | **operator** | jury reasoning(packet) | audit(created_by/actorNote) |
| P0 open → escalate（非 jury） | convergence | harness convergence | — | operator |
| budget_exhausted → stop（非 jury） | convergence | harness convergence | — | operator |
| diverging → escalate（非 jury, harness-origin のみ） | divergenceReason | harness convergence | divergence policy | operator |

override は `harness.hitch.classify_finding`（`kind:"mutation"`, dangerous/confirmation-required list 外）＝
**guarded mutation**（guarded-mutation mode + 権限スナップショット + audit）。shell bypass しない。

---

## 9. Work Item DAG（深掘り版・各 WI RED 先行 TDD）

```
Layer 0 — DB 基盤(v31)
  A1 migration: 3表+index, SCHEMA_VERSION→31, V31_TABLE_NAMES, ALL_TABLE_NAMES, FK ゼロ
  A2 repositories: proposal/refutation/severity-audit（finding_id→hitch_id 整合検査・business-key dedup）
  A3 doctor 拡張 + import/export DB-only 検証
Layer 1 — 純粋決定論コア
  B1 型: jury/types.ts + additive(HitchNextAction.decisionPacket?, ClassifyRunnerResult)
  B2 aggregateJuryVotes（凍結・純）
  B3 aggregateDeliberation（深掘りゲート・純・★単調 fail-closed 中核）  [dep: B2]
  B4 auditSeverity（凍結・純）
  B5 verifyEvidence（決定論 IO）
  B6 decision-packet formatters（純・v2 MCDA）
Layer 2 — LLM 提案/批判/反証（DB閉）
  C1 generateJuryProposals(Stage1)        [dep: B1,B5]
  C2 runCritiqueRound(Stage3, 条件起動)    [dep: B1]
  C3 runClassificationRefuter(Stage4)      [dep: B1]
  C4 deliberate.ts パイプライン            [dep: B2-B6,C1-C3]
Layer 3 — 統合
  D1 classify runner 3フェーズ + source filter + deliberate + Phase3 永続化  [dep: A2,B5,C4]
  D2 ClassifyRunnerResult + orchestrator WI-9b（escalate 前に packet 記録）   [dep: D1,B6]
  D3 convergence 直接 escalate に additive packet（任意）                     [dep: B6]
  D4 integration e2e（hitch-orchestrate: 分類→deliberation→confirm/escalate + DB 永続化 assert）  [dep: 全]
  D5 回帰スイート                                                            [dep: D1,D2]
Layer 4 — docs（同コミット）
  E1 hitch-convergence.md（5-stage + RACI + packet v2 + severity precedence + 単調 fail-closed 不変条件）
  E2 workflow.md / db.md（v31・deliberation 永続化・DB-only/no-FK）/ mcp.md・cli.md（guarded mutation）/ GOAL_RULES(footprint)
```

---

## 10. TDD テスト計画（要点）

**★深掘りで新規に守る不変条件**:
- `aggregateDeliberation` 単調 fail-closed: ① split は refuter が何を言っても auto_confirm にならない
  ② refuter=refute/inconclusive は unanimous を veto ③ `unanimous ∧ distinct ∧ 判定不能ゼロ ∧ 全員検証可能証拠 ∧
  uphold` のみ auto_confirm ④ 同入力→同出力。
- `verifyEvidence`: 実在 file:line→verified / 不在→unverifiable / 検証可能証拠ゼロ proposal→inconclusive。
- `runCritiqueRound`: R1→R2 で vote 変更可 / 批判後 split→escalate / **批判後 unanimous でも直接 confirm せず refuter へ**。
- `runClassificationRefuter`: 批判後 unanimous ∧ 全証拠検証済 のときだけ起動。fail-closed(timeout/parse/exit≠0→inconclusive)。
- DB 永続化: R1/R2 行・refutation 行・severity audit 行・packet(convergence decision) が全て残り round-trip。
  doctor が orphan/整合を検出。FK ゼロ。import/reset で残る（fresh のみ空）。
- 良性 finding 救済: heuristic unknown → 3 lens unanimous + 証拠 + refuter uphold → 自動分類（誤 escalate 削減）。

**凍結から継続**: jury 不一致→必ず escalate / severity 決定論・自動降格なし / packet 統合フォーマット&永続化 /
operator-origin は機械分類しない / P0/budget/divergence は jury 不通過 / 固定 severity・close gate 不変 / 既存スイート緑。

**テスト配置**: `tests/unit/hitch/jury/*.test.ts`（純関数・proposer/critique/refuter）、
`tests/unit/hitch/orchestrator-runners.test.ts`（jury flow 統合）、`tests/unit/db/`（migration/repository/doctor）、
`tests/integration/hitch-orchestrate.test.ts`（e2e）。production は `deps.reviewerRunner`、テストは `createFakeCodexRunner()`。
`fixture-matrix.test.ts` は convergence-only 回帰に限定。

---

## 11. 受け入れ条件（#230・Phase1 単体充足）

1. jury 不一致時は必ず人間 escalate（自動確定しない）— ＋ 反証で偽合意も escalate。
2. severity 集約が決定論的（同入力→同出力）。
3. escalate payload が統合フォーマット（MCDA）を満たす **かつ DB 永続化される**。
4. 既存 divergence / fail-closed / severity 挙動に回帰なし。
5. `docs/specs/*` を同コミット更新（RACI 含む）。
6. **（v3）Stage 1–5 入力が v31 テーブルに永続化され doctor が監査できる**（migration additive・後方互換・FK ゼロ）。
7. サブ Phase = 関連テスト + typecheck 緑、大 Phase = フルスイート + typecheck 緑（回帰禁止・テストを弱めない）。

---

## 12. スコープ注記・限界・follow-up

- **規模**: 凍結 Phase1 の約 1.5〜2 倍（DB v31 前倒し + 4 モジュール + 1 新表 + 深掘りゲート）。
- **真の多モデル多様性は未達**（単一 backend・別プロンプト）。research §5.1/§9 の疑似多様性限界を spec に明記し、
  案C（共有熟議エンジン）/ 将来 epic に defer。深掘りは敵対 refuter で立場の多様性を一部補う。
- **follow-up**: severity 自動降格（close gate を動かす）/ jury telemetry の budget 計上 / DB-only audit prune コマンド /
  dashboard packet 可視化 / classify_finding の confirmation-required 格上げ / 正規化 evidence テーブル。

---

## 13. 駆動方式（実装実行フェーズ）

dev クローン `feat/230-deliberation-jury`（origin/main 基底）で TDD ＋ codex exec gpt-5.5 xhigh 実装 ＋
多角レビュー（codex xhigh ＋ Opus サブエージェント複数）。PR は dev→main。ops DB に hitch レコードを立てて
履歴を残すハイブリッドも可。CLAUDE.md 鉄則（ops ハーネスが driver / dev クローンが target）を遵守。

---

## 14. 人間批准が要る点 / open questions

- **Q1（条件起動の批判）**: clean unanimous + 強証拠で批判 skip を既定とする（コスト有界化）。常時起動にするか。→ 既定: 条件起動。
- **Q2（refuter 起動範囲）**: refuter は批判後 unanimous 時のみ。split に refuter を回さない（fail-closed・コスト）。→ 既定: unanimous 時のみ。
- **Q3（証拠の正規化）**: evidence は JSON 列（集約不要・監査詳細）。正規化テーブルは follow-up。
- **Q4（migration 版）**: #230 が v31 単独取得。#229/#231 は逐次次版（凍結の単一 v31 共有から変更）。
- **Q5（worktree 共有）**: jury proposer は read-only。run の既存 worktree を共有し、Phase3 再検証で stale を弾く（frozen §H1 踏襲）。
