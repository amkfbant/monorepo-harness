# Phase 6-6 — Project-aware metrics / inbox / digest / backlog

**Date:** 2026-05-22
**Trigger:** `tmp/phase6/phase-6-6.md`（Phase 6-6 設計）
**Scope tag:** （Phase 6-6、close タグなし）

## 目的

Phase 5 で follow-up に繰り延べた `metrics` / `inbox` / `knowledge digest` /
`backlog list` の `--project` / `--repo-id` filter を DB query として完成させる。

## 成果物

- `src/db/repositories/aggregates.ts` — `metricsSummary` / `inboxSummary` /
  `knowledgeDigest` / `backlogList`。各 `AggregateFilter`（project/repo/domain）対応。
- `src/dashboard/data-source.ts` — `DashboardDataSource` に 4 つの aggregate を追加。
- `src/cli/db-scope.ts` — `hasScopeFilter` と `runScoped{Metrics,Inbox,
  KnowledgeDigest,Backlog}`。DB を files から full refresh して aggregate を出す。
- `src/cli/run.ts` — `metrics summary` / `inbox` / `knowledge digest` /
  `backlog list` に `--project` / `--repo-id`。scope 指定時は DB 経路。

## 設計

- DB 経路の trigger は `--project` / `--repo-id` のみ。`--domain` 単独は trigger
  にしない（`knowledge digest` は既存の file-based `--domain` を持つ）。scope 無し
  なら従来の file-based 経路は不変（後方互換）。
- scoped query は `runFullImport({ reset: true })` で DB を full rebuild してから
  集計する（消えた source の row が残らない）。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 4 / P2: 2。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | scoped query の import が `reset` なしで、消えた source の row が残る | `withRefreshedDb` を `reset: true` に |
| P1 | `inboxSummary` が `status='candidate'` を「未決」扱いだが、import は candidate yaml の status をそのまま入れる（昇格/却下は別 sidecar） | 「candidate を出した run 数」に意味を修正、誤った filter を削除 |
| P1 | scoped `knowledgeDigest.entryTotal` が `knowledge_entries.project_id` で filter するが promoted entry に project 属性がない | `entryTotal` は常に global count（promoted-knowledge の namespace は Phase 5 follow-up と明記） |
| P1 | `backlog_items.repo_id` が常に null で `backlog list --repo-id` が空 | importer が item の project から `projects.repo_id` を導出 |
| P2 | scope 指定時に既存 flag（`--since` / `--status` / inbox の section flag）が silent 無視 | 無視される flag があれば stderr に warning |
| P2 | inbox の needsReview/changesRequested が `listRuns` の default limit 100 で truncate | inbox bucket は unbounded limit |

## テスト

- `tests/unit/db/aggregates.test.ts`（6 件）— metrics/inbox/knowledgeDigest/
  backlog の集計と project scope。
- `tests/integration/cli-db-scope.test.ts`（4 件）— `metrics summary --project`
  / `inbox --repo-id` の DB 経路、空 project、scope 無しの後方互換。
- `tests/unit/db/import-files.test.ts` — backlog item の `repo_id` が project から
  導出される。
- `npm run typecheck` green。`npm test` 717 pass / 1 skip（Phase 6-6 で +11）。

## Close 条件

- [x] metrics / inbox / knowledge digest / backlog が project/repo filter を持つ。
- [x] Phase 5 follow-up（filter）が回収されている。
- [x] ダッシュボードの aggregate を project-aware に作れる（`DashboardDataSource`）。
