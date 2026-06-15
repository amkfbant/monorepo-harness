# 合議制 × フレームワーク — 導入カタログ

> **位置づけ**: 設計ノート。[`deliberation.md`](./deliberation.md)（会議の回し方・安全境界）と
> [`consulting-frameworks.md`](./consulting-frameworks.md)（成果物の型・可視化）を前提に、
> **実際に導入する単位**を後から着手できる粒度で並べたもの。各案に対応する enhancement
> issue を立てる。
>
> **共通の不可侵チェック（全案に適用）**: 集約と状態遷移は決定論ゲートのまま
> （`src/core/review-processor.ts` / `src/hitch/convergence.ts`）。LLM 出力は提案・整理に
> 留め、状態遷移の直接根拠にしない（[`deliberation.md`](./deliberation.md) §2）。spec/policy/
> 検証も既存どおり。各案は TDD（RED→GREEN→REFACTOR）で入れ、`docs/specs/*` を同じコミットで
> 更新する。

## 着手順（推奨）

`B → A → C → D → E`。B が最小リスク（基盤あり）。F/G は小粒で随時。

| 案 | 概要 | リスク | 既存基盤 |
|---|---|---|---|
| [A](#案a) | escalation 決定パケット格上げ / needs_classification jury / severity クロスチェック | 中 | convergence / classification |
| [B](#案b) | multi-lens review consensus + 反証 verify | 低 | Phase 11 consensus mode |
| [C](#案c) | spec 策定/レビュー層（As-Is/To-Be + ギャップ → closeConditions） | 中 | roadmap / hitch scope |
| [D](#案d) | 型付き finding triage パイプライン（段間 verify つき） | 中 | pipeline / lineage |
| [E](#案e) | ダッシュボード可視化テンプレート | 低 | dashboard（可視化主体） |
| [F](#案f) | RACI 決定権限モデルの明文化（A に折込可） | 低 | — |
| [G](#案g) | escalation 事後レビュー・ループ | 低 | hitch tables（findings/decisions） |

---

<a id="案a"></a>

## 案A
### escalation 決定パケットの格上げ / needs_classification jury / severity クロスチェック

**目的**: 判断系エスカレーションの質を上げ、人間に飛ぶ頻度を下げつつ、誤った自動判定は
fail-closed で人間に残す。

**現状**:
- `unknown` scope の finding は、決定論ヒューリスティック分類器 `classifyFindingForHitch`
  （`src/hitch/classification.ts`、正規表現/パス照合/カテゴリ許可リスト。**LLM は使わない**）が
  `orchestrator-runners.ts` で再分類し、なお `unknown` のときだけ人間へ escalate する
  （`convergence.ts`）。過去の運用で観測した「良性 finding での誤 escalate」「0→1 誤発火」は
  この分類/発散判定の精度問題。
- severity P0–P3 は reviewer ごとのフィールドではなく **harness 由来のマッピング**で決まる
  （`src/hitch/review-integration.ts`: required_changes→P1 固定 / non_blocking→P2 固定）。
  P0/P1/P2 ゲートは convergence が算出する。
- escalate 時の提示は finding ID 列に近い。

**提案**:
1. **needs_classification jury**: 決定論ヒューリスティック分類器がなお `unknown` を返す
   finding を、異レンズ 3 体（correctness / scope-fit / spec 準拠）が独立に分類提案 →
   決定論的多数決で集約。**不一致は人間へ**（fail-closed 維持）。＝ heuristic 分類器の
   後段に多体提案層を足す（分類器自体の置き換えではない）。
2. **severity クロスチェック**: 現状 severity は harness マッピング（P1/P2 固定）なので、
   reviewer proposal に明示 severity フィールドを足すか、harness マッピングの妥当性を
   多体でクロスチェックする。最終集約は決定論。
3. **決定パケット格上げ**: escalate 時の出力を [`deliberation.md`](./deliberation.md) §5 の
   統合フォーマット（推奨/少数意見/反証条件/確信度/次アクション）にする。意思決定
   マトリクス型（[`consulting-frameworks.md`](./consulting-frameworks.md) §2.2）。

**スコープ**: `classification.ts` の後段に多体分類提案層 + 決定論集約 /
`review-integration.ts` の severity 付与（明示フィールド or マッピングのクロスチェック）/
convergence の escalate payload 整形。分類・severity の**最終集約は決定論**（多数決ルールを
事前登録）。

**受け入れ条件**:
- jury 不一致時は必ず人間 escalate（自動確定しない）テストが緑。
- severity 集約が決定論的（同入力→同出力）であるテスト。
- escalate payload が統合フォーマットを満たす。
- 既存の divergence / fail-closed 挙動に回帰なし。

**安全境界チェック**: 分類・severity の最終確定は決定論集約。LLM の自己申告で
scope/severity を直接確定しない。

**依存**: なし（F の RACI を取り込むと決定権限が明確になる）。

---

<a id="案b"></a>

## 案B
### multi-lens review consensus + 反証 verify

**目的**: レビューの見落としを減らす。最小リスク・基盤ありなので最初に着手。

**現状**: Phase 11 consensus mode（`src/core/review-consensus.ts`）は複数 proposal の
`decision` を quorum + 決定論 tie-break で集約済み。ただし **orchestrator review runner は
1 reviewer→即 `review process`** のため、wired な `harness hitch orchestrate` では
`quorum > 1` に到達できない（`docs/future-features.md` の multi-reviewer driving follow-up）。
集約能力はあるが駆動側が単数。加えて同一モデル複数は疑似多様性。

**提案**:
1. **異レンズ reviewer**: N 体の同一 reviewer ではなく correctness / security / regression /
   efficacy / spec 準拠で割る（可能なら異モデル）。#163 で単一 xhigh reviewer が efficacy
   欠陥を見逃し multi-angle のみ検出した教訓（[`deliberation.md`](./deliberation.md) §4）。
2. **反証 verify**: `required_changes` の各 finding を独立に refute させ、過半 refute なら
   advisory 降格。plausible-but-wrong finding が `changes_requested` を引き起こすのを防ぐ。
3. **LLM-as-judge バイアス対策**: 提示順シャッフル / coder の出力を coder 自身に評価させない
   （既に層分離済み）。

**スコープ**: `quorum > 1` を hitch から到達可能にするには **2 つの前提が両方**要る:
(0) **profile-loaded review rules**: 現状 `src/core/review-rule.ts` の `resolveEffectiveRule`
は常に `DEFAULT_REVIEW_RULE`（`mode: latest-proposal`、requirements なし）を返すため、
たとえ N reviewer を回しても `review process` は quorum 要件を無視する。consensus /
requirements rule を profile からロードする（`docs/future-features.md` の reachable consensus
mode 前提）。
(1) **orchestrator review runner が `review process` の前に N reviewer を dispatch** する。
(2) `src/core/review-consensus.ts` への lens 設定 + verify ステップ。
**集約は既存の決定論 quorum / tie-break のまま。**

**受け入れ条件**:
- `resolveEffectiveRule` が profile から consensus(`quorum > 1`) rule を返せるテスト。
- 上記 (0)+(1) が揃った状態で `harness hitch orchestrate` が `quorum > 1` の consensus に
  実際に到達できるテスト。
- 異レンズ proposal の集約が決定論的（同入力→同出力）。
- 反証 verify が finding を advisory に降格できる経路のテスト。
- 既存 consensus の tie-break / override パスに回帰なし。

**安全境界チェック**: consensus decision は `review-processor.ts` の expected-status ガードを
必ず通す。多数決結果を直接 run.status にしない。

**依存**: なし（最初に着手）。

---

<a id="案c"></a>

## 案C
### spec 策定 / レビュー層（As-Is/To-Be + ギャップ → closeConditions）

**目的**: 上流（仕様）の品質を上げる。合議制の価値が最も高い領域（決定論的 ground truth が
ない・判断比重が大）。現状ハーネスに明示的な spec レビュー層がない＝空白地帯。

**現状**: scope / closeConditions は `harness hitch start --scope-file / --close-file` で暗黙に
渡すだけ。起案・レビューの構造がない。

**提案**:
1. **spec 策定**: NGT/Delphi 型で複数エージェントが scope/closeConditions を独立起案 →
   重複排除 → 批判ラウンド → 意思決定マトリクスで統合。
2. **As-Is/To-Be + ギャップ分析**: 現状→目標→差分を構造化
   （[`consulting-frameworks.md`](./consulting-frameworks.md) §2.4）。ギャップ行
   （asIs/toBe/gap/cause/action/owner/deadline/metric）が closeConditions テンプレート。
3. **spec レビュー**: scope/closeConditions を**ロックする前**に critic ラウンド
   （機械検証可能か / target files に漏れはないか / 曖昧で発散を招かないか）。

**不可侵の制約**:
- 成果物（spec）は**人間が批准**し、harness が canonical scope として記録（委員会は決めない）。
- closeConditions は実在する `HitchCloseConditionKind` のみを使い、かつ
  **「自動検証される kind」と「外部証拠待ち(ask_human)の kind」を区別**する:
  - **自動検証**（harness が決定論的に判定/実行）: `command`（close-check runner が実行）/
    `finding_policy`（count 系ゲートを finding 状態から評価）/ `review_consensus`（review/consensus
    step で充足、ask_human 行きではない）。
  - **外部証拠待ち**（convergence が `ask_human` に routing し、operator の記録を待つ）:
    `manual` / `artifact_exists` / `operation_status` / **`db_doctor`（現状 runner 未実装のため
    自動実行されず ask_human 行き）**。
  「schema を通る」≠「自動検証される」。後者を自動ゲートのつもりで多用すると、hitch が
  `HitchCloseConditionSchema` を通っても operator 証拠待ちで stall する。合議は条件文を*書く*が
  判定は決定論ゲート。さもないと曖昧合意への spec drift を招き close-check が骨抜きになる。

**スコープ**: 主に新規ドキュメント/ワークフロー（オフライン・人間批准）。`docs/specs/roadmap.md`
（course→phase）と `hitch start` 入力の橋渡し。コア状態機械は変更しない見込み。

**受け入れ条件**:
- 起案 → 批判 → 統合の成果物テンプレートが存在し、人間批准ステップが明示。
- 生成された closeConditions が実在する `HitchCloseConditionKind` のみで構成され、
  `HitchCloseConditionSchema` を通ることの検査（`count` 等の無効 kind を出さない）。
- 「自動検証 kind」と「外部証拠待ち kind」がテンプレート上で区別され、自動ゲートを意図した
  条件が `manual`/`artifact_exists`/`operation_status` に化けない検査。

**安全境界チェック**: spec の enforcement（close 判定）は決定論ゲート。合議は起草のみ。

**依存**: A（決定パケット形式の再利用）。

---

<a id="案d"></a>

## 案D
### 型付き finding triage パイプライン（段間 verify つき）

**目的**: finding の整理・優先度付け・escalation 準備を、相互参照する型付き DAG にする。

**提案**: [`consulting-frameworks.md`](./consulting-frameworks.md) §3 のパイプライン:
```
イシューツリー分解 → MECE 網羅監査 → インパクト×実現性 → 意思決定マトリクス → RACI/リスク
```
各段が前段の構造化成果物を入力に取り、**段間に反証/検証ステップを挟む**（誤り伝播対策）。
実装は `pipeline()` の各 stage 後に verify stage。

**スコープ**: 主に triage オーケストレーション層（read 中心 + 提案生成）。状態遷移は最終段で
既存ゲート経由。

**受け入れ条件**:
- 各段が前段出力スキーマを入力に取り、段間 verify が存在するテスト。
- 誤った前段入力が verify で捕捉される回帰テスト。

**安全境界チェック**: 出力は提案・整理。autofix/defer の確定は既存の severity/scope ゲート。

**依存**: A（意思決定マトリクス・RACI）、B（finding 入力源）。

---

<a id="案e"></a>

## 案E
### ダッシュボード可視化テンプレート

**目的**: フレームワークの正準的視覚形をダッシュボード（可視化主体、`docs/specs/dashboard.md`）の
read-only ビューにする。

**提案**: [`consulting-frameworks.md`](./consulting-frameworks.md) §4 の対応表
（イシューツリー / リスクマトリクス / インパクト×実現性 / 意思決定マトリクス / RACI /
As-Is/To-Be / ロードマップ）。**各セルは示唆/次アクションへ落ちる decision-grade** に限る。

**スコープ**: dashboard の read-only API + ビュー。mutation は伴わない（可視化のみ）。

**受け入れ条件**:
- 各ビューが既存 DB-canonical データから導出（新たな真実源を作らない）。
- 図のセルから finding / decision-log への drill-down がある。

**安全境界チェック**: read-only。状態を持たない。

**依存**: A/D（可視化する成果物の型が先に必要）。

---

<a id="案f"></a>

## 案F
### RACI 決定権限モデルの明文化（A に折込可）

状態遷移の種類ごとに R/A/C/I を定義し、**Accountable は人間 1 人**を明示
（[`consulting-frameworks.md`](./consulting-frameworks.md) §1）。安全境界
（「状態遷移は harness のみ」「Accountable=人間」）の*表現*であって新機能ではない。
小粒なので A の受け入れ条件に折り込んでよい。成果物は `docs/specs/` への RACI 表追記。

<a id="案g"></a>

## 案G
### escalation 事後レビュー・ループ

escalate / 誤分類の**イベント**（runtime ログは `hitch_findings` / `hitch_convergence_decisions`
等の hitch テーブル。`docs/reports/` は手動の F1/F2 index であって runtime ログではない）を
定期的に合議でレビューし、分類 heuristic・評価軸・プロンプトを更新する運用ループ。小粒・
低リスク。優先度は最後。当面は `docs/future-features.md` の保留項目として扱い、A/B の運用
知見が溜まってから issue 化。
