# Phase 6-5 — DB-backed run source / filters

**Date:** 2026-05-22
**Trigger:** `tmp/phase6/phase-6-5.md`（Phase 6-5 設計）
**Scope tag:** （Phase 6-5、close タグなし）

## 目的

ダッシュボードの run データ取得を DB query に移し、`runs/` 直接 scan と stale な
`index.sqlite` 依存を断つ。`DashboardDataSource` seam を導入する。

## 成果物

- `src/db/repositories/runs.ts` — `RunRepository`（`listRuns` / `countRuns` /
  `getRun` / `getTimeline` / `getRerunChain` / `getCommandResults` /
  `getReviewDecision`）、`RunFilter`、row 型。
- `src/dashboard/data-source.ts` — `DashboardDataSource` interface（seam）+
  `DbDashboardDataSource`（`RunRepository` に委譲）。
- `src/cli/run.ts` — `harness index` 群に Phase 6 deprecation warning。

## 設計

- `RunFilter`: project / repo / domain / status set / date range / reviewer /
  safetyStatus / limit / offset。SQL は全てパラメータ化。
- legacy run（`project_id = NULL`）は repo filter で包含、project filter で除外。
- `index.sqlite` は deprecated。`index` は legacy `review list --use-index` 用に
  残るが warning を出す。新規 dashboard / metrics は `harness.sqlite` を使う。
- `DashboardDataSource` seam により、ダッシュボードは DB 実装に直接溶接されない
  （壁打ち調整 3）。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 2 / P2: 3。対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | dashboard export がまだ file/index-backed | 6-7（DashboardSnapshot）/ 6-8（export 書き換え）のスコープ。レビューも「scope mismatch」と明記。6-5 は query 層のみ |
| P1 | `getRerunChain` が legacy chain（`parent_run_id` のみ、`root_run_id` 無し）で全体を返さない | recursive CTE で `parent_run_id` を上下に辿る実装に変更 |
| P2 | `statuses: []` が no-filter 扱いで全件返す | 明示的空集合は `0 = 1` で 0 件 |
| P2 | `offset` が clamp されず fractional/NaN/Infinity が SQLite に到達 | `clampInt` で limit/offset とも有限整数に clamp |
| P2 | `countRuns` が全行を materialize | WHERE builder を共有し `SELECT count(*)` に |

## テスト

- `tests/unit/db/run-repository.test.ts`（13 件）— 全 filter、pagination、
  同一 domain の project 分離、legacy run の filter、空 statuses、offset clamp、
  legacy rerun chain、detail メソッド。
- `tests/unit/dashboard/data-source.test.ts` — `DbDashboardDataSource` の委譲。
- `npm run typecheck` green。`npm test` 706 pass / 1 skip（Phase 6-5 で +14）。

## Close 条件

- [x] ダッシュボードの run データ source が DB query になる（query 層）。
- [x] project/repo/domain/status/date filter が DB で動く。
- [x] `DashboardDataSource` seam が入っている。
