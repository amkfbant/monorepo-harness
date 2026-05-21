# Phase 6-3 — File importers

**Date:** 2026-05-22
**Trigger:** `tmp/phase6/phase-6-3.md`（Phase 6-3 設計）
**Scope tag:** （Phase 6-3、close タグなし）

## 目的

既存 file artifacts（`runs/` / `projects/` / `policies/` / `backlog/` /
`docs/knowledge/`）を `.harness/harness.sqlite` に取り込む。Phase 6 の DB を満たす
唯一の経路。

## 成果物

- `src/db/import/common.ts` — `sha256`（string/Buffer）、`ImportCounters`、
  `recordImportError` / `clearImportError`。
- `src/db/import/projects.ts` — `importProjects`（`projects/*.yaml` →
  `projects` / `project_profiles` / `domains`）。surrogate `domainKey`。
- `src/db/import/policies.ts` — `importPolicies`（`*.generated.json` +
  `*.yaml` → `policy_generations`）。
- `src/db/import/runs.ts` — `importRuns`（`runs/<id>/` → `runs` /
  `run_events` / `command_results` / `review_decisions` /
  `review_required_changes` / `artifacts` / `run_context_packs` /
  `run_context_pack_files`）。
- `src/db/import/backlog.ts` — `importBacklog`。
- `src/db/import/knowledge.ts` — `importKnowledge`（candidates + entries）。
- `src/db/import-files.ts` — `runFullImport` orchestrator、`ImportReport`、
  `--reset`、`formatImportReport`。
- `src/cli/db.ts` — `harness db import --from-files [--reset] [--json]`。

## 設計

- **idempotent** — run は全 source file（meta + events + review-decision +
  context-pack-manifest + artifact 一覧）の fingerprint を `source_meta_sha256`
  に持ち、一致すれば skip。projects / backlog のタイムスタンプは source file
  の mtime 由来で、再 import で同一 row になる。
- **malformed は `import_errors` に記録**し、throw しない（1 ファイルが import
  全体を止めない）。

## スコープ外（Phase 6-3）

`run_changed_files` / `policy_violations` は diff / artifact 解析が必要なため
Phase 6-3 では populate しない（テーブルは存在）。ダッシュボードは scalar の
`runs.changed_files_count` を使う。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 3 / P2: 2。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | 未変更の再 import でも `updated_at` / `loaded_at` に wall-clock time が入り idempotency 違反 | タイムスタンプを source file の mtime 由来に変更 |
| P1 | run skip が `meta.json` だけを hash し、`review-decision.yaml` 等の変更を見逃す | 全 run source file + artifact 一覧の fingerprint で skip 判定 |
| P1 | `domains` / `knowledge_candidates` の可変長 child が delete-replace されず stale row が残る | project_id / run_id 単位で delete してから再挿入 |
| P2 | malformed な `review-decision.yaml` / `context-pack-manifest.yaml` が silent 無視 | `import_errors` に記録 |
| P2 | artifact hash を UTF-8 decode して算出（binary で不正） | raw Buffer を byte-accurate に hash |

## テスト

- `tests/unit/db/import-files.test.ts`（10 件）— empty tree、normal tree、
  idempotency（skip / 同一タイムスタンプ）、meta 変更での再 import、
  review-decision 変更での再 import、domain 削除の反映、malformed meta /
  review-decision の `import_errors`、`--reset`。
- `tests/integration/cli-db.test.ts` — `db import` の `--from-files` 必須、
  `--from-files --json` のレポート。
- `npm run typecheck` green。`npm test` 683 pass / 1 skip（Phase 6-3 で +13）。

## Close 条件

- [x] Phase 5 close tree 相当を DB に import できる。
- [x] import が fingerprint / mtime で idempotent。
- [x] malformed file が `import_errors` に残る。
- [x] `ImportReport` が出る。
