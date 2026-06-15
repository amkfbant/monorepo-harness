# epic #228（AI 合議制 × コンサルフレームワーク）実装設計提案 — インデックス

> マルチエージェント合議（独立起案 → 反証verify → 批判/MECE/採点 → 統合）+ codex exec gpt-5.5 xhigh
> レビューの反復で作成した、実装着手可能な設計提案一式。**計画のみ（コード未変更）**。
> 検証元: ops checkout（生成時 v0.7.10、現 v0.7.11。レビュー対象の core src は v0.7.9..HEAD で同一を確認）。
> **実装は別セッションが dev クローンの `origin/main` ベース隔離ブランチで TDD**。これらの最終 home は dev クローンの `docs/design/`。

## ファイル一覧

| ファイル | 内容 | codex 判定 |
|---|---|---|
| [design-230-classification-jury-severity-packet.md](./design-230-classification-jury-severity-packet.md) | 案A: needs_classification jury / severity クロスチェック / 決定パケット / 案F RACI | GO-with-fixes（v2 反映済） |
| [design-229-multi-lens-consensus.md](./design-229-multi-lens-consensus.md) | 案B: multi-lens review consensus + 反証 verify | NO-GO→GO-with-fixes（v2 反映済） |
| [design-231-spec-drafting-review-layer.md](./design-231-spec-drafting-review-layer.md) | 案C: spec 策定/レビュー層（As-Is/To-Be→closeConditions） | GO-with-fixes（v2 反映済） |
| [design-db-persistence.md](./design-db-persistence.md) | 横断: 合議アーティファクトの DB 永続化（共有 decision-log backbone + v31） | GO-with-fixes（v2 反映済） |
| [design-gate-specs.md](./design-gate-specs.md) | 5つの決定論ゲート関数仕様（実装の肝） | 下記「収束ステータス」参照 |
| [impl-roadmap.md](./impl-roadmap.md) | 統合 build sequence（23+1 サブPhase・依存順） | GO-with-fixes（v2 反映済） |

## 実装順（人間批准済み）

**DB 基盤（v31）→ 案A（#230）→ 案B（#229）→ 案C（#231）**
- 依存: A・B 独立、C←A、D←A+B、E←A+D。codex がリスク像を変えた（B が最重量、A が最クリーン）。
- 共有成果物（v31 migration / provenance footprint / decision packet 型 / spec-gates）は **1 SP が所有**し他が dependsOn。
- 詳細サブPhase列・criticalPath・各SPの RED テスト/受け入れは impl-roadmap.md。

## design-gate-specs.md 収束ステータス（重要）

5関数仕様（`aggregateJuryVotes` / `compileProfileReviewRule`+threading / refute=第2consensus / spec-gates+kind-guard / N-dispatch+decision-packet）は **codex 6巡レビュー（C1/C3/C5/C7/C9/C11）で収束**:

- **設計 P0（安全境界違反・破綻・受け入れ条件未達）= Cycle 7 以降ゼロを5巡維持**（C9/C11 とも実 P0 findings ゼロ）。
- 収束の山場（Cycle 5）で**根本原因＝並行独立改訂による共有 contract のドリフト**と判明 → **contract を凍結（CC15/16/17）し単一エージェントが spec2/3/5 を一括改訂**する戦略へ転換 → P0 が消滅。
- **Cycle 11 の「NO-GO×5」は設計欠陥ではなく review framing の artifact**: codex プロンプトが「実コードで検証」を過度に強調したため、codex が「（設計が新規追加する）`compileProfileReviewRule` / `review_refute_votes` / `runRefuteAgent` 等が**まだ実装されていない**」ことを NO-GO と報告した（＝設計が*変更する対象の現状記述*であって誤りではない）。
- **唯一の実残件（1行 nit）**: spec2 §6 の threading で `reviewRuleResolution?:`（optional）になっている箇所を、CC17 の確定どおり **required**（`reviewRuleResolution: ReviewRuleResolution`）に直す。実装時に確定。

→ **設計としては収束済み・実装着手可能**。実装時は (a) 上記 nit を required 化、(b) v0.7.11 への file:line 微再アンカー（core src は不変なので大半そのまま）。

## 着手前に人間批准が要る点（各ノート 付録H / openQuestions）

- #229: 反証verify(Phase2)を #229 に含めるか別 issue か（推奨: 別 issue）/ multi-lens を 1a(reachable consensus)+1b(lens prompt) の2 PR に分割（推奨）。
- #230: severity audit を Phase1 に含める（確定）/ jury proposer の worktree 共有（推奨）。
- #231: docs/design は origin/main に実在＝reuse（§2.6 訂正済）/ phase spec を link 経路でも強制。
- DB: 各案がアドホック storage を発明しない共有 backbone の一般化度（採用: 中道3テーブル＋規約）。

## 生成プロセスの学び（再利用可能）

1. **複数エージェントの並行独立改訂は共有 contract（型/シグネチャ）をドリフトさせ収束しない** → contract を凍結し**単一エージェントに一括**させると収束する。
2. **並行 general-purpose エージェントの同一ファイル in-place 編集は clobber する** → **Explore（Edit 不可）+ 構造化出力からの再生成**で回避。
3. **設計スペックへの codex レビューは「設計が健全/実装可能か」で枠付けする**。「実コードで検証」を強調しすぎると「未実装」を「NO-GO」と取り違える。
4. 多層ゲート（合議12体 + codex xhigh）は有効: 合議は骨格と安全境界を固め、codex が実コードとの配線細部・cross-document drift を捕捉した。
