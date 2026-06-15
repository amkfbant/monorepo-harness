# コンサルフレームワーク — このハーネスへの選別適用

> **位置づけ**: 設計ノート。合議の各ステップが埋める**成果物スキーマ・問いの
> チェックリスト・分析の連鎖・可視化形**を定める。会議の*回し方*は
> [`deliberation.md`](./deliberation.md)、導入単位は [`applications.md`](./applications.md)。
>
> 元リサーチ: `tmp/consultant/consulting_frameworks_research_ja.md`（45 フレームワークの
> 調査メモ、リポジトリ外）。本ファイルは**ドメインに写像できる ~8 個に選別した版**。

---

## 0. なぜ「選別」なのか

リサーチは 45 個を網羅するが、価値は個々のフレームワーク（PEST/5 Forces/STP/BMC/
ペルソナ/NPS…）ではなく、それらが共通して持つ**メタ規律**にある:

- 問いを MECE に立て、検証順序を固定する
- **事実・解釈・仮説を分ける**
- 各分析を必ず「示唆・打ち手・次に検証する仮説」まで落とす
- 成果物を**意思決定ログとして更新し続ける**

45 個中 ~40 個はビジネスドメイン専用でコードハーネスに無関係。全部載せるのは、リサーチ自身
が失敗パターン筆頭に挙げる「フレームワークを埋めることが目的化する」そのもの。
**ドメインに写像できる 8 個だけを、合議の成果物スキーマとして使う。**

---

## 1. 選別した 8 個と写像先

| フレームワーク | 合議での役割 | このハーネスでの写像先 |
|---|---|---|
| **MECE / イシューツリー** | エージェント分担の抜け漏れ防止・答える問いの定義 | review カバレッジ監査 / spec の sub-phase 分解（course→phase） |
| **仮説思考**（結論/理由/反証条件） | 独立ラウンドの出力スキーマ | 合議 independent-round の `agent({schema})` |
| **As-Is / To-Be + ギャップ分析** | 現状→目標→差分の構造化 | spec 策定（[案C](./applications.md#案c)）。ギャップ行が closeConditions テンプレート |
| **意思決定マトリクス** | 複数案の透明な比較（軸・重み・採点・必須条件） | escalation 決定パケット / reviewer decision 集約 |
| **インパクト × 実現性**（2×2） | 着手順の決定 | finding を autofix 即時 / defer の優先度 |
| **リスクマトリクス**（発生可能性 × 影響 + 残余リスク + トリガー） | 副作用と残余リスク | finding severity モデル / divergence リスク / escalation トリガー |
| **RACI**（Accountable は原則 1 人） | 役割と最終責任の明確化 | 状態遷移ごとの決定権限（Accountable=人間）。安全境界の補強 |
| **ロードマップ / WBS** | 実行順序と依存の合意 | course→phase roadmap（`docs/specs/roadmap.md`）の充足 |

> 捨てるもの: 市場規模推計・ペルソナ・カスタマージャーニー・NPS・アンゾフ・PPM・STP・
> 4P/7P・PEST・5 Forces・BMC・7S・チェンジマネジメント等（ビジネスドメイン専用）。

---

## 2. 成果物スキーマ（型付き契約）

合議エージェントの出力を、下記スキーマで固定する。**型は出力契約であって、推論は縛らない。**

### 2.1 仮説思考（独立ラウンド）
```
conclusion        # 結論
rationale         # 根拠
evidence[]        # 使用した証拠（出典/ファイル:行/コマンド結果）
confidence        # 確信度 0–1
refutationCond[]  # 反証されたら撤回する条件
outOfExpertise[]  # 自分の専門外領域
```

### 2.2 意思決定マトリクス
```
axes[]            # 評価軸（事前定義）
weights{}         # 軸ごとの重み（根拠つき）
options[]         # 案
scores{opt}{axis} # 採点（採点根拠つき）
hardConstraints[] # 必須条件（満たさない案は合計点に関わらず除外）
scorer            # 採点者
log               # 意思決定ログ（DB-canonical と整合）
```
**「合計点が高くても必須条件を満たさない案は除外」は P0 ゲートと同じ思想**
（severity P0 が open なら他の点に関わらず close しない）。

### 2.3 リスクマトリクス
```
event / cause / impact / likelihood / detectability
mitigation / owner / deadline
residualRisk      # 対応後の残余リスク
trigger           # 再評価のトリガー
escalationCond    # エスカレーション条件
```
「残余リスク・トリガー・エスカレーション条件を定義」は convergence controller が必要と
するものそのもの。

### 2.4 ギャップ分析（closeConditions テンプレート）
```
asIs / toBe / gap / cause / action / owner / deadline / metric
```
`metric` は**実在する `HitchCloseConditionKind`** で書く（`count` という kind は存在しない）。
かつ**自動検証 kind**（`command` / `finding_policy` / `db_doctor` / `review_consensus`）と
**外部証拠待ち kind**（`manual` / `artifact_exists` / `operation_status` → `ask_human` に routing）を
区別する。自動ゲートを意図するなら前者を使う。合議は条件を*書く*が、判定は決定論ゲートが*行う*。

---

## 3. 相互参照（型付き分析パイプライン）

ある型の出力スキーマが次の型の入力になる。リサーチの「組み合わせ例」
（PEST→5F→3C→SWOT→意思決定マトリクス→ロードマップ）のハーネス版:

```
イシューツリー分解        → 答えるべき問いの集合（finding を木に整理）
  ↓
MECE 網羅監査            → 抜け漏れ/重複チェック（未検査カテゴリの検出）
  ↓
インパクト × 実現性        → 各 finding の優先度（autofix / defer）
  ↓
意思決定マトリクス         → 案比較 + 必須条件除外 + 採点ログ
  ↓
RACI / リスクマトリクス     → 決定権限 + 残余リスク + escalation パケット
```

各段は前段の**構造化済み成果物**を入力に取り、再導出しない。これが単なる並列レビューより
強い理由（エージェントが互いの出力に反応する）。

**ただし**: 逐次依存なので前段の誤りが伝播する。**段間に反証/検証ステップを必須に**
（[`deliberation.md`](./deliberation.md) §6）。実装では `pipeline()` の各 stage の後に
verify stage を挟む形。

---

## 4. 可視化（フレームワークはそのまま viz テンプレート）

各フレームワークの正準的な視覚形が、ダッシュボード（`docs/specs/dashboard.md`、可視化主体）の
テンプレートになる。

| フレームワークの図 | ダッシュボードでの可視化対象 |
|---|---|
| イシューツリー / ロジックツリー | finding 階層・review カバレッジの木 |
| リスクマトリクス（ヒートマップ） | finding severity × scope / divergence リスク |
| インパクト × 実現性（2×2） | autofix / defer の優先度 |
| 意思決定マトリクス | escalation 時の案比較 + 監査ログ |
| RACI 表 | 状態遷移ごとの「誰が決めるか」（Accountable=人間） |
| As-Is / To-Be + ギャップ一覧 | spec の現状→目標→差分→closeConditions |
| ロードマップ / ガント | course→phase の進捗・依存 |

**戒め**（リサーチ §使い方の前提）: 「きれいな図より、意思決定に使える粒度が重要」。
各セルから**「示唆 / 次アクション」へ落ちている decision-grade** であること。図だけ描いて
満足しない。

---

## 5. 失敗パターンと対策

| 失敗パターン | 対策 |
|---|---|
| フレームワークを埋めることが目的化 | 各分析の最後に必ず「示唆・意思決定・次アクション」を書く |
| 45 個を輸入してしまう | ドメインに写像できる 8 個に限定（§1） |
| 固定スキーマで多様性が下がる | 型は出力契約のみ。推論経路は縛らない |
| 相互参照で誤りが伝播 | 段間に反証/検証ステップを必須化 |
| きれいな図が decision-grade でない | 各セルを示唆/次アクションに接続 |
| closeConditions が曖昧化 | `metric` を機械検証可能な形に限定 |
