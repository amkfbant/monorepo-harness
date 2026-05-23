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

- `npm test`: 969 passed / 1 skipped（close 直後）→ post-close fix 後
  **987 passed / 1 skipped**。
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

## post-close fix（外部 codex gpt-5.5 xhigh レビュー反映）

Phase 9 close 後に実施した外部レビューで P0×1 / P1×2 / P2×4 / P3×5 を検出。
P0〜P2 はすべて修正を入れた（P3 は positive observation のため対応不要）。

| ID | issue | 修正コミット |
|----|-------|------|
| P0 | runtime DB writers が DB-wide maintenance lock を取らずに `openDb` を直接呼んでいた。`db restore` が live runtime プロセスから DB を atomic に置換できる data-safety リスク | `b5a2690` `fix(db): Phase 9 post-close — runtime DB open に shared maintenance lock を適用` |
| P1 #2 | `review auto` の DB persist 経路が `runMigrations` + `assertNoLegacyRuntimeRows` を skip し、`insertProposal` 失敗を warning に降格していた（同コミット） | `b5a2690` |
| P1 #1 | `review process` の `applyReviewDecision` と `markProcessed` が別 transaction で、間 crash で active unprocessed proposal が status=approved の run に残り、再実行で `ReviewGateError` | `f6ec947` `fix(db): Phase 9 post-close — review_proposals idempotency` |
| P2 #1 | fencing token bootstrap window（最初の INSERT が `lease_*` を null で書き、直後 UPDATE で stamp） | `5170125` `fix: Phase 9 post-close — codex P2 #1〜#4 まとめ修正` |
| P2 #2 | `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=0` でも warning が消えてしまう正規化バグ | `5170125` |
| P2 #3 | `docs/specs/db.md` / `workflow.md` の legacy-file gate scope 記述で `knowledge_candidates` も対象と書いていたが実装は runs + backlog_items のみ | `5170125` |
| P2 #4 | scratch runDir lifecycle の integration test が phase9-fixture-matrix に無かった | `5170125` |

### 主な変更

- 新ヘルパ `src/db/managed-connection.ts` — `openManagedDb` /
  `withManagedDb` が maintenance lock を取得してから `openDb` を呼び、
  `close()` は DB handle を閉じてから lock を release する（inode 単位の
  swap から保護）。`lockPath` は `dbPath` から自動派生（`deriveDbLockPath`）
- 全 runtime DB open（workflow-runner / review-processor / cleanup /
  pr-creator / backlog-db / knowledge-db / rerun / run-materialize /
  run-db-reader / dashboard/snapshot / cli/db-scope / cli/run.ts
  lock list-release / reviewer-agent）を managed wrapper 経由に移行
- `workflow-runner.ts` の teardown 順序が「heartbeat 停止 → DB lease
  release → DB handle close + maintenance lock release → file lock release」
  に確定（dbHandle.close が DB と lock を atomically 解放）
- `RunRepository.applyReviewDecision` が optional `markProposalProcessed`
  を受け取り、同 transaction で `review_proposals.processed_at` を立てる
- `ReviewProposalRepository`: `getLatestActiveProposal` を `processed_at
  IS NULL` でも filter、`markProcessed` に `WHERE processed_at IS NULL`
  guard、新規 `getLatestProcessedProposal` 追加
- `review-processor` の冒頭で「すでに processed + run.status != needs_review」
  ケースを idempotent no-op として return
- `createDbRunLog` の最初の INSERT に lease_* を同梱（bootstrap window 解消）
- `HARNESS_SUPPRESS_EXPORT_MODE_WARNING` を ON_VALUES と同じ truthy 正規化
- `docs/specs/db.md` / `workflow.md` の legacy gate scope 記述を実装に揃え
- `tests/integration/scratch-run-dir-lifecycle.test.ts` を新規追加
- `tests/integration/review-process-idempotency.test.ts` を新規追加
- `tests/unit/db/managed-connection.test.ts` を新規追加

合計 4 コミット、+1077 / -142、テスト 988 → 987 passed / 1 skipped
（managed-connection +9, review-proposals 編集 +4 (旧 1 改 + 新 3), idempotency +2,
scratch +2, suppress +2 = +19 / 既存修正 1 で 988 → 987）。

### 残課題（Phase 10）

- file lock の完全撤去（dual-lock を解く）
- legacy-file 分岐コードの dead code 剥離
- crash 後の review process idempotency: 現状は「processed proposal が
  ある + run.status != needs_review」を no-op 扱いするが、より精密に
  `source_sha256` 一致確認まで入れる選択肢あり

## post-close fix 第 2 弾（独立外部レビュー反映）

最初の codex post-close fix の後、別系統の外部レビュアから Phase 9 の
P1×6 / P2×6 / P3×3 の指摘を受領。すべて受け入れて修正。

### P1 系（修正済み）

| ID | 内容 | コミット |
|----|------|------|
| P1-1 | materialize と compatibility export の分離 — exportRun に trackExport:boolean を追加し、ensureRunMaterialized は trackExport:false 経由。syncRunArtifactsToDb 後に export OFF + db-first なら runDir 削除。run-viewer に shouldPreferDbForRun helper を追加し、db-first AND export_status != synced で DB を canonical 扱い | `5b9fb93` |
| P1-2 | exportRun の review sidecar logic に active review_proposals を反映（review_decisions > active proposal > pending template の優先順） | `5b9fb93` |
| P1-3 | reviewer-agent.ts の write 順序を逆転（DB-first、sidecar は fileExportEnabled() のときだけ、OFF なら stale sidecar を rm） | `5b9fb93` |
| P1-4 | markProcessed / applyReviewDecision の inline UPDATE に `AND superseded_at IS NULL` guard 追加（0-rows changed で StateConflictError）、reviewer-agent.ts に insertProposal 前の run.status guard 追加 | `5b9fb93` |
| P1-5 | reviewer-agent.ts の overwrite guard を DB active proposal primary に切替、file decision を secondary fallback | `5b9fb93` |
| P1-6 | RunRepository.forceFailFinalize（lease guard を bypass する recovery path）追加、workflow-runner の catch path で LeaseGuardFailedError を up-front 検知し ingest を skip、fallback として forceFailFinalize を呼ぶ | `2a82972` |

### P2 系（修正済み）

| ID | 内容 | コミット |
|----|------|------|
| P2-1 | docs/specs/workflow.md に「assertActiveLease を Phase 10 で transaction 内へ移す」blocker 注記 | `02c96ae` |
| P2-2 | review-processor の file fallback パスで、file decision を `reviewer='manual-file'` として review_proposals に import → applyReviewDecision で markProposalProcessed | `02c96ae` |
| P2-3 | lock list が DB 未初期化 / schema < v5 / domain_locks 無しでも graceful。readonly open に変更 | `02c96ae` |
| P2-4 | maintenance-lock.ts の acquire loop で EWOULDBLOCK / EAGAIN のみ retry、その他 errno は throw（busy で disguise しない） | `02c96ae` |
| P2-5 | check-consistency に artifacts.original_* invariant 追加（truncated → original_* 必須 / original_bytes >= bytes / 非 truncated → original_* null） | `02c96ae` |
| P2-6 | docs/specs/cli.md に「shared vs exclusive の意味」を明文化（shared = read-only ではない） | `02c96ae` |

### P3 系（修正済み）

| ID | 内容 | コミット |
|----|------|------|
| P3-1 | src/db/schema.ts と artifact-blobs.ts のヘッダコメントを Phase 9 反映（schema v5 / original_bytes 記録） | `02c96ae` |
| P3-3 | docs/specs/cli.md の restore 説明に「Phase 9 で exclusive lock を取るので runtime release まで待つ」を追加 | `02c96ae` |

### 主な追加テスト

- `tests/integration/lease-stolen-finalize.test.ts` — lease 奪取後の
  forceFailFinalize 動作 / no-op idempotency / 実 lease 奪取後の recovery
- `tests/integration/materialize-and-export-tracking.test.ts` —
  exportRun が active proposal を sidecar に出すこと、
  ensureRunMaterialized が exported_files / export_status を更新しないこと
- `tests/unit/db/maintenance-lock.test.ts` — 非 busy flock error 伝播
- `tests/unit/db/consistency.test.ts` — truncated invariant 3 ケース
- `tests/unit/db/review-proposals.test.ts` — markProcessed の supersede guard

### 検証

- `npm test`: **997 passed / 1 skipped**（typecheck green）
- post-close fix 第 2 弾で +10（lease-stolen 3 + materialize 2 +
  flock error 1 + consistency 3 + markProcessed supersede 1）
