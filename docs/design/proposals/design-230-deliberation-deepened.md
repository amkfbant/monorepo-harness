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

## 0.1 v3.1 改訂（多角レビュー反映・確定事項）

> 2026-06-16、本 doc を **codex exec gpt-5.5 xhigh ＋ Opus 多角レビュワー 5体（安全境界/凍結契約整合/DB/熟議efficacy/完全性）**
> でレビュー。**全 6 レビュアー GO-with-fixes・P0 ゼロ**（中核の単調 fail-closed ゲートは airtight と検証済み）。
> 以下は P1/主要 P2 の確定対処。**本節は本文の該当箇所を上書きする（矛盾時は本節が優先）**。

### P1（実装前に必須）

**R1. 証拠の型境界 + verifyEvidence の airtight 化 + 関連性の限界明示**
（codex P1-1 / safety P1-1,P1-2 / efficacy P1-2）
- 型を **2 段に分離（brand 型）**: `RawJuryEvidence = { citation; kind; claim }`（LLM 出力・proposer parse 対象）と
  `VerifiedJuryEvidence = RawJuryEvidence & { verified: boolean; resolvedRef?: string }`（`verifyEvidence` のみが生成）。
  **proposer の parseSchema は `verified`/`resolvedRef` を受理しない**（`z.strict()` で reject、または parse 後に必ず drop）。
  LLM が出せるのは `citation/kind/claim` のみ。
- `verifyEvidence` は **入力の verified を完全無視し決定論再計算**（解決不能は必ず `verified=false`）。
- `aggregateDeliberation` は **`VerifiedJuryEvidence` だけを受け取る純関数**。未検証 `RawJuryEvidence` を gate に渡せない型設計。
  ゲートは渡された `verified` フラグを信頼し、`verifyEvidence` 通過は呼び出し側 `deliberate.ts` の不変条件（gate 直前で assert）。
- **`allHaveVerifiedEvidence` 述語を確定**: 「各 proposal について `evidence` に `verified===true` が **最低 1 件**存在し、
  かつ全 `evidence` が `verifyEvidence` 通過済み（`verified` が undefined でない）」。
- **関連性は機械検証不可と明記（限界）**: `verifyEvidence` は **citation の実在のみ**を保証し、claim を支持するかの関連性は見ない。
  ＝ 無関係だが実在する citation は弾けない。関連性は **Stage3 批判（各 citation が finding をどう支持/反証するか必須記述）**で担い、
  加えて **決定論的近接性フィルタ**（citation の path/domain が finding の `filePath`/`category` と同一ドメイン）を auto_confirm の
  証拠条件に AND する。この限界を §12 に明示。
- TDD: 「LLM が `verified:true` を申告しても `verifyEvidence` 後に false → gate escalate」「未検証 evidence を含む proposals → escalate」を RED に追加。

**R2. proposedSeverity の保存先**（codex P1-2）
- `jury_severity_audits` に **`jury_votes_json TEXT`** を追加（`[{lens, proposedSeverity, reasoning, round}]` を保存）し、
  3 lens の severity 票・reasoning・round を再構成・監査可能にする。packet の `lensVotes` にも `severity?` を含める。

**R3. non-escalating severity packet 記録（D2b WI 復活 + updateStatus:false）**（codex P1-3 / completeness P1-1）
- `recordConvergenceDecisionWithStatus` は既定で status sync するため、**advisory 記録には `updateStatus:false` を必須**にする
  （hitch status を `escalated` に倒さない）。
- WI DAG に **D2b** を独立追加: 「`resolved:true ∧ severityAuditPacket≠null` のとき orchestrator が
  `recordConvergenceDecisionWithStatus({ updateStatus:false, recommendedNextAction.decisionPacket })` で **non-escalating に 1 回記録**」。
- RED: 「scope unanimous + severity diverged → **hitch status 不変・packet が convergence decision に永続化**」。

**R4. DB audit linkage（deliberation_id）**（codex P1-4）
- 1 finding の 1 回の deliberation 実行を束ねる **`deliberation_id TEXT`**（app 層生成の決定論 ID / 例 `sha256(hitchId|findingId|gate_input_sha256)`）を
  `jury_classification_proposals` / `jury_classification_refutations` / `jury_severity_audits` の各行と packet に持たせる。
  doctor は `deliberation_id` で proposal/refutation/packet を正確に対応付け（retry / R1+R2 複数行でも一意束ね）。
  business-key dedup は従来どおり（deliberation_id は linkage 用・dedup キーには含めない）。

**R5. operator-origin 混在 batch の挙動 = 部分前進（確定）**（codex P1-5 / frozen §H3）
- **harness-origin の unknown は同 batch で jury まで進めて確定/escalate（部分前進）／ operator-origin の unknown は機械分類せず
  同一 escalate packet に `operator_origin_unknown` として束ねて即 manual escalate**。packet は複数 `decisionKind` を運べる。
- 安全側はどちらでも同じ（operator-origin は機械分類しない）。誤 escalate 削減という headline benefit のため部分前進を採る。
- TDD: 「mixed batch → harness-origin は jury 確定 / operator-origin は escalate packet に同梱・機械分類されない」。

**R6. packetVersion 1→2 の後方互換 reader 戦略**（frozen-contract P1-1）
- 既存 DB に残る `packetVersion:1` 行（escalate packet は `recommended_next_action` JSON に永続化済み・migration で消えない）を、
  **v2 reader は `packetVersion` で discriminate し、`deliberation`/`evidence` 系を undefined として読む**。全 reader（dashboard read API / MCP / CLI listDecisions）に
  optional chaining + default fallback を徹底。RED:「`packetVersion:1` 行が v2 reader で壊れず読める」round-trip。
- frozen §5.4 の RED-11 anchor（`findings.summary/detail`・`lensVote.scope+proposalStatus`）は v2 でも温存。

**R7. recommendation.action は rich(§3.3) 3 値が正本**（frozen-contract P1-2）
- `recommendation.action: 'classify_manually' | 'review_split' | 'review_severity'`（rich §3.3）を正本とする。
  lean §5.4 の 2 値を additive に superset し RED-11 を壊さない旨を明記。

**R8. selectFinalRound 決定論**（frozen-contract P1-3）
- `aggregateDeliberation` に渡す「最終ラウンド」proposals を **純関数 `selectFinalRound(proposals)`** で確定:
  「各 lens について critique 実行時は `round=2` 行、skip 時は `round=1` 行を 1 件ずつ選び、選択後の 3 件を `aggregateJuryVotes` に渡す。
  混在・欠落・lens 重複は fail-closed で split」。critique 未起動（`critiqueRan=false`）時は R1 をそのまま最終ラウンドとする。
  RED:「round 選択の決定論・R1/R2 混在しない・skip 時 R1 採用」。

**R9. 批判/反証プロンプト契約（儀式化防止）**（efficacy P1-1）
- 深掘りの load-bearing 要素はプロンプト。**出力契約で儀式化を構造的に防ぐ**（付録 P 参照・spec 付録として凍結）:
  - **critique**: 各 lens は最低 1 件の **具体的 objection** を必須フィールド。空/定型（「問題なし」等）は parse 段で reject → `proposalStatus=inconclusive`（fail-closed）。各 citation が finding をどう支持/反証するか必須記述。
  - **refuter**: `uphold` でも「**この合意が偽合意でない理由**」と「**棄却したら覆る反証条件**」を必須記述、欠落は `inconclusive`。
  - GOAL_RULES の codex レビューテンプレ同様、jury 各 stage の prompt テンプレ（必須出力項目・棄却条件）を **spec 付録として凍結**し「中身は実装任せ」にしない。

**R10. ALL_TABLE_NAMES union 健全性**（DB P1-1）
- `V31_TABLE_NAMES = [jury_classification_proposals, jury_classification_refutations, jury_severity_audits]` を新設し
  `ALL_TABLE_NAMES` union 末尾に append。**手動 union は歴史的に歯抜けがある**ため、
  「v31 適用後に 3 表が `CURRENT_TABLE_NAMES` に含まれ実 DB の `sqlite_master` と一致する」migration テストを RED 先行で追加。

**R11. doctor category union 改修 + JSON-parse check 形**（DB P1-2）
- `DoctorCheck.category` 固定 union に jury 用カテゴリ（`'review'` 流用 or 新規追加）を加える。
- `packet↔proposals` 整合は `recommended_next_action` を **TS パースして突合する新 check 形**（SQL 単独でない）を許容。
  orphan / hitch_id 整合は既存 SQL パターンで別 check に分離。DELETE repair は dry-run default + operator 承認の既存 repair gate に乗せる。

**R12. #230 単独 v31 の merge-gate + 同番号衝突防止**（DB P1-3 / frozen-contract P2 / efficacy P2）
- **v31 は #230 が排他取得。#229=v32 / #231=v33 は #230 merge 後に rebase して連番を確定し直す。同一 version 番号で 2 branch 同時 open を禁止（merge order ゲート）**。
  `schema_migrations` は同番号既存だと `runMigrations` が no-op 化し新 DDL が永久未適用になるため、**`schema_migrations.name` が期待値と一致するか検査するテスト**を足し、別 DDL の同番号混入を fail-closed 検出。
- frozen sibling doc（design-db-persistence §4/Q3 の単一 v31 共有・design-231 の v31→v32 仮定・design-gate-specs C10 の review_refute_votes v31 前提）の版番号を実装着手前に同期更新（follow-up）。実装着手順 DB→A→B→C は維持。

**R13. MCP/CLI standalone classify_finding は jury 非適用（明記）**（completeness P1-2）
- **jury 後段は orchestrate 駆動の classify runner のみ**。MCP `harness.hitch.classify_finding`（hitch-tools.ts）と CLI `hitch classify`（cli/hitch.ts）の
  heuristic 直呼びは **従来どおり heuristic + operator-manual で jury を起動しない**（理由: standalone 呼び出しは reviewerRunner/worktree/audit context を持たないため fail-closed に heuristic 境界を保つ）。
  「どの経路が jury を持ち、どれが持たないか」を §7 と cli.md/mcp.md に MECE に明記。

### 主要 P2（実装計画に織り込む）

- **P2a 証拠鮮度（Phase3 drift）**（safety P2）: jury proposer は **run の既存 worktree を共有しつつ revision を snapshot に pin**し、Stage2 と Phase3 で同一 immutable revision を見る。
  または Phase3 で auto_confirm 直前に file kind の verified citation のみ軽量 re-stat（spec/policy は immutable 扱い）。
- **P2b doctor の auto_confirm 正当性再検証**（safety P2）: jury 由来で確定した finding について、保存済み proposals/refutations から `aggregateDeliberation` を再実行し
  `decision==='auto_confirm'` を満たすか advisory 検証（満たさねば「LLM→状態直結の疑い」の強い finding）。＝ 安全境界の事後監査を機械化。
- **P2c evidenceStrength 決定論述語**（codex P2-1 / safety P3 / efficacy P3）: Stage3 起動条件「弱証拠」を決定論定義
  （例: いずれかの lens の verified evidence 件数 < 1、または全体 verified 件数 < 閾値）。critiqueRan を決定論にし doctor 再計算と一致。
- **P2d v31 DDL の self-contained 化**（codex P2-2）: 実装時、proposals/severity_audits の **最終 DDL 全文**を db.md / migration に載せる（差分参照でなく）。
- **P2e 多様性の現実的緩和 + over-claim 回避**（codex P2-3 / efficacy P2）: 単一 backend の限界を §12 で「敵対 refuter は **立場**の多様性のみ・**認知的**多様性ではない」と正確に区別。
  低コスト策として refuter の `model_reasoning_effort` を変える等の sampling 多様化を Phase1 で検討余地に残す。効果指標（誤分類救済/誤 confirm 防止件数）を follow-up telemetry に。
- **P2f finding_id→hitch_id 整合 reject を 3 表すべてに**（DB P2）: 共通ヘルパ `assertFindingHitchConsistency` を 3 repository が共有。doctor も 3 表で advisory チェック。
- **P2g FK ゼロ assert を 3 表すべてに**（DB P2）: v31 適用後 3 表の `PRAGMA foreign_key_list` が空 + 親削除後も jury 行が残る（CASCADE しない）を RED。
- **P2h refutation↔proposals/packet doctor 具体化**（frozen-contract P2 / DB P3）: (a) refutation.target_scope が proposals の unanimous scope と一致、(b) packet.deliberation.refuter.refuteVerdict と保存 refutation 行の一致。
- **P2i multi-batch drain loop**（completeness P2）: jury は 1 orchestrate cycle で **jury 専用 cap**（既定 `FINDING_BATCH_LIMIT` 以下）だけ処理し、残 unknown は次 cycle 持ち越しか escalate。
  コスト像に batch 全体の最悪上限（finding 数 × per-finding 呼び出し）と打ち切りを明記。既存 `previousRemaining` no-progress guard を Phase3 に残す。
- **P2j critique skip 時の refuter 入力**（completeness P2）: skip 時は R1 を最終ラウンドとし、refuter には voteChanged を含めず（検証済証拠 + 反証条件 + unanimous verdict のみ）。
- **P2k Phase3 で skip する finding の audit 永続化**（completeness P2・確定）: **live 再検証で skip する finding でも、生成済み proposals/refutation/severity_audit 行は監査目的で永続化する**（business-key dedup で安全）。
  ただし `classifyFinding` は呼ばない。doctor は「finding は存在するが他経路分類済み」を orphan 誤検出しない。

### P3（nit・実装時に反映）

- counterEvidence は **packet 記録(advisory)専用**・gate 判定に使わない（記録目的でのみ verifyEvidence を通す）。
- `severityAudit.juryConsensus?` の optional 化は `auditSeverity` の inconclusive 整合（記法ゆれを v2 で正した）と一文補足。
- refutations dedup の target_scope は **Stage4 起動時の unanimous verdict 単一値**（split refuter は follow-up）と DDL コメント。
- 3 lens（correctness/scope_fit/spec_adherence）は **MECE でなく多角的視点**（重複は冗長性として許容）と明記。
- §5.3 に **経路 → formatter → decisionKind → severityAudit field 有無**の対応表を 1 つ追加。
- §10 に verifyEvidence の **kind×境界 RED**（file 実在+line 範囲外→false / spec anchor 不在・重複の決定論 / policy glob ゼロ/複数マッチ）を列挙。

### codex App #252 追加対処（PR レビュー反映）

PR #252 の codex App レビュー（P1×2 は plan 本文スニペットの v1.1 未反映＝plan 側で修正済み）に加え、設計側の P2×2 を確定:

- **R14（P2-a・mixed-kind packet）**: R5 の部分前進で harness-origin(split→escalate) と operator-origin を同一 escalate packet に束ねると、スカラー `decisionKind` では片方の manual action が消える。**`HitchDecisionPacket.decisionKind` を `decisionKinds: Array<'classify_scope'|'severity_audit'|'operator_origin_unknown'>`（plural）に変更**し、`findings[]` 各要素に **`origin?: 'harness' | 'operator'`** を追加。`nextActions[]`（既に plural）が各 finding の必要 manual action を漏れなく列挙する（どの kind の action も hidden にしない）。§5.2 のスカラー `decisionKind` は本項で上書き。
- **R15（P2-c・deliberation_id を dedup key に）**: `deliberation_id` を business-key の**外**に置くと、prompt_sha256 を再利用する retry（gate input=refuter verdict が変わる）で `INSERT OR IGNORE` が old deliberation_id の行を温存し、新 packet の deliberation_id と不整合 → doctor 照合が誤 fail。**business-key UNIQUE に `deliberation_id` を含める**:
  - proposals: `(finding_id, lens, reviewer_id, round, prompt_sha256, deliberation_id)`
  - refutations: `(finding_id, target_scope, reviewer_id, prompt_sha256, deliberation_id)`
  - severity_audits: `(finding_id, prompt_sha256, deliberation_id)`
  ＝ **同一 deliberation 内では dedup（Phase3 retry 安全）／別 deliberation（=retry）は別行**で packet の deliberation_id と常に一致。§6.2 の dedup index は本項で上書き。
- **R-plan（P1×2・plan 側で修正済み）**: plan Task B3 の元コードスニペット（`selectFinalRound` の `r2 ?? r1`・`aggregateDeliberation` の proximity 未組込）を v1.1 PR1/PR2 契約に揃えた（target-round 限定選択・近接性 AND・`finding` を `DeliberationInput` に thread・`gateTrace.proximityOk`）。RED に proximity-fail / partial-R2-mix / gateTrace 直接 assert を追加。

### 付録 P: jury stage プロンプト出力契約（凍結・儀式化防止）

実装時に下記を厳格 parse schema として固定（中身を実装任せにしない）:
- **Stage1 propose（各 lens）**: `{ proposedScope, evidence[]{citation,kind,claim}（≥1）, refutationCondition（必須）, uncertainty, reasoning（必須）, proposedSeverity }`。
  欠落・空 → `proposalStatus∈{parse_error,inconclusive}`（fail-closed）。
- **Stage3 critique（各 lens）**: `{ objections[]（他者提案ごとに ≥1 具体 objection。種別: 事実誤認/推論飛躍/代替仮説/最悪ケース/評価軸欠落）, citationRelevance[]（各自証拠が finding をどう支持/反証するか）, revisedScope, voteChanged }`。
  空/定型 objection → reject → `proposalStatus=inconclusive`。
- **Stage4 refuter**: `{ refuteVerdict, whyNotFalseConsensus（uphold でも必須）, refutationConditions（覆る条件・必須）, counterEvidence[], reasoning }`。
  欠落 → `inconclusive`（veto＝fail-closed）。

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
