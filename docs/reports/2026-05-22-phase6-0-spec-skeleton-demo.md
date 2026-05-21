# Phase 6-0 — DB migration / dashboard spec skeleton

**Date:** 2026-05-22
**Trigger:** `tmp/phase6/phase-6-0.md`（Phase 6-0 設計）
**Scope tag:** （Phase 6-0、close タグなし）

## 目的

DB 完全移行の意味、Phase 6/7/8 の境界、file compatibility 方針、ダッシュボードが
DB read model を使い read-only であることを明文化する。コードは書かない。

## 成果物

- `docs/specs/db.md`（新規）— DB read model 仕様。source-of-truth transition
  （Phase 6 read-side / Phase 7 write-side / Phase 8 complete）、`.harness/harness.sqlite`、
  schema v1 のテーブル一覧、repository layer、importer の idempotency、consistency
  checker。`index.sqlite` deprecation。
- `docs/specs/dashboard.md`（新規）— DB-backed read-only project-aware ダッシュボード
  仕様。`DashboardSnapshot`、`dashboard export`（静的 HTML、Phase 6 の UI 成果物）、
  `dashboard serve`（任意 stretch）、mutation を持たない read-only 保証。
- `docs/specs/README.md` — ToC に db.md / dashboard.md を追加。
- `docs/specs/workflow.md` — 「Phase 6: DB read model」節を追加。
- `docs/superpowers/plans/2026-05-22-phase6-dashboard-db.md` — 総合設計（overview）を配置。

## 壁打ちで確定した方針の反映

外部実装計画 `tmp/phase6-dashboard-db-migration-implementation-plan.md` を土台に、
壁打ちの 4 調整を反映した（`tmp/phase6/00-overview.md` §2）:

1. `dashboard serve` を Phase 6 コアから外し任意 stretch に（UI 成果物は `export`）。
2. Phase 6 スコープを「最小 viable」に絞る（write-side 用テーブルは Phase 7+）。
3. `DashboardDataSource` seam を残す。
4. Phase 5 整合性修正は「コード照合で確認 → 確認分を importer 前に」（6-1）。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 2 / P2: 2。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | db.md / workflow.md が「file → DB 構築」と言いつつ「file を消しても再構築」と書き、依存方向が逆転 | 「`harness.sqlite` を消しても file から再構築」「依存方向は file → DB の一方向」に修正 |
| P1 | db.md / dashboard.md が確定仕様を cli.md に委譲しているが cli.md は旧 Phase 4-8 のまま | 「実装フェーズで cli.md に追記/反映する（6-0 時点では未掲載）」に修正 |
| P2 | workflow.md の Phase 6 節に target-spec の caveat が無い | 「Phase 6 実装中（target spec）」の blockquote を追加 |
| P2 | dashboard.md が未作成の close レポートを参照（dangling） | 「Phase 6 の close レポート（`docs/reports/`）に記録」に一般化 |

## テスト

コード変更なし。`npm run typecheck` / `npm test` は不変（651 pass / 1 skip）。

## Close 条件

- [x] DB 移行の定義（6/7/8 境界）が明文化されている。
- [x] ダッシュボードが DB read model を使い read-only であることが明文化されている。
- [x] `index.sqlite` → `harness.sqlite` の置き換え方針が書かれている。
