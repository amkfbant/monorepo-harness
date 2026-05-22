# DB（harness.sqlite）

**Phase 6 で導入。** Phase 5 close まで、harness の state は `runs/` / `projects/`
/ `policies/` / `backlog/` / `docs/knowledge*` の **file が source of truth**で、
SQLite（`index.sqlite`）は run 一覧の派生キャッシュにすぎなかった。Phase 6 は
DB への完全移行の第一歩として、**DB を read model（読み取りの正式な集約先）**に
する。

実装: `src/db/`。

> **ステータス: Phase 7 close 済み（現状仕様）。** DB read model（Phase 6）と
> DB-first write path（Phase 7）はいずれも `src/db/` に実装済み。schema の確定値は
> `src/db/schema.ts`（`MIGRATION_V1_STATEMENTS` / `MIGRATION_V2_STATEMENTS` /
> `MIGRATION_V3_STATEMENTS`）。下記「Phase 7 — DB-first write path」節は
> 現状仕様。設計書は
> [`2026-05-22-phase7-db-first-write-path-design.md`](../superpowers/specs/2026-05-22-phase7-db-first-write-path-design.md)。

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

write-side 用のテーブルのうち、Phase 7 の migration v2 で追加するのは
`export_records` / `exported_files` / `operations` / `pull_requests` /
`cleanup_actions`（下記「Phase 7」節）。`artifact_blobs` / `domain_locks` は
Phase 7 のスコープ外で Phase 8 以降、`project_check_results` は別トラック。

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

## Phase 7 — DB-first write path（close 済み・現状仕様）

Phase 7 は **runtime write path を DB-first 化**した。`runDomainCoding` /
`review` / `rerun` / `cleanup` / `backlog` / `knowledge` / `pr create` が DB
トランザクションを canonical な書き込みとし、files をその compatibility export
にする。

### source-of-truth の反転

Phase 6 では files が write-source、DB が read-source だった。Phase 7 では
runtime state について反転する。

```txt
Phase 7 で DB が canonical:
  run state / run events / review decisions / changed files /
  policy violations / backlog state / knowledge decision state /
  artifact manifest / pull request state / cleanup action records

Phase 8 まで file-backed storage が canonical:
  artifact body（codex-*.log / final-diff.patch / summary）/ large logs /
  patch body / knowledge entry の markdown body（docs/knowledge/**/*.md）
```

「files は DB から導出される compatibility export」という表現は *runtime
workflow state に限って* 正しい。artifact body と knowledge markdown body は
Phase 8 まで file-backed storage のままで、DB はその manifest（path / sha256 /
metadata）と参照整合性のみを持つ。

### `source_mode` invariant（移行中の二重 source 防止）

Phase 7 はサブフェーズごとにコマンドを移行するため、移行途中は DB-first 化済み
コマンドと file-first のままのコマンドが共存する。各 runtime row（`runs` /
`backlog_items` / `knowledge_candidates` / `knowledge_entries`）は
`source_mode ∈ {legacy-file, db-first}` を持つ。

```txt
migration invariant:
  DB-first row（source_mode='db-first'）を対象にする write command は、
  file-first path で files を直接 mutation してはならない。
```

- Phase 6 importer で取り込んだ既存 row は `legacy-file`。DB-first 化した
  コマンドが作成・遷移させた row は `db-first`。
- file-first のまま残るコマンドが `db-first` row を触ろうとしたら `SourceModeError`
  で reject（移行待ちであることを明示）。
- 各 runtime コマンドの entrypoint で `source_mode` を見て DB-first writer か
  legacy writer かにルーティングする。

### state transition guard

status 遷移は expected-status guard を通す。`runs` 行の status update は
`WHERE status IN (expectedStatuses)` 付きで実行し、`changes === 0` なら
`StateConflictError`。event append は同一トランザクション。`run_events` は
`(run_id, seq)` unique。`operation_id` 重複は idempotent no-op（`operations`
ledger に記録）。同 invariant を backlog / knowledge の status 遷移にも適用する。

### export と integrity tracking

各 write コマンドは DB commit 直後に影響範囲を scoped export する
（`src/db/export-files.ts`）。file は temp file へ書いて rename する atomic
write。run directory は export 進行中を示す `.exporting` marker を使う
（crash 時に未完了 export を検出できる）。export 成否は
`export_records` / `exported_files` に記録し、`runs.export_status`
（`synced` / `dirty` / `failed`）/ `last_export_revision` / `last_exported_at`
を更新する。export 失敗は rollback しない（commit 済み DB が canonical）。
`db check-consistency` と再 export で回復する。

### import semantics（Phase 7）

source-of-truth が反転するため、stale な files で DB-first row を巻き戻さない。

```txt
db import --from-files
  - legacy-file row: 従来どおり upsert
  - db-first run / backlog item: skip（DB が canonical。files は export 出力で
    あって import 元ではない）
  - db-first knowledge candidate: content（kind/title/body）のみ upsert し、
    decision state（status/decided_at/reviewer/reason）は保持
  - --reset でも runtime テーブルは source_mode != 'db-first' の行のみ削除
    （read-only scoped command が db-first 行を legacy-file へ demigrate しない）

db import --from-files --force-legacy-reconcile
  - 明示指定時のみ db-first run / backlog row の files 上書きを許す（災害復旧用途）
```

### db export-files（Phase 7-11）

`harness db export-files` は DB canonical な state の compatibility files を
bulk 再 export する。`--scope run|backlog|knowledge` / `--id <id>` で範囲指定可。
crash・export 失敗・`--reset` import のあとに files を DB から再構築する。

- `run` / `backlog`: `db-first` row の files（`meta.json` / `events.jsonl` /
  `backlog/*.yaml`）を再 export。`legacy-file` row は files が source of truth
  なので対象外。
- `knowledge`: `db-first` decision を持つ run の `knowledge-decisions.yaml` を
  再投影する。promote 済み entry の `.md` body は **file-backed**（`.md` 自体が
  canonical な artifact で人手編集可能）なので DB から再生成しない。

`db check-consistency` は export 追跡も検査する: `export_status` が
`dirty` / `failed` の runtime 行、`exported_files.sha256` と実ファイルの drift。

### schema v2

Phase 7 で migration v2 を追加する（`runMigrations` は idempotent）。

- `runs` / `backlog_items` / `knowledge_candidates` / `knowledge_entries` に
  列追加: `source_mode` / `db_revision` / `last_export_revision` /
  `export_status` / `last_exported_at` / `last_export_error`。既存 row は
  `source_mode='legacy-file'`。
- 新規テーブル: `export_records` / `exported_files` / `operations` /
  `pull_requests` / `cleanup_actions`。
- `run_events` に `(run_id, seq)` unique 制約。

### スコープ外（Phase 8 以降）

- artifact body / 大型 body の DB 格納（`artifact_blobs`）。
- file export の optional 化（Phase 7 は常に export する）。
- `domain_locks` テーブル（Phase 7 は file lock を維持）。
- project profile / generated policy の write path 自体の DB-first 化。Phase 7
  close のスコープは runtime write path に限定し、`projects/*.yaml` /
  `policies/repos/*.yaml` は user-authored config file のまま（DB は import して
  参照する read model 扱い）。
