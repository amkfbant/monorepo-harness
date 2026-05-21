# Phase 6-2 — DB connection / migrations / schema v1

**Date:** 2026-05-22
**Trigger:** `tmp/phase6/phase-6-2.md`（Phase 6-2 設計）
**Scope tag:** （Phase 6-2、close タグなし）

## 目的

`.harness/harness.sqlite` と schema migration runner を作る。Phase 6 の DB は
files から構築する read model であり、本サブフェーズではそのスキーマ基盤だけを
用意する（importer は 6-3）。

## 成果物

- `src/config/paths.ts` — `dbPath`（`.harness/harness.sqlite`）を追加。
- `src/db/connection.ts` — `openDb()` / `openDbReadonly()`（`better-sqlite3`、
  WAL / foreign_keys / busy_timeout）、`DbError`。
- `src/db/schema.ts` — `SCHEMA_VERSION`、`MIGRATION_V1_STATEMENTS`（v1 DDL、
  20 テーブル + runs index）、`V1_TABLE_NAMES`。write-side テーブル
  （`artifact_blobs` / `project_check_results` / `domain_locks`）は v1 では作らない。
- `src/db/migrations.ts` — `Migration` / `MIGRATIONS` / `runMigrations()` /
  `currentSchemaVersion()` / `readSchemaVersion()`。
- `src/cli/db.ts` — `registerDbCommands()` で `harness db init / migrate / status`。
- `src/cli/run.ts` — `db` コマンド群を登録。

## 設計上の判断

- **FK 制約なし** — read model は file model と同様に dangling 参照を許容する
  （cleanup 済み run を指す backlog link 等）。整合性は importer / consistency
  checker の責務。
- **`domains` は surrogate `domain_key` PK** — composite (repo_id, domain_id,
  project_id) は NULL project_id を PK に含めてしまうため。
- **`artifacts.storage` は `CHECK (storage = 'file')`** — Phase 6 は manifest のみ。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 2 / P2: 2。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | SQLite rowid テーブルでは `TEXT PRIMARY KEY` が `NOT NULL` を含意せず、NULL id が複数挿入されうる | 全単一カラム TEXT PK に `NOT NULL` を明示（11 テーブル） |
| P1 | `runMigrations` が concurrency-safe でない（並行 init/migrate で片方が duplicate-DDL 失敗） | 各 migration を `.immediate()` write transaction で実行し、tx 内で適用済みか再チェック |
| P2 | `openDb` で pragma 失敗時に DB handle が close されず leak | catch で `db?.close()` |
| P2 | `db status` が read-write で開き `schema_migrations` を作成（DB を mutate） | `openDbReadonly()` + 非作成の `readSchemaVersion()` に変更 |

## テスト

- `tests/unit/db/migrations.test.ts` — fresh DB の schema v1 全テーブル / index、
  idempotent migrate、`currentSchemaVersion` / `readSchemaVersion`、未来 version
  reject、非 SQLite ファイルの `DbError`。
- `tests/integration/cli-db.test.ts` — `db init` / `migrate` / `status`、
  未初期化時の status、init / migrate の冪等性。
- `npm run typecheck` green。`npm test` 671 pass / 1 skip（Phase 6-2 で +12）。

## Close 条件

- [x] `.harness/harness.sqlite` を作成できる。
- [x] migration が idempotent（かつ concurrency-safe）。
- [x] `db init` / `migrate` / `status` が動く。
