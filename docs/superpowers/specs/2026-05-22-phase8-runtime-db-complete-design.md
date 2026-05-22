# Phase 8 — runtime DB complete 設計書

**作成日:** 2026-05-22
**対象:** `phase7-close`（+ post-close hardening `65e4536`）後の `monorepo-harness`
**実装計画:** `tmp/phase8-db-complete-migration-plan.md`（外部レビュー反映済み第 2 版）
**ステータス:** 設計確定（Phase 8-0）。実装は 8-1 以降。

---

## 1. 位置づけ — DB 完全移行の最終段

```txt
Phase 6: files = write-source,        DB = read-source
Phase 7: DB = write-source,           files = 常時 compatibility export
Phase 8: DB = runtime complete,       files = optional / migration-only
```

Phase 7 で runtime write path は DB-first 化したが、files は今も DB commit 直後に
**必ず** export される。Phase 8 は **files を必須でなくす**。完了後は run を
DB だけで運用でき（artifact body も DB 内）、files は opt-in の互換出力になる。

**名称の意味:** 本フェーズは **runtime machine-generated state** の DB 完全移行
であり、人手 authored content（knowledge entry markdown / project profile /
policy）は file canonical のまま残す。「完全DB移行」は runtime state に
限定された意味である。

## 2. canonical 境界（Phase 8 確定値）

```txt
DB canonical（Phase 8 で完成）:
  run state / events / review decision / changed files / policy violations /
  backlog state / knowledge decision state / PR state / cleanup action /
  artifact manifest + artifact body（← Phase 8 で DB へ）

file-authored canonical（DB 化しない。人手キュレーション対象）:
  knowledge entry の markdown body（docs/knowledge/**/*.md）
  project profile（projects/*.yaml）
  policy（policies/repos/*.yaml、global.yaml）

files = optional compatibility export（Phase 8）:
  runs/<id>/ の meta.json / events.jsonl / review-decision.yaml /
  artifact 群 — DB から導出。export OFF なら生成しない
```

Phase 7 まで artifact body（codex ログ / diff / summary 等）は file canonical
だった。Phase 8 でこれを DB（`artifact_blobs`）へ移し、runtime state の DB 化を
完成させる。

## 3. 確定した設計判断

### A. artifact body は chunked SQLite BLOB（file fallback なし）

artifact body は content-addressed（raw bytes の sha256）で `artifact_blobs` /
`artifact_blob_chunks` に**分割保存**する。巨大 codex ログに対応するため chunk
分割し、optional に `gzip` 圧縮する。

**oversized artifact を file に逃がさない。** hard max を超えた artifact は
file canonical に残さず、**DB 内に truncated artifact として保存**する
（`body_status='truncated'`、`original_bytes` / `truncation_reason` を記録）。
file へ逃がすと DB-only mode でその artifact が読めず、「DB complete」が
成立しないため。`storage='file'` は legacy / backfill 未完了 row のみ。

### B. knowledge entry markdown は file-authored のまま

knowledge entry の `.md` body は DB canonical 化しない。knowledge entry は人手
キュレーション対象（`deprecated` frontmatter の編集が前提）であり、Phase 8 が
対象とする machine-generated runtime state とは別カテゴリ。

重要な帰結: `knowledge promote` が `docs/knowledge/**/*.md` を作るのは
**authored file の作成**であって compatibility export ではない。よって
**export OFF でも knowledge markdown の書き込みは skip しない**。export gate の
対象は knowledge candidate / decision の DB 由来 sidecar
（`knowledge-decisions.yaml`）のみ。

### C. file export の default は ON

export はオプトインにするが **default は ON**（後方互換）。設定 / フラグで OFF
にすると DB-only 運用。default OFF は Phase 9 以降。

### D. domain lock の DB 化は Phase 9 送り

domain lock は runtime concurrency の話で DB-complete の中核ではなく、
lease / expiry / heartbeat / fencing token（split-brain 防止）の設計が重い。
Phase 8 のスコープ外とし、Phase 9 で独立して扱う。file lock を維持する。

## 4. schema v4

migration v4 で追加するもの:

- `artifact_blobs(sha256 PK, bytes, content_encoding, stored_bytes,
  chunk_count, created_at)` — content-addressed blob manifest。`sha256` は
  **raw artifact bytes** の sha256。`content_encoding` は `identity` | `gzip`。
- `artifact_blob_chunks(sha256, chunk_index, content BLOB, PK(sha256,
  chunk_index))` — blob 本体の分割保存。
- `artifacts` への列追加: `blob_sha256`（blob 参照）、`body_status`
  （`db_available` | `legacy_file` | `missing` | `truncated`）。
  厳格 CHECK ではなく `body_status` で表現し backfill 中間状態を許容する。
- `pull_requests` に `UNIQUE(run_id)`。追加前に既存 duplicate を preflight で
  検出/整理する。PR 作成試行は `pull_request_attempts` に分離する。
- `export_status` の許容値に `disabled` / `removed` を追加（状態機械、§5）。

既存 `artifacts` テーブルに `storage` の CHECK 制約があれば、SQLite では
table rebuild（新テーブル作成 → copy → index/trigger 再作成 → drop/rename）が
必要になる。8-1 で現 DDL を確認して migration 方式を確定する。

## 5. export_status 状態機械

file export の optional 化に伴い、runtime row の `export_status` を 5 状態の
状態機械にする。`check-consistency` はこの状態で判定する。

```txt
synced    DB revision と exported files が一致
dirty     DB が export されていない（export 保留）
failed    export を試みたが失敗
disabled  export 設定が OFF。missing files は正常
removed   cleanup tombstone（run_dir_remove）で exported files 削除済み

check-consistency:
  synced   → missing / drift は error
  dirty    → 「db export-files を実行」warning
  failed   → warning（または error）
  disabled → missing は ok。file が存在し DB と不一致なら warning
  removed  → run dir missing は ok
```

## 6. import semantics（migration-only）

Phase 8 で `db import` は migration-only ツールになる。DB-complete row を
stale file で巻き戻さない:

```txt
db import --from-files --legacy-only
  - legacy-file source の初回取り込みのみ
db import --from-files --verify-export
  - DB と exported file の一致検証（書き込みなし）
db import --from-files --force-reconcile
  - 明示的な復旧用上書き
```

DB-first / DB-complete row は通常 import で overwrite しない。`--reset` の
全消し再構築は DB backup 作成または強い確認を必須にする。

## 7. 安全モデルは不変

Phase 8 が変えるのは artifact body の保存先と files の必須性だけで、安全モデルは
不変: policy 検証 / 状態遷移 gate（`review process` のみが status を動かす）/
review auto 境界 / `source_mode` invariant はすべて維持する。

DB が artifact body（codex ログ / diff）の canonical になるため、
`.harness/harness.sqlite` 自体が高感度 artifact になる。DB / WAL / backup の
permission を `0600` 寄りにし、「DB は secret を含みうる」を docs に明記する。

## 8. サブフェーズ

実装計画 `tmp/phase8-db-complete-migration-plan.md` の §5 を参照。8-0（本書）→
8-1 schema v4 → 8-2 ArtifactWriter → 8-3 backfill → 8-4 read/export/drift →
8-5 export optional → 8-6 import migration-only → 8-7 index 撤去 →
8-8 DB 運用コマンド → 8-9 テスト → 8-10 docs/close。

## 9. スコープ外（Phase 9 以降）

- knowledge entry markdown / project profile / policy の DB canonical 化。
- `domain_locks` の DB 化（判断 D）。
- `dashboard serve` / mutation UI。
- file export の default OFF 化。
- legacy-file routing 分岐の完全削除（Phase 8 は分岐を残す）。
- artifact body の外部オブジェクトストア化。
