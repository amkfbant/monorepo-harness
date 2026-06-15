# AI 合議制 — このハーネスへの適用方針

> **位置づけ**: 設計ノート（提案・思想の正本）。`docs/specs/` のような「現状実装の
> スナップショット」ではなく、これから導入する合議制機構の**設計前提と安全境界**を
> 定める。個別 enhancement の導入単位は [`applications.md`](./applications.md)、成果物の
> 型と可視化は [`consulting-frameworks.md`](./consulting-frameworks.md) を参照。
>
> 元リサーチ: `tmp/consultant/ai_gougisei_research_ja.md`（リポジトリ外の調査メモ）。
> 本ファイルは、その一般論を**このハーネスのドメインと安全境界に写像した版**。

---

## 0. 一行で

**合議制は「提案・批判・採点・統合」を担う。集約と状態遷移は今まで通り harness の
決定論ロジックが握る。** この分離を守る限り、合議制の導入は安全境界（`CLAUDE.md` §安全
境界 / `GOAL_RULES.md` §G）と矛盾しない。

---

## 1. 合議制とこのハーネスの安全境界は同じことを言っている

リサーチの核心（集合知の本質は「AI を増やすこと」ではなく、独立性・多様性・反証・
評価軸・証拠・**意思決定権限**・ログの設計）は、このハーネスの不可侵境界とほぼ一対一で
対応する。

| 合議制の原則 | このハーネスでの既存実装 |
|---|---|
| LLM 評価者の出力は提案。判定は集約ルール | `review_proposals` に記録するだけ／状態遷移は `src/core/review-processor.ts` の決定論ゲート |
| Accountable は原則人間 | `escalate` / `needs_classification` / `budget_exhausted` で人間に返す（`src/hitch/convergence.ts`） |
| 出典なき合意を避ける（一次情報・検証担当を分離） | close condition は `command` exit code / `artifact_exists`。`review_consensus` は static approval のみでテスト実行を証明しない（`src/hitch/close-checks.ts`） |
| 評価者バイアス（自己選好）対策 | coder agent と reviewer agent を別層に分離（`src/core/`） |
| 多数決は独立・有能のときだけ強い（Condorcet） | 同一基盤モデルの複数インスタンスは独立投票者ではない → 異レンズ/異モデルで割る（§4） |

つまり既存の **3 層モデル**（MCP per-step gate → hitch loop → course dispatch、いずれも
convergence の決定論判定で gate する。`docs/specs/hitch-convergence.md`）は、合議制を載せる
ための理想的な基盤になっている。合議は肉付けであって、土台の置き換えではない。

---

## 2. 判定の境界線（最重要・これだけは外さない）

> **「LLM の判定を*入力*にした、事前登録済みの決定論的集約ルール」は許される。**
> **「LLM の自己申告を*そのまま*状態遷移の根拠にする」は禁止。**

- Phase 11 consensus mode（`src/core/review-consensus.ts`）が**許される側の実例**:
  複数 reviewer proposal の `decision` を quorum + 決定論 tie-break
  （`rejected > changes_requested > approved > pending`）で集約し、`review-processor.ts` の
  expected-status ガードを通して初めて run.status を遷移させる。
- **禁止側**: reviewer が「修正した」「これは P0 だ」と言ったことを、harness 側の
  再判定なしに状態遷移へ反映すること。severity も scope も close 充足も、最終判定は
  決定論ロジックが握る。

合議制で「決定論的でないものを決める」とは、正確には
**「決定論的でない*入力*を、決定論的な*集約ルール*に通す」**ことを指す。委員会は
*起草・整理・採点*し、harness が*集約・遷移*する。

---

## 3. 合議を載せられる箇所 / 載せない箇所

現状の 5 エスカレーション地点（`src/hitch/convergence.ts`）を「決定論的か / 判断を要するか」
で仕分ける。

| エスカレーション | 性質 | 合議の扱い |
|---|---|---|
| `budget_exhausted`（iteration/rerun/cycle カウント） | 純粋に決定論的 | **載せない**。数値で十分 |
| policy violation（git diff × path、`diffAndValidate`） | 純粋に決定論的 | **載せない** |
| close-check（finding count / command exit） | 決定論的 | **載せない**（条件の*文面策定*は合議の対象＝[案C](./applications.md#案c)） |
| `needs_classification`（unknown scope の finding） | 判断 | **最有力**。多角レンズの jury 投票で scope 分類 → 不一致は人間 |
| `diverging`（本当に発散か、良性 finding の急増か） | 判断 | 有力。同じ metrics を複数視点で評価し集約 |
| severity P0–P3（現状 reviewer 単独ではなく **harness 由来マッピング**: required_changes→P1 / non_blocking→P2 固定） | 判断 | 有力。明示 severity フィールド追加 or マッピングの多体クロスチェック |

判断系であっても、合議の役割は**「人間への提示パケットを豊かにする」**まで。
Accountable を人間から委員会に移してはならない（責任希釈の防止）。escalate 時に出す情報を
「finding ID 列」から「推奨 + 少数意見 + 反証条件 + 確信度 + 次に検証すべきこと」
（§5 統合フォーマット）へ格上げするのが正しい方向。

---

## 4. 多様性の確保（疑似多様性の罠）

- codex を N 体並べても、同一基盤モデルは Condorcet 的独立投票者にならない。
  **N 人の同一 reviewer ではなく、異レンズ**（correctness / security / regression /
  efficacy / spec 準拠）で割る。可能なら異モデルも混ぜる。
- 実証（#163）: 単一の codex xhigh reviewer が efficacy 欠陥を見逃し、角度を分けた
  multi-angle レビューのみが検出した。＝同一モデルを N 体並べても盲点は共有される。
- フレームワークは固定スキーマなので、全エージェントを同じ型に流し込むと多様性が下がる。
  型は**「出力成果物の契約」と「問いのチェックリスト」**として使い、推論経路は縛らない
  （`agent({schema})` で出力形だけ固定する）。

---

## 5. 合議ラウンドの構造（このハーネス版）

リサーチの最小構成（独立 → 批判 → 採点 → 統合 → 人間）を、ハーネスの語彙に写像する。

1. **独立ラウンド**: 各エージェントが他者の出力を見ずに初期見解を出す。
   出力スキーマ（仮説思考と同型）: `結論 / 根拠 / 使用した証拠 / 確信度 / 反証条件 /
   自分の専門外領域`。
2. **批判ラウンド**: 事実誤認・推論の飛躍・代替仮説・最悪ケース・評価軸の欠落・
   実行時依存を明示的に求める。findings は通常どおり `review_proposals` / hitch finding に
   記録する（状態遷移はしない）。
3. **採点ラウンド**: 評価軸に沿って採点。LLM-as-judge バイアス対策（提示順シャッフル /
   自己出力を自己評価させない / 棄却条件を明示）。
4. **統合ラウンド（決定論集約）**: 事前登録した quorum / 重み付けで集約。下表の形式で
   成果物化する。
5. **最終判定**: 決定論ゲート（convergence / review-processor）が状態遷移。判断系で
   ゲートが結論を出せない場合のみ人間に escalate。

### 統合フォーマット（escalate / 採点結果の成果物）

| 項目 | 内容 |
|---|---|
| 最終推奨 | 採用案 |
| 採用理由 | 評価軸ごとの根拠 |
| 棄却案 | 不採用案と理由 |
| 少数意見 | 反対意見・条件付き賛成 |
| 重大リスク | 発生可能性・影響・対策 |
| 未検証前提 | 追加調査が必要な点 |
| 次アクション | 担当・期限・検証方法 |

---

## 6. 相互参照（型付き分析パイプライン）と誤り伝播

合議は「並列レビュー（barrier 集約）」だけでなく、**ある段の構造化出力を次段の入力にする
DAG**（相互参照）も組める。詳細な型は [`consulting-frameworks.md`](./consulting-frameworks.md)。

- 並列レビュー = N 人が同じ対象を別角度で見て最後に集約。各人は他人の構造化出力を見ない。
- 相互参照パイプライン = 段 N が段 N−1 の成果物を入力に取り、それに反応して深掘りする。

**重大な注意**: 相互参照は逐次依存なので、前段の誤りが後段に伝播する
（Mixture-of-Agents の警告）。**段の受け渡しごとに反証/検証ステップを必須にする**。
これを入れないと「自信満々で一貫しているが間違っている連鎖」ができ、可視化されると
余計に正しく見える。相互参照を採るならこれはオプションではない。

---

## 7. 失敗パターンと対策（このプロジェクトに具体化）

| 失敗パターン | このハーネスでの症状 | 対策 |
|---|---|---|
| 多数決信仰 | 提案数の多い decision を採用 | 独立性・能力・証拠強度で重み付け（決定論集約） |
| 疑似多様性 | codex 複数インスタンスで盲点が同じ | 異レンズ / 異モデル / 異データ源 |
| 早すぎる収束 | 初期 finding に全員が寄る | 独立ラウンド / 反対役 / 遅延合意 |
| 批判の儀式化 | 表面的懸念のみ | 反証条件・最悪ケース・棄却基準を要求 |
| 評価者バイアス | 長い/先出し/自文体を好む | シャッフル・匿名化・複数評価者・自己評価禁止 |
| 出典なき合意 | close 判定を review_consensus 単独に依存 | 合議は条件を*書く*、harness が `command`/`finding_policy` 等の**自動検証 kind**で*検証する*（`artifact_exists`/`manual`/`operation_status` は operator 証拠待ち） |
| 責任希釈 | 誰が決めたか不明 | RACI（Accountable=人間 1 人）を状態遷移ごとに固定 |
| ログ過多 | 会話全文で要点が埋もれる | 会話全文でなく「判断ログ」（§5 形式）を残す |
| bootstrapping | 未確定の dev ハーネスで自分の合議を駆動 | 駆動は pin した ops ハーネス（`CLAUDE.md`） |

---

## 8. 導入順序

リサーチも本プロジェクトの開発規律も「複雑なエージェント基盤を先に作るな」で一致。
リスクと既存基盤の流用度で並べる（各単位の詳細は [`applications.md`](./applications.md)）。

1. **[案B](./applications.md#案b)**（最小リスク・基盤あり）: Phase 11 consensus を
   「異レンズ reviewer + 反証 verify」に拡張。集約は既存の決定論 quorum のまま。
2. **[案A](./applications.md#案a)**: `needs_classification` jury / severity クロスチェック /
   escalation 決定パケットの格上げ。
3. **[案C](./applications.md#案c)**: spec 策定/レビュー層（As-Is/To-Be + ギャップ →
   closeConditions、ロック前の critic ラウンド）。
4. 以降、型付き finding triage パイプライン・ダッシュボード可視化・RACI 決定権限モデルなど。

各段で **§2 の境界線**を越えないこと。これが守れている限り、合議制はこのハーネスの
安全境界と矛盾せず、既存 3 層モデルの自然な肉付けになる。
