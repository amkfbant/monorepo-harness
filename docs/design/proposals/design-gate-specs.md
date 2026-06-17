# 実装仕様: 決定論ゲート関数群 v6（epic #228・codex 5巡で収束）

> 収束: C1→codex(2/3/5 NG)→C2/C4 v2/v3(個別・並行ドリフト)→C6 v4(CC15凍結→P0全消)→C8 v5(CC16)→codex(局所P1)→**C10 v6(CC17で残P1解消)**。spec1/4 は GO系。
> 安全境界: 集約・状態遷移は決定論ゲートのみ。LLM 出力は入力/監査。fail-closed。
>
> **⚠️ 版番号同期（2026-06-17）**: #230(案A) が **schema v31 を排他取得して先行リリース**（0.7.15）。`review_refute_votes`(#229) は
> v31 に載らず **新 migration `v32`** で作成する（出荷済み v31 statements は不可侵）。本書中の `review_refute_votes` の
> 「v31」表記（C10 残件・§8 DDL 等）は **v32** に読み替え。`jury_classification_proposals` 等 #230 表の v31 表記は出荷済で正。
> 決定根拠: design-230-deliberation-deepened.md R12（:124/511/661）。

## C10 changeLog
- CC17 contract complete integration: spec2 adds reviewRuleResolution to PreparedProjectRun (required) and implements compileProfileReviewRule with ProjectProfileSchema review section; spec3 defines per-target refute loop (CC17②) with targetHash filter (cross-target mix prevention), dedupeLatestPerReviewer with refuteId tie-break (CC16⑤), and evaluateConsensus as pure function with refuteInputs; spec5 adds runRefuteAgent (CC17②③), N-dispatch review runner with refute dispatch loop (CC17③), reviewed-run consensus rejection (CC17④), and ReviewRefuteVoteRepository; minRefuteFraction schema is (0,1] excluding 0 (CC16④); quorum.minParticipants defaults to 2 (fail-closed); reviewRuleResolution threading unified across CLI/MCP/hitch/orchestrator (CC17①); all changes maintain backward compatibility with DEFAULT_REVIEW_RULE when profile.review is absent; pure function boundary for evaluateConsensus maintained with reviewer set resolution in processConsensusModePath (CC17①)

## C10 残件
- Database migration (**v32** — v31 was taken exclusively by #230; review_refute_votes ships in a new v32 migration, NOT by editing the shipped v31) for review_refute_votes table creation and ReviewRefuteVoteRepository implementation requires DB layer completion; reviewer-agent.ts refute prompt builder requires Codex interaction specification; ReviewerRepository.listByGroup implementation in reviewers.ts (new method) required; RunRepository.applyReviewDecision threading of consensusId/proposalsSummaryJson when refuteDropped present (spec3 output); reviewed-run workflow reviewed-run-workflow.ts integration point for assertReviewedRunRuleCompatible call needs specification; targetChangeHash and normalizeChangeText utility function placement (consensus.ts or review-rule.ts) to clarify; processConsensusModePath transaction handling when RefuteVoteRepository query fails (boundary condition); reviewed-run against consensus + no-refute rules (forward spec design for future phases); Decision packet buildJurySplitPacket implementation signature details beyond camelCase fields; CLI run.ts and MCP mutation-tools.ts specific threading points for resolveEffectiveRule with profile parameter

---

# 1. v3改訂 spec#1「aggregateJuryVotes」Cycle3レビュー対応(CC13反映)

## v3改訂(codex Cycle3反映+CC13)

> Cycle 3: codex spec1判定 **GO-with-fixes** のCC13指摘(lens集合distinct必須) + 横断決定CC1〜CC14を本文・シグネチャ・テストに反映。差分要旨:
> - **(CC13)unanimous条件にlens distinct必須**: 「3票同一scope」だけでなく、提案の lens集合が {correctness, scope_fit, spec_adherence}と完全一致(=各lens1件ずつ)であることを必須にする。同一lens重複(correctness 2件+scope_fit 1件など)は split(fail-closed)。
> - **(v2継承)unanimous条件の矛盾解消**: 「2票一致でも unanimous か」の二義性を排除。unanimous は **`proposals.length === 3` かつ 全3票同一scope かつ lens集合が期待3値と完全一致 かつ 判定不能ゼロ** の全会一致だけに固定。2票以下・4票以上・lens重複・判定不能混在は**全て split**(fail-closed)。
> - **(v2継承) `SeverityAuditContext` を exported type一覧に明示**。実装者が型を補わない。
> - **(v2継承)CC5**: DB v31と一致させ、row レベルでは `proposed_scope ∈ {in_scope,out_of_scope,unknown}` + 別列 `proposal_status ∈ {complete,timeout,parse_error,inconclusive}` で表す。「判定不能」= `proposal_status !== 'complete'` **または** `proposed_scope === 'unknown'`。
> - **(v2継承)reason は固定順count出力**で決定論にする。順序は常に `in_scope → out_of_scope → unknown → incomplete` 固定。

安全境界は一切緩めない(集約のみが状態遷移を駆動 / LLM出力は入力 / confidence float gate禁止 / severity自動変更禁止 / fail-closed)。

## 1.「判定不能(inconclusive)」の表現(CC5 — v2で明確化)

DB v31 `jury_classification_proposals` と一致させる。proposal rowはscopeとstatusを**分けて**持つ:
- `proposed_scope ∈ {'in_scope','out_of_scope','unknown'}`(scope enum と同じ3値)
- `proposal_status ∈ {'complete','timeout','parse_error','inconclusive'}`(`DEFAULT 'complete'`)

集約上の **「判定不能」判定述語**(deterministic):
```
isInconclusive(p) := (p.proposal_status !== 'complete') || (p.proposed_scope === 'unknown')
```

## 2. aggregateJuryVotes関数仕様(v3 — CC13反映)

### 2.1 型シグネチャ

```ts
/**
 * 決定論集約: 3体jury(correctness/scope_fit/spec_adherence)の分類提案から
 * 全会一致(3票・同一scope・lens distinct必須・判定不能ゼロ)のときだけ自動確定。
 * 
 * unanimous充足条件(CC13):
 * - proposals.length === 3 (票数が正確に3)
 * - 全3票のproposedScopeが同じ値(in_scope or out_of_scope)
 * - lens集合が {correctness, scope_fit, spec_adherence}と完全一致(各lens1件ずつ)
 * - いずれもisInconclusive === false (status=complete AND scope≠'unknown')
 * 
 * 上記すべてが成立のみ unanimous。以外は全て split(fail-closed)。
 * 
 * @safety 純関数・状態遷移なし。confidence float gate禁止。
 */
export function aggregateJuryVotes(
  proposals: JuryClassificationProposal[],
): JuryAggregate;

export interface JuryClassificationProposal {
  findingId: string;
  lens: 'correctness' | 'scope_fit' | 'spec_adherence';
  proposedScope: 'in_scope' | 'out_of_scope' | 'unknown'; // CC5
  proposalStatus: 'complete' | 'timeout' | 'parse_error' | 'inconclusive'; // CC5
  confidence?: number;  // advisory only(gate駆動に使わない)
  reasoning?: string;
}

export interface JuryAggregate {
  decision: 'unanimous' | 'split';
  scope?: 'in_scope' | 'out_of_scope'; // unanimous時のみ値あり
  reason: string; // 固定順count文字列(§2.4)
}
```

### 2.2 ロジック仕様(v3 — CC13 lens distinct必須)

**unanimous充足条件(唯一 — CC13新規)**:
```
proposals.length === 3
  AND 提案の lens集合 {correctness, scope_fit, spec_adherence}と完全一致
       (= new Set(proposals.map(p=>p.lens)).size === 3
         AND Set内容が期待値と同じ)
  AND proposals全てが isInconclusive(p) === false
  AND 3票のproposedScopeが全て同一(in_scope または out_of_scope)
```
上記が成立したときのみ `decision:'unanimous'`、`scope`にその共通値。

**split判定(fail-closed) — 上記以外すべて**:
- `proposals.length !== 3` → split
- lens集合が期待値と完全一致しない(同一lens重複 / lens欠落 / 4lens以上) → split
- いずれかが `isInconclusive` → split
- 2種以上の異なる確定scope → split

> v3での新規指摘(CC13): 同一lens 2件+別lens 1件の場合、3票一致でも**分類不能**として split(異なる視点が揃っていないため verdict が単一決定論ではない)。

### 2.3 エッジケース(全テスト対象)

| ケース | 入力(scope/status/lens) | decision | scope | 注 |
|---|---|---|---|---|
| 全3票一致(correctness/scope_fit/spec_adherence + in_scope) | in/c/correctness, in/c/scope_fit, in/c/spec_adherence | unanimous | in_scope | 基本系(lens distinct満たす) |
| 全3票一致(out_of_scope) | out/c/{c,s,spec}, out/c/{c,s,spec}, out/c/{c,s,spec} | unanimous | out_of_scope | 基本系 |
| lens重複(同一lens2件) | in/c/correctness, in/c/correctness, in/c/spec_adherence | split | — | lens distinct失敗→fail-closed |
| lens欠落(1lens) | in/c/correctness, in/c/scope_fit (spec_adherence無し) | split | — | length=2 かつ lens distinct失敗 |
| 2票vs1票(scope分裂) | in/c/{c,s,spec}, in/c, out/c | split | — | scope分裂 |
| 1票のみ | length=1 | split | — | length≠3 |
| 4票以上 | length=4 | split | — | length≠3 |
| 空配列 | [] | split | — | no votes |
| confidence差異 | in/c/c(0.9), in/c/s(0.1), in/c/spec(0.8) | unanimous | in_scope | confidence gate非駆動 |
| status不一致(1件timeout) | in/c/c, in/c/s, in/timeout/spec | split | — | isInconclusive混在 |
| scope不一致(unknown混在) | in/c/c, in/c/s, unknown/c/spec | split | — | scope不一致かつisInconclusive |

(c=correctness, s=scope_fit, spec=spec_adherence。status全て complete でない場合は記載)

### 2.4 reason文字列(v2 — 固定順count で決定論)

順序を**固定**(`in_scope → out_of_scope → unknown → incomplete`)で count出力する。
- unanimous: `"unanimous in_scope (3/3 lenses agreed)"`(scope は確定値)
- split: `"split votes: in_scope(N1), out_of_scope(N2), unknown(N3), incomplete(N4)"`
  - N1=scope==='in_scope' かつ complete の件数 / N2=out_of_scope かつ complete / N3=scope==='unknown' / N4=status≠complete
  - 例: in×2(complete,distinct lens) + timeout×1 → `"split votes: in_scope(2), out_of_scope(0), unknown(0), incomplete(1)"`

固定順・固定fmt なのでテストで完全一致assert可能(determinism)。

## 3. auditSeverity関数仕様(v2 — SeverityAuditContext を明示export)

### 3.1 型シグネチャ

```ts
/**
 * advisory-only severity audit集約。固定mappingは絶対不変、乖離はescalate packetに記録のみ。
 * @safety 純関数・severity自動変更なし・決定論。
 */
export function auditSeverity(
  context: SeverityAuditContext,
): SeverityAuditResult;

export interface SeverityAuditContext {
  harnessSeverity: HitchFindingSeverity; // immutable(固定mapping由来)
  juryVotes: {
    lens: string;
    juryProposedSeverity: HitchFindingSeverity;
    reasoning?: string;
  }[];
  finding: { findingId: string; summary: string };
}

export interface SeverityAuditResult {
  harnessSeverity: HitchFindingSeverity; // 不変(元値そのまま返却)
  juryConsensus?: HitchFindingSeverity;  // majority一致時のみ。無ければ undefined
  status: 'aligned' | 'diverged' | 'inconclusive';
  escalate: boolean; // diverged || inconclusive → true
  reasoning: string; // 固定fmt
}
```

### 3.2 ロジック仕様

- **aligned**: jury票の strict majority が `harnessSeverity` と**同一** → `status:'aligned'`, `juryConsensus=harnessSeverity`, `escalate:false`
- **diverged**: jury票の strict majority が `harnessSeverity` と**異なる** → `status:'diverged'`, `juryConsensus=majority`, `escalate:true`(**severity は不変**。packet に記録して人間escalate)
- **inconclusive**: majority が成立しない(全異 / tie / 票0) → `status:'inconclusive'`, `juryConsensus=undefined`, `escalate:true`
- **majority定義**: ある severity の票数が **過半(> 総票数/2)** のときのみ majority。同数(tie)は majority不成立=inconclusive(fail-closed)。
- confidence/reasoning は記録のみ・gate非駆動。

## 4. 既存接続点

### 4.1 型定義(src/hitch/types.ts に追記 — v3)
新規export型:
- `JuryClassificationProposal` (§2.1。`proposedScope` 3値 + `proposalStatus` 4値 = CC5)
- `JuryAggregate` (§2.1)
- `SeverityAuditContext` (§3.1)
- `SeverityAuditResult` (§3.1)

既存enum参照:
- `HitchFindingSeverity` = `types.ts:100-108`(P0/P1/P2/P3/**info**)
- scope 3値は `'in_scope'|'out_of_scope'|'unknown'`(lens 定数別途)

### 4.2 lens定数(v3新規)

```ts
export const JURY_LENSES = [
  'correctness',
  'scope_fit',
  'spec_adherence',
] as const;

export type JuryLens = (typeof JURY_LENSES)[number];
```

呼び出し元で lens集合の distinct 検証時に使用: `new Set(proposals.map(p=>p.lens)).size === 3 && JURY_LENSES.every(l => proposals.some(p=>p.lens===l))`

### 4.3 呼び出し元

- `aggregateJuryVotes`: `src/hitch/orchestrator-runners.ts`(WI-9)。jury 3lens proposal を集約後、`unanimous` → repo.classifyFinding()、`split` → escalatepocket。
- `auditSeverity`: severity audit(WI-11s)。

## 5. 安全境界(不可侵 — v3でも不変)

| 原則 | aggregateJuryVotes | auditSeverity |
|---|---|---|
| LLM出力は入力 | confidence 読まない / float gate禁止 | severity提案はadvisory / 自動降格しない |
| 決定論集約のみ | 同入力→同出力(WI-2) | 同入力→同出力(WI-10s) |
| 多数決自動確定禁止 | 2-1/1-1-1/lens重複/length≠3全て split | majority≠harness でも severity不変 |
| 判定不能→fail-closed | status≠complete or scope='unknown' or lens重複混在→split | tie/票0→inconclusive(escalate) |
| 票割れ→人間escalate | split → decisionPacket | escalate:true → packet.severityAudit |
| DB write は集約後 | 関数内write無し(純関数) | 関数内write無し(純関数) |

## 6. v3差分(CC13反映)

v2との差分:
- unanimous条件に **lens distinct** (各lens 1件ずつ、重複無し)を追加
- §2.2 ロジック仕様に CC13 条件を明記
- §2.3 エッジケース「lens重複」を追加テストケース
- §4.2 JURY_LENSES定数を新規追加
- reason fmt では lens distinctの検証失敗ケースを「split」に統一

## openQuestions(v3)

- Q1: lens distinct検証の実装効率 — `new Set(...).size` vs Set.has()+loop。答: Set.size === 3 && JURY_LENSES.every(l => proposals.some(...))で確定。
- Q2: 同一lens複数の意味論 — 同一lens から複数提案が来る仕様は無い(caller が排除済みが前提)。来てもlength≠3 or distinctfail で deterministic split。
- Q3: phase3 再検証で斃れた分類の reason表記 — 別WI(WI-9で clarify)。aggregateJuryVotes は提案レベルのみ責任。

## シグネチャ
```ts
export function aggregateJuryVotes(proposals: JuryClassificationProposal[]): JuryAggregate;
export interface JuryClassificationProposal { findingId: string; lens: 'correctness' | 'scope_fit' | 'spec_adherence'; proposedScope: 'in_scope' | 'out_of_scope' | 'unknown'; proposalStatus: 'complete' | 'timeout' | 'parse_error' | 'inconclusive'; confidence?: number; reasoning?: string; }
export interface JuryAggregate { decision: 'unanimous' | 'split'; scope?: 'in_scope' | 'out_of_scope'; reason: string; }
export function auditSeverity(context: SeverityAuditContext): SeverityAuditResult;
export interface SeverityAuditContext { harnessSeverity: HitchFindingSeverity; juryVotes: { lens: string; juryProposedSeverity: HitchFindingSeverity; reasoning?: string; }[]; finding: { findingId: string; summary: string; }; }
export interface SeverityAuditResult { harnessSeverity: HitchFindingSeverity; juryConsensus?: HitchFindingSeverity; status: 'aligned' | 'diverged' | 'inconclusive'; escalate: boolean; reasoning: string; }
export const JURY_LENSES = ['correctness', 'scope_fit', 'spec_adherence'] as const;
export type JuryLens = (typeof JURY_LENSES)[number];
```

## work items
- **WI-1-v3** 型定義: JuryProposal / JuryAggregate / JuryProposerDeps / HitchDecisionPacket、HitchNextAction.decisionPacket? additive、ClassifyRunnerResult(構造化戻り型) — /Users/kn/ops/monorepo-harness/src/hitch/types.ts, /Users/kn/ops/monorepo-harness/src/hitch/orchestrator-types.ts
- **WI-2-v3** RED: aggregateJuryVotes決定論集約のユニットテスト(unanimous/split/lens-distinct/同入力→同出力) — /Users/kn/ops/monorepo-harness/tests/unit/hitch/jury-aggregation.test.ts
- **WI-3-v3** GREEN: aggregateJuryVotes純関数実装(全3票一致+lens distinct+判定不能ゼロのみunanimous、他全てsplit、float gate無し) — /Users/kn/ops/monorepo-harness/src/hitch/jury-aggregation.ts
- **WI-10s-v3** RED+GREEN: auditSeverity()決定論テスト実装(harness mapping vs jury severity consensus、aligned/diverged/inconclusive、同入力→同出力、自動降格しない) — /Users/kn/ops/monorepo-harness/tests/unit/hitch/severity-audit.test.ts, /Users/kn/ops/monorepo-harness/src/hitch/severity-audit.ts

## RED テスト
- [unit] aggregate-unanimous-3-lenses-distinct: proposals with exactly 3 votes, distinct lenses (correctness/scope_fit/spec_adherence), same scope, all complete → decision='unanimous' and scope is shared value
- [unit] aggregate-split-lens-duplicate: proposals with correctness×2 + spec_adherence×1, all in_scope, all complete → decision='split' (lens distinct fails) and reason='split votes: ...'
- [unit] aggregate-split-lens-missing: proposals with only correctness + scope_fit (spec_adherence missing), both in_scope, both complete, length=2 → decision='split' and reason=split
- [unit] aggregate-split-scope-divergence: proposals with in_scope/in_scope/out_of_scope, correct lenses, all complete → decision='split' and reason='split votes: in_scope(2), out_of_scope(1)...'
- [unit] aggregate-split-inconclusive-timeout: proposals where one has proposalStatus='timeout', others complete, unanimous lens set → decision='split' (isInconclusive triggers)
- [unit] aggregate-split-scope-unknown: proposals with in_scope/in_scope/unknown scope, correct lenses, complete → decision='split' (scope==='unknown' is inconclusive)
- [unit] aggregate-deterministic: same proposals array called twice → identical JuryAggregate results (no timestamp, no randomness)
- [unit] aggregate-no-confidence-gate: unanimous unanimous 3-vote in_scope with confidence [0.9,0.1,0.5] → decision='unanimous' (confidence values ignored)
- [unit] severity-audit-aligned: harnessSeverity P1, juryVotes all P1 → status='aligned', escalate=false, juryConsensus=P1
- [unit] severity-audit-diverged: harnessSeverity P1, juryVotes [P2,P2,P1] (majority P2) → status='diverged', escalate=true, juryConsensus=P2, harnessSeverity unchanged (P1)
- [unit] severity-audit-inconclusive: harnessSeverity P1, juryVotes [P1,P2,P3] (all different) → status='inconclusive', escalate=true, juryConsensus=undefined
- [unit] severity-audit-deterministic: same SeverityAuditContext called twice → identical SeverityAuditResult
- [unit] severity-audit-no-auto-downgrade: harnessSeverity P1 returned unchanged even when status='diverged' (audit advisory-only, no P1→P2 mutation)

## 安全境界
**不可侵安全境界(v3でも継続)**:

1. **決定論集約が唯一の状態遷移駆動**: aggregateJuryVotes・auditSeverity は純関数。repo.classifyFinding・severity書込は Phase3再検証後・unanimous のときだけ orchestrator が呼ぶ(関数内では状態遷移なし)。

2. **LLM出力は入力のみ**: confidence/reasoning は advisory記録。gate駆動に float値を使わない。提案層が finding の scope/severity を直接書き換えない。

3. **lens distinctの新規安全責務(CC13)**: anonymous 判定にlens集合の distinct 必須追加。同一lens重複は fail-closed で split。3つの独立した視点が揃っていない = 分類不能 = 人間escalate。

4. **多数決自動確定禁止**: 2-1 / tie / 1-1-1 全て split。unanimous は 3票一致 + lens distinct + 判定不能ゼロの唯一のケース。

5. **severity自動変更禁止**: auditSeverity は harnessSeverity を不変で返す。diverged/inconclusive は escalate flag のみ立てて packet に記録。P1→P2 降格は close gate(convergence.ts:702-708)を動かすため自動適用しない。

6. **判定不能 → fail-closed**: proposalStatus !== 'complete' または proposed_scope === 'unknown' は isInconclusive=true → split → escalate。context欠如・timeout・parse失敗は all unknown_inconclusive(fail-closed)。

7. **決定パケット永続化は orchestrator責務**: classify runner は packet を返すだけ。orchestrator が recordConvergenceDecisionWithStatus(decision:'escalate' + recommendedNextAction.decisionPacket) を呼ぶ(WI-9b)。packet は DB から読み戻せることをテストで assert(WI-13)。


---

# 2. compileProfileReviewRule (#229(0)) — v6

# spec2: compileProfileReviewRule (v6 改訂 Cycle 10 最終)

## v6 改訂(Cycle 10 最終)

### 概要
CC17 を逐語的に採用し、spec3/spec5 と完全一致する型・シグネチャ・識別子を確定。profile の `review:` セクション(snake_case YAML) → 決定論的に camelCase `ReviewRule` 生成。quorum を RefuteRequirement に追加、DEFAULT_MAX_REVIEWERS を定義、reviewRuleResolution を実構造に配線(required)。fail-closed(不正 profile は run 拒否)、後方互換(profile 欠落時は DEFAULT_REVIEW_RULE)の3原則を堅持。

### 1. 型定義(CC17 ① ② ⑤ ⑥ 逐語採用)

#### 1.1 ReviewRuleRefuteRequirement(CC16 ① 逐語 — quorum 追加)
`src/core/review-rule.ts` に新規追加:
```typescript
export interface ReviewRuleRefuteRequirement {
  group: string;
  minRefuteFraction: number;  // (0,1]. distinctRefute / participatingReviewers > minRefuteFraction
  quorum?: { minParticipants: number };  // CC16①: デフォルト 2
  reviewerIds?: string[];  // additive optional
  maxReviewers?: number;  // additive optional
}
```

#### 1.2 ReviewRule 拡張(CC16 ③)
```typescript
export interface ReviewRule {
  mode: ReviewMode;
  requirements: ReviewRuleRequirement[];
  refuteRequirements?: ReviewRuleRefuteRequirement[];  // NEW: additive optional
  overrides: ReviewRuleOverrides;
  staleProposal: ReviewRuleStaleProposal;
}
export const DEFAULT_MAX_REVIEWERS = 5;
```

#### 1.3 ReviewRuleResolution(CC16 ③)
```typescript
export interface ReviewRuleResolution {
  rule: ReviewRule;
  source: "default" | "project-profile";
  ruleSha256: string;
}
```

### 2. ProjectProfileSchema 拡張

`src/project/schema.ts:146` の `ProjectProfileSchema` に optional `review` セクション追加:
```typescript
const ReviewRuleRefuteQuorumSchema = z
  .object({
    min_participants: z.number().int().min(2).optional(),
  })
  .strict()
  .optional();

const ReviewRuleRefuteRequirementSchema = z
  .object({
    group: z.string().min(1),
    min_refute_fraction: z.number().gt(0).max(1),  // CC16④: (0,1]。0 除外
    quorum: ReviewRuleRefuteQuorumSchema,
    reviewer_ids: z.array(z.string().min(1)).optional(),
    max_reviewers: z.number().int().positive().optional(),
  })
  .strict();

const ReviewRuleSchema = z
  .object({
    mode: z.enum(["latest-proposal", "consensus"]).default("latest-proposal"),
    requirements: z.array(ReviewRuleRequirementSchema).optional(),
    refute: z.array(ReviewRuleRefuteRequirementSchema).optional(),
    overrides: ReviewRuleOverridesSchema.optional(),
    stale_proposal: ReviewRuleStaleProposalSchema.optional(),
  })
  .strict()
  .optional();

export const ProjectProfileSchema = z
  .object({
    // ... existing ...
    review: ReviewRuleSchema.optional(),  // NEW
    domains: z.array(ProjectDomainSchema).min(1),
  })
  .strict();
```

### 3. compileProfileReviewRule シグネチャ(CC16 ④ co-location)

**Location**: `src/core/review-rule.ts` (schema と co-location、ProjectProfileSchema から import)

```typescript
export function compileProfileReviewRule(
  profileReview: Record<string, unknown> | undefined,
  domain?: string,
): ReviewRule {
  if (!profileReview) return DEFAULT_REVIEW_RULE;
  
  // Zod parse + camelCase map + validation
  // CC16①: refuteReq 検証で quorum.minParticipants >= 2 force
  // CC16⑤: DEFAULT_MAX_REVIEWERS 参照
  return rule;
}

export class ReviewRuleCompileError extends Error {}
```

### 4. resolveEffectiveRule 修正(profile thread, CC16 ③)

```typescript
export function resolveEffectiveRule(scope: {
  projectId?: string;
  repoId?: string;
  domain?: string;
  profile?: { review?: Record<string, unknown> };  // NEW: CC16③
}): ReviewRuleResolution {
  if (scope.profile && scope.profile.review) {
    const rule = compileProfileReviewRule(
      scope.profile.review as Record<string, unknown>,
      scope.domain,
    );
    return {
      rule,
      source: "project-profile",
      ruleSha256: ruleSha256(rule),
    };
  }
  return {
    rule: DEFAULT_REVIEW_RULE,
    source: "default",
    ruleSha256: ruleSha256(DEFAULT_REVIEW_RULE),
  };
}
```

### 5. PreparedProjectRun + thread(CC16 ③)

`src/project/run-project.ts:32-43` に `reviewRuleResolution: ReviewRuleResolution` (required) を追加。

### 6. RunDomainCodingOpts + ProjectRuntimeDeps threading

- `src/core/workflow-runner.ts`: RunDomainCodingOpts に `reviewRuleResolution?: ReviewRuleResolution`
- `src/hitch/orchestrator-runners.ts`: ProjectRuntimeDeps に `reviewRuleResolution?: ReviewRuleResolution`
- `src/cli/run.ts`, `src/mcp/tools/mutation-tools.ts`: resolveEffectiveRule call

## シグネチャ
```ts
export interface ReviewRuleRefuteRequirement { group: string; minRefuteFraction: number; quorum?: { minParticipants: number }; reviewerIds?: string[]; maxReviewers?: number; }
export interface ReviewRuleResolution { rule: ReviewRule; source: 'default' | 'project-profile'; ruleSha256: string; }
export const DEFAULT_MAX_REVIEWERS = 5;
export function compileProfileReviewRule(profileReview: Record<string, unknown> | undefined, domain?: string): ReviewRule
export function resolveEffectiveRule(scope: { projectId?: string; repoId?: string; domain?: string; profile?: { review?: Record<string, unknown> }; }): ReviewRuleResolution
```

## work items (v3)
- **SPEC2-1** Add ReviewRuleRefuteRequirement type and refuteRequirements to ReviewRule — /Users/kn/ops/monorepo-harness/src/core/review-rule.ts
- **SPEC2-2** Add ReviewRuleCompileError exception class — /Users/kn/ops/monorepo-harness/src/core/review-rule.ts
- **SPEC2-3** Implement compileProfileReviewRule() with full validation (snake→camel mapping) — /Users/kn/ops/monorepo-harness/src/core/review-rule.ts
- **SPEC2-4** Refactor resolveEffectiveRule() to accept profile and return ReviewRuleResolution — /Users/kn/ops/monorepo-harness/src/core/review-rule.ts
- **SPEC2-5** Extend ReviewRuleRequirement with reviewerIds and maxReviewers (CC2) — /Users/kn/ops/monorepo-harness/src/core/review-rule.ts
- **SPEC2-6** Extend ProjectProfileSchema with review: ReviewRuleSchema (snake_case) — /Users/kn/ops/monorepo-harness/src/project/schema.ts
- **SPEC2-7** Add review rule compile error handling to prepareProjectRun (before run row creation) — /Users/kn/ops/monorepo-harness/src/core/workflow-runner.ts
- **SPEC2-8** Move snapshot logic into runDomainCodingInner try block with rethrow for project-profile failures — /Users/kn/ops/monorepo-harness/src/core/workflow-runner.ts
- **SPEC2-9** Thread reviewRuleResolution through PreparedProjectRun and RunDomainCodingOpts — /Users/kn/ops/monorepo-harness/src/core/workflow-runner.ts
- **SPEC2-10** Thread reviewRuleResolution through ReviewedRunWorkflowOpts and ProjectRuntimeDeps — /Users/kn/ops/monorepo-harness/src/core/workflow-runner.ts
- **SPEC2-11** Update MCP mutation-tools.ts orchestrate() to pass reviewRuleResolution — /Users/kn/ops/monorepo-harness/src/mcp/tools/mutation-tools.ts
- **SPEC2-12** Update CLI run.ts to thread reviewRuleResolution into runDomainCoding — /Users/kn/ops/monorepo-harness/src/cli/run.ts

## RED テスト (v3)
- [unit] compileProfileReviewRule: missing review section returns DEFAULT_REVIEW_RULE: compileProfileReviewRule({}) === DEFAULT_REVIEW_RULE; ruleSha256 unchanged
- [unit] compileProfileReviewRule: consensus mode with empty requirements throws ReviewRuleCompileError: throw ReviewRuleCompileError; message contains 'consensus mode requires at least one requirement'
- [unit] compileProfileReviewRule: requirement with min_approvals < 1 throws ReviewRuleCompileError: throw ReviewRuleCompileError; context.profileReview preserved
- [unit] compileProfileReviewRule: snake_case YAML correctly maps to camelCase ReviewRule: min_approvals→minApprovals; blocking_decisions→blockingDecisions; min_participants→minParticipants; reviewer_ids→reviewerIds; max_reviewers→maxReviewers
- [unit] compileProfileReviewRule: refute min_refute_fraction は (0,1] — 0/負/1超 のみ ReviewRuleCompileError、(0,1] の値(0.5・1.0 含む)は valid（codex PR#246 :448: 「1未満は throw」は誤り。strict-majority の 0.5 等を弾かない）
- [unit] resolveEffectiveRule with profile.review returns ReviewRuleResolution with source='project-profile': result.source === 'project-profile'; result.rule is compiled rule; ruleSha256 matches ruleSha256(rule)
- [unit] resolveEffectiveRule without profile returns ReviewRuleResolution with source='default': result.source === 'default'; result.rule === DEFAULT_REVIEW_RULE
- [integration] prepareProjectRun: ReviewRuleCompileError caught and rethrown as ProjectError before run row creation: throw ProjectError; RunRepository.countByProject() === 0 (no orphan row)
- [integration] runDomainCodingInner: snapshot for project-profile rethrows on failure → failed-internal-error finalize: run.status === 'failed-internal-error'; snapshot failure bubble up
- [integration] runDomainCodingInner: snapshot for default logs warning only; run continues: stderr contains 'warning: could not snapshot'; run proceeds to codex execution
- [unit] ProjectProfileSchema strict validation rejects unknown fields in review section: ProfileSchema.parse({review: {unknown_field: true}}) throws Zod error
- [integration] reviewRuleResolution threads through PreparedProjectRun → RunDomainCodingOpts → runDomainCodingInner: opts.reviewRuleResolution is accessible in inner; source matches expected value

---

# 3. refute = 第2 consensus requirement (#229 P2) — v6

# spec3: refute = 第2 consensus requirement (v6 改訂 Cycle 10 最終)

## v6 改訂(Cycle 10 最終)

### 概要
CC17 を逐語的に採用し、spec2 と完全一致。refute requirement に quorum を追加(CC16①)、expected reviewer set ベースの分母を確定(CC16①)、distinct reviewer dedupe に refuteId tie-break を追加(CC16⑤)、per-target ループを完全定義(CC17②)、snake/camel 境界を明記(CC16⑥)。`evaluateConsensus` は純関数のまま(DB 非依存)、reviewer set 解決は `processConsensusModePath` で実施(CC17①)。

### 1. 型定義(CC16 ① ② ④ ⑤ ⑥ 逐語採用)

#### 1.1 ReviewRuleRefuteRequirement(spec2 と同一)
`src/core/review-rule.ts` より import(spec2 所有)。

#### 1.2 RefuteVoteData と per-target dedupe(CC16⑤ refuteId tie-break)

```typescript
export interface RefuteVoteData {
  refuteId: number;  // AUTOINCREMENT PK — 決定論 tie-break
  targetChangeHash: string;  // per-target ループの絞り込みキー
  reviewerId: string;
  groupId: string | null;
  verdict: "uphold" | "refute" | "inconclusive";
  confidence?: number | null;
  promptSha256?: string | null;  // CC16②: tie-break 用
  createdAt: string;  // ISO datetime
}

export interface RefuteConsensusInput {
  requirement: ReviewRuleRefuteRequirement;
  refuteVotes: RefuteVoteData[];  // reviewerId lex sort 済み
  activeRequiredChanges: Array<{ idx: number; change_text: string }>;  // CC16⑥: included from ReviewProposalRow.requiredChanges (snake_case DB DTO)
  out: NonNullable<ConsensusSummary["refuteDropped"]>;
}
```

#### 1.3 ConsensusSummary 拡張
```typescript
export interface ConsensusSummary {
  // ... existing ...
  refuteDropped?: Array<{
    changeIdx: number;  // activeRequiredChanges[i].idx
    targetHash: string;  // targetChangeHash で絞り込み
    refuteCount: number;  // verdict === "refute" な distinct reviewer count
    participatingReviewers: number;  // expected reviewer set ∩ votes (CC16①記録)
    verdict: "refuted";
  }>;
}
```

### 2. evaluateConsensus 修正(CC16 ① ② ⑥)

`src/core/review-consensus.ts:99-160` を修正。refute 集約は **expected reviewer set filter + distinct-reviewer count + gate-内 quorum 再検証**:

```typescript
/** CC17②: per-target refute ループ完全定義 */
function evaluateRefuteRequirement(
  input: RefuteConsensusInput,
): void {
  const { requirement, refuteVotes, activeRequiredChanges, out } = input;
  const { group, minRefuteFraction, quorum } = requirement;
  
  // Step 1: each blocking required_change ごとにループ
  for (const change of activeRequiredChanges) {
    // Step 1a: targetHash = targetChangeHash(normalizeChangeText(change.change_text))
    const targetHash = targetChangeHash(normalizeChangeText(change.change_text));
    
    // Step 1b: votesForTarget = refuteVotes.filter(v => v.targetChangeHash === targetHash && v.groupId === group)
    const votesForTarget = refuteVotes.filter(
      (v) => v.targetChangeHash === targetHash && v.groupId === group
    );
    
    // cross-target 混線禁止チェック(votesForTarget の全要素が targetHash で確認)
    for (const v of votesForTarget) {
      if (v.targetChangeHash !== targetHash) {
        throw new Error(`Internal: cross-target vote mixed in votesForTarget`);
      }
    }
    
    if (votesForTarget.length === 0) continue;  // fail-closed: 降格しない
    
    // Step 1c: latest-per-reviewer dedupe (CC16⑤: createdAt desc, then refuteId desc)
    const byReviewer = dedupeLatestPerReviewer(votesForTarget);
    const participatingReviewers = byReviewer.length;
    
    // Step 1d: CC16①: quorum gate
    const minParticipants = quorum?.minParticipants ?? 2;
    if (participatingReviewers < minParticipants) continue;  // fail-closed: blocking 維持
    
    // Step 1e: refute count
    const refuteCount = byReviewer.filter((v) => v.verdict === "refute").length;
    
    // Step 1f: minRefuteFraction threshold (厳密 >)
    if (refuteCount / participatingReviewers > minRefuteFraction) {
      out.push({
        changeIdx: change.idx,
        targetHash,
        refuteCount,
        participatingReviewers,  // CC16①: 文ṃ確定
        verdict: "refuted",
      });
    }
  }
}

/** CC16⑤: latest-per-reviewer dedupe. tie-break = refuteId (AUTOINCREMENT) */
function dedupeLatestPerReviewer(votes: RefuteVoteData[]): RefuteVoteData[] {
  const byReviewer = new Map<string, RefuteVoteData>();
  const sorted = [...votes].sort((a, b) => {
    // createdAt 降順
    const cmpTime = b.createdAt.localeCompare(a.createdAt);
    if (cmpTime !== 0) return cmpTime;
    // refuteId 降順 (AUTOINCREMENT で常に存在・決定論)
    return (b.refuteId ?? 0) - (a.refuteId ?? 0);
  });
  for (const vote of sorted) {
    if (!byReviewer.has(vote.reviewerId)) {
      byReviewer.set(vote.reviewerId, vote);
    }
  }
  return Array.from(byReviewer.values());
}

function normalizeChangeText(changeText: string): string {
  return changeText.trim().replace(/\s+/g, " ");
}

function targetChangeHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}
```

### 3. processConsensusModePath 拡張(CC17①)

`src/core/review-processor.ts:163-277` で reviewer set を解決してから evaluateConsensus に渡す:

```typescript
function processConsensusModePath(
  db: Database.Database,
  opts: ProcessOpts,
  rule: ReviewRule,
  ruleSha: string,
): ProcessResult {
  // ... existing code ...
  
  const gate = db.transaction((): { decision: ConsensusStatus; includedCount: number; decisionPath: string } => {
    // ... existing gate logic ...
    
    // NEW: resolve expected reviewer sets for refute requirements (CC17①)
    // CC17①: activeRequiredChanges を processConsensusModePath の transaction 内で直接読む
    // (applyReviewDecision が後で書くため review_required_changes は常に入力としての状態)
    const refuteInputs: RefuteConsensusInput[] = [];
    if (rule.refuteRequirements !== undefined && rule.refuteRequirements.length > 0) {
      // Query review_required_changes directly from DB within transaction
      // to ensure consistency with RefuteConsensusInput contract
      const activeChanges = db
        .prepare(
          `SELECT idx, change_text FROM review_required_changes WHERE run_id = ? ORDER BY idx`
        )
        .all(opts.runId) as Array<{ idx: number; change_text: string }>;
      
      for (const req of rule.refuteRequirements) {
        // Resolve expected reviewer set (spec2 preflight と同じロジック)
        const expectedReviewers = resolveExpectedReviewers(req, reviewerRepo);
        
        // Load refute votes for this group/expected-reviewers
        // Contract: listByGroupAndExpectedReviewers ensures v.groupId === req.group
        const votes = refuteVoteRepo.listByGroupAndExpectedReviewers(
          opts.runId,
          req.group,
          expectedReviewers
        );
        
        refuteInputs.push({
          requirement: req,
          refuteVotes: votes,  // CC17①: 既に期待値で filter 済み & groupId確定
          activeRequiredChanges: activeChanges,  // DB read 済み実体
          out: [],  // filled by evaluateRefuteRequirement
        });
      }
    }
    
    const result = evaluateConsensus({
      rule,
      ruleSha256: ruleSha,
      proposals: enrichRows(rows, reviewerRepo),
      evaluatedAt: reviewedAt,
      refuteInputs,  // CC17①: 純関数に解決済み input 渡す
    });
    
    // ... rest of gate logic ...
  });
}

function resolveExpectedReviewers(
  req: ReviewRuleRefuteRequirement,
  reviewerRepo: ReviewerRepository
): string[] {
  if (req.reviewerIds !== undefined && req.reviewerIds.length > 0) {
    return req.reviewerIds;
  }
  const allInGroup = reviewerRepo.listByGroup(req.group);
  const max = req.maxReviewers ?? DEFAULT_MAX_REVIEWERS;
  return allInGroup.map((r) => r.reviewerId).slice(0, max);
}
```

### 4. change_text 統一(CC16⑥ snake/camel 明記)

DB row DTO (repository 層): `target_change_hash`, `change_text` = snake_case
App DTO (spec3 signature): `targetHash`, `changeText` = camelCase

### 5. activeProposalRows と reviewer sort(CC12)

`src/core/consensus-enrichment.ts:19` の既存関数を reviewer 昇順 sort で使用。

## Design Invariants(CC17)

- minRefuteFraction は (0,1] — 0 を除外(quorum=2 での 1/2 > 0 を防止)
- quorum.minParticipants デフォルト 2(fail-closed)
- evaluateConsensus は純関数 — DB access なし(CC17①)
- per-target ループで targetHash 必ず filter(cross-target 混線禁止)(CC17②)
- dedupe tie-break は refuteId (AUTOINCREMENT PK で常に存在・決定論)(CC16⑤)

## シグネチャ
```ts
export interface RefuteVoteData { refuteId: number; targetChangeHash: string; reviewerId: string; groupId: string | null; verdict: 'uphold' | 'refute' | 'inconclusive'; confidence?: number | null; promptSha256?: string | null; createdAt: string; }
export interface RefuteConsensusInput { requirement: ReviewRuleRefuteRequirement; refuteVotes: RefuteVoteData[]; activeRequiredChanges: Array<{ idx: number; change_text: string }>; out: NonNullable<ConsensusSummary['refuteDropped']>; }
function evaluateRefuteRequirement(input: RefuteConsensusInput): void
function dedupeLatestPerReviewer(votes: RefuteVoteData[]): RefuteVoteData[]
export function evaluateConsensus(input: { rule: ReviewRule; ruleSha256: string; proposals: EnrichedProposal[]; override?: ConsensusOverride | null; evaluatedAt: string; refuteInputs?: RefuteConsensusInput[]; }): ConsensusResult
```

## work items (v3)
- **P3-0** ReviewRule に refuteRequirements? additive 追加(CC10・新規 interface) — /Users/kn/ops/monorepo-harness/src/core/review-rule.ts, /Users/kn/ops/monorepo-harness/src/project/schema.ts
- **P3-A** prompt_sha256 NOT NULL 反映 + change_text 統一(CC11・schema/DDL) — /Users/kn/ops/monorepo-harness/src/db/schema.ts, /Users/kn/ops/monorepo-harness/docs/design/proposals/design-db-persistence.md, /Users/kn/ops/monorepo-harness/src/db/repositories/review-refute-votes.ts
- **P3-B** activeProposalRows usage 統一 + reviewer field 参照統一(CC12) — /Users/kn/ops/monorepo-harness/src/core/refute-agent.ts, /Users/kn/ops/monorepo-harness/src/hitch/orchestrator-runners.ts, /Users/kn/ops/monorepo-harness/src/core/consensus-enrichment.ts
- **P3-C** RefuteVotesByTargetHash 型定義 + evaluateRefuteRequirement 内部関数実装(CC3・CC10) — /Users/kn/ops/monorepo-harness/src/core/review-consensus.ts
- **P3-D** evaluateConsensus 関数署名修正(refuteVotes/activeRequiredChanges param追加) — /Users/kn/ops/monorepo-harness/src/core/review-consensus.ts, /Users/kn/ops/monorepo-harness/src/core/review-processor.ts
- **P3-E** refute target binding data model + verifyRefuteBinding(CC8・no re-hash) — /Users/kn/ops/monorepo-harness/src/core/refute-binding.ts
- **P3-F** processConsensusModePath advisory hash 除外実装(CC11・refuteDropped反映) — /Users/kn/ops/monorepo-harness/src/core/review-processor.ts
- **P3-TEST** RED→GREEN refute統合テスト(binding/majority/quorum/tie/determinism/dedup/advisory) — /Users/kn/ops/monorepo-harness/tests/unit/core/refute-binding.test.ts, /Users/kn/ops/monorepo-harness/tests/unit/core/review-consensus-refute.test.ts, /Users/kn/ops/monorepo-harness/tests/integration/orchestrate-refute.test.ts

## RED テスト (v3)
- [unit] verifyRefuteBinding positive bind (CC8 no re-hash): verifyRefuteBinding({ refuteVote: { target_change_hash: targetChangeHash('add validation') }, activeRequiredChanges: [{ idx: 0, change_text: 'add validation' }] }) === { bound: true, boundToIdx: 0 }
- [unit] verifyRefuteBinding rejects mismatched hash: verifyRefuteBinding({ refuteVote: { target_change_hash: 'wrong_hash_xyz' }, activeRequiredChanges: [{ idx: 0, change_text: 'add validation' }] }).bound === false
- [unit] evaluateConsensus strict majority 2/3: votes=[2 refute + 1 uphold] → refuteCount*2 > total → summary.refuteDropped contains {changeIdx:0, refuteCount:2, totalVotes:3}
- [unit] evaluateConsensus tie 1/2 maintains blocking: votes=[1 refute + 1 uphold] → refuteCount*2 == total (not >) → refuteDropped empty, blocking maintained
- [unit] evaluateConsensus gate-internal quorum re-check: 1 vote + minParticipants=2 → votesForTarget.length < minParticipants → blocking maintained (1票=100% 防止)
- [unit] evaluateConsensus group filter: votes from multiple groups, requirement.group='sec' → votes outside 'sec' ignored, decision unaffected
- [unit] evaluateConsensus determinism input order: same refuteVotes reversed → same summary.refuteDropped (reviewerId lex sort)
- [unit] ReviewRule snapshot roundtrip: canonicaliseRule(rule with refuteRequirements) → JSON.parse → rule.refuteRequirements preserved
- [integration] review_refute_votes business-key dedup: same (run_id, target_change_hash, reviewer_id, prompt_sha256) insert twice → UNIQUE violation, second fails
- [integration] processConsensusModePath advisory drop: consensus has refuteDropped=[hash0], proposalRows include requiredChanges=[text_hash0, text_other] → output requiredChanges=[text_other]
- [integration] orchestrator review N-dispatch: rule.refuteRequirements[group='sec'], listByGroup('sec')=[alice,bob,charlie], maxReviewers=2 → runRefuteAgent called 2 times
- [integration] refute advisory doesn't change severity: finding severity=P1, advisory drops required_changes → decision severity=P1(unchanged), close gate sees P1

---

# 4. gate spec #4「spec-gates-and-kind-guard」v3 改訂

v3 改訂: codex GO-with-fixes P2(型定義欠落)を解消。ValidationResult/GapRow/MappingContext/MappedCloseConditionProposal を spec内に完全定義。実装可能な形に収束。

## シグネチャ
```ts
export function isScopeWidening(previous: HitchScope, next: HitchScope): boolean
export function closeConditionsLoosenGate(previous: readonly HitchCloseCondition[], next: readonly HitchCloseCondition[]): boolean
export interface ValidationResult { valid: boolean; errors: Array<{field:string;code:string;message:string;severity:'hard'|'advisory'}>;warnings:string[] }
export interface GapRow { metric: string; count: number; gap: number; reason?: string }
export interface MappingContext { gap: GapRow; allowedKinds: readonly HitchCloseConditionKind[]; existingConditions?: readonly HitchCloseCondition[] }
export interface MappedCloseConditionProposal { kind: HitchCloseConditionKind; description: string; rule?: Record<string,unknown>; confidence: number; rationale: string }
```

## work items
- **WI.1** gap-to-kind.ts: canonical key emit + P2 type def — src/hitch/gap-to-kind.ts
- **WI.2** spec-validation.ts: validateCloseConditions + HitchValidationError — src/hitch/spec-validation.ts, src/hitch/types.ts

## RED テスト
- [unit] R2b canonical key: Unknown→maxOpenUnknownScope emit
- [unit] R3c form-only bare-id: form-only mode skip resolve

## 安全境界
Validator form-check only. State transition authority remains with convergence.decide()/aggregateJuryVotes. Command resolution deferred to close-check runtime. Phase unknown baseline parsed before gate (no type casts). Create-time bare-id safe (resolution at run time fail-closed).


---

# 5. N-Dispatch + Decision Packet (#229/#230) — v6

# spec5: N-Dispatch + Decision Packet (v6 改訂 Cycle 10 最終)

## v6 改訂(Cycle 10 最終)

### 概要
CC17 ① ② ③ ④ を逐語的に採用。runRefuteAgent 新規シグネチャ(spec2/spec3 を経由)、refute dispatch ループ、reviewed-run consensus 拒否配線、reviewRuleResolution threading 統一。spec2/spec3 と完全一致。

### 1. runRefuteAgent(CC17② ③ 新規)

**File**: `src/core/refute-agent.ts` (新規)

```typescript
/**
 * Refute agent: run a reviewer sandbox to evaluate a specific blocking
 * required_change against a coder proposal (CC17②③).
 */
export async function runRefuteAgent(input: {
  runsDir: string;  // runs directory
  runId: string;  // parent coder run_id
  dbPath: string;  // harness DB path
  reviewerName: string;  // registered reviewer_id
  requiredChange: { changeText: string; targetChangeHash: string };  // CC17③: blocking required_change
  codexRunner: CodexExecRunner;  // codex reviewer runner
  now?: Date;  // optional override timestamp
}): Promise<{
  refuteVerdict: "uphold" | "refute" | "inconclusive";
  reviewedAt: string;
}> {
  // 1. Load run + proposal from DB (read-only sandbox)
  // 2. Build refute prompt (deterministic)
  // 3. Run codex in read-only sandbox
  // 4. Parse verdict from result
  // 5. Record vote to review_refute_votes
  return { refuteVerdict: "inconclusive", reviewedAt: new Date().toISOString() };
}
```

### 2. N-Dispatch Review Runner(CC17③)

**File**: `src/hitch/orchestrator-runners.ts:1090-1160`

Orchestrator review runner 内:

```typescript
async function orchestrateReviewPhase(
  deps: OrchestratorRunnerDeps,
  run: RunRow,
): Promise<void> {
  // 0. resolveEffectiveRule(projectRuntime) → rule, CC16③
  const reviewResolution = resolveEffectiveRule({
    projectId: run.project_id,
    domain: run.domain,
    profile: deps.projectRuntime?.profile,  // CC17①: threading
  });
  const rule = reviewResolution.rule;
  
  // 1. N-dispatch: expected reviewers を昇順で loop → runReviewerAgent
  // (consensus rejection happens in reviewed-run only)
  
  // 2. N-dispatch: expected reviewers を昇順で loop → runReviewerAgent
  const expectedReviewers = resolveExpectedReviewers(rule, new ReviewerRepository(db));
  for (const reviewer of expectedReviewers) {
    await runReviewerAgent({ runId: run.run_id, reviewerName: reviewer, ... });
  }
  
  // 3. refute dispatch — rule.refuteRequirements があれば (CC17②③):
  if (rule.refuteRequirements !== undefined && rule.refuteRequirements.length > 0) {
    const activeChanges = db
      .prepare(`SELECT idx, change_text FROM review_required_changes WHERE run_id = ?`)
      .all(run.run_id) as Array<{ idx: number; change_text: string }>;
    
    for (const refuteReq of rule.refuteRequirements) {
      const expectedRefuteReviewers = resolveExpectedReviewers(
        refuteReq,
        new ReviewerRepository(db)
      );
      
      // each blocking required_change × expected reviewers
      for (const change of activeChanges) {
        for (const reviewer of expectedRefuteReviewers) {
          await runRefuteAgent({
            runsDir: deps.runsDir || ".",
            runId: run.run_id,
            dbPath: deps.dbPath,
            reviewerName: reviewer,
            requiredChange: {
              changeText: change.change_text,
              targetChangeHash: targetChangeHash(
                normalizeChangeText(change.change_text)
              ),
            },
            codexRunner: deps.reviewerRunner,
            now: new Date(),
          });
        }
      }
    }
  }
  
  // 4. processReviewDecision 1回 — spec3 evaluateConsensus で集約(refute 票迼み)
  await processReviewDecision(db.db, { runId: run.run_id, runsDir: deps.runsDir || ".", now: new Date() });
  
  // 5. pending catch — CC15④ と同じ stall 検出器
  // (optional)
}

function resolveExpectedReviewers(
  req: ReviewRuleRequirement | ReviewRuleRefuteRequirement,
  reviewerRepo: ReviewerRepository
): string[] {
  const r = req as any;
  if (r.reviewerIds !== undefined && r.reviewerIds.length > 0) {
    return r.reviewerIds;
  }
  const allInGroup = reviewerRepo.listByGroup(r.group);
  const max = r.maxReviewers ?? DEFAULT_MAX_REVIEWERS;
  return allInGroup.map((rev) => rev.reviewerId).slice(0, max);
}
```

### 3. Consensus Determinism(CC12)

`processConsensusModePath`: activeProposalRows → reviewer 昇順 sort → evaluateConsensus
refuteVotes: reviewerId lex sort + targetHash lex (CC17②)

### 4. Decision Packet(CC15③ camelCase)

**File**: `src/hitch/decision-packet.ts` (新規)

```typescript
export interface HitchDecisionPacket {
  packetVersion: 1;
  decisionKind: "classify_scope" | "severity_audit" | "operator_origin_unknown";
  findings: Array<{
    findingId: string;
    summary: string;
    detail?: string;
    filePath?: string;
    severity?: HitchFindingSeverity;
  }>;
  evaluationAxes: Array<{
    axis: "correctness" | "scope_fit" | "spec_adherence";
    lensVotes: Array<{
      lens: string;
      scope?: "in_scope" | "out_of_scope" | "unknown";  // CC15③: camelCase
      proposalStatus?: "complete" | "timeout" | "parse_error" | "inconclusive";  // CC15④: camelCase
      reasoning?: string;
      confidence?: number;
    }>;
    consensus: "aligned" | "split";
  }>;
  recommendation: { action: "classify_manually" | "review_split"; rationale: string; };
  nextActions?: Array<{ owner: "operator"; action: string; verificationMethod: string; }>;
}

export function buildJurySplitPacket(
  splits: Array<{
    finding: HitchFinding;
    proposals: JuryClassificationProposal[];
    aggregate: JuryAggregate;
  }>
): HitchDecisionPacket {
  // Implementation omitted
  return { packetVersion: 1, decisionKind: "classify_scope", findings: [], evaluationAxes: [], recommendation: { action: "classify_manually", rationale: "" } };
}
```

### 5. Reviewed-Run Consensus Rejection(CC17④)

**File**: `src/core/reviewed-run-workflow.ts`

```typescript
export class ReviewWorkflowUnsupportedError extends Error {}

function assertReviewedRunRuleCompatible(rule: ReviewRule, domain: string): void {
  if (rule.mode === "consensus") {
    throw new ReviewWorkflowUnsupportedError(
      `reviewed-run does not support consensus rules`
    );
  }
}

// In runReviewedRunWorkflow before review loop:
const reviewResolution = resolveEffectiveRule({
  projectId: ...,
  domain: opts.domain,
  profile: ...,  // CC17①: threading
});
assertReviewedRunRuleCompatible(reviewResolution.rule, opts.domain);
```

### 6. ReviewRuleResolution Threading(CC17①)

- `PreparedProjectRun.reviewRuleResolution` (spec2)
- `ProjectRuntimeDeps.reviewRuleResolution?` (spec5 orchestrator-runners.ts)
- `RunDomainCodingOpts.reviewRuleResolution?` (spec5 workflow-runner.ts)
- Thread points: CLI run.ts / MCP mutation-tools.ts / reviewed-run-workflow.ts / orchestrator-runners.ts

All entry points を統一。

### 7. ReviewRefuteVoteRepository(CC17① 新規)

**File**: `src/db/repositories/review-refute-votes.ts`

```typescript
export interface RefuteVoteRow {
  refute_id: number;  // AUTOINCREMENT PK
  run_id: string;
  reviewer_id: string;
  target_change_hash: string;
  group_id: string | null;
  verdict: "uphold" | "refute" | "inconclusive";
  confidence?: number | null;
  prompt_sha256: string;  // CC16②: NOT NULL, required for UNIQUE + tie-break
  created_at: string;
}

export class ReviewRefuteVoteRepository {
  /**
   * Insert a refute vote with groupId persisted.
   * Contract: groupId must be saved to DB and match req.group during evaluation.
   * CC17①: evaluateRefuteRequirement filters votes by v.groupId === group
   */
  insert(input: {
    runId: string;
    reviewerId: string;
    targetChangeHash: string;
    groupId: string | null;  // CC17①: repository が reviewer の group を解決・保存
    verdict: "uphold" | "refute" | "inconclusive";
    confidence?: number;
    promptSha256: string;
    createdAt: string;
  }): RefuteVoteRow { ... }
  
  /**
   * Query refute votes filtered by group and expected reviewers.
   * Contract: all returned votes satisfy v.groupId === groupId (filter applied).
   * Used by processConsensusModePath to build RefuteConsensusInput.refuteVotes.
   * CC17①: ensures v.groupId === group match in evaluateRefuteRequirement
   */
  listByGroupAndExpectedReviewers(
    runId: string,
    groupId: string,
    expectedReviewerIds: string[],
  ): RefuteVoteData[] { ... }  // all returned votes: groupId === groupId parameter
}
```

### 8. DB Schema Addition(CC17①)

Database schema migration — `review_refute_votes` (**migration v32**; v31 is #230-only and already shipped). **⚠️ The DDL below is a simplified/older sketch — do NOT copy it verbatim. The canonical current DDL is [design-db-persistence.md §3.1](./design-db-persistence.md), which adds `validation_status` / `reject_reason` / `source_sha256` / `source_yaml` and partitioned partial-unique indexes (passed / inconclusive / rejected). Implement from §3.1:**
```sql
CREATE TABLE review_refute_votes (
  refute_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  target_change_hash TEXT NOT NULL,
  group_id TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('uphold','refute','inconclusive')),
  confidence REAL,
  prompt_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, reviewer_id, target_change_hash, prompt_sha256)
);
CREATE INDEX review_refute_votes_run_idx ON review_refute_votes(run_id, group_id);
CREATE INDEX review_refute_votes_target_idx ON review_refute_votes(target_change_hash);
```

## Invariants(CC17)

- runRefuteAgent は read-only sandbox(worktree 不変)
- refute dispatch は expected reviewer set ベース
- N-dispatch は reviewer 昇順 deterministic
- reviewed-run は consensus + refute を拒否(fail-closed)
- reviewRuleResolution は全 entry point で統一 thread
- refuteId (PK AUTOINCREMENT) で決定論 tie-break

## シグネチャ
```ts
export async function runRefuteAgent(input: { runsDir: string; runId: string; dbPath: string; reviewerName: string; requiredChange: { changeText: string; targetChangeHash: string }; codexRunner: CodexExecRunner; now?: Date; }): Promise<{ refuteVerdict: 'uphold' | 'refute' | 'inconclusive'; reviewedAt: string; }>
async function orchestrateReviewPhase(deps: OrchestratorRunnerDeps, run: RunRow): Promise<void>
export class ReviewWorkflowUnsupportedError extends Error {}
export interface HitchDecisionPacket { packetVersion: 1; decisionKind: 'classify_scope' | 'severity_audit' | 'operator_origin_unknown'; findings: Array<{ findingId: string; summary: string; detail?: string; filePath?: string; severity?: HitchFindingSeverity; }>; evaluationAxes: Array<{ axis: 'correctness' | 'scope_fit' | 'spec_adherence'; lensVotes: Array<{ lens: string; scope?: 'in_scope' | 'out_of_scope' | 'unknown'; proposalStatus?: 'complete' | 'timeout' | 'parse_error' | 'inconclusive'; reasoning?: string; confidence?: number; }>; consensus: 'aligned' | 'split'; }>; recommendation: { action: 'classify_manually' | 'review_split'; rationale: string; }; nextActions?: Array<{ owner: 'operator'; action: string; verificationMethod: string; }>; }
export class ReviewRefuteVoteRepository { insert(input: { runId: string; reviewerId: string; targetChangeHash: string; verdict: 'uphold' | 'refute' | 'inconclusive'; confidence?: number; promptSha256?: string; createdAt: string; }): RefuteVoteRow; listByGroupAndExpectedReviewers(runId: string, groupId: string, expectedReviewerIds: string[]): RefuteVoteData[]; }
```

## work items (v3)
- **WI-1** N-dispatch review runner with preflight + pending catch — /Users/kn/ops/monorepo-harness/src/hitch/orchestrator-runners.ts
- **WI-2** Consensus determinism: sort by reviewerId+proposalId — /Users/kn/ops/monorepo-harness/src/core/review-processor.ts
- **WI-3** Decision packet formatter: buildJurySplitPacket + buildOperatorOriginPacket — /Users/kn/ops/monorepo-harness/src/hitch/decision-packet.ts
- **WI-4** Orchestrator packet recording: recordConvergenceDecisionWithStatus before escalate — /Users/kn/ops/monorepo-harness/src/hitch/orchestrator.ts
- **WI-5** Reviewed-run consensus rejection: ReviewWorkflowUnsupportedError — /Users/kn/ops/monorepo-harness/src/core/reviewed-run-workflow.ts
- **WI-6** Review rule compilation: compileProfileReviewRule with snake→camel mapping — /Users/kn/ops/monorepo-harness/src/core/review-rule.ts
- **WI-7a** ReviewerRepository.listByGroup(groupId): camelCase order by reviewer_id ASC — /Users/kn/ops/monorepo-harness/src/db/repositories/reviewers.ts
- **WI-7b** FakeMultiReviewerRunner fixture for N-dispatch preflight test — /Users/kn/ops/monorepo-harness/tests/fixtures/fake-codex-multi-reviewer.ts
- **WI-8** ReviewRuleRequirement: add reviewerIds? + maxReviewers? fields — /Users/kn/ops/monorepo-harness/src/core/review-rule.ts
- **WI-9** ProjectProfileSchema: add optional snake_case review section — /Users/kn/ops/monorepo-harness/src/project/schema.ts
- **WI-10** HitchDecisionPacket type + HitchNextAction.decisionPacket additive field — /Users/kn/ops/monorepo-harness/src/hitch/types.ts
- **WI-11** resolveEffectiveRule return value: {rule, source, ruleSha256} — /Users/kn/ops/monorepo-harness/src/core/review-rule.ts
- **WI-12** Thread reviewRuleResolution through entry points — /Users/kn/ops/monorepo-harness/src/project/run-project.ts, /Users/kn/ops/monorepo-harness/src/core/workflow-runner.ts, /Users/kn/ops/monorepo-harness/src/core/reviewed-run-workflow.ts, /Users/kn/ops/monorepo-harness/src/mcp/tools/mutation-tools.ts

## RED テスト (v3)
- [unit] RED-1a: resolveEffectiveRule({profile with review consensus}) → {rule, source:'project-profile', ruleSha256} matches compile hash
- [unit] RED-1b: compileProfileReviewRule(min_approvals=0) throws ReviewRuleCompileError, not DEFAULT
- [unit] RED-1c: snake→camel: YAML min_approvals/blocking_decisions/min_participants/reviewer_ids/max_reviewers → ReviewRuleRequirement.minApprovals/blockingDecisions/quorum.minParticipants/reviewerIds/maxReviewers
- [unit] RED-2: ProjectProfileSchema: profile without review parses ok(backward compat), top-level unknown fields rejected by .strict()
- [unit] RED-3: listByGroup('reviewers') with [bob,alice,charlie] → camelCase ReviewerRow[] sorted by reviewerId ASC [alice,bob,charlie], empty group → []
- [integration] RED-4: consensus rule + 2 reviewers → runReviewerAgent 2x (ordered) → processReviewDecision 1x → run.status=approved (not pending)
- [unit] RED-5: 3 proposals inserted in reverse DB order → summary.proposals/sourceProposalIds/requiredChanges deterministic (reviewerId+proposalId order)
- [integration] RED-7b: existing 1 manual proposal + consensus 2 reviewers → preflight logs existing → all reviewers allowOverwrite:true, 2nd not blocked
- [integration] RED-7c: 4 entry points (CLI run, reviewed-run, MCP orchestrate, hitch CLI) all freeze consensus profile as source='project-profile' snapshot
- [integration] RED-8: quorum=2, 1 reviewer approves → ReviewGateError(pending) caught in review runner → cycle recorded → evaluateConsensusStallForHitch called → hitch NOT generic escalated
- [integration] RED-9: quorum=2, registered=1 → preflight escalate reason: 'group=reviewers, required=2, registered=1'
- [integration] RED-10: classifier jury split → recordConvergenceDecisionWithStatus called before return → DB recommended_next_action.decisionPacket has evaluationAxes/recommendation
- [unit] RED-11: buildJurySplitPacket: finding.summary/detail(not title/description), severity ∈ {P0,P1,P2,P3,info}, lensVote.scope ∈ {in_scope,out_of_scope,unknown} + proposalStatus ∈ {complete,timeout,parse_error,inconclusive}
- [integration] RED-12: consensus profile reviewed-run → ReviewWorkflowUnsupportedError thrown before agent launch(run row not created)

---

# 付録: codex Cycle9 レビュー(v5 への指摘 = v6 改訂根拠)

結論: **spec3/spec5 はまだ GO 系に収束していません。** v5 は前回 P1 の一部、特に `runRefuteAgent` の本文/RED 不一致と refute の `minParticipants=2` は改善していますが、実装可能性と fail-closed 境界に P1 が残ります。

**主要 Findings**

- P1: `reviewRuleResolution` threading がまだ実構造と完全一致していません。現行の `prepareProjectRun` は [src/project/run-project.ts](/Users/kn/ops/monorepo-harness/src/project/run-project.ts:32) にあり、返却にも `reviewRuleResolution` はありません [run-project.ts](/Users/kn/ops/monorepo-harness/src/project/run-project.ts:124)。`RunDomainCodingOpts` も `compiledPolicy/project/projectContextPacks` までで rule resolution はありません [workflow-runner.ts](/Users/kn/ops/monorepo-harness/src/core/workflow-runner.ts:252)。spec5 の `ProjectRuntimeDeps { reviewRuleResolution?: ... }` は optional のため、consensus profile の reviewed-run 拒否を bypass できる形です。

- P1: spec3 の `evaluateRefuteRequirement` は core の純関数境界に `new ReviewerRepository(db)` を持ち込んでいますが、現行 `evaluateConsensus` の signature は DB/repository を受けません [review-consensus.ts](/Users/kn/ops/monorepo-harness/src/core/review-consensus.ts:99)。実装するなら `processConsensusModePath` 側で reviewer set を解決して渡す必要があります。現行でも reviewer repo は processor 側にあります [review-processor.ts](/Users/kn/ops/monorepo-harness/src/core/review-processor.ts:169)。

- P1: spec3 の refute pseudo-code は per-target loop が未完成です。`change` / `targetHash` / `output` / `continue` が未定義で、`votesInScope` が `targetHash` で絞られないため、複数 required change 間で同一 reviewer の票が混線し得ます。これは refuteDropped の決定論ゲートとしては NO-GO。

- P1: `minRefuteFraction` の contract が割れています。型コメントは `(0,1]` ですが、schema 案は `z.number().min(0).max(1)` で 0 を許可しています。`0` を許すと quorum=2 でも `1/2 > 0` で drop でき、strict-majority/fail-closed の意図と衝突します。

- P2: `promptSha256` tie-break は追加されていますが optional です。tie-break に使うなら `RefuteVotesByTargetHash.promptSha256` は required か、欠落時の deterministic fallback を明記してください。現行 `review_proposals.promptSha256` も nullable/optional です [review-proposals.ts](/Users/kn/ops/monorepo-harness/src/db/repositories/review-proposals.ts:31)。

**仕様別判定**

| spec | P0 | P1 | P2 | P3 | 判定 |
|---|---:|---:|---:|---:|---|
| spec1 aggregateJuryVotes/auditSeverity | 0 | 0 | 0 | 1 | **GO-with-fixes** |
| spec2 compileProfileReviewRule | 0 | 1 | 2 | 0 | **GO-with-fixes** |
| spec3 refute consensus requirement | 0 | 3 | 2 | 0 | **NO-GO** |
| spec4 spec gates/kind guard | 0 | 0 | 1 | 0 | **GO-with-fixes** |
| spec5 N-dispatch/decision packet | 0 | 1 | 3 | 0 | **NO-GO** |

**補足**

- spec3 の「1票=1/1 drop」は、`quorum.minParticipants ?? 2` が本当に enforce され、`minRefuteFraction > 0` も enforce されるなら構造的には解消です。ただし上記 P1 のため、現 v5 のままではまだ安全に実装できません。
- spec5 の `runRefuteAgent` 署名と dispatch 順は本文に入ったので、前回の本文/RED 不一致は解消方向です。
- 現行コードでは `src/core/refute-agent.ts`、`review_refute_votes`、jury/audit 関数群、`HitchNextAction.decisionPacket` は未実装です。静的レビューのみで、テスト/型チェックは実行していません。
