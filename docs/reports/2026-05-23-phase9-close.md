# Phase 9 close レポート — concurrency + runtime DB story 完結

**日付:** 2026-05-23
**対象:** `monorepo-harness` Phase 9（concurrency + runtime completion）
**設計:** [`../superpowers/specs/2026-05-23-phase9-concurrency-and-runtime-completion-design.md`](../superpowers/specs/2026-05-23-phase9-concurrency-and-runtime-completion-design.md)
**実装計画:** `tmp/phase9-concurrency-and-runtime-completion-plan.md`（外部レビュー反映済み v2）
**タグ:** `phase9-close`

## 概要

Phase 9 は Phase 8 が残した 2 縦串を閉じるフェーズ:

- **A. concurrency**: DB-backed `domain_locks`（lease + heartbeat + fencing
  token = `lock_id`）、DB-wide reader/writer maintenance lock
  （`.harness/db.lock` を flock）、run execution stage writes の active
  lease guard。
- **B. runtime DB story の完結**: `HARNESS_EXPORT_FILES` を default OFF へ
  反転（breaking change）、scratch runDir lifecycle 確定（export OFF +
  ingest 成功 → 削除）、legacy-file routing の runtime gate、
  `review_proposals` テーブルが `review auto` の verdict を DB canonical
  化、truncated artifact の audit（`artifacts.original_*`）。

## サブフェーズ

| # | 内容 | コミット |
|---|------|------|
| 9-0 | 設計確定（design spec doc） | a7d8b1a |
| 9-1 | schema v5（domain_locks / review_proposals / lease / original_*） | 539710e |
| 9-2 | DB-wide maintenance lock 基盤（flock reader/writer） | 0310dc8 |
| 9-3 | `harness db` exclusive/shared 適用（`db init` / `db migrate` も exclusive、`db backup` は shared） | 9c68fea |
| 9-4 | DB-backed domain lock repository（lease + heartbeat + fencing） | d4c4dec |
| 9-5 | file + DB dual-lock 期間 + `harness lock list/release` の DB-backed 化 | 9520b54 |
| 9-6 | active lease guard（`assertActiveLease`）を run execution stage writes に挿入 | bdda2b2 |
| 9-7 | scratch runDir lifecycle（export OFF + ingest 成功で削除） | 75d61e8 |
| 9-8 | `review_proposals` テーブル + `review auto` DB-first + idempotent process | f51cdf7 |
| 9-9 | `artifacts.original_bytes` / `original_sha256` + `db stats` の truncated 統計 | 4c4c244 |
| 9-10 | `HARNESS_EXPORT_FILES` default OFF + warning + suppress env | 753a624 |
| 9-11 | legacy-file routing gate（runtime tables、migrate-legacy / disaster recovery は bypass） | 891b5c0 |
| 9-12 | fixture matrix + concurrency/lease/legacy/maintenance lock テスト | fdd9aca |
| 9-13 | docs + close package（本コミット） | — |

各サブフェーズで TDD 実装 → 既存テスト緑維持 → `npm run typecheck` を保つ
作法で進めた。

## close 条件チェック

- [x] `domain_locks` が lease + expires_at + heartbeat_at + fencing_token
  （= `lock_id`）+ audit columns（release_reason / released_by）を持ち、
  acquire / heartbeat / release が DB-backed で動く（9-4）
- [x] **stale writer rejection は `runs.lease_token` 単体 CAS ではなく、active
  `domain_locks` 行を EXISTS で検証している**（9-6、`assertActiveLease`）
- [x] **run execution stage writes と post-run writes の concurrency guard が
  分離されている**（run execution = active lease guard、post-run = 既存の
  expected status / operation_id guard、Phase 7-5 以降の不変）
- [x] `harness lock list / release` が DB-backed（file lock との dual mode、
  `--source file|db|both`、release --force は強い stderr warning）
- [x] **dual file+DB lock mode の lease stealing 限界が明文化され、full-path
  integration test は Phase 10 に送られている**（9-5、設計書 §A4）
- [x] DB-wide maintenance lock（flock-based reader/writer）があり、
  destructive maintenance + schema 系（`db init` / `db migrate` /
  `db restore` / `db vacuum` / `db checkpoint --truncate` / `db migrate-*`）が
  exclusive lock を取る（9-2 / 9-3）
- [x] `db backup` は shared lock（destructive ではないため）
- [x] **lock 取得順序（maintenance → DB open → domain）と LockHandle の
  lifetime が docs に明記**（design §A2 / §A3、9-2 で実装）
- [x] `review_proposals` テーブルが DB canonical で、`review auto` →
  `review process` の verdict 受け渡しが DB 経由 + active partial unique
  index + `processed_at` で idempotent（9-8）
- [x] `artifacts.original_bytes` / `original_sha256` が truncated 時に記録、
  `db stats` で truncated 統計が見える（9-9）
- [x] `HARNESS_EXPORT_FILES` の default が OFF、未設定時に warning、
  `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1` で抑制可（9-10）— **breaking
  change**
- [x] **export OFF 時の scratch runDir lifecycle が定義されている** — ingest
  成功で削除、failure で保持 + warning（9-7、happy / 例外 finalize 両 path）
- [x] **legacy-file routing 削除の対象が runtime rows に限定** され、
  `knowledge_entries` / project profile / policy / `knowledge_candidates`
  と衝突しない（9-11、scope = runs + backlog_items）
- [x] **`db migrate-legacy` / `db import --force-legacy-reconcile` /
  `db init` / `db migrate` 等の disaster recovery / migration 系は legacy
  check を bypass できる**（9-11）
- [x] schema v1→v5 migration が idempotent（`migrations-v5.test.ts`、
  `migrations.test.ts`、phase9-fixture-matrix の end-to-end）
- [x] crash / lease-expiry / lease-stolen / maintenance-lock / legacy gate /
  scratch lifecycle のテストが injectable Clock / 短 lease で安定に動く
  （`tests/unit/workspace/db-domain-lock.test.ts` / `tests/unit/db/
  maintenance-lock.test.ts` / `tests/integration/phase9-fixture-matrix.test.ts`）
- [x] 安全モデル（policy 検証 / 状態遷移 gate / review auto 境界 /
  `source_mode` invariant）が不変
- [x] 既存テスト green（969 passed / 1 skipped）、typecheck green
- [x] docs / specs 更新（`db.md` / `cli.md` / `workflow.md` / `README.md`）、
  `phase9-close` タグ

## 設計判断 / 計画からの差分

- **legacy-file gate の scope を縮小**: 計画書は runs / backlog_items /
  `knowledge_candidates` の 3 表を gate 対象にしていたが、
  `knowledge_candidates` は `syncCandidate` が「未決定」の marker として
  `source_mode='legacy-file'` を使うため、ゲートを通すと新規 knowledge
  candidate のたびに refuse してしまう。9-11 で scope を **runs と
  backlog_items のみ** に絞った。`knowledge_entries` は file-authored のまま
  （Phase 8 設計判断 B）。
- **legacy-file routing コード自体は残置**: 9-11 で gate が起動時に refuse
  する形にしたため、各 runtime コマンドの `if (sourceMode === 'legacy-file')`
  分岐は本流で実行されない dead code 化した。完全削除は Phase 10 へ defer
  （テスト fixture の依存もあり、安全に剥がすには別フェーズが必要）。
- **CLI 例外 handler の exit code 分け**: 9-12 で
  `LegacyRowsFoundError` / `MaintenanceLockBusyError` を user-fixable と
  みなし top-level catch で exit 1（既存の exit 2 = unexpected と区別）。
- **dual-lock 下の lease stealing 検証範囲**: 9-5 / 9-6 の通り、Phase 9 は
  `domainLock` 層の unit テスト + 直接 `domain_locks` を操作する integration
  で semantics を検証。`runDomainCoding` 経路の full-path lease stealing は
  file lock が primary serialization のため発生しないので、**Phase 10**
  （file lock 撤去）で integration を有効化する。

## Breaking change（強周知）

**`HARNESS_EXPORT_FILES` の default が OFF に反転した**。Phase 8 まで default
ON だったため、無設定で実行していた operator は files が export されなく
なる挙動変化を見る。

- 従来の挙動に戻すには: `export HARNESS_EXPORT_FILES=1`（shell の起動設定 /
  `.env` / CI の env 等）
- warning を黙らせるには: `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1`
- export OFF + 後から files が欲しい: `harness db export-files`

`harness db stats` の truncated 統計、`db restore` の `--wait` / `--timeout
<ms>`、`lock list` の DB セクションも追加されている。docs/specs/cli.md /
db.md / workflow.md を参照。

## スコープ外（Phase 10 以降 / 別トラック）

- **file lock の完全撤去 + DB-lock-only 化** — full-path lease stealing
  integration test を有効化。Phase 9 の dual-lock を終わらせる
- **legacy-file routing の分岐コード完全削除** — Phase 9 で gate により
  unreachable 化された分岐の安全な剥離（テスト fixture の見直しを含む）
- **knowledge entry markdown / project profile / policy の DB canonical 化**
  （編集 UX 含む。Phase 8 設計判断 B のまま）
- **`dashboard serve`** / mutation UI（Phase 10+ 候補）
- **artifact body の外部ストア化（S3 等）** — スケール課題
- **archive DB 分離** — 古い runs を別 DB に
- **`stronger sandbox`**（Phase 3-7 deferred）
- **複数 reviewer / consensus** — `review_proposals` を集約する verdict
  semantics（9-8 が DB-canonical 化までの足がかり）
- **`review_proposals` の retention**（古い superseded proposal の vacuum）

## 検証

- `npm test`: 969 passed / 1 skipped。
- `npm run typecheck`: green。
- schema v1→v5 migration: idempotent（`migrations-v5.test.ts` /
  `migrations.test.ts` / `phase9-fixture-matrix.test.ts`）。
- 既存テスト: 回帰なし（HARNESS_EXPORT_FILES=1 を vitest setup で pin して
  Phase 8 までのテストを保護）。
- 9-12 fixture matrix:
  - shared 中の `db restore` busy
  - lease expiry → 別 process acquire → 元 process の `assertActiveLease` が
    LeaseGuardFailedError
  - pre-9-5 run の lease guard 透過
  - CLI 経由の legacy gate（backlog add が exit 1、migrate-legacy は bypass）
  - export default OFF
  - schema v1→v5 idempotent
