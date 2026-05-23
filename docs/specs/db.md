# DB（harness.sqlite）

**Phase 6 で導入。** Phase 5 close まで、harness の state は `runs/` / `projects/`
/ `policies/` / `backlog/` / `docs/knowledge*` の **file が source of truth**で、
SQLite（`index.sqlite`）は run 一覧の派生キャッシュにすぎなかった。Phase 6 は
DB への完全移行の第一歩として、**DB を read model（読み取りの正式な集約先）**に
する。

実装: `src/db/`。

> **ステータス: Phase 8 close 済み（現状仕様）。** DB read model（Phase 6）/
> DB-first write path（Phase 7）/ runtime DB complete（Phase 8）はいずれも
> `src/db/` に実装済み。schema の確定値は `src/db/schema.ts`
> （`MIGRATION_V1_STATEMENTS`〜`MIGRATION_V4_STATEMENTS`、`SCHEMA_VERSION = 4`）。
> 下記「Phase 7 — DB-first write path」「Phase 8 — runtime DB complete」節は
> いずれも現状仕様。設計書は
> [`2026-05-22-phase7-db-first-write-path-design.md`](../superpowers/specs/2026-05-22-phase7-db-first-write-path-design.md)
> /
> [`2026-05-22-phase8-runtime-db-complete-design.md`](../superpowers/specs/2026-05-22-phase8-runtime-db-complete-design.md)。

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

- artifact body / 大型 body の DB 格納（`artifact_blobs`）→ Phase 8。
- file export の optional 化（Phase 7 は常に export する）→ Phase 8。
- `domain_locks` テーブル（Phase 7 は file lock を維持）→ Phase 9。
- project profile / generated policy の write path 自体の DB-first 化。Phase 7
  close のスコープは runtime write path に限定し、`projects/*.yaml` /
  `policies/repos/*.yaml` は user-authored config file のまま（DB は import して
  参照する read model 扱い）。

## Phase 8 — runtime DB complete（close 済み・現状仕様）

Phase 8 は **files を必須でなくす**フェーズ。DB-first write path（Phase 7）に
残った最後の file-canonical な runtime state — **artifact body**（codex ログ /
diff / summary 等）— を DB へ移し、file export を optional にする。完了後は
run を DB だけで運用でき、files は opt-in の互換出力になる。設計の正典は
[`2026-05-22-phase8-runtime-db-complete-design.md`](../superpowers/specs/2026-05-22-phase8-runtime-db-complete-design.md)。
close レポートは
[`reports/2026-05-22-phase8-close.md`](../reports/2026-05-22-phase8-close.md)。

- **artifact body の DB 格納** — `artifact_blobs` / `artifact_blob_chunks` に
  content-addressed（STORED body の sha256 — truncation 後・compression 前）で
  分割保存。oversized は file に逃がさず DB 内に truncated 保存。`artifacts`
  行は `blob_sha256` / `body_status` を持つ。
- **file export の optional 化** — `HARNESS_EXPORT_FILES=0` で
  **compatibility export**（DB から `runs/<id>/` への構造的再 export）を止め
  られる（default ON）。ただし run 実行自体は作業用 run dir に artifact を
  書くため、OFF でも run dir は実行中・完了直後に存在する（後述「file export
  と run dir」）。`export_status` を状態機械化（`synced` / `dirty` / `failed` /
  `disabled` / `removed`）。
- **`db import` の migration-only 化** — 通常 import は DB-first（db-complete）
  row を stale file で上書きしない（runs / backlog item は skip）。災害復旧用の
  上書きは `--force-legacy-reconcile` のみ。
- **DB 運用コマンド** — `harness db backup / restore / checkpoint / vacuum /
  stats`。DB は artifact body（secret を含みうる）の canonical なので permission
  を `0600` 寄りにする。
- knowledge entry markdown / project profile / policy は **file-authored の
  まま**（人手キュレーション対象。Phase 8 の対象は machine-generated runtime
  state に限定）。`domain_locks` の DB 化は Phase 9。

### DB 運用コマンド（Phase 8-8）

artifact body が DB canonical になり files が optional になると、DB は files に
無い情報を持ちうる。よって DB 自体の backup / 復旧が必須になる。

```bash
harness db backup --out <path>      # 一貫した standalone コピーを書き出す
harness db restore --from <path>    # backup で live DB を置換（--force 必須）
harness db checkpoint               # WAL を本体へ checkpoint し truncate
harness db vacuum                   # blob 削除後などの空き領域を回収
harness db stats                    # table 別行数 / DB・WAL サイズ / blob 総量
```

- **backup** — better-sqlite3 の online backup を使い、WAL を含む
  transactionally consistent な単一 `.sqlite` を書き出す（journal sidecar
  なし、writer を block しない）。出力先が既存なら拒否する。
- **restore** — `--from` を SQLite online backup で target dir の temp に
  写し（source の WAL も読むので live DB の copy でも committed data を失わ
  ない）、`integrity_check` / schema version 範囲 / harness core テーブルを
  **temp に対して検証**してから `rename` で atomic に live DB を置換する。
  検証前に失敗すれば live DB は無傷。live DB を自分自身に restore するのは
  拒否。置換後に旧 WAL/SHM sidecar を削除し stale journal の replay を防ぐ。
  live DB が既存なら `--force` を要求する（誤 `--from` での破壊を防ぐ。
  `db backup` を先に取る運用）。**restore は他の harness プロセスが動いて
  いない状態で実行する** — DB ファイルを差し替えるため、旧 DB を開いたまま
  のプロセスは置換後のファイルに書き続けてしまう（harness 全体の DB-wide
  排他ロックは concurrency トラックとして Phase 9）。
- backup / restore は artifact blob を含めて DB 全体を扱うので、files を
  すべて消しても backup から復旧できる。

### permission と secret sensitivity（Phase 8-8）

DB は codex ログ / diff / summary などの artifact body を canonical に持つ。
これらは **secret を含みうる**（コマンド出力中の token、diff 中の credential
など）。したがって:

- `.harness/harness.sqlite` と WAL/SHM sidecar、および `db backup` 出力は
  permission `0600`（owner read/write のみ）に制限する。`openDb` は開くたびに
  best-effort で chmod し、新規 DB が world-readable のまま残らないようにする
  （POSIX mode を持たない FS では no-op）。
- backup ファイルは live DB の完全コピーなので、同じ機密度として扱う。
  共有ストレージや VCS に置かない。
- artifact 取り込み時の `secret_suspect` フラグ（`artifacts.secret_suspect`）は
  DB 内で維持され、dashboard / export はこのフラグを引き継ぐ。secret-shaped な
  untracked artifact は従来どおり redaction の対象。

### file export と run dir（Phase 8 — 運用上の注意）

`HARNESS_EXPORT_FILES=0` は **pure fileless runtime ではない**。OFF にするのは
DB-canonical state から `runs/<id>/` への**構造的 compatibility export**であって、
run 実行そのものは止めない:

- run 実行中、`runDomainCoding` は codex prompt / output ログ / diff /
  summary / review-decision 等を作業用 run dir に書く（codex は worktree を
  編集し、harness は diff・artifact を run dir に組み立てる）。
- run 完了時、finalize の前に `ingestRunArtifacts` がそれら body を DB blob に
  取り込む（`storage='db'`）。以後の canonical は DB blob。
- したがって export OFF でも、run dir は run 実行中・完了直後に存在し、
  artifact files（logs / diff / prompt）がディスク上に残る。run dir は
  `cleanup` または明示削除まで残置される。
- nested artifact（`commands/**`）も `ingestRunArtifacts` が再帰的に DB へ
  取り込む。run dir 直下 / サブディレクトリの regular file が対象（dotfile・
  symlink は除外）。

運用上の含意: DB-only 運用でも、secret / privacy / backup scope を考えるときは
**run dir 上の artifact files も対象**になる。完全に file を残したくない場合は
run 後に `cleanup` で run dir を削除する（DB blob は canonical として残る）。

### `db import --reset` の意味（Phase 8）

`db import --from-files --reset` は **完全な再構築ではない**。file-derived /
legacy-file の行はクリアして再構築するが、**DB-first（db-complete）runtime
行は canonical state として保持**する（stale file が DB-first state を巻き戻す
のを防ぐため、`source_mode != 'db-first'` の行のみ削除）。「DB を files から
丸ごと作り直す」という意図で使うものではない。

## Phase 9 — concurrency + runtime completion（実装中・target spec）

Phase 9 は Phase 8 が残した 2 縦串を閉じるフェーズ。**concurrency safety**
（lease ベースの domain lock + DB-wide reader/writer maintenance lock）と
**runtime DB story の完結**（file export の default OFF、scratch runDir
lifecycle、legacy-file routing 撤去、`review_proposals` の DB canonical 化、
truncated artifact の監査情報）を実装する。設計は
[`../superpowers/specs/2026-05-23-phase9-concurrency-and-runtime-completion-design.md`](../superpowers/specs/2026-05-23-phase9-concurrency-and-runtime-completion-design.md)、
計画は `tmp/phase9-concurrency-and-runtime-completion-plan.md`。確定は
`phase9-close`。

- **schema v5** — `domain_locks` / `review_proposals` / `artifacts.original_*`
  / `runs.lease_*` 追加。
- **DB-wide maintenance lock** — `.harness/db.lock` を flock-based
  reader/writer に。destructive maintenance + schema 系（`db init` /
  `db migrate` / `db restore` / `db vacuum` / `db checkpoint --truncate` /
  `db migrate-*`）が exclusive lock を取り、通常 write は shared、`db backup`
  も shared。
- **DB-backed domain lock** — lease (5min) + heartbeat (1min) + fencing
  token (= lock_id)。`runs.lease_*` で run row に紐付け。run execution stage
  writes は `assertActiveLease` で active な `domain_locks` 行を EXISTS で
  検証する compare-and-swap。post-run writes は既存の expected status /
  operation_id guard のまま。Phase 9 は file + DB の **dual-lock**（runtime
  経路は file lock が primary serialization、Phase 10 で file lock 撤去）。
- **scratch runDir lifecycle** — `HARNESS_EXPORT_FILES=0` で ingest 成功時
  に scratch runDir を削除。ingest failure で保持 + warning。
- **legacy-file routing 撤去** — runtime tables（runs / backlog_items /
  knowledge_candidates）のみ。`knowledge_entries`（markdown = file-authored）
  は対象外。`db migrate-legacy` / `db import --force-legacy-reconcile` は
  bypass。
- **`review_proposals`** — `review auto` の verdict を DB canonical に。
  active partial unique index + `processed_at` で idempotent な promotion。
- **`HARNESS_EXPORT_FILES` の default OFF 化** — Phase 9 close で即 flip +
  warning。`HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1` で抑制可。breaking
  change として close report で強周知。
- **truncated artifact の original 情報** — `artifacts.original_bytes` /
  `original_sha256` 記録。`db stats` で truncated 統計表示。
