# Phase 7 — DB-first write path 設計

**作成日:** 2026-05-22
**改訂:** 2026-05-22（外部レビュー P1/P2 反映）
**対象:** Phase 6 close（`phase6-close` @ `d4dbfc8`）後の `monorepo-harness`
**ステータス:** 設計（brainstorming 承認済み + 外部レビュー反映）。実装計画は別途。

## Context — なぜこの変更をするか

Phase 6 で DB（`.harness/harness.sqlite`）を **read model** として導入した。
現状は files（`runs/` / `projects/` / `policies/` / `backlog/` / `docs/knowledge/`）
が write-side の source of truth で、DB は `harness db import --from-files` で
files から構築する派生キャッシュにすぎない。

DB 完全移行の 3 段階移行表:

```txt
Phase 6（完了）: files = write-source,  DB = read-source（importer で構築）
Phase 7（本設計）: DB = write-source,    files = compatibility export
Phase 8（将来）: DB complete,            file scan = migration-only
```

Phase 7 は **runtime write path を DB-first にする**。runtime write コマンドが DB へ
トランザクション書き込みし、files は DB から導出される compatibility export に
なる。これにより runtime state の read/write 両方の source of truth が DB に
一本化され、Phase 8（artifact body の DB 格納・file export optional 化）の土台に
なる。

## Goal

`runDomainCoding` / `review process` / `review auto` / `rerun` / `cleanup` /
`backlog` / `knowledge` / `pr create` の各 runtime write コマンドを、DB
トランザクションを canonical な書き込みとし、files をその compatibility export
とする形に移行する。既存の安全モデル（policy 検証・状態遷移 gate）と観測挙動は
変えない。

## 確定した設計判断（brainstorming + レビュー反映）

1. **スコープ = runtime write path の DB-first 化のみ。** project profile /
   policy template の write path、`dashboard serve`、mutation UI、read model の
   小粒 follow-up は別トラック（後述「スコープ外」P1-7 参照）。
2. **files は DB commit 後に即 export。** 各 write コマンドが DB トランザクション
   確定の直後に、影響した files を DB から書き出す。files は常に最新の
   compatibility export を目指す。
3. **`runs` は直接 UPDATE + event 追記。** write コマンドが各 stage で `runs` 行を
   直接 UPDATE し、あわせて `run_events` に append。full event-sourcing は採らない
   （`runs` は projection ではなく current state のまま）。ただし status 遷移は
   expected-status guard を通す（後述）。
4. **実装アプローチ = 案 A。** Phase 6 の read repository に write メソッドを足し、
   コマンドごとに「DB-write → export」へ段階移行する。
5. **移行中の二重 source 問題を `source_mode` で防ぐ。** 各 runtime row は
   `source_mode ∈ {legacy-file, db-first}` を持ち、file-first command は
   db-first row を mutate しない（後述 migration invariant）。

## アーキテクチャ

### write+export パターン（コア単位）

移行された各 write コマンドは次の形をとる:

```txt
openDb(read-write)
  → db.transaction(() => { repository の write メソッド群（guard 付き） })
  → commit（db_revision を bump）
  → exportFiles(db, 影響した id 群)   ← atomic write、export_records を更新
  → close
```

- **DB トランザクションが atomic 単位。** runs 行の UPDATE、`run_events` への
  append、child 行（command_results / changed_files / violations / review）を
  1 トランザクションで確定する。
- **`exportFiles` は DB 行を読み戻して file artifact を書く。** 既存の file 書き込み
  コード（`run-log.ts` の meta.json/events.jsonl 出力、`reporter/` の各 artifact、
  `backlog.ts` の yaml 出力等）を「export ステップ」として再利用する。供給元が
  in-memory state から DB 行に変わるだけ。
- **export 失敗は rollback しない。** commit 済みの DB が canonical で正しい。
  export が失敗しても files が stale になるだけで、`export_records` に
  `status='failed'` が残り、`db check-consistency` と再 export で回復できる。

### migration invariant — `source_mode`（P1-1）

Phase 7 はサブフェーズごとにコマンドを移行するため、移行途中は **DB-first 化済み
コマンドと file-first のままのコマンドが共存**する。file-first command が
DB-first row の files を直接 mutate すると、DB（canonical）と files が乖離する。

不変条件:

```txt
Phase 7 migration invariant:
  DB-first row を対象にする write command は、
  file-first path で mutation してはならない。
```

実装:

- 各 runtime row（`runs` / `backlog_items` / `knowledge_candidates` /
  `knowledge_entries`）に `source_mode ∈ {legacy-file, db-first}` を持たせる。
  - Phase 6 importer で取り込んだ既存 row は `legacy-file`。
  - DB-first 化したコマンドが新規作成・遷移させた row は `db-first`。
- file-first のまま残るコマンドは、対象 row が `db-first` なら **reject**
  （`SourceModeError`、「このコマンドはまだ DB-first 化されていない」旨）。
- file-first command は `legacy-file` row のみ write 可。
- 各 runtime コマンドの entrypoint で、対象 row の `source_mode` を見て DB-first
  writer か legacy writer かにルーティングする。

これにより、7-3 で `runDomainCoding` を DB-first 化した直後に 7-5 の `review
process` がまだ file-first でも、DB-first run の状態を file-first review が壊す
ことはない（その review は reject され、移行待ちであることが明示される）。

### state transition guard / optimistic concurrency（P1-5）

SQLite は single-writer だが、それだけでは logical race を防げない。後続
トランザクションが先行決定を上書きしうる（例: 同一 run への並行 review）。
status 遷移は expected-status guard を通す:

```ts
updateRunStatus({
  runId,
  expectedStatuses: ["needs_review"],
  nextStatus: "approved",
  eventType: "review_approved",
  actor,
  operationId,
})
```

invariant:

- status update は `WHERE status IN (expectedStatuses)` 付きで実行し、
  `changes === 0` なら `StateConflictError` を投げる。
- event append は status update と同一トランザクション。
- `run_events` は `(run_id, seq)` を unique 制約にする。`seq` は同一
  トランザクション内で `MAX(seq)+1`。
- `operation_id` 重複は idempotent no-op（`operations` ledger に記録済みなら
  再実行しても DB を二重変更しない）。
- 同 invariant を backlog / knowledge の status 遷移にも適用する。

これは review / rerun / cleanup / pr create で特に重要。

### トランザクション粒度と crash safety

`runDomainCoding` は codex exec で数分かかるため **1 トランザクションにしない**。
現行の「stage ごとの `meta.json` 逐次更新」と同じく、**stage ごとに短い
トランザクション + export** を行う:

| stage | DB トランザクション | export |
|-------|------|--------|
| run 作成 | `runs` 行 insert（status=in-progress, source_mode=db-first）+ `run_started` event | meta.json / events.jsonl |
| codex 完了 | status / safety 更新 + event | meta.json / events.jsonl / codex-*.log |
| diff 検証 | changed_files / violations / safety_status + event | meta.json / final-diff.patch 等 |
| finalize | 最終 status / commandResults + `run_completed` event | meta.json / summary.md / review-decision.yaml 等 |

- codex exec をまたぐトランザクションは無い → SQLite single-writer の競合は
  各 stage の短い書き込みに限定される。
- crash 時は最後に commit した stage で `runs` 行が止まる。現行の部分
  `meta.json` と同じ観測挙動で、`maintenance` の orphan 検出もそのまま効く。
- 各 stage commit 後に export し、export 結果を `export_records` に記録する。

### write repository 層

Phase 6 の read repository（`src/db/repositories/`）に write メソッドを追加する
（read+write を 1 entity 1 repository に集約。SQL は repository のまま集約）。

- `RunRepository` — `insertRun` / `updateRunStage` / `updateRunStatus`（guard 付き）
  / `appendEvents` / `upsertCommandResults` / `upsertChangedFiles` /
  `upsertViolations` / `upsertReviewDecision`。
- `BacklogRepository` — `insertItem` / `updateItemStatus`（guard 付き）/ `linkRun` 等。
- `KnowledgeRepository` — `setCandidateDecision`（guard 付き）/ `insertEntry`
  （manifest）等。
- `PullRequestRepository` — `upsertPullRequest`（operation_id idempotent）。
- `CleanupRepository` — `recordCleanupAction`。

コマンド（が使う state writer）は 1 つの `db.transaction(...)` でこれらを呼ぶ。

### export 層（P2-1 / P2-2 / P1-3）

- `src/db/export-files.ts` — `import-files.ts` の逆。DB と影響 id（runId /
  projectId / itemId）を渡すと、その範囲の file artifact を書く。
- **scoped export は 7-2 で先に実装する。** `runDomainCoding` の DB-first 化
  （7-3）には scoped export が必須なので、CLI（full export）より前に
  `src/db/export-files.ts` の scoped export API を用意する。CLI
  `harness db export-files`（全 export）は後段（7-12）でよい。
- **atomic write。** 各 file は temp file へ書いてから rename する:

  ```txt
  write   runs/<id>/meta.json.tmp.<pid>.<nonce>
  fsync   （実用上可能なら）
  rename  → runs/<id>/meta.json
  ```

  run directory 単位では marker を使う:

  ```txt
  runs/<runId>/.exporting           ← export 開始時に作成
  runs/<runId>/.export-manifest.json ← export 完了時に書く（exported file 一覧 + db_revision）
  ```

  export 完了後だけ `.export-manifest.json` を更新し `.exporting` を消す。
  file-first（未移行）command は `.exporting` がある run を拒否または待機する。
- **export 状態を DB に残す。** `export_records` / `exported_files`（後述
  schema v2）に、どの scope をどの `db_revision` まで export できたか、
  status（synced / dirty / failed）を記録する。`db check-consistency` と
  dashboard はこれを読んで stale export を表示する。

### schema v2（migration）

Phase 6 v1 schema に対し、Phase 7 で migration v2 を追加する。`runMigrations` は
idempotent。主な追加:

`runs`（および `backlog_items` / `knowledge_candidates` / `knowledge_entries`）への列追加:

```txt
source_mode           'legacy-file' | 'db-first'   （既存 row は legacy-file）
db_revision           integer  （行更新ごとに bump）
last_export_revision  integer  nullable
export_status         'synced' | 'dirty' | 'failed'
last_exported_at      ISO string nullable
last_export_error     text nullable
```

新規テーブル:

```txt
export_records
  id                INTEGER PK
  scope_type        'run' | 'project' | 'backlog_item' | 'knowledge_entry'
  scope_id          TEXT
  db_revision       INTEGER
  status            'synced' | 'dirty' | 'failed'
  started_at        TEXT
  finished_at       TEXT nullable
  error_message     TEXT nullable
  exported_files_json TEXT

exported_files
  scope_type        TEXT
  scope_id          TEXT
  relative_path     TEXT
  sha256            TEXT
  bytes             INTEGER
  db_revision       INTEGER
  exported_at       TEXT
  PRIMARY KEY (scope_type, scope_id, relative_path)

operations                       （operation_id idempotency ledger）
  operation_id      TEXT PK
  command           TEXT
  scope_type        TEXT
  scope_id          TEXT
  result_json       TEXT nullable
  created_at        TEXT

pull_requests                     （pr create DB-first）
  id                INTEGER PK
  run_id            TEXT
  provider          TEXT
  repo              TEXT
  branch            TEXT
  base_branch       TEXT
  title             TEXT
  url               TEXT nullable
  external_pr_id    TEXT nullable
  status            TEXT
  operation_id      TEXT nullable
  created_at        TEXT
  updated_at        TEXT

cleanup_actions                   （cleanup DB-first）
  id                INTEGER PK
  run_id            TEXT
  action_type       TEXT
  target            TEXT
  status            TEXT
  executed_at       TEXT
  error_message     TEXT nullable
```

`run_events` に `(run_id, seq)` unique 制約を追加（既存 v1 schema が未保証なら
v2 で付与）。

### `run_changed_files` / `policy_violations`

Phase 6 で「file import から取れない」として繰り延べた 2 テーブルは、Phase 7 で
`runDomainCoding` 自身が changed-files / violations を in-memory に持っているため
DB へ直接書ける。**`runDomainCoding` の移行（7-3 / 7-4）でこの read-side の穴が
自然に閉じる。**

## canonical source の範囲（P1-4）

Phase 7 では「files は DB から導出される compatibility export」という表現は
*runtime workflow state に限って* 正しい。artifact body / 大型ログ / patch body /
knowledge markdown body は DB に入れず file-backed のままなので、その body は DB
から復元できない。境界を明文化する:

```txt
Phase 7 で DB が canonical:
  run state / run events / review decisions / changed files /
  policy violations / backlog state / knowledge decision state /
  artifact manifest / pull request state / cleanup action records

Phase 8 まで file-backed storage が canonical:
  artifact body（codex-*.log, final-diff.patch, summary など）
  large logs
  patch body
  knowledge entry の markdown body（docs/knowledge/**/*.md）
```

設計文言（旧版「files は DB から導出される compatibility export」）は次に置き換える:

> Phase 7 では、workflow state / run metadata / events / review / backlog /
> knowledge decision / diff validation / artifact manifest / PR state /
> cleanup action は DB を canonical とする。一方、artifact body と knowledge
> entry の markdown body は Phase 8 まで file-backed storage のままとし、DB は
> manifest と参照整合性のみを持つ。

knowledge について（P2-5）: knowledge entry の markdown body は「価値そのもの」
だが、artifact body と同じく Phase 8 まで file-backed とする（一貫した 1 規則を
保つ）。`knowledge promote` / `reject` の **decision state は DB canonical**で、
markdown body は promote 時に file へ書き、DB はその manifest（frontmatter
metadata + path + sha256）を持つ。backlog は body を持たない構造データなので
完全に DB canonical（YAML は export）。

## 安全モデルは不変（最重要）

Phase 7 が変えるのは state の**保存先**（file → DB）だけで、**何が state 遷移を
gate するかは一切変えない**:

- 事後 `git diff` policy 検証は `runDomainCoding` 内でそのまま実行する。検証結果の
  保存先が `meta.json` → `runs` 行に変わるだけ。
- `approved` / `changes_requested` / `rejected` への遷移は引き続き
  `review process` のみが行う。LLM の出力が状態を動かさない原則も不変。
- run の最終 status は `needs_review` / `failed-*` で確定する規則も不変。

### review auto と review process の権限境界（P2-4）

Phase 7 対象に `review auto` が含まれるため、DB-first 化で何を書くかを明確に分ける:

```txt
review auto:
  - review proposal / suggested decision / rationale artifact を DB に書く
  - runs.status は変更しない
  - approved / changes_requested / rejected への遷移は行わない

review process:
  - human/operator decision を検証
  - status transition（guard 付き updateRunStatus）を実行
```

`review auto` の DB write は proposal 系テーブル/列に限定し、status guard を
通る遷移は一切呼ばない。

## import semantics in Phase 7（P1-2）

Phase 6 の importer は files を source of truth として DB へ upsert する設計
だった。Phase 7 では source-of-truth が反転するため、stale な files で DB-first
row を巻き戻さないルールが必要:

```txt
db import --from-files
  - legacy-file row: 従来どおり取り込み（upsert）
  - db-first row: その scope の exported db_revision と DB の db_revision が
    一致する場合のみ no-op。file が古い（revision 不一致）なら overwrite せず
    conflict として import_errors / レポートに記録。

db import --from-files --force-legacy-reconcile
  - 明示指定時のみ db-first row の上書きを許す。CI / 復旧用途。
    通常コマンドでは使わない。
```

`.export-manifest.json`（export marker）と `exported_files.db_revision` で
「files がどの DB revision に対応するか」を判定する。

### export failure の終了コード

migration 中は未移行コマンドが files に依存するため、export failure を黙殺しない:

```txt
DB commit 成功 + export 成功:  exit 0
DB commit 成功 + export 失敗:  exit 0 + strong warning（export_status=failed を DB に記録）
```

少なくとも migration 中は export 失敗を強い warning として表示し、
`harness db status` / dashboard で stale export を可視化する。

## スコープ外（Phase 8 以降）

- **artifact body / 大型 body の DB 格納**（`artifact_blobs` / `--storage db`）—
  移行表どおり Phase 8。Phase 7 は artifact body / knowledge markdown body を
  file-backed のまま（manifest は DB）。
- **file export の optional 化** — Phase 8。Phase 7 は常に export する。
- **`domain_locks` テーブル** — locks は write path と直交する並行制御。Phase 7 は
  file lock を維持する（スコープとリスクを増やさない）。Phase 8 候補。
- **`dashboard serve` / dashboard からの mutation** — 別トラック。
- **project profile / generated policy の DB-first 化（P1-7）** — Phase 7 close の
  スコープは **runtime write path の DB-first 化に限定**する（案 A）。
  `projects/*.yaml` / `policies/repos/*.yaml` / project profile / policy template
  は **user-authored config file のまま**で、DB はそれらを import して参照する
  （Phase 6 と同じ read model 扱い）。これらの write path 自体の DB-first 化
  （案 B）は実装量が大きく、Phase 8 以降の候補とする。

## 移行中の整合性

- `db import --from-files` は Phase 7 中も動く（legacy-file row、未移行コマンド用）。
  ただし db-first row には上記 import semantics を適用する。
- DB-first 化したコマンドの run は DB canonical。`source_mode` invariant により
  file-first command がその files を mutate しないので、二重 source 化しない。
- `db check-consistency` の意味は「export された files が DB と乖離していないか」
  「export が `failed` / `dirty` のまま残っていないか」へ拡張する。検査ロジック
  （file hash 再計算 vs `exported_files.sha256`）はそのまま使える。
- リスク緩和: DB-first 完了後も files は full record として export 済み →
  万一 DB に問題が出ても files から再構築できる（body は元々 file-backed）。

## 移行順（サブフェーズ）

レビュー提案の構成を採用する。7-0/7-1 を spec と schema に分け、scoped export を
7-2 に前倒し、`runDomainCoding` を 7-3/7-4 に 2 分割する。

```txt
7-0   Phase 7 spec + migration invariant
      - source_mode / DB-first vs legacy-file rules
      - import conflict policy / export status policy
      - state transition contract
7-1   DB schema v2 + write repository skeleton
      - source_mode / db_revision / export_records / exported_files
      - operations / pull_requests / cleanup_actions
      - expected-status update helper / StateConflictError / SourceModeError
7-2   scoped export engine
      - run meta/events/review export、backlog export、knowledge manifest export
      - atomic write（temp+rename / .exporting marker）
      - export failure tracking（export_records）
7-3   runDomainCoding DB-first part 1
      - run create / stage updates / events、短トランザクション、source_mode=db-first
7-4   runDomainCoding DB-first part 2
      - changed_files / policy_violations / artifact manifest
      - export + round-trip
7-5   review process / review auto DB-first
      - strict transition guard、review auto は最終 status を変えない
7-6   rerun DB-first
      - parent/root chain、project profile 再解決、operation idempotency
7-7   cleanup DB-first
      - cleanup_actions records、export deletion semantics
7-8   backlog（add/run/done/defer）DB-first
      - DB → YAML export の move semantics
7-9   knowledge（promote/reject）DB-first
      - decision state DB canonical、body は file-backed、docs export
7-10  pr create DB-first
      - pull_requests table、idempotent external PR creation
7-11  db export-files full + import / consistency finalization
      - bulk re-export、legacy import mode、DB-first conflict detection
7-12  fixture matrix + crash / concurrency tests
7-13  docs / close package
```

files が常時 export されるので、未移行コマンドは export 済み files（legacy-file
row）で動き続ける。`source_mode` invariant により、未移行コマンドが db-first row
に触れることはない。順序は実装計画で微調整可。

## テスト

各移行コマンドで次を検証する:

- DB 行（runs / events / child）がコマンド後に正しい。
- export された files が DB 行と一致する。
- **round-trip は正規化一致で判定する（P2-3）。** `db import --from-files` の
  結果が DB と *semantically equivalent* であること。内部 operational metadata
  （`export_status` / `last_exported_at` / `operation_id` / 再生成された
  `db_revision`）は比較から除外し、deepEqual ではなく正規化 snapshot を比較する。
- crash safety: run の途中 stage で停止しても `runs` 行が sane。
- 並行性: 複数 run を並行実行しても短トランザクションで DB が壊れない。
- 既存 file-based テストの回帰なし（移行済みコマンドの観測挙動が不変）。

追加シナリオ（レビュー反映）:

1. DB-first run に legacy file-first review process を実行 → `SourceModeError`
   で reject。
2. export 失敗後: DB は新状態 / `export_status=failed` / dashboard・`db status`
   に warning / `db import --from-files` は DB を巻き戻さない。
3. stale な exported `meta.json` を手で古くして `db import` → db-first row は
   conflict として報告、legacy row は import 可。
4. 2 つの review process が同一 run を同時承認 → 片方成功、もう片方
   `StateConflictError`。
5. `pr create` を同一 `operation_id` で再実行 → duplicate PR を作らず DB row は
   idempotent。
6. `cleanup` 後: DB の run row は残る / exported run dir の削除・更新は export
   policy どおり / full export で再現可能。
7. `runDomainCoding` crash simulation: `run_created` 後 / `codex_done` 後 /
   `diff_verified` 後の各 crash で dashboard・maintenance が sane に扱う。
8. `knowledge promote`: DB に entry decision state が残り、docs/knowledge
   markdown export と manifest が一致、reject/promote の再実行が idempotent。

## close 条件

- [ ] 全 runtime write コマンドが DB トランザクションを canonical 書き込みとする。
- [ ] files が DB から export され、`db import` で正規化 round-trip する。
- [ ] `run_changed_files` / `policy_violations` が populate される。
- [ ] DB-first row を file-first command が直接 mutate しない guard がある
      （`source_mode` invariant）。
- [ ] `db import --from-files` が DB-first row を stale file で上書きしない。
- [ ] `export_status` / `export_records` により stale export を検出・再 export
      できる。
- [ ] scoped export が atomic write を使い、partial export を検出できる。
- [ ] run status transition が expected status guard で守られている。
- [ ] duplicate `operation_id` が idempotent に扱われる。
- [ ] `pr create` が duplicate PR を作らない。
- [ ] cleanup は DB canonical state を削除せず、export files の削除/更新として
      扱われる。
- [ ] artifact body / knowledge body の canonical source が明文化されている。
- [ ] `harness db export-files`（全 export）がある。
- [ ] DB v1 → v2 migration が idempotent。
- [ ] 安全モデル（policy 検証 / 状態遷移 gate / review auto 境界）が不変。
- [ ] crash safety / 並行性のテストがある。
- [ ] Phase 6 DB-backed dashboard が Phase 7 DB-first writes を即時に読める。
- [ ] 既存テストが green、typecheck green。
- [ ] docs / specs 更新、`phase7-close` タグ。
