# DB（harness.sqlite）

**Phase 6 で導入。** Phase 5 close まで、harness の state は `runs/` / `projects/`
/ `policies/` / `backlog/` / `docs/knowledge*` の **file が source of truth**で、
SQLite（`index.sqlite`）は run 一覧の派生キャッシュにすぎなかった。Phase 6 は
DB への完全移行の第一歩として、**DB を read model（読み取りの正式な集約先）**に
する。

実装: `src/db/`。

> **ステータス: Phase 9 close 済み（現状仕様）。** DB read model（Phase 6）/
> DB-first write path（Phase 7）/ runtime DB complete（Phase 8）/
> concurrency + runtime completion（Phase 9）はいずれも `src/db/` /
> `src/workspace/` に実装済み。schema の確定値は `src/db/schema.ts`
> （`MIGRATION_V1_STATEMENTS`〜`MIGRATION_V5_STATEMENTS`、`SCHEMA_VERSION = 5`）。
> 下記「Phase 7」「Phase 8」「Phase 9」節はいずれも現状仕様。設計書は
> [`2026-05-22-phase7-db-first-write-path-design.md`](../superpowers/specs/2026-05-22-phase7-db-first-write-path-design.md)
> /
> [`2026-05-22-phase8-runtime-db-complete-design.md`](../superpowers/specs/2026-05-22-phase8-runtime-db-complete-design.md)
> /
> [`2026-05-23-phase9-concurrency-and-runtime-completion-design.md`](../superpowers/specs/2026-05-23-phase9-concurrency-and-runtime-completion-design.md)。

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

## Phase 9 — concurrency + runtime completion（close 済み・現状仕様）

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
- **legacy-file routing 撤去** — `runs` + `backlog_items` のみ。
  `knowledge_candidates` は `syncCandidate` が `legacy-file` を「未決定
  marker」として使う運用都合があり scope 外（close レポート § "計画からの
  差分" 参照）。`knowledge_entries`（markdown = file-authored）も対象外。
  `db migrate-legacy` / `db import --force-legacy-reconcile` は bypass。
- **`review_proposals`** — `review auto` の verdict を DB canonical に。
  active partial unique index + `processed_at` で idempotent な promotion。
- **`HARNESS_EXPORT_FILES` の default OFF 化** — Phase 9 close で即 flip +
  warning。`HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1` で抑制可。breaking
  change として close report で強周知。
- **truncated artifact の original 情報** — `artifacts.original_bytes` /
  `original_sha256` 記録。`db stats` で truncated 統計表示。

## Phase 10 — DB-only runtime completion（設計確定・実装中）

Phase 10 は Phase 9 の transition 状態（file + DB の dual-lock / scratch と
compat export が単一 materialize 経路 / viewer が file-first / runtime に
legacy-file 分岐残置 / review process idempotency 緩さ）を閉じるフェーズ。
設計は [`../superpowers/specs/2026-05-23-phase10-db-only-runtime-completion-design.md`](../superpowers/specs/2026-05-23-phase10-db-only-runtime-completion-design.md)、
元計画は `tmp/phase10-16-design-plans/phase10-db-only-runtime-completion-plan.md`。

### schema v6（Phase 10-3 / 10-5）

`SCHEMA_VERSION = 6`。Phase 10 で追加するもの:

#### `run_materializations`

scratch materialize（review/pr/external command 用の一時 file 領域）の
lifecycle を追跡する table。compat-export は **この table を更新しない**
（既存 `exported_files` で tracking）。

```sql
CREATE TABLE run_materializations (
  materialization_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT NOT NULL,
  purpose            TEXT NOT NULL CHECK (purpose IN ('scratch', 'compat-export')),
  path               TEXT NOT NULL,
  reason             TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  expires_at         TEXT,
  cleaned_at         TEXT,
  status             TEXT NOT NULL CHECK (status IN ('active', 'cleaned', 'failed')),
  error_message      TEXT,
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
CREATE INDEX run_materializations_run_idx ON run_materializations(run_id, created_at);
CREATE INDEX run_materializations_expiry_idx ON run_materializations(status, expires_at);
```

Phase 10 minimum viable では `purpose='scratch'` のみ INSERT する。
`purpose='compat-export'` 行を作る経路は Phase 15（`db doctor` が compat
export の TTL/orphan を見る必要が出たとき）に判断する。

#### `runs.state_version`

```sql
ALTER TABLE runs ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;
```

すべての runtime state transition（`RunLog.setStatus` /
`setSafetyStatus` / `processReviewDecision` / `cleanupRun` /
`createPullRequest` / `rerunFromReview`）が `state_version = state_version
+ 1` を CAS 付きで実行する。bump しない write: artifact ingest /
heartbeat / `run_events` INSERT / `run_changed_files` INSERT /
`policy_violations` INSERT。

### DB-only domain lock（file lock 完全撤去）

Phase 10-1 で `src/workspace/domain-lock.ts` の runtime usage は削除。
runtime 経路は `db-domain-lock.ts`（Phase 9 で導入された lease + heartbeat
+ fencing token）のみ。`.harness/locks/<domain>.lock` は読みも書きもしない。

旧 file lock sentinel（`.harness/locks/*.lock`）が残っていた場合は無視 +
1 回 stderr warning（`HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING=1` で
抑制可）。`harness lock migrate` コマンドは **作らない**。

Lock ordering（Phase 10）:

```
1. shared maintenance lock
2. open DB
3. acquire DB domain lock
4. execute
5. release DB domain lock
6. close DB
7. release shared maintenance lock
```

### lease stealing semantics（Phase 10 確定）

dual-lock 撤去で実 hot path となる lease stealing の挙動を確定:

1. **expired lease の steal**: process B が active lease を acquire しようと
   して `expires_at < now` の active 行を見つけたら、`released_at = now,
   release_reason='expired', released_by='steal:<B-info>'` で soft-release
   して新 lease を INSERT。
2. **stale writer reject**: process A の次 guarded write は
   `assertActiveLease(db, { lockId: A's, runId, now })` の EXISTS check に
   失敗し `LeaseLostError` を throw。
3. **unguarded finalize**: workflow-runner が `LeaseLostError` を catch
   して `UPDATE runs SET status='failed', failure_reason='lease-stolen',
   lease_lost_at=now WHERE run_id=:runId AND status='coding'` で clean
   finalize（assertActiveLease を回らない expected-status guard 経路）。
4. **DB safe invariant**: A は B の run row には触れない（run_id 単位で
   分離）。post-run table（review/cleanup/pr/backlog）は触らない。

`db doctor` の minimum orphan 検出（Phase 15 待たず Phase 10-2 で fixture
として書く）:

```sql
-- expired but not released
SELECT * FROM domain_locks
WHERE released_at IS NULL AND expires_at < datetime('now', '-1 minute');

-- orphan in-progress run
SELECT * FROM runs WHERE status = 'coding'
  AND lease_lock_id NOT IN (
    SELECT lock_id FROM domain_locks WHERE released_at IS NULL
  );
```

### Materialization vs export（Phase 10）

| 概念 | API | 更新する table |
|---|---|---|
| scratch materialize | `materializeRun({ purpose: 'scratch', ttlMs, reason })` | `run_materializations` のみ |
| compat export | `exportRun({ purpose: 'compat-export', force })` | `exported_files` + `runs.export_status='synced'` |

scratch handle は `cleanup()` を finally で呼ぶ契約。失敗時は
`HARNESS_KEEP_SCRATCH_ON_FAILURE=1` で path 保持 + `status='failed'` 記録。
`harness db materialize cleanup --expired` で後から回収。

**Invariant（test 化対象）**: `materializeRun({ purpose: 'scratch' })` は
絶対に `exported_files` を更新せず、`runs.export_status` も `synced` に
しない。

### Viewer source mode（Phase 10）

```txt
auto (default):
  source_mode='db-first'   → DB を読む（runDir があっても無視）
  source_mode='legacy-file'→ files を読む（Phase 10 runtime では発生しない）

--source db:
  DB のみ。runDir 在っても無視。legacy-file run は reject。

--source files:
  runDir のみ。debug 用。db-first run でも許可。
```

`runs.export_status` が `disabled / dirty / failed / removed` の場合、auto
モードでも 1 行 warning を表示し、operator が `--source files` を明示する
ことを促す。

### Review process idempotency（Phase 10-5）

`review process` の core mutation は transaction 内で次を全部満たすことを
確認する:

```sql
UPDATE review_proposals SET processed_at = :now, review_decision_id = :decisionId
WHERE proposal_id        = :proposalId
  AND source_sha256      = :expectedSourceSha
  AND processed_at IS NULL
  AND superseded_at IS NULL
  AND run_id             = :runId
  AND EXISTS (
    SELECT 1 FROM runs
    WHERE run_id = :runId
      AND status        = :expectedStatus
      AND state_version = :expectedStateVersion
  );
```

`changes = 0` → `StateConflictError`。CLI / API は最新 proposal の再確認を
ユーザーに促す（CLI UX は `cli.md` Phase 10 節参照）。`operation_id` 重複は
同一結果なら no-op、結果が違えば `OperationReplayConflictError`。

### Runtime legacy branch 撤去範囲（Phase 10-6）

runtime rows（runs / run_events / review_decisions / review_proposals /
artifacts / command_results / run_changed_files / policy_violations /
cleanup records / pr records）への runtime write 経路から
`sourceMode === 'legacy-file'` 分岐を削除。

撤去しない（Phase 14 マター）:

- `project profile YAML` / `policy YAML` / `docs/knowledge/**/*.md`
- `knowledge_entries.body_*` 列

Phase 9-11 で導入した `assertNoLegacyRuntimeRows(db)` 起動 guard は維持。
bypass は `db migrate-legacy` / `db import --force-legacy-reconcile` /
`db doctor` / `db check-consistency`。

### schema versions

| Version | Phase | 主な内容 |
|---|---|---|
| 1〜4 | Phase 6〜8 | runtime DB completion |
| 5 | Phase 9 | domain_locks / review_proposals / artifacts.original_* / runs.lease_* |
| 6 | Phase 10 | run_materializations / runs.state_version |
