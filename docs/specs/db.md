# DB（harness.sqlite）

**Phase 6 で導入。** Phase 5 close まで、harness の state は `runs/` / `projects/`
/ `policies/` / `backlog/` / `docs/knowledge*` の **file が source of truth**で、
SQLite（`index.sqlite`）は run 一覧の派生キャッシュにすぎなかった。Phase 6 は
DB への完全移行の第一歩として、**DB を read model（読み取りの正式な集約先）**に
する。

実装: `src/db/`。

> **ステータス: Phase 6 close 済み（現状仕様）。** DB read model は `src/db/` に
> 実装済み。schema の確定値は `src/db/schema.ts`（`MIGRATION_V1_STATEMENTS`）。
> write-side の DB 化は Phase 7 以降。

## source-of-truth transition

DB 完全移行は 3 フェーズに分けて進める。

```txt
Phase 6: files = write-source,  DB = read-source（importer で files から構築）
Phase 7: DB = write-source,     files = compatibility export
Phase 8: DB complete,           file scan = migration-only
```

**Phase 6 のスコープは read-side のみ。** `harness run` / `review` / `cleanup` /
`pr create` などの write path は従来どおり file へ書く。DB は file から構築する
派生であり、`harness.sqlite` を消しても `db import --from-files` で files から
再構築できる（依存方向は file → DB の一方向）。write path の DB 化は Phase 7 以降。

## DB file

```txt
.harness/harness.sqlite
```

SQLite（`better-sqlite3`）。`PRAGMA journal_mode=WAL` / `foreign_keys=ON`。

既存の `.harness/index.sqlite`（Phase 3-5 の run index）は Phase 6 で **deprecated**。
`harness.sqlite` を正式 DB として一本化する。`index` 系コマンドの扱いは
[`cli.md`](./cli.md) を参照。

## schema version

schema は migration version を持つ。`schema_migrations` テーブルに適用済み
version を記録し、`harness db migrate` が未適用分を idempotent に適用する。

## schema v1 のテーブル

v1 は read-side が必要とするテーブルのみを作る。

| 分類 | テーブル |
|------|---------|
| migration | `schema_migrations` / `db_meta` |
| project | `projects` / `project_profiles` / `domains` |
| policy | `policy_generations` |
| run | `runs` / `run_events` / `command_results` / `run_changed_files` / `policy_violations` |
| review | `review_decisions` / `review_required_changes` |
| artifact | `artifacts`（manifest のみ。`storage='file'`） |
| context pack | `run_context_packs` / `run_context_pack_files` |
| backlog | `backlog_items` / `backlog_run_links` |
| knowledge | `knowledge_candidates` / `knowledge_entries` |
| import | `import_errors` |

`runs` は project / repo / domain / status / parent / root に index を持つ。

`run_events` は `events.jsonl` を取り込む append-only ログ。`runs` は current
state、`run_events` は lifecycle ログという event-sourced 寄りの構成にして、
Phase 7 の write path で監査性を保てるようにする。

> **`run_changed_files` / `policy_violations` は v1 schema に予約済みだが Phase 6
> の importer では populate しない。** file import からは変更 path 一覧・違反
> 一覧をクリーンに取れない（diff / artifact 解析が要る）ため。ダッシュボードは
> scalar の `runs.changed_files_count` を使う。これらは Phase 7（DB-first write
> path）で `runDomainCoding` が in-memory に持つ検証結果から直接 populate される。
> Phase 6 ではこの 2 テーブルは「空が正しい」。

write-side 用のテーブル（`artifact_blobs` / `project_check_results` /
`domain_locks`）は v1 では作らず、Phase 7 以降の migration で追加する。

## repository layer

DB を直接あちこちから触らない。SQL は `src/db/repositories/` に閉じ込め、
ダッシュボード等は repository だけを見る。DB row ↔ TypeScript 型の境界は zod で
検証する。

```txt
src/db/
  connection.ts        接続 + PRAGMA
  migrations.ts        migration runner
  schema.ts            v1 DDL + zod boundary schema
  import-files.ts      files → DB importer
  consistency.ts       DB ↔ files の drift 検出
  repositories/        runs / projects / policies / backlog / knowledge / artifacts / dashboard
```

## importer の idempotency

`harness db import --from-files` は次の契約を満たす。

- **upsert by stable id**（runId / projectId / itemId など）。
- 各 source ファイルの **sha256 を記録**。同じなら再書き込みを skip、変わったら
  replace。何度実行しても同じ DB state になる（idempotent）。
- malformed file は throw せず `import_errors` テーブルに記録して継続。
- destructive ではない。全消去は `--reset` 指定時のみ。

## consistency checker

`harness db check-consistency` が DB と file state のズレ（drift / missing-file /
missing-db）を検出する。ダッシュボードは consistency status を表示し、operator が
古い/壊れた DB を見ていないか判断できるようにする。

## CLI

`harness db` コマンド群の確定仕様は [`cli.md`](./cli.md) の `harness db` 節を参照。

```bash
harness db init               # DB 作成 + schema v1 適用
harness db migrate            # 未適用 migration を適用
harness db status             # schema version / table 数 / path / size
harness db import --from-files # files から DB を構築
harness db check-consistency  # DB ↔ files の drift 検出
```
