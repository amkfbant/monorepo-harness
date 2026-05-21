# Phase 6-7 — DashboardSnapshot from DB

**Date:** 2026-05-22
**Trigger:** `tmp/phase6/phase-6-7.md`（Phase 6-7 設計）
**Scope tag:** （Phase 6-7、close タグなし）

## 目的

ダッシュボードの source of truth を「DB から生成した `DashboardSnapshot`」にする。
file scan をしない。project health / provenance / drift も含める。

## 成果物

- `src/dashboard/snapshot.ts`:
  - `DashboardSnapshot` 型 — `generatedAt` / `dbPath` / `dbSchemaVersion` /
    `importedRuns` / `consistencyStatus` / `filters` / `projects[]` /
    `overview` / `inbox` / `recentRuns[]` / `backlog` / `knowledge` / `warnings[]`。
  - `buildDashboardSnapshot()` — `DbDashboardDataSource` の aggregate +
    `checkConsistency`（6-4）+ per-project `ProjectSummary` を 1 オブジェクトに集約。
  - `loadDashboardSnapshot()` — DB を開き、auto-import（既定 true、`reset` で
    full refresh）してから snapshot を構築。DB 不在 + `autoImport: false` は
    `DashboardSnapshotError`。
  - `ProjectSummary` — domain/run 数、generated policy の有無、consistency status。

## 設計

- ダッシュボードは file scan をせず snapshot を読む。
- DB 不在時は既定で auto-import（operator surprise 回避）、CI 用に
  `autoImport: false`。
- `warnings[]` に consistency drift / import_errors を載せ、stale な DB を
  operator が認識できる。
- project health は新テーブルを作らず、import 済み `policy_generations`
  provenance + consistency checker から導出（`project_check_results` は Phase 7+）。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 1 / P2: 1。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | `hasGeneratedPolicy` が `project_id` のみで判定し、repo.id 変更時に stale な generation を継承しうる | `project_id` + `repo_id` 両方で照会 |
| P2 | `projects[]` が常に global で、他 section が filtered なのと不整合 | `projects[]` も filter で scope（filtered snapshot が内部整合） |

## テスト

- `tests/unit/dashboard/snapshot.test.ts`（5 件）— DB 不在からの auto-import、
  `autoImport: false` での error、project filter（aggregate + projects[]）、
  consistency warning。
- `npm run typecheck` green。`npm test` 722 pass / 1 skip（Phase 6-7 で +5）。

## Close 条件

- [x] `DashboardSnapshot` が DB から生成される（file scan しない）。
- [x] project health / provenance / drift が snapshot に含まれる。
- [x] DB 不在時の auto-import 挙動が明示的。
