# Phase 8 close レポート — runtime DB complete

**日付:** 2026-05-22 → 2026-05-23
**対象:** `monorepo-harness` Phase 8（runtime DB complete）
**設計:** [`../superpowers/specs/2026-05-22-phase8-runtime-db-complete-design.md`](../superpowers/specs/2026-05-22-phase8-runtime-db-complete-design.md)
**タグ:** `phase8-close`

## 概要

Phase 8 は DB 完全移行の第 3 段階。DB-first write path（Phase 7）に残った
最後の file-canonical な runtime state — **artifact body**（codex ログ / diff /
summary 等）— を DB へ移し、file export を optional にした。完了後は run を
DB だけで運用でき、files は opt-in の互換出力になる。

```txt
Phase 6（完了）: files = write-source,    DB = read-source
Phase 7（完了）: DB = write-source,       files = 常時 compatibility export
Phase 8（本フェーズ）: DB = runtime complete, files = optional / migration-only
```

「runtime DB complete」は **machine-generated runtime state** に限定した意味で
ある。人手 authored content（knowledge entry markdown / project profile /
policy）は file-authored canonical のまま残す。

## サブフェーズ

| # | 内容 | コミット種別 |
|---|------|------|
| 8-0 | runtime DB complete 設計確定 | docs |
| 8-1 | schema v4（artifact blobs / chunks / body_status / PR uniqueness） | feat + fix |
| 8-2 | DB-first ArtifactWriter | feat + fix |
| 8-3 | artifact body backfill（`db migrate-artifacts`） | feat |
| 8-4 | artifact body の DB read / export + drift consistency | feat |
| 8-5 | file export の optional 化（DB-only mode / `export_status` 状態機械） | feat + fix |
| 8-6 | `db import` の migration-only 化 + legacy-file 移行 | feat + fix |
| 8-7 | `index.sqlite` / `harness index` 撤去 | refactor + fix |
| 8-8 | DB 運用コマンド（backup / restore / checkpoint / vacuum / stats） | feat + fix |
| 8-9 | fixture matrix + crash / 並行性テスト | test + fix |
| 8-10 | docs + close package | docs |
| 8-11 | consistency checker artifact blob 検査 | feat |
| 8-12 | DB-backed run viewers（run show / timeline / artifacts / rerun chain） | feat |
| 8-13 | DB-only review + review/workflow artifact の DB 取り込み | feat |
| 8-14 | restore 安全性 docs + truncation 設計整合 + close | docs |

8-11〜8-14 は、8-10 時点の**全フェーズ横断 codex レビュー**が DB-only mode の
read 経路に close 条件未達（P1×4）を検出したため追加したサブフェーズ:

- P1-1 — DB-only で `review auto` が壊れる（reviewer agent が `meta.json` を
  file 直読み）→ 8-13。
- P1-2 — review / workflow が生成する artifact が DB blob に入らない → 8-13。
- P1-3 — `check-consistency` が DB の artifact blob 自体を検査しない → 8-11。
- P1-4 — `db restore` が利用中の DB を無防備に置換しうる → 8-14（docs +
  運用上の制約として明記、DB-wide 排他は Phase 9 concurrency トラック）。

各サブフェーズは TDD 実装 → codex（gpt-5.5, `model_reasoning_effort=xhigh`,
`--sandbox read-only`）外部レビュー → P0/P1/P2 修正の作法で進めた。全サブ
フェーズで codex レビューの P0 はゼロ、P1/P2 は修正コミット（`fix(...) /
refactor: ... — codex レビュー反映`）で反映済み。

## close 条件チェック

- [x] 新規 runtime artifact body が DB（`artifact_blobs` / `artifact_blob_chunks`）
      に content-addressed で canonical 格納される（8-2）。
- [x] 新規 runtime artifact は oversized でも file canonical に逃げず、DB 内に
      truncated 保存される（`body_status='truncated'`、8-1/8-2）。
- [x] artifact の dedup（content-addressed）と chunk 分割が動く（8-2、
      `artifact-blobs.test.ts` / `phase8-fixture-matrix.test.ts`）。
- [x] 既存 Phase 7 run の file-backed artifact body を DB に backfill できる
      — `harness db migrate-artifacts`（8-3）。
- [x] backfill は idempotent / resumable、不能 artifact（missing / hash
      mismatch）は report・除外（8-3）。
- [x] `exportRun` / `db export-files` が artifact body を DB から復元する（8-4）。
- [x] runtime command が `storage='db'` artifact body を file でなく DB から
      読む（8-4 export / 8-12 run viewers）。
- [x] `check-consistency` が artifact body の drift / missing を検出する
      — exported file 側（8-4）と DB blob 自体（8-11: blob_sha256 欠落 /
      blob・chunk 欠損 / `body_status='missing'`）の両方。
- [x] file export がオプトインで、DB-only で run→review→rerun→pr create→
      cleanup→dashboard が動く（8-5 export gate / 8-12 run viewers の DB
      fallback / 8-13 reviewer の DB materialize）。
- [x] `export_status` が `synced` / `dirty` / `failed` / `disabled` / `removed`
      を区別し、`check-consistency` が export OFF / tombstone を正しく扱う（8-5）。
- [x] export default ON で既存挙動が不変（回帰なし）。
- [x] `db import --from-files` が DB-complete row を stale file で上書きしない
      （8-6。Phase 7 の `source_mode` guard + 8-6 で明文化・強化）。
- [x] `harness db migrate-legacy` が legacy-file row を db-first へ移行する（8-6）。
- [x] deprecated `index.sqlite` / `harness index` が撤去（exit 1 stub 化）
      されている（8-7）。
- [x] `pull_requests` に `UNIQUE(run_id)`、追加前に既存 duplicate を
      de-duplicate（8-1、`migrations-v4.test.ts`）。
- [x] `harness db backup / restore / checkpoint / vacuum / stats` がある（8-8）。
- [x] backup が artifact blob を含めて復元でき、files 全削除後も復旧できる
      （8-8 / 8-9 `phase8-fixture-matrix.test.ts`）。
- [x] DB / WAL / backup の permission（`0600`）と secret sensitivity が docs に
      明記（8-8、`db.md`）。
- [x] `artifacts` の `storage='db'` と `blob_sha256` の整合が schema /
      `body_status` で表現される（8-1）。
- [x] schema v1→v2→v3→v4 migration が idempotent（`migrations-v4.test.ts`）。
- [x] 安全モデル（policy 検証 / 状態遷移 gate / review auto 境界 /
      `source_mode` invariant）が不変。
- [x] crash / 並行性 / artifact blob / backup-restore のテストがある（8-9、
      3 プロセス並行書き込みを含む）。
- [x] DB-only mode の read 経路（`run show` / `timeline` / `artifacts` /
      `rerun chain` / `review auto`）が DB から動く（8-12 / 8-13）。
- [x] review / workflow 生成 artifact（reviewer ログ / `workflow.json`）が
      DB-canonical に取り込まれる（8-13）。
- [x] 既存テスト green（typecheck green）。
- [x] docs / specs 更新（`db.md` / `cli.md` / `workflow.md` / `README.md`）、
      `phase8-close` タグ。

### close 条件の設計判断（計画からの差分）

- **`db import` の CLI フラグ分離。** 計画 8-6 は `--legacy-only` /
  `--verify-export` / `--force-reconcile` の 3 フラグへの分離を挙げていた。
  実装では substantive な振る舞いを優先した: (1) 通常の `db import` は
  `source_mode` guard により既に **db-first row を上書きせず legacy-file
  row のみ取り込む**ため `--legacy-only` は default と等価、(2) DB ↔ files の
  一致検証は `harness db check-consistency`（`exported_files.sha256` 照合）が
  担う、(3) 復旧用上書きは既存の `--force-legacy-reconcile` が `--force-reconcile`
  の役割を果たす。新フラグは振る舞いの重複になるため追加しなかった。
  overwrite guard そのものは満たしている。
- **truncation メタデータ。** 設計初版は oversized artifact に raw bytes の
  sha256 と `original_bytes` / `truncation_reason` を記録するとしていた。実装
  確定値は **STORED（truncated）body の sha256 で content-address** する方式に
  した（`blob_sha256` が常に `readArtifactBlob` の返り値そのものを指す。8-14
  で設計書 §A / schema コメントを実装へ整合）。truncation の signal は
  `body_status='truncated'`、stored length は `artifacts.bytes` が保持する。
  original のフルサイズは記録しない（truncated body は定義上それ以上復元
  できないため）。
- **nested artifact（`commands/` / `review-evaluations/`）。** サブ
  ディレクトリ下の artifact body は従来どおり file-backed —
  `ingestRunArtifacts` は run dir 直下のみを走査する（Phase 6/7 からの境界）。
  構造化されたコマンド結果は `command_results` テーブルが保持する。
- **`review auto` の verdict（`review-decision.yaml`）。** `review auto` は
  proposal file `review-decision.yaml` を生成する補助コマンドで、verdict を
  DB-canonical 化するのは `review process`（`review_decisions` テーブル、
  Phase 7-5 で db-first）。`review auto` と `review process` の間、verdict は
  materialize された run dir のファイルとして存在する（run dir は materialize
  後に残るため通常フローでは失われない）。verdict 自体を DB に持つ
  `review_proposals` テーブル化は Phase 7 close で Phase 8 候補として defer
  され、Phase 8 設計でも採用しなかった — 引き続き Phase 9 候補。

## スコープ外（Phase 9 以降 / 別トラック）

- knowledge entry markdown / project profile / policy の DB canonical 化
  — 人手キュレーション対象の file-authored content（設計判断 B）。
- `domain_locks` の DB 化 — runtime concurrency の独立トピック。lease /
  expiry / heartbeat / fencing token の設計が重く Phase 9 送り（設計判断 D）。
- **harness 全体の DB-wide 排他ロック。** `db restore` は live DB ファイルを
  差し替えるため、他プロセスが DB を開いたままだと不整合が起きうる。Phase 8
  では `--force` 要求 + docs での運用制約明記に留め、全コマンドが取る
  DB-wide lock は上記 concurrency トラック（Phase 9）で扱う。
- `dashboard serve` / mutation UI。
- file export の **default OFF 化** — Phase 8 は「OFF にできる」まで。
- legacy-file routing 分岐の**完全削除** — 未移行 row の保険として分岐を残す。
  全環境移行確認後の Phase 9 で撤去。
- artifact body の外部オブジェクトストア化（S3 等）。

## 検証

- `npm test`: 924 passed / 1 skipped。
- `npm run typecheck`: green。
- schema v1→v2→v3→v4 migration: idempotent（`migrations-v4.test.ts`）。
- 既存 file-based テスト: 回帰なし（legacy-file path は不変）。
- 8-9 fixture matrix: artifact blob 境界 / dedup / truncation / crash sanity /
  3 プロセス並行書き込み / DB-only recovery を網羅。
- 8-11〜8-13 テスト: `consistency.test.ts`（blob 検査）/ `run-viewer-db.test.ts`
  （DB fallback）/ `review-auto-db-only.test.ts`（DB-only review）。

## 全フェーズ codex レビュー

8-10 時点の横断 codex レビュー（gpt-5.5, xhigh）で P0 ゼロ・P1×4・P2×2。
P1 は DB-only mode の read 経路の close 条件未達で、8-11〜8-14 を追加して
解消した。8-11〜8-14 に対する追加 codex レビューでも P0 ゼロ・P1×3 を検出し、
`fix(runtime): Phase 8-11/8-12/8-13 — codex レビュー反映` で修正した:
checkArtifactBlobs の DB-reconstructed artifact 偽陽性、ensureRunMaterialized
が `exportRun` の失敗 status を無視していた点、reviewed-run の全 attempt
sync。`review-decision.yaml` の DB-canonical 化（`review_proposals`）は上記の
とおり Phase 9 候補として明示 defer。
