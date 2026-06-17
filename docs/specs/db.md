# DB（harness.sqlite）

**Phase 6 で導入。** Phase 5 close まで、harness の state は `runs/` / `projects/`
/ `policies/` / `backlog/` / `docs/knowledge*` の **file が source of truth**で、
SQLite（`index.sqlite`）は run 一覧の派生キャッシュにすぎなかった。Phase 6 は
DB への完全移行の第一歩として、**DB を read model（読み取りの正式な集約先）**に
する。

実装: `src/db/`。

> **ステータス: Phase 19 close 済み（現状仕様）。** DB read model（Phase 6）/
> DB-first write path（Phase 7）/ runtime DB complete（Phase 8）/
> concurrency + runtime completion（Phase 9）/ DB-only runtime completion
> （Phase 10）/ review governance（Phase 11）/ mutation + operation audit
> （Phase 13）/ human-authored assets DB canonical（Phase 14）/ DB operations
> （Phase 15）/ blob storage scale-out（Phase 16）/ DB canonical platform
> integration（Phase 17）/ MCP confirmation + invocation audit（Phase 18）/
> hitch convergence（Phase 19）はいずれも `src/db/` / `src/workspace/` /
> `src/mcp/` / `src/hitch/` に実装済み。schema の確定値は `src/db/schema.ts`
> （`MIGRATION_V1_STATEMENTS`〜`MIGRATION_V33_STATEMENTS`、
> `SCHEMA_VERSION = 33`）。下記「Phase 7」以降の節はいずれも現状仕様。設計書は
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

> **v17（agent workspaces）**: additive な `workspaces` テーブルを追加。`harness
> workspace`（[`cli.md`](./cli.md#harness-workspace)）が作る per-agent git worktree
> の **index**。git が worktree の存在・branch の正本で、この行は git が持たない
> harness 側メタ（`objective` / advisory `hitch_id`（FK なし＝hitch 削除で cascade
> しない）/ `last_active_at` heartbeat / `status active|archived`）を持つ。
> `UNIQUE(repo_path, agent)` で 1 agent 1 行。`list` 時に git worktree 一覧と突き
> 合わせ、git 側に無い行は **stale** として扱う（runs の「meta は DB・worktree は
> disk」と同じ git-authoritative パターン）。`WorkspaceRepository`（`src/db/
> repositories/workspaces.ts`）。
>
> **v18（workspace checkpoints）**: append-only な `workspace_checkpoints`（`harness
> workspace checkpoint`）。LLM の advisory narrative（`note`）＋ その時点の決定論
> スナップショット（`head_sha` / `dirty_count` / advisory `hitch_id`）。`workspaces`
> への FK は `ON DELETE CASCADE`。recover は git/hitch から正本状態を再構成し最新 note を
> **文脈として**重ねる（note は状態の根拠にしない＝§0 非対称）。
>
> **v19（operational knowledge — issue #57）**: `knowledge_entries` に `category`
> 列（`codebase` / `operational`、DEFAULT `codebase`、CHECK 制約）を additive に
> 追加。codebase 知識（run 由来の candidate → promote → coder prompt 注入）に対し、
> **operational 知識**（toolchain / CI / 環境 / harness 運用の学び）を並列カテゴリ
> として持つ。operational は **candidate ステージを持たず**（信用しない生成元が無い
> ので gate 不要）operator が直接著述し、`knowledge_entry_revisions` の履歴 /
> deprecate 機構を再利用する（entry_id は `ops/` namespace。DB-canonical だが、
> `knowledge ops export/import` で **`docs/ops-knowledge/<kind>/<key>.md`** に round-trip
> できる＝codebase 知識の `docs/knowledge/` importer とは別 namespace で衝突しない。
> `db import --from-files` は自動取り込みしない）。**安全境界**:
> `listCurrentKnowledgeRevisions` は `category='codebase'` を **fail-closed default**
> とし、coder prompt 用の `buildKnowledgeContextFromDb` は codebase のみを集約する。
> operational 知識が coder prompt に混入することは構造上あり得ない。core は
> `src/core/operational-knowledge.ts`（+ `operational-knowledge-files.ts`）。

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

schema v25 で `runs` に実行環境 provenance の nullable columns を追加する:
`harness_version TEXT`（実行した harness の `package.json` version）/
`schema_version_at_run INTEGER`（run 作成時点の `SCHEMA_VERSION`）/
`codex_model TEXT`（現状は常に NULL。harness は model を指定せず codex config
既定に委ねるため、将来 model を明示指定できるようになったときの予約列）/
`codex_binary_version TEXT`（`<codexBin> --version` の stdout 1 行目を trim。
取得失敗時 NULL）/ `prompt_sha256 TEXT`（codex に渡した組み立て済み prompt 全文の
SHA-256 hex）。これらは DB-only の監査メタデータで、`meta.json` compatibility export
や file import 形式には含めない。file import で復元された run は NULL のまま。

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
  - runtime child rows は parent の `source_mode != 'db-first'` 削除に追随して削除し、
    その後 orphan prune する。対象には `run_usage` も含み、per-invocation の
    複数行も `run_id` 単位でまとめて削除する。

db import --from-files --force-legacy-reconcile
  - 明示指定時のみ db-first run / backlog row の files 上書きを許す（災害復旧用途）
```

### backlog read path（現状仕様）

`backlog_items` / `backlog_run_links` は backlog の canonical state。`backlog add`
と `hitch finding defer --backlog` は `db-first` row を作り、`backlog done` /
`backlog defer` / `backlog run` も DB を先に更新する。したがって read path も
DB を正本にする。

- `harness backlog list` / `show` は DB が存在する root では DB から full item
  （`goal` / `tags` / `created_at` / `backlog_run_links` を含む）を読む。
- read の直前に通常の file import refresh を実行し、file-only の legacy YAML を
  `legacy-file` row として取り込む。`db-first` row は import で上書きしないため、
  export 前・export 失敗後の DB-only backlog item も一覧・詳細に出る。
- `.harness/harness.sqlite` が存在しない旧 root では、後方互換のため従来の
  `backlog/<status>/*.yaml` read に fallback する。
- `backlog/<status>` が export 失敗などで directory ではない場合、import は
  `import_errors` に記録してその status dir を skip し、DB read 自体は継続する。

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

runtime parent を削除する reset では、`run_events` / `artifacts` /
`run_context_packs` / `run_usage` などの child rows も同じ parent 境界で削除する。
`run_usage` は v30 以降 1 run 複数行になり得るため、reset / force reconcile は
`run_id` 単位で既存 usage rows を削除し、files からは再構築しない。
DB-first parent の child rows は保持し、parent が存在しなくなった child rows は orphan
prune で削除する。

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
- **`HARNESS_EXPORT_FILES` の default OFF 化** — Phase 9 close で即 flip。移行
  warning は **opt-in（#79）**: 既定 silent、`HARNESS_WARN_EXPORT_MODE=1` で一度だけ
  表示（`HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1` は opt-in 時も抑制）。breaking
  change として close report で強周知済み。
- **truncated artifact の original 情報** — `artifacts.original_bytes` /
  `original_sha256` 記録。`db stats` で truncated 統計表示。

## Phase 10 — DB-only runtime completion（close 済み・現状仕様）

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
`purpose='compat-export'` は schema 上 **reserved for future use**（post-review
P3）。Phase 10 内では INSERT も SELECT も行わない。`run_materializations`
を読む queries は `WHERE purpose = 'scratch'` を必ず明示し、将来 compat-export
が混入しても誤動作しないようにする。`purpose='compat-export'` 行を実際に
書き始める計画は Phase 15（`db doctor` が compat export の TTL/orphan を
見る必要が出たとき）に判断する。

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

clean finalize SQL は次の guard を組み合わせる (post-review P1):

```sql
UPDATE runs
   SET status='failed',
       failure_reason='lease-stolen',
       lease_lost_at=:now,
       state_version=state_version+1
 WHERE run_id=:runIdA
   AND status='coding'
   AND lease_lock_id=:lostLockId;
```

`AND lease_lock_id=:lostLockId` を含めることで、A が catch してから finalize
までの間に同じ `run_id` が rerun されて新 lease を保持していても、A は
自身が失った lease の行のみを finalize する (= live attempt を誤って fail
にしない)。state_version bump で state transition として記録する。

`db doctor` の minimum orphan 検出（Phase 15 待たず Phase 10-2 で fixture
として書く）:

```sql
-- expired but not released
SELECT * FROM domain_locks
WHERE released_at IS NULL AND expires_at < datetime('now', '-1 minute');

-- orphan in-progress run (post-review P3: NOT EXISTS for NULL safety)
SELECT r.* FROM runs r
WHERE r.status = 'coding'
  AND NOT EXISTS (
    SELECT 1 FROM domain_locks dl
    WHERE dl.lock_id = r.lease_lock_id
      AND dl.released_at IS NULL
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

#### Operation transaction flow (post-review P2)

review process の operation は `BEGIN IMMEDIATE` で開始する単一 transaction
内で次を実行する:

1. **operation claim** — `(operation_type='review.process', target_run_id,
   idempotency_key)` で `operations` row を SELECT。succeeded で
   `request_hash` 一致 → 既存結果を返す。succeeded で hash 違 →
   `OperationReplayConflictError`。running → `OperationInFlightError`。failed
   → 再 claim（`status='running'` 更新）。row なし → INSERT。
2. **proposal CAS** — 上記の guard SQL を実行。`changes=0` → operation を
   `status='failed', error_code='state_conflict'` 化 → `StateConflictError`。
3. **decision INSERT + run state update** — `review_decisions` INSERT、
   `runs.state_version` bump（`WHERE run_id=:runId AND state_version=
   :expectedStateVersion`）。失敗 → `StateConflictError`。
4. **operation 完了** — `operations.status='succeeded'`, `result_json` 保存。

`request_hash = sha256(canonical_json({proposal_id, source_sha256,
expected_status, expected_state_version, decision_payload}))`。同一意図の
再送と別意図の同 key 衝突を区別する。

#### state_version rollout (post-review P2)

`runs.state_version DEFAULT 0` の migration を入れた瞬間から、bump 対象
writer が全て同一 migration boundary 内で bump するよう統一する。途中状態
(state_version 列はあるが bump しない writer が残る) は CAS が
false-positive を返し review process が永続的に conflict になる。

Phase 10 は次の順序で land:

- **Phase 10-3** (`run_materializations` + `runs.state_version DEFAULT 0`
  migration を schema v6 として追加)：**state_version は読まない / bump
  しない**。
- **Phase 10-5** (CAS 有効化 + 全 bump 対象 writer 更新 + lease-stolen
  finalize guard を 1 commit / 1 sub-phase で land)。

Phase 10-3 と Phase 10-5 の間で review process CAS を有効化してはいけない。

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

`SCHEMA_VERSION = 33`（`src/db/schema.ts`）。

| Version | Phase | 主な内容 |
|---|---|---|
| 1〜4 | Phase 6〜8 | runtime DB completion |
| 5 | Phase 9 | domain_locks / review_proposals / artifacts.original_* / runs.lease_* |
| 6 | Phase 10 | run_materializations / runs.state_version |
| 7 | Phase 11 | reviewers / review_rules / run_review_rule_snapshots / review_consensus / review_overrides + review_proposals/decisions additions |
| 8 | Phase 13 | operations audit ledger 拡張 + operation_events + idempotency partial index |
| 9 | Phase 14 | project_profile_revisions / policy_templates / effective_policy_snapshots / knowledge_entry_revisions / asset_exports |
| 10 | Phase 15 | doctor_runs / doctor_findings / repair_actions / backup_catalog / archive_catalog / db_stats_snapshots |
| 11 | Phase 16 | blob_stores / external_artifact_blobs / blob_migration_jobs |
| 12 | Phase 17 | artifacts rebuild (`storage='external'` 許容) + runs の asset 帰属列 |
| 13 | Phase 18 | mcp_confirmation_requests / mcp_sessions / mcp_tool_invocations |
| 14 | Phase 18 | mcp_confirmation_requests.permission_snapshot_json |
| 15 | Phase 18 | mcp_sessions.reported_client_* / mcp_confirmation_requests.error_message |
| 16 | Phase 19 | hitch_sessions / hitch_attempts / hitch_review_cycles / hitch_findings / hitch_close_checks / hitch_convergence_decisions（v20 で goal_* から rename） |
| 17 | agent workspaces | workspaces |
| 18 | workspace checkpoints | workspace_checkpoints |
| 19 | operational knowledge (issue #57) | knowledge_entries.category（additive 列・新規テーブル無し） |
| 20 | goal→hitch rename (SP-0) | goal_* の6テーブル＋全 goal_id 列を hitch_* / hitch_id に rename（index も） |
| 21 | course → phase roadmap layer (SP-1) | courses / phases / phase_hitches（additive。既存テーブル変更なし） |
| 22 | audit cleanup #126 | 未配線の db_stats_snapshots ledger を DROP（index 先、table 後）。`DROPPED_TABLE_NAMES` で現行 table 集合から除外 |
| 23 | audit fix #130 | hitch_lifecycle_events（reopen/close/cancel reason の audit-only ledger） |
| 24 | audit fix #131 | `review_proposals.prompt_provenance_json`（reviewer prompt template と injected operational knowledge の audit-only provenance） |
| 25 | telemetry provenance B1 | `runs` に実行環境 provenance 列（harness/schema/codex binary/prompt sha。`codex_model` は NULL 予約） |
| 26 | telemetry usage C2 | `run_usage`（Codex token usage。v30 で per-invocation key に再作成。`exact` / `unavailable` を記録、`parsed_log` / `estimated` は予約） |
| 27 | telemetry snapshots E1 | `metrics_snapshots`（live aggregate の append-only stored projection。snapshot caller と retention prune を同時実装） |
| 28 | telemetry follow-up F4 | `domain_lock_contention`（run log 作成前の domain lock busy を append-only に記録する純テレメトリ） |
| 29 | course-ext G4 | `hitch_lifecycle_events.event` CHECK を rebuild で拡張し `pr_adopted` / `updated` を許容（v23 の FK/NOT NULL/index は維持） |
| 30 | token-usage G1 | `run_usage` を `(run_id, kind, seq)` primary key へ再作成。既存行は `kind='coder', seq=0` で移行し、snapshot payload schema は 2 |
| 31 | epic #228 / #230 deliberation jury A1 | `jury_classification_proposals` / `jury_classification_refutations` / `jury_severity_audits`（合議制 classification jury の append-only 監査入力表。FK ゼロ・business-key に `deliberation_id` を含む。詳細は下記「schema v31」） |
| 32 | epic #228 / #229 refute votes | `review_refute_votes`（refute consensus の append-only 監査入力表。FK ゼロ・DB-only・partial UNIQUE。詳細は下記「schema v32/v33」） |
| 33 | epic #228 / #231 phase review-state CAS | `phases.review_state_version INTEGER NOT NULL DEFAULT 0`（`review_state_json` の将来 CAS 書込用 additive 列。新規 table 無し） |

## Phase 11 — Review governance / consensus（close 済み・現状仕様）

Phase 11 は `review_proposals` を governance layer に拡張する。設計は
[`../superpowers/specs/2026-05-24-phase11-review-governance-consensus-design.md`](../superpowers/specs/2026-05-24-phase11-review-governance-consensus-design.md)、
元計画は `tmp/phase10-16-design-plans/phase11-review-governance-consensus-plan.md`。

### schema v7 (Phase 11-1)

新規 5 tables:
- `reviewers` — reviewer identity registry (default: human / codex / codex-security / system)
- `review_rules` — rule template history (per project/repo/domain × version)
- `run_review_rule_snapshots` — run-level effective rule freeze
- `review_consensus` — computed consensus rows (superseded_at で履歴)
- `review_overrides` — human override audit

`review_proposals` 追加 columns: `reviewer_id` (FK, nullable; legacy 互換) /
`reviewer_type` / `model` / `prompt_sha256` / `context_pack_id` /
`policy_generation_id` / `lifecycle_status` / `archived_at`。

schema v24 で `prompt_provenance_json TEXT` を nullable 追加。`review auto`
（codex 由来）は reviewer に実際に送信した最終 prompt 文字列
（`PROMPT_PREAMBLE` + operational knowledge section）の SHA-256 を harness 側で
決定論的に計算し、`review_proposals.prompt_sha256` に格納する。同じ insert で
`prompt_provenance_json` に
`{template:{name,version},knowledge:[{entryId,version}]}` を JSON として保存する。
`review process` の file 由来 legacy import は prompt を持たないため、
`prompt_sha256` / `prompt_provenance_json` は NULL のままにする。

`prompt_sha256` と `prompt_provenance_json` は監査用 read-only メタデータであり、
convergence / mutation gate / review・hitch の状態遷移判定には使わない。

`review_decisions` 追加 columns: `consensus_id` / `proposals_summary_json`。

### Reviewer identity

Phase 11 で reviewer は string ではなく `reviewer_id` (FK to `reviewers`)。
既存 string 列 `review_proposals.reviewer` は legacy 互換のため温存。
`UnknownReviewerError` で unknown reviewer は CLI exit 1。新規登録する
`reviewer_id` は path-safe（`[A-Za-z0-9][A-Za-z0-9._-]{0,127}`、`..` 不可）でなければ
ならない。これは `review auto` が reviewer 別 artifact を
`runs/<runId>/reviewers/<reviewer_id>/` に分離するための境界でもある。

`ReviewerRepository.listByGroup(group_id)` は reviewer dispatch の決定論境界であり、
該当 reviewer を `reviewer_id ASC` で返す。空 group / 未登録 group は空配列を返す。

### Review rule snapshot

`run_review_rule_snapshots(run_id, rule_json, source_sha256)` で run 作成時
に effective rule を freeze。project profile を後変更しても進行中 run の
review semantics は変わらない。consensus mode で explicit `reviewer_ids` がある
requirement は、この snapshot 内の reviewer set が hitch orchestrator の expected
participant set になる。後から reviewer registry に同じ group の reviewer を追加しても、
その run の consensus 評価・再評価・stall timeline には入らない。

### Consensus evaluator

pure function: `evaluateConsensus(rule, proposals, override?) → {status,
summary}`。tie-break: `rejected > changes_requested > approved > pending`。
human override が最優先。production wiring は `review_proposals` の active row を
`reviewer_id ASC, proposal_id ASC` に正規化してから enrichment / evaluation するため、
proposal の insertion order や reviewer dispatch order は `summary.proposals` /
`sourceProposalIds` / `required_changes` の順序に影響しない。unknown reviewer は
`group_id = NULL` として enrichment され、per-group requirement では満たさない側に倒す。
rule snapshot に frozen `reviewer_ids` がある場合、`processReviewDecision` と
`recordConsensusReEvaluation` は active proposal をその reviewer set で filter してから
評価する。frozen set 外の同一 group proposal は quorum / blocking / stall timeline に
効かない。

`review_consensus` の active row は `superseded_at IS NULL` で run 単位 1 つ
(partial unique index)。re-evaluate (新 proposal insert 時や hitch pending catch) は
supersede。status guard、rule snapshot 読込、frozen-set filter、評価、active row insert は
同一 immediate transaction 内で行う。

### Human override

`review_overrides(override_id, run_id, consensus_id?, actor_reviewer_id,
decision, reason, ...)`。`rule.overrides.allowedReviewers` に含まれない
actor は `UnauthorizedOverrideError`、reason 空は `OverrideReasonRequiredError`。
`run_events` に `review_override` event を追加。

### Proposal lifecycle

`lifecycle_status`: `active` / `superseded` / `processed` / `rejected_stale`
/ `archived`。consensus / process は `active` (+ historical `processed`) のみ。
`harness review proposals vacuum --older-than <N>d` で古 superseded /
rejected_stale / processed を `archived` 化 (delete はしない)。

## Phase 13 — mutation API + operation audit（close 済み・現状仕様）

Phase 13 は Phase 7-5 の軽量 `operations` ledger（`operation_id` / `command`
/ `scope_type` / `scope_id` / `result_json` / `created_at`）を **audit ledger
shape** へ拡張する。dashboard mutation API（[`dashboard.md`](./dashboard.md)）が
書く operation の状態遷移・入出力・error を一元記録するのが目的。

### schema v8

- `operations` への列追加（すべて nullable / DEFAULT 付き。Phase 7-12 で
  `processReviewDecision` 等が insert した legacy 行は影響しない）:
  `operation_type` / `target_type` / `target_id` / `actor` /
  `idempotency_key` / `dry_run` / `status`
  （`pending`/`running`/`succeeded`/`failed`/`cancelled`、DEFAULT `succeeded`）/
  `input_json` / `error_code` / `error_message` / `started_at` /
  `completed_at` / `metadata_json`。
- 新規 index: `operations_idempotency_idx`（`(operation_type, target_id,
  idempotency_key)` UNIQUE partial — `idempotency_key IS NOT NULL`）/
  `operations_target_idx` / `operations_status_idx`。
- 新規テーブル `operation_events` — operation ごとの timeline（state
  transition / side-effect log）。`(operation_id, seq)` unique、`operations`
  への FK ON DELETE CASCADE。

Phase 13 minimum では `operation_confirmations` は作らない（CSRF token で
十分。confirmation UX は Phase 18 の MCP 経路で別途導入）。

## Phase 14 — human-authored assets DB canonical（close 済み・現状仕様）

Phase 14 は project profile / policy template / knowledge entry markdown と
いった **人手 authored asset** を DB canonical 化する infrastructure を入れる。
revision ベースの history テーブルと、compat-export 追跡 ledger を追加する。

### schema v9

- `project_profile_revisions` — project profile YAML の version 履歴
  （`(project_id, version)` unique）。`projects.current_profile_revision_id`
  が最新 revision を指す（既存 row は NULL、Phase 14-2 import が version=1 を
  作って pointer を更新）。`harness project import` と file bulk import は、
  revision 記録と同一 transaction で `projects` / compat `project_profiles` /
  `domains` へ write-through する（冪等 upsert + profile 単位の domains replace）。
- `policy_templates` — repo/project/domain/global scope ごとの policy
  template 履歴（`(scope_type, scope_id, version)` unique）。
- `effective_policy_snapshots` — per-run / per-scope の生成済み policy +
  provenance（`policy compile` が再生成する derived table）。
- `knowledge_entry_revisions` — knowledge entry markdown body の version
  履歴（`(entry_id, version)` unique）。`knowledge_entries.current_revision_id`
  が最新を指す。codebase / operational（v19）の両カテゴリで共用する。
- `asset_exports` — compat-export した files の sha + status（`synced` /
  `dirty` / `removed`）を `(asset_type, asset_id, relative_path)` 単位で追跡。

## Phase 15 — DB operations / doctor / archive / backup（close 済み・現状仕様）

Phase 15 は DB 自体の健全性検査・修復・archive・backup を DB-backed にする
infrastructure を入れる（CLI は [`cli.md`](./cli.md) の `harness db doctor` /
`db archive` 系を参照）。

### schema v10

- `doctor_runs` / `doctor_findings` — `db doctor` の実行と検出結果。
  `doctor_findings` は severity（`info`/`warn`/`error`/`critical`）/ status
  （`ok`/`flagged`/`resolved`）/ `repairable` を持つ。
- `repair_actions` — finding に対する修復 action（dry_run / status / 結果）。
- `backup_catalog` — `db backup` 出力のカタログ（schema_version / size /
  sha256 / verified_at / status `available`/`missing`/`failed`）。
- `archive_catalog` — detach 済み archive の range とステータス
  （`attached`/`detached`/`missing`）。
- `db_stats_snapshots` — `db stats` の時系列スナップショットとして v10 で追加されたが、
  production caller / retention prune / downstream consumer が無く未配線だったため、schema v22 で
  `db_stats_snapshots_created_idx` → `db_stats_snapshots` の順に DROP された。
  v10 DDL / `V10_TABLE_NAMES` / `ALL_TABLE_NAMES` は migration history として残し、
  latest schema で存在すべき table は `CURRENT_TABLE_NAMES`
  （`ALL_TABLE_NAMES - DROPPED_TABLE_NAMES`）で表す。

## Phase 16 — blob storage scale-out（close 済み・現状仕様）

Phase 16 は artifact body の external blob store（local / S3）への退避を可能に
する catalog + repository を入れる。Phase 16 minimum では infrastructure のみで、
`artifacts.storage` の CHECK（`IN ('file', 'db')`）はこの時点では据え置き。
`storage='external'` 行を実際に書けるようにするための table rebuild は Phase 17
（schema v12）で行う。それまで新テーブルは migration 準備用の manifest store。

### schema v11

- `blob_stores` — external store の登録（`store_type` `local`/`s3` /
  `config_json` / status `active`/`disabled`）。
- `external_artifact_blobs` — store 上の blob manifest（`sha256` PK /
  `store_id` FK / `uri` / `bytes` / `stored_bytes` / `content_encoding`
  `identity`/`gzip` / status `available`/`missing`/`corrupt`）。
  `external_artifact_blobs_store_idx`（`(store_id, uploaded_at)`）。
- `blob_migration_jobs` — `db-to-external` / `external-to-db` の移行 job
  （input/result/error）。

## Phase 17 — DB canonical platform integration（close 済み・現状仕様）

Phase 17 は Phase 16 の BlobStore infrastructure を実際の runtime storage 状態に
昇格させ、runs に query 可能な asset 帰属列を追加する。

### schema v12

- `artifacts` を rebuild し `storage` CHECK を `IN ('file', 'db', 'external')`
  に拡張（SQLite は in-place な CHECK 変更ができないため `artifacts_v12` を
  作って `INSERT … SELECT` → `DROP` → `RENAME`）。`blob_sha256` /
  `body_status` / `original_bytes` / `original_sha256` は引き継ぐ。
- `runs` に asset 帰属列を追加: `project_profile_revision_id`（FK →
  `project_profile_revisions`）/ `effective_policy_snapshot_id`（FK →
  `effective_policy_snapshots`）/ `knowledge_revision_ids_json`。`meta_json`
  は lossless 文書のまま残し、これらの列は dashboard / doctor / archive が
  JSON scan なしで provenance を引けるようにする query index。
- 新規 index: `runs_project_profile_revision_idx` /
  `runs_effective_policy_snapshot_idx`。

## Phase 18 — MCP confirmation + invocation audit（close 済み・現状仕様）

Phase 18 は MCP（`harness mcp serve`）経由の tool 実行に confirmation gate と
invocation 監査を入れる。mutation tool は preview を作って confirmation を
要求し、confirm 後に同一 permission snapshot で実行する。実装は
`src/mcp/`（`src/mcp/tools/mutation-tools.ts` 等）。

### schema v13

- `mcp_confirmation_requests` — confirmation request（`tool_name` /
  `operation_type` / `target_*` / `input_json` / `preview_json` / status
  `pending`/`confirmed`/`rejected`/`expired`/`consumed` / `expires_at` /
  `consumed_operation_id`）。`mcp_confirmation_status_idx`（`(status,
  expires_at)`）。
- `mcp_sessions` — MCP session（`client_name` / `transport` /
  `permission_snapshot_json`）。
- `mcp_tool_invocations` — tool 呼び出し監査（`arguments_sha256` /
  redacted 引数 / `result_status` / `operation_id` / `confirmation_id`）。
  session FK + `(session_id, started_at)` / `(tool_name, started_at)` index。

### schema v14

- `mcp_confirmation_requests.permission_snapshot_json`（DEFAULT `'{}'`）—
  confirmation は preview を作った時と同じ MCP permission snapshot 下で実行
  する。`harness mcp serve` が渡した `--config` が `operation confirm` の
  out-of-band な config reload で失われないようにする。

### schema v15（post-review hardening）

- `mcp_sessions.reported_client_name` / `reported_client_version` —
  permission identity を、client が initialize で自己申告した metadata と
  分離して保持する。
- `mcp_confirmation_requests.error_message` — confirmation handler の失敗を
  記録し、request が `confirmed` の中間状態で stuck しないようにする。

## Phase 19 — hitch convergence controller（close 済み・現状仕様）

Phase 19 は runs / reviews / operations / backlog の上位に **hitch レベルの
control plane** を追加する。frozen scope・close 条件・attempt・review cycle・
finding 分類・close-check 証跡・convergence decision を記録し、反復的な agent
作業が scope を無限に広げる代わりに converge / defer / escalate できるように
する。feature spec は [`hitch-convergence.md`](./hitch-convergence.md)、実装は
`src/hitch/`。

### schema v16（v20 で goal_* → hitch_* / goal_id → hitch_id に rename）

- `hitch_sessions` — hitch session（`status` `open`/`in_progress`/`close_ready`
  /`closed`/`diverging`/`budget_exhausted`/`escalated`/`cancelled` /
  `scope_json` / `close_conditions_json` / `policy_json` / budget 列
  `max_iterations`/`max_review_cycles`/`max_reruns`/`max_total_new_findings`
  / `current_iteration` / `current_review_cycle` / `created_source`
  `cli`/`mcp`/`dashboard`/`worker`/`import`）。
  `hitch_sessions_status_idx` / `hitch_sessions_project_idx`。
- `hitch_attempts` — hitch 内の attempt（`attempt_type`
  `plan`/`implement`/`fix-review`/`rerun`/`validate`/`close-check`/
  `classify-findings`/`defer-followups` / status / `operation_id` /
  `run_id` / `parent_attempt_id`）。hitch FK ON DELETE CASCADE。
- `hitch_review_cycles` — review cycle（`review_mode`
  `initial`/`delta`/`close`/`regression`/`manual` / findings_* カウンタ）。
  `(hitch_id, cycle_number)` unique。
- `hitch_findings` — 分類済み finding（`stable_key` / `duplicate_of` /
  `source` / `severity` `P0`〜`P3`/`info` / `scope_status`
  `in_scope`/`out_of_scope`/`unknown`/`duplicate` / `lifecycle_status`
  `open`/`fixed`/`reopened`/`deferred`/`duplicate`/`out_of_scope`/
  `escalated`/`accepted_risk` / `deferred_backlog_item_id`）。
  `hitch_findings_stable_idx`（`(hitch_id, stable_key)` partial unique WHERE
  `duplicate_of IS NULL`）/ `hitch_findings_hitch_status_idx`。
- `hitch_close_checks` — close 条件ごとの check 証跡（status
  `pending`/`passed`/`failed`/`skipped`/`unknown` / `evidence_json`）。
  Autonomous command close checks store stdout/stderr artifacts under
  `runs/<runId>/close-checks/` and reference them from `evidence_json`; they do
  not write evidence into the target repo tree.
- `hitch_convergence_decisions` — convergence decision（`decision`
  `continue`/`needs_fix`/`needs_classification`/`close_ready`/`closed`/
  `diverging`/`budget_exhausted`/`escalate`/`cancel` / `reason` /
  `metrics_json` / `recommended_next_action`）。hitch FK ON DELETE CASCADE。
- `hitch_lifecycle_events` — `reopened` / `closed` / `cancelled` /
  `pr_adopted` / `updated` の audit-only
  ledger（`event_id` PK / `hitch_id` FK ON DELETE CASCADE / `reason` /
  optional `detail_json` / `created_at` / `created_by`）。`reopenSession` は
  status update と event insert を同一 transaction で行う。`updateStatus`
  経由の close/cancel、`adoptPr`、`updateSessionConfig` も同じ ledger に記録するが、
  状態判定の source of truth は
  `hitch_sessions.status` と deterministic convergence 入力であり、この ledger は
  convergence / rollup の遷移根拠には使わない。

`hitch_convergence_decisions` は audit ledger であり、decision を記録すると同時に
`hitch_sessions.status` を遷移させる（`src/hitch/convergence-status.ts` の
`statusForConvergenceDecision`）。詳細な状態連携は
[`workflow.md`](./workflow.md) の「Phase 19」節を参照。

## SP-1 — course → phase roadmap layer（schema v21）

SP-1 は hitch 実行層の**上位**に course → phase のロードマップ構造を追加する additive
migration。既存テーブルへの変更はゼロ。機能仕様は
[`roadmap.md`](./roadmap.md)、実装は `src/roadmap/`。

### schema v21（新規 3 テーブル）

- **`courses`** — ロードマップ上位の initiative（`course_id` PK / `project_id`
  nullable / `repo_id` nullable / `title` / `description` / `status`
  `active`|`paused`|`closed` DEFAULT `active` / `created_by` / `created_source` /
  `created_at` / `updated_at`）。`courses_project_idx(project_id, status)`。
  MCP read の `allowedProjects` visibility gate が `project_id` を参照する（null は
  project-restricted client に fail-closed invisible）。
- **`phases`** — course 配下の自己参照ツリー（`phase_id` PK / `course_id` FK →
  courses ON DELETE CASCADE / `parent_phase_id` nullable FK → phases ON DELETE
  CASCADE / `title` / `position` INTEGER DEFAULT 0 / `status`
  `pending`|`in_progress`|`closed`|`blocked` DEFAULT `pending` / `scope_json` /
  `close_conditions_json` / `review_state_json` / `created_by` / `created_source` /
  `created_at` / `updated_at`）。`phases_course_idx(course_id, parent_phase_id,
  position)` で tree walk を効率化。
- **`phase_hitches`** — hitch と phase の 1:1 リンクテーブル。`hitch_id` が **PK**
  (= 1 hitch は最大 1 phase にしか属せない。スキーマレベル強制) / `phase_id` FK →
  phases ON DELETE CASCADE / `linked_at`。`phase_hitches_phase_idx(phase_id)`。

3 テーブルはいずれも **DB-only**（compat file export なし / consistency entry なし）。
`hitch_*` / `workspaces` と同じ先例。

## Audit cleanup #126 — db_stats_snapshots drop（schema v22）

schema v22 は未配線だった DB stats snapshot/delta ledger を削除する一方向
migration。既存ポリシーどおり no-downgrade で、v22 へ上げた DB を古い harness が
開けないことは許容する。migration は冪等にするため `IF EXISTS` を使い、index を先に
落としてから table を落とす。

```sql
DROP INDEX IF EXISTS db_stats_snapshots_created_idx;
DROP TABLE IF EXISTS db_stats_snapshots;
```

append-only 規約により、v10 の DDL と `V10_TABLE_NAMES` は書き換えない。
`ALL_TABLE_NAMES` は「migration history 上で作成された全 table」、`DROPPED_TABLE_NAMES`
は後続 migration で意図的に削除された table、`CURRENT_TABLE_NAMES` は latest schema で
存在を期待する table 集合を表す。fresh migration test と `db stats` の row-count 対象は
`CURRENT_TABLE_NAMES` を使う。

## Telemetry usage C2 — run_usage（schema v26）

schema v26 は additive な `run_usage` を追加し、schema v30 は同じ table name のまま
per-invocation 粒度へ再作成する。latest schema では 1 run に coder / reviewer /
evaluator の各 invocation が複数行入り得る。Codex CLI structured JSONL
(`codex-events.jsonl`) の `turn.completed.usage` だけを入力にし、LLM の自然文・
自己申告テキストは usage source にしない。書き込み経路は: coder（`workflow-runner`、G1）、
reviewer（`reviewer-agent`、publish 直後に全 outcome で記録、G2）、evaluator
（`review-evaluator`、`dbPath` 指定時のみ per-sample 記録、G2）。いずれも fail-open で、
記録失敗は run/review/evaluation の成否に波及しない。書込可能な DB ハンドルを持たない経路
（例: `dbPath` 無しの `review auto`）は記録なし（unavailable のまま）。
`db import --from-files --force-legacy-reconcile` では `run_usage` を削除し、files から
再構築しない（行なし = usage 未収集）。削除は `run_id` 単位なので、同一 run に複数
usage rows があっても全て置き換え境界に含まれる。
`db import --from-files --reset` でも legacy-file run が reset で消える場合、その
`run_usage` は child row として削除する。DB-first run の `run_usage` は canonical state
として保持する。

```sql
CREATE TABLE run_usage (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  kind TEXT NOT NULL
    CHECK (kind IN ('coder','reviewer','evaluator')),
  seq INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  reasoning_output_tokens INTEGER,
  total_tokens INTEGER,
  usage_source TEXT NOT NULL
    CHECK (usage_source IN ('exact','parsed_log','estimated','unavailable')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, kind, seq)
);
CREATE INDEX run_usage_run_idx ON run_usage(run_id);
```

v30 migration は既存 v26 rows を `kind='coder'`, `seq=0` として `INSERT ... SELECT`
で移行してから旧 table を drop / rename する。`V26_TABLE_NAMES` /
`CURRENT_TABLE_NAMES` の table 名は引き続き `run_usage` のまま変わらない。
`model` は現状 `NULL`。`seq` は同一 `(run_id, kind)` 内で
`COALESCE(MAX(seq) + 1, 0)` により採番し、採番と INSERT は同じ `BEGIN IMMEDIATE`
transaction 内で行う。usage 記録は fail-open で、記録失敗は run を止めない。
`usage_source` の意味論:

- `exact` — Codex CLI structured events の `turn.completed.usage` から決定論的に取得。
  複数 turn は token fields を合算する。
- `unavailable` — events file が無い、空、JSON parse 不可、または
  `turn.completed.usage` が無い。token fields はすべて `NULL`。
- `parsed_log` / `estimated` — 将来予約。C2 では書き込まない。

`total_tokens` の正規定義は `input_tokens + output_tokens`。`reasoning_output_tokens`
は別列であり、total に二重加算しない。

## Telemetry snapshots E1 — metrics_snapshots（schema v27）

schema v27 は additive な `metrics_snapshots` を追加する。これは
`metricsSummary` / `hitchMetricsSummary` / `tokenUsageSummary` /
`mcpConfirmationSummary` の live aggregate を、ある時点の read model として保存する
append-only projection である。stored snapshot は rollup と同じ導出値であり、
live 集計の正本性や lifecycle 判定を変えない。E2 の delta/trend はこの snapshot を
消費するが、正本は引き続き既存 tables と aggregate repository である。

```sql
CREATE TABLE metrics_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  project_id TEXT,
  repo_id TEXT,
  domain TEXT,
  payload_json TEXT NOT NULL,
  payload_schema INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX metrics_snapshots_created_idx
  ON metrics_snapshots(created_at);
CREATE INDEX metrics_snapshots_scope_created_idx
  ON metrics_snapshots(project_id, repo_id, domain, created_at);
```

`snapshot_id` は `msnap-<uuid>`。`project_id` / `repo_id` / `domain` は snapshot の
scope 記録で nullable。現行 writer は `payload_schema=2` を明示し、`payload_json`
は `schema: 2` / `capturedAt` / `filter` と、4 つの aggregate payload
（`metricsSummary`, `hitchMetricsSummary`, `tokenUsageSummary`,
`mcpConfirmationSummary`）を持つ JSON。schema 2 の `tokenUsageSummary` は
top-level totals（kind を問わず exact rows を SUM）に加えて
`byKind.{coder,reviewer,evaluator}` の内訳を持つ。`runsWithUsage` は scoped runs の
distinct count、`bySource` は invocation rows の source 別 count。保存済み
`payload_schema=1` は読み出し時に互換 payload として扱い、kind 内訳は要求しない。
MCP confirmations は global table なので、project/repo/domain scope は適用せず、
date scope のみ aggregate に渡す。

production caller は `harness metrics snapshot`。記録時に retention prune を同じ DB
transaction で必ず実行する。repository の `recordMetricsSnapshot` は 1 行 INSERT、
`pruneMetricsSnapshots` は `created_at < now - retentionDays` を DELETE し、境界時刻
ちょうどの row は残す。旧 `db_stats_snapshots` との違いは、初期実装時点で
caller（CLI）/ retention prune / downstream consumer（E2 delta/trend）が同一 Phase の
契約に含まれており、未配線 ledger として無限成長させない点である。

## Telemetry follow-up F4 — domain_lock_contention（schema v28）

schema v28 は additive な `domain_lock_contention` を追加する。これは
`DomainLockBusyError` が run log 生成前に発生するため `run_events` に残せない
lock-busy 発生回数を数えるための append-only telemetry table である。
lock ownership / lease fencing / state transition の根拠には使わない。

```sql
CREATE TABLE domain_lock_contention (
  contention_id TEXT PRIMARY KEY,
  domain_key TEXT NOT NULL,
  repo_id TEXT,
  domain TEXT,
  holder_run_id TEXT,
  contender_pid INTEGER,
  contender_hostname TEXT,
  observed_at TEXT NOT NULL
);
CREATE INDEX domain_lock_contention_domain_observed_idx
  ON domain_lock_contention(repo_id, domain, observed_at);
```

`contention_id` は `dlc-<uuid>`。`holder_run_id` は busy 判定時に読んだ
active `domain_locks` 行から取得できる場合に記録する。`metricsSummary` は
`lockContentionCount` として `repo_id` / `domain` / `observed_at` の scope を適用して
count する。`project_id` 列は持たないため、project scope はこの table には直接適用せず、
repo/domain/date scope のみを使う。

## Course external fixes G4 — hitch lifecycle event enum（schema v29）

schema v29 は `hitch_lifecycle_events.event` の CHECK 制約を rebuild で拡張し、
`pr_adopted` と `updated` を追加する。SQLite は CHECK 制約を直接変更できないため、
`PRAGMA foreign_keys = OFF` → `hitch_lifecycle_events_v29` 作成 → `INSERT ... SELECT`
で既存行移行 → 旧 table drop → rename → index 再作成 → `PRAGMA foreign_keys = ON`
の順で実行する。v23 の DDL 契約は完全維持する: `hitch_id` は
`hitch_sessions(hitch_id) ON DELETE CASCADE`、`reason` と `created_by` は
`NOT NULL`、index は `hitch_lifecycle_events_hitch_idx(hitch_id, created_at)`。

この migration は audit table の enum だけを広げる。`hitch_sessions.status`、
convergence decision、phase rollup、auto-merge gate の source は変わらない。

## Audit fix #130 — hitch lifecycle events（schema v23）

schema v23 は additive な `hitch_lifecycle_events` を追加する。`hitch reopen
--reason` の reason と actor、`hitch close` / `hitch cancel` の reason と actor を
永続化し、cancel reason の取りこぼしをなくす。現行 schema では v29 により
`pr_adopted` と `updated` も同じ audit-only ledger に記録できる。

```sql
CREATE TABLE hitch_lifecycle_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  hitch_id TEXT NOT NULL REFERENCES hitch_sessions(hitch_id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (event IN ('reopened','closed','cancelled','pr_adopted','updated')),
  reason TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX hitch_lifecycle_events_hitch_idx
  ON hitch_lifecycle_events(hitch_id, created_at);
```

この table は監査ログであり、hitch の状態遷移や phase rollup の判定には使わない。

## epic #228 / #230 deliberation jury（schema v31）

schema v31 は合議制 classification jury（issue #230）の 5-stage 熟議
（Stage 1 propose / Stage 3 critique / Stage 4 refute / severity audit）を永続化する
**append-only の監査入力 3 テーブル**を additive 追加する。LLM 出力はこの 3 表に
だけ載り、状態遷移は決定論ゲート `aggregateDeliberation` の結果だけが駆動する
（LLM の自己申告で状態を書き換えない）。

backbone 準拠（[`docs/design/proposals/design-db-persistence.md`](../design/proposals/design-db-persistence.md)）:

- **FK ゼロ**: 3 表とも `FOREIGN KEY` を一切宣言しない。`finding_id` が権威キー、
  `hitch_id` は denorm advisory。親 purge 後も行は残る（doctor が orphan を報告）。
  insert 時に `finding_id → hitch_findings.hitch_id` の一致を harness 側で検査し、
  不一致は reject（fail-closed・repository / consistency 層の責務）。
- **business-key に `deliberation_id` を含む**: prompt_sha256 を再利用する retry
  （gate input = refuter verdict が変わる）を別行にし、decision packet の
  `deliberation_id` と常に一致させる（design §0.1 R15）。
- **`V31_TABLE_NAMES`** を新設し `ALL_TABLE_NAMES` union に追加。`CURRENT_TABLE_NAMES`
  と live な `sqlite_master`（`schema_migrations` / `sqlite_%` を除く）の exact-match
  health check で union の宣言漏れ・余分の双方向 drift を検出する。
- **同番号衝突 guard（R12）**: `runMigrations` は適用ループ前に
  `assertMigrationNameIntegrity` を実行し、`schema_migrations` の既適用 version の
  `name` が `MIGRATIONS` 定義の期待 `name` と一致するか検査する。別 branch が同一
  version を別 name で先取りした場合（version-only dedup による silent skip で
  #230 DDL が永久未適用になる罠）を throw で検出する（fail-closed）。

### ① `jury_classification_proposals`（Stage 1/3）

```sql
CREATE TABLE jury_classification_proposals (
  proposal_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id           TEXT NOT NULL,
  hitch_id             TEXT NOT NULL,
  run_id               TEXT,
  lens                 TEXT NOT NULL
    CHECK (lens IN ('correctness','scope_fit','spec_adherence')),
  reviewer_id          TEXT NOT NULL,
  proposed_scope       TEXT NOT NULL
    CHECK (proposed_scope IN ('in_scope','out_of_scope','unknown')),
  proposal_status      TEXT NOT NULL
    CHECK (proposal_status IN ('complete','timeout','parse_error','inconclusive'))
    DEFAULT 'complete',
  confidence           REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  reasoning            TEXT,
  model                TEXT,
  prompt_sha256        TEXT NOT NULL,
  prompt_provenance_json TEXT,
  usage_kind           TEXT,
  usage_seq            INTEGER,
  audit_dir_path       TEXT,
  round                INTEGER NOT NULL DEFAULT 1 CHECK (round IN (1,2)),
  evidence_json        TEXT,
  refutation_condition TEXT,
  uncertainty          TEXT,
  vote_changed         INTEGER CHECK (vote_changed IN (0,1)),
  critique_json        TEXT,
  deliberation_id      TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX jury_classification_proposals_dedup_idx
  ON jury_classification_proposals(finding_id, lens, reviewer_id, round, prompt_sha256, deliberation_id);
CREATE INDEX jury_classification_proposals_delib_idx   ON jury_classification_proposals(deliberation_id);
CREATE INDEX jury_classification_proposals_finding_idx ON jury_classification_proposals(finding_id, lens);
CREATE INDEX jury_classification_proposals_hitch_idx   ON jury_classification_proposals(hitch_id, finding_id);
```

`round=1` は独立提案、`round=2` は批判後の再投票（`vote_changed` / `critique_json`
は R2 のみ）。business-key に `round` を含むため R1/R2 は別行。

### ② `jury_classification_refutations`（Stage 4・新表）

```sql
CREATE TABLE jury_classification_refutations (
  refutation_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id           TEXT NOT NULL,
  hitch_id             TEXT NOT NULL,
  run_id               TEXT,
  target_scope         TEXT NOT NULL CHECK (target_scope IN ('in_scope','out_of_scope')),
  refute_verdict       TEXT NOT NULL CHECK (refute_verdict IN ('uphold','refute','inconclusive')),
  counter_evidence_json TEXT,
  reasoning            TEXT,
  reviewer_id          TEXT NOT NULL,
  model                TEXT,
  prompt_sha256        TEXT NOT NULL,
  prompt_provenance_json TEXT,
  usage_kind           TEXT,
  usage_seq            INTEGER,
  audit_dir_path       TEXT,
  deliberation_id      TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX jury_classification_refutations_dedup_idx
  ON jury_classification_refutations(finding_id, target_scope, reviewer_id, prompt_sha256, deliberation_id);
CREATE INDEX jury_classification_refutations_delib_idx   ON jury_classification_refutations(deliberation_id);
CREATE INDEX jury_classification_refutations_finding_idx ON jury_classification_refutations(hitch_id, finding_id);
```

`target_scope` は Stage 4 起動時の unanimous verdict 単一値。

### ③ `jury_severity_audits`（severity advisory）

```sql
CREATE TABLE jury_severity_audits (
  audit_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id           TEXT NOT NULL,
  hitch_id             TEXT NOT NULL,
  run_id               TEXT,
  harness_severity     TEXT NOT NULL CHECK (harness_severity IN ('P0','P1','P2','P3','info')),
  jury_severity        TEXT          CHECK (jury_severity IN ('P0','P1','P2','P3','info')),
  audit_status         TEXT NOT NULL CHECK (audit_status IN ('aligned','diverged','inconclusive')),
  escalate_flag        INTEGER NOT NULL DEFAULT 0 CHECK (escalate_flag IN (0,1)),
  reasoning            TEXT,
  model                TEXT,
  prompt_sha256        TEXT NOT NULL,
  usage_kind           TEXT,
  usage_seq            INTEGER,
  jury_votes_json      TEXT,
  deliberation_id      TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX jury_severity_audits_dedup_idx   ON jury_severity_audits(finding_id, prompt_sha256, deliberation_id);
CREATE INDEX jury_severity_audits_finding_idx ON jury_severity_audits(hitch_id, finding_id);
```

severity audit は advisory（`hitch_findings.severity` や close 判定には波及しない）。
doctor 配線は A3（下記）で実装済み。decision-packet（`packetVersion: 2` の MCDA packet）
への配線も実装済みで、jury split / refuter veto / 弱証拠 / stale の escalate packet と
severity 乖離の advisory packet を classify runner / orchestrator が組み立てて
`hitch_convergence_decisions.recommended_next_action` に永続化する（workflow.md
「finding 分類」参照）。

### repository（A2）

3 表それぞれに insert 専用 repository（`src/db/repositories/jury-*.ts`）。すべて
`class { constructor(private readonly db) }` 形で、共通ヘルパ
`assertFindingHitchConsistency`（`src/db/jury-consistency.ts`）を insert 前に呼ぶ。

- **fail-closed 整合検査**: insert する前に `finding_id` が `hitch_findings` に
  存在し、かつ stored `hitch_id` が input の `hitchId` と一致するかを検査する。
  finding 不在は throw（`finding_id ... not found`）、hitch_id 不一致は throw
  （`hitch_id mismatch`）。FK が無い（backbone P1-1）ため、この検査が denorm
  `hitch_id` の整合性を担保する（design §0.1 R5/P2f）。
- **business-key dedup**: `INSERT OR IGNORE` で business-key UNIQUE index が
  重複を黙って捨てる。`deliberation_id` を business-key に含むため、prompt_sha256
  を再利用する retry（別 deliberation）は別行になり packet と常に一致する（R15）。
- **JSON 列**: `evidence_json` / `counter_evidence_json` / `jury_votes_json` /
  `critique_json` / `prompt_provenance_json` は値が `undefined`/`null` のときのみ
  `null` を格納し、それ以外は `JSON.stringify`。`evidence`/`juryVotes`（必須 array）
  は空配列でも `'[]'` で round-trip する。proposal の `evidence_json` は
  `VerifiedJuryEvidence`（`verifyEvidence` 通過後）を保存する（verify は Layer 1/2
  で上流処理・repository は検証しない＝design §0.1 R1）。

### doctor 拡張（A3）

FK ゼロの 3 表は、親 purge / denorm drift / packet 不整合を doctor が**事後監査
で報告**する（自動修復はしない＝state 遷移は harness のみ）。check は
`src/db/jury-doctor-checks.ts` に定義し `DEFAULT_CHECKS` に登録する。category は
既存 union の `'review'` を流用（design §0.1 R11）。すべて advisory（severity
`warn`・`repairable:false`）で、DELETE は既存 `repairFinding` の operator 承認 gate
に乗る（doctor が勝手に消さない）。

- **`jury.orphan_rows`**: 3 表のいずれかに、対応する `hitch_findings` 行が無い
  audit 行（finding が purge 済み）。FK ゼロゆえ親削除後も残るのが正で、doctor が
  orphan として advisory 報告する。
- **`jury.hitch_mismatch`**: stored `hitch_id` が `hitch_findings` join の
  `hitch_id` と食い違う行（denorm drift）。orphan（join 行が無い）は本 check では
  flag しない（`jury.orphan_rows` が担当）。
- **`jury.refutation_mismatch`**: refutation と proposals/packet の不整合（design
  §0.1 P2h）。(a) `refutation.target_scope` が同一 `deliberation_id` proposals の
  **最終 round（`MAX(round)`）の unanimous な `proposed_scope`** と一致するか（split
  や proposals 不在は比較対象が無く vacuous → flag しない）。(b)
  `hitch_convergence_decisions.recommended_next_action` を **TS でパース**して
  `decisionPacket.deliberation.refuter.refuteVerdict` を取り出し、保存済み
  refutation 行の `refute_verdict` と一致するか。SQL 単独では nested packet に
  届かないため JSON-parse する新 check 形（R11）。壊れた JSON / packet 欠落は防御的
  に skip（doctor を crash させない）。**bundled packet の単一
  `deliberation.refuter` は LEAD split（`findings[0]`）のみを表す**ため、(b) は
  LEAD finding のみと突き合わせる（非 LEAD finding は (a) で各自の per-deliberation
  proposals と検証する。さもなくば非 LEAD が共有 verdict と誤 mismatch する）。
- **`jury.auto_confirm_replay`**（P2b auto_confirm 正当性再検証）: jury 確定
  finding（`classification_reason` が `jury auto_confirm (deliberation_id=<id>)`
  を含む）について、保存済みの最終 round proposals（`selectFinalRound`）+ refutation
  行から `DeliberationInput` を再構成し `aggregateDeliberation` を **replay**。
  `decision==='auto_confirm'` を満たさない finding を advisory flag する（LLM→状態
  直結の疑い＝安全境界の事後監査の機械化）。証拠 JSON の破損は防御的に空配列扱い
  （verified 証拠ゼロ → replay は escalate → 改竄を隠さず surface する）。**replay
  scope-match 監査（codex#254-R6 FIX 2）**: replay が `auto_confirm` を返す場合でも、
  replay の `scope` を finding の保存 `scope_status` と照合する。両者が食い違う行
  （proposals は in_scope に replay するのに保存 `scope_status` が out_of_scope 等、
  決定論ゲートの scope と記録 scope が不一致）も advisory flag する（gate が
  auto_confirm すること自体は再現できても、記録された scope がゲート由来でない
  ＝LLM→状態直結 / 事後改竄の疑い）。

**v31 table-presence guard（codex#254-R5 P2 FIX3）**: これら 4 check は
`DEFAULT_CHECKS` に常駐するが、v31 の 3 表（`jury_classification_proposals` /
`jury_classification_refutations` / `jury_severity_audits`）を **無条件には
query しない**。各 check は実行前に必要な v31 表の存在を
`SELECT name FROM sqlite_master WHERE type='table' AND name=?` で確認し、
**いずれかが欠落していれば finding ゼロで skip**（status `ok`、error を投げない）。
これは migration 前の DB に対して read-only caller が `DEFAULT_CHECKS` を回す経路
（例: `dbRepairDryRunTool` は `withReadonlyDb` ＋ `DEFAULT_CHECKS.flatMap` で
migration を走らせない）で `no such table` crash を起こさないため。表が無い＝監査
対象の jury 行も無いので skip は安全（fail-open。隠れた不整合は生じない）。v31
適用済み DB での挙動は guard 前と byte 同一。

### import / export（A3 — DB-only audit）

3 表は **DB-only** の append-only 監査表で、いずれの reset list
（`import-files.ts` の `RESET_TABLES_FILE_DERIVED` / `RESET_TABLES_RUNTIME` /
`RESET_CHILD_TABLES`）にも**追加しない**。よって `runFullImport({ reset: true })`
（read-only scoped command が `withRefreshedDb` 経由で毎回呼ぶ）後も既存の audit 行は
残り、空になるのは fresh DB のみ。FK が無いので親 finding を DELETE しても constraint
error にならず、audit 行は orphan として残る（doctor が報告）。SQLite フル snapshot
backup は全表を自動包含する。

## epic #228 / #229 #231 sequential migrations（schema v32 / v33）

schema v31 は #230 jury 3 表として出荷済みであり、後続の #229 / #231 は
**v31 を変更しない**。#229 の refute vote audit は schema v32、#231 の
phase review-state CAS 用 version 列は schema v33 として逐次適用する。

### v32 `review_refute_votes`

`review_refute_votes` は refute consensus の LLM 出力を保存する **append-only
監査入力表**。この表自体は状態遷移を駆動しない。後続の決定論 gate が
`validation_status='passed'` かつ `refute_verdict IN ('uphold','refute')` の
行だけを入力として扱う。

backbone 準拠:

- **FK ゼロ**: `run_id` / `hitch_id` / `finding_id` / `reviewer_id` は advisory
  provenance ID であり、`FOREIGN KEY` は一切宣言しない。import reset や親 purge
  で FK error を起こさず、監査行は doctor の orphan / hitch mismatch check へ残す。
- **target binding**: `target_change_hash` は app 層が事前計算する
  `sha256(normalizeChangeText(change_text))`。repository は SP-2 以降で
  precomputed hash を保存するだけで、schema migration は hash 関数を持たない。
- **provenance footprint**: `model` / `prompt_sha256` /
  `prompt_provenance_json` / `usage_kind` / `usage_seq` を持ち、`run_usage` とは
  `(run_id, usage_kind, usage_seq)` で相関できる（FK は張らない）。
- **DB-only**: `import-files.ts` の reset list には追加しない。既存 DB の
  `review_refute_votes` 行は `db import --from-files` 後も残り、空になるのは
  fresh DB の場合のみ。SQLite backup はファイル snapshot なので自動包含する。
- **table-name manifest**: `V32_TABLE_NAMES = ['review_refute_votes']` を
  `ALL_TABLE_NAMES` union に追加する。v33 は ALTER のみなので table-name 登録しない。

DDL の現行形:

```sql
CREATE TABLE review_refute_votes (
  refute_id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                TEXT NOT NULL,
  hitch_id              TEXT,
  target_change_hash    TEXT NOT NULL,
  target_change_idx     INTEGER,
  finding_id            TEXT,
  reviewer_id           TEXT NOT NULL,
  refute_verdict        TEXT
    CHECK (refute_verdict IS NULL OR refute_verdict IN ('uphold','refute','inconclusive')),
  confidence            REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  reasoning             TEXT,
  refute_reason         TEXT,
  counter_evidence_kind TEXT
    CHECK (counter_evidence_kind IS NULL OR counter_evidence_kind IN ('diff','test','none')),
  counter_evidence_ref  TEXT,
  refute_condition      TEXT,
  retract_condition     TEXT,
  model                 TEXT,
  prompt_sha256         TEXT NOT NULL,
  prompt_provenance_json TEXT,
  usage_kind            TEXT,
  usage_seq             INTEGER,
  source_yaml           TEXT NOT NULL DEFAULT '',
  source_sha256         TEXT NOT NULL,
  validation_status     TEXT NOT NULL DEFAULT 'rejected'
    CHECK (validation_status IN ('passed','rejected')),
  reject_reason         TEXT,
  created_at            TEXT NOT NULL,
  CHECK (validation_status = 'passed' OR (reject_reason IS NOT NULL AND reject_reason <> '')),
  CHECK (validation_status <> 'passed' OR refute_verdict IS NOT NULL),
  CHECK (validation_status <> 'passed' OR refute_verdict <> 'refute' OR (
    refute_reason IS NOT NULL AND refute_reason <> ''
    AND counter_evidence_kind IS NOT NULL
    AND counter_evidence_kind IN ('diff','test')
    AND counter_evidence_ref IS NOT NULL AND counter_evidence_ref <> ''
    AND refute_condition IS NOT NULL AND refute_condition <> ''
    AND retract_condition IS NOT NULL AND retract_condition <> ''
  ))
);
CREATE UNIQUE INDEX review_refute_votes_passed_idx
  ON review_refute_votes(run_id, target_change_hash, reviewer_id, prompt_sha256)
  WHERE validation_status = 'passed' AND refute_verdict IN ('uphold','refute');
CREATE UNIQUE INDEX review_refute_votes_inconclusive_idx
  ON review_refute_votes(run_id, target_change_hash, reviewer_id, prompt_sha256)
  WHERE validation_status = 'passed' AND refute_verdict = 'inconclusive';
CREATE UNIQUE INDEX review_refute_votes_rejected_idx
  ON review_refute_votes(run_id, target_change_hash, reviewer_id, prompt_sha256, source_sha256)
  WHERE validation_status = 'rejected';
CREATE INDEX review_refute_votes_run_idx ON review_refute_votes(run_id, created_at);
CREATE INDEX review_refute_votes_target_idx ON review_refute_votes(run_id, target_change_hash);
CREATE INDEX review_refute_votes_finding_idx ON review_refute_votes(finding_id, created_at);
CREATE INDEX review_refute_votes_hitch_idx ON review_refute_votes(hitch_id, finding_id);
```

`validation_status='rejected'` は必ず `reject_reason` を持つ。`passed` は必ず
`refute_verdict` を持つ。`passed` かつ `refute_verdict='refute'` の行だけは
反証 DSL の構造化フィールド（reason / diff or test evidence / refute condition /
retract condition）を必須にする。`uphold` / `inconclusive` は降格を駆動しないため、
counter evidence なしでも `passed` にできる。

Repository contract:

- `ReviewRefuteVotesRepository.insert()` writes the v32 footprint columns and
  stores caller-provided `targetChangeHash` as-is. It does not normalize change
  text or recompute hashes.
- `listByRun(runId)` and `listByTarget(runId, targetChangeHash)` return rows in
  append order (`created_at`, then `refute_id`).
- Duplicate rows are deduped only through the v32 partial unique predicates:
  passed `uphold`/`refute` share `(run_id, target_change_hash, reviewer_id,
  prompt_sha256)`, passed `inconclusive` has the same key but a separate
  predicate, and rejected rows include `source_sha256`.
- Because the table has no FKs, insert performs the hard app-layer guard for
  advisory finding binding: a supplied `finding_id` must exist, and a supplied
  `hitch_id` must match `hitch_findings.hitch_id` for that finding.

Doctor coverage:

- **`review_refute_votes.orphan_rows`**: rows with a non-null `finding_id` whose
  parent `hitch_findings` row no longer exists are reported as advisory
  `warn` findings. Rows without `finding_id` are valid provenance rows and are
  not orphan findings.
- **`review_refute_votes.hitch_mismatch`**: rows whose non-null stored
  `hitch_id` disagrees with the `hitch_findings.hitch_id` join are reported as
  advisory `warn` findings. Orphans are handled by `orphan_rows`, not double
  counted here.
- These checks are registered in `DEFAULT_CHECKS`, `category='review'`, with
  `repairable:false`. They are table-presence guarded so a pre-v32 DB skips
  safely instead of crashing in read-only doctor paths.

### v33 `phases.review_state_version`

schema v33 は新規 table を作らず、既存 `phases` に次の additive column だけを追加する。

```sql
ALTER TABLE phases
  ADD COLUMN review_state_version INTEGER NOT NULL DEFAULT 0;
```

既存 phase 行は `review_state_version=0` で移行する。
`PhaseRepository.updateReviewState()` は `transaction().immediate()` 内で
`review_state_json` / `review_state_version` / `scope_json` /
`close_conditions_json` を読み、mutator の結果を
`WHERE phase_id=? AND review_state_version=?` で CAS 書込する。成功時は
`review_state_version` を +1 し、CAS miss は read→merge→retry を最大 3 回
繰り返す。超過時は `ReviewStateConflictError` を throw し、後勝ち overwrite
にはしない。

`recordSpecApproval()` はこの経路を使って namespaced
`review_state_json.specApproval = { approvedBy, approvedAt, reason, specHash }`
を書き込む。`specHash` は TS 側で `[scope, closeConditions]` tuple の
canonical JSON の sha256 として計算する（scalar 連結だと `1`+`23` と `12`+`3` が
ともに "123" に衝突するため、tuple で構造化して衝突を防ぐ）。既存
`setNote()` も同じ CAS 経路を使うため、operator note と spec approval は互いの
key を lost-update しない。v33 は table identity を変えないため
`ALL_TABLE_NAMES` には何も追加しない。
