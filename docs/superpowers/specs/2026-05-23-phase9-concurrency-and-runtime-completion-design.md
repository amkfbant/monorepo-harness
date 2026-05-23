# Phase 9 — concurrency + runtime DB story 完結 設計書

**作成日:** 2026-05-23
**対象:** `phase8-close` + post-close hardening 後の `monorepo-harness`
**実装計画:** `tmp/phase9-concurrency-and-runtime-completion-plan.md`
（外部レビュー反映済み v2）
**ステータス:** 設計確定（Phase 9-0）。実装は 9-1 以降。

---

## 1. 位置づけ — Phase 8 が残した縦串

```txt
Phase 6: files = write-source,        DB = read-source
Phase 7: DB = write-source,           files = compatibility export
Phase 8: DB = runtime complete,       files = optional / migration-only
Phase 9: concurrency safety + runtime DB story 完結
```

Phase 8 で artifact body の DB 格納と file export の opt-in 化が済んだ。
ただし以下の縦串が残った:

- **concurrency**: 現状の domain lock は file lock のみで、lease / heartbeat
  / fencing token がない。DB が runtime canonical になった今、`db restore`
  等の destructive maintenance は他プロセスとの衝突を防ぐ DB-wide lock を
  欠いている。
- **runtime DB story 完結**: file export は default ON、scratch runDir
  の lifecycle 未定義、legacy-file routing が残置、review verdict が file
  仲介、truncated artifact の監査情報なし。

Phase 9 はこの 2 縦串を閉じる。

## 2. canonical 境界（Phase 9 確定値）

Phase 8 の境界を引き継ぐ:

```txt
DB canonical（Phase 8 / Phase 9）:
  run state / events / review decision / changed files / policy violations /
  backlog state / knowledge decision state / PR state / cleanup action /
  artifact manifest + artifact body（top-level + nested）

DB canonical（Phase 9 で追加）:
  review proposal（review_proposals: review auto の verdict）
  domain lock state（domain_locks: lease / heartbeat / fencing token）

file-authored canonical（DB 化しない）:
  knowledge entry の markdown body（docs/knowledge/**/*.md）
  project profile（projects/*.yaml）
  policy（policies/repos/*.yaml、global.yaml）

files = optional compatibility export（Phase 9 close 時点）:
  default OFF。HARNESS_EXPORT_FILES=1 で opt-in。
  export OFF + ingest 成功 → scratch runDir 削除。
```

## 3. 確定した設計判断

### A. concurrency model

#### A1. domain lock の DB 化（lease + heartbeat + fencing token）

`domain_locks` テーブル（schema v5、§4 参照）に lease ベースの domain lock
を持つ。

- `lock_id INTEGER PRIMARY KEY AUTOINCREMENT` を **fencing token として使う**。
  AUTOINCREMENT が global monotonic を保証し、別途 SELECT MAX が要らない。
- `UNIQUE(domain_key) WHERE released_at IS NULL` partial index で「同一
  domain で活きている lease は 1 つ」を強制。
- `LEASE_DURATION_MS = 5 min` / `HEARTBEAT_INTERVAL_MS = 1 min` /
  `LOCK_BUSY_TIMEOUT_MS = 30s`（env override 可）。
- acquire は `BEGIN IMMEDIATE` で:
  1. active lease の有無確認
  2. あって未 expire → busy
  3. あって expired → `released_at = now, release_reason='expired'` で
     soft-release
  4. INSERT で新 lease（lock_id が fencing token）
  5. `runs.lease_lock_id` / `lease_token` / `lease_domain_key` を更新
- heartbeat: `HEARTBEAT_INTERVAL_MS` ごとに `UPDATE expires_at = now + LEASE,
  heartbeat_at = now WHERE lock_id = ? AND holder_run_id = ? AND released_at
  IS NULL`。`changes = 0` → `LeaseLostError`。
- audit columns: `heartbeat_at` / `release_reason`（normal/expired/force/
  stolen/process-exit）/ `released_by`（pid/user/command）。

#### A2. fencing guard（修正版 — v1 レビュー P1-1 反映）

`runs.lease_token` 単体の CAS は **機能しない**。古い run の `lease_token`
は不変のため stale process の write が通る。

修正: **active な `domain_locks` 行を `EXISTS` で検証する**:

```sql
UPDATE runs SET ...
WHERE run_id = :runId
  AND EXISTS (
    SELECT 1 FROM domain_locks
    WHERE lock_id = :lockId
      AND holder_run_id = :runId
      AND released_at IS NULL
      AND expires_at > :now
  );
```

または write 関数の先頭で `assertActiveLease(db, { lockId, runId, now })`
helper を呼ぶ（実装上は後者が読みやすい）。

##### 適用範囲（run execution stage writes のみ）

**lease guard が必要な write**:
- `RunLog.setStatus` / `setSafetyStatus` / `emit(event)` / `finalize`
- `runDomainCoding` の各 stage（`upsertChangedFiles` / `upsertViolations` /
  `writeCommandResults`）
- `ingestRunArtifacts`（artifacts / blob 更新）

**lease guard を使わない write（既存の state guard のまま）**:
- `processReviewDecision` → expected status + operation_id（Phase 7-5）
- `cleanupRun` → expected status guard
- `createPullRequest` → UNIQUE(run_id) + status + operation_id（Phase 7-10）
- backlog / knowledge → entity state_version / operation_id

post-run writes は domain lock を保持していないので lease guard 不適切。
これらは Phase 7 で導入済みの expected status / operation_id で守る。

#### A3. DB-wide maintenance lock（flock ベース）

`.harness/db.lock` を **reader/writer lock** として運用:

- **shared lock (LOCK_SH)** — 通常 write コマンド + 重い read（`db status`
  / `db stats` / `db check-consistency` / `db backup`）
- **exclusive lock (LOCK_EX)** — destructive maintenance + schema 系:
  - `db init` / `db migrate`（schema 変更）
  - `db restore`（DB ファイル swap）
  - `db vacuum`（rebuild）
  - `db checkpoint --truncate`
  - `db migrate-artifacts` / `db migrate-legacy`
- 短い read（`run show` / `harness review list` / `dashboard export`）は
  lock を取らず WAL に任せる。

`db backup` は **shared lock**（destructive ではないため）。

##### Lock ordering（v1 レビュー P1-6 反映）

通常 write コマンド:

```
1. acquire DB-wide shared maintenance lock
2. open DB connection
3. acquire file domain lock（if needed）
4. acquire DB domain lock（if needed）
5. execute command
6. release domain locks
7. close DB connection
8. release shared maintenance lock
```

destructive maintenance:

```
1. acquire DB-wide exclusive maintenance lock
2. open DB connection（if needed）
3. perform operation
4. close DB connection
5. release exclusive maintenance lock
```

`db restore` は **DB を開く前に** exclusive lock を取る（old inode 掴み防止）。

LockHandle は DbHandle にバンドルする:

```ts
interface DbHandle {
  db: Database;
  maintenanceLock?: LockHandle;
  close(): void;  // maintenanceLock.release() + db.close() を必ず実行
}
```

実装手段: `fs-ext` パッケージ（POSIX flock の Node binding）。Windows は
未サポート（POSIX 前提）。

#### A4. file + DB dual-lock 期間（v1 レビュー P1-2 反映）

Phase 9 は **file lock を primary serialization のまま** にし、DB lock を
**並行運用**する。

- `runDomainCoding` は file lock → DB lock の順に二重 acquire。片方失敗で
  もう片方を release。
- **runDomainCoding 経路の lease stealing は Phase 9 では発生しない**
  （file lock が先に block する）。
- lease stealing semantics は **DB lock 層の unit test で検証** し、
  full-path integration test は **Phase 10**（file lock 撤去）に送る。

`harness lock migrate` は **作らない**（v1 レビュー P2-6）— stale file lock
history 化の価値が低いため。Phase 10 で file lock 撤去時に再検討。

### B. runtime DB story 完結

#### B1. file export の default OFF（v1 レビュー P2-5 反映）

Phase 9 close で **即 flip + warning**（deprecation 期間は持たない）:

- `HARNESS_EXPORT_FILES` 未設定 → OFF（Phase 8 では ON）
- 明示 ON: `=1` / `=true` / `=on` / `=yes`
- 未設定時、write コマンド起動時に stderr へ 1 回 warning（per-process）
- `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1` で抑制可（CI / test 用）
- Phase 9 close report で **breaking change として強く周知**

#### B2. scratch runDir lifecycle（v1 レビュー P1-3 反映）

`runDomainCoding` は実行中、`runs/<runId>/` に artifact を書く（compatibility
export を止めても、内部的に runDir を scratch として使う）。Phase 9 で確定:

- 完了時 + ingest 成功 + **export OFF** → `rmSync(runDir, { recursive:
  true, force: true })` で削除
- 完了時 + ingest 成功 + **export ON** → 既存挙動（runDir 残置 = exported
  runs/<id>/）
- ingest failure → runDir 保持 + stderr warning（debug 用）

viewer は変更不要（Phase 8-12 の DB fallback でカバー）。

nested artifact は Phase 8 post-close で `ingestRunArtifacts` が再帰化済み
（`commands/**` / `review-evaluations/**` が DB blob へ）。Phase 9 で追加
実装は不要。

#### B3. legacy-file routing 撤去（runtime scope only、v1 レビュー P1-4 反映）

`source_mode='legacy-file'` の routing 経路を runtime tables から撤去:

- check 対象: `runs` / `backlog_items` / `knowledge_candidates`
- 各 runtime write コマンドの先頭で `assertNoLegacyRuntimeRows(db)` を呼ぶ。
  1 つでも legacy 行があれば exit 1 with actionable error。
- bypass: `db migrate-legacy` / `db import --force-legacy-reconcile` / disaster
  recovery 系（catch-22 回避）
- `knowledge_entries` は **対象外**（markdown は file-authored、Phase 8
  設計判断 B のまま）
- 削除対象コード: `core/cleanup.ts` / `core/pr-creator.ts` / `core/rerun.ts`
  / `core/review-processor.ts` / `core/backlog-db.ts` / `core/knowledge-db.ts`
  の `if (sourceMode === 'legacy-file') ...` 経路

#### B4. `review_proposals` テーブル（v1 レビュー P2-4 反映）

`review auto` の verdict を DB canonical に。

- schema: `review_proposals` テーブル（§4 参照）。`run_id, reviewer` の
  active partial unique index（`WHERE superseded_at IS NULL`）。
- `processed_at` / `review_decision_id` で idempotent な promotion を担保。
- `review auto` は proposal を DB に INSERT、export ON なら sidecar 出力。
- `review process` は DB から最新 active を読み、processed なら no-op、
  未 processed なら `review_decisions` に昇格 + `processed_at` を更新。
- `--reviewer <name>` フラグで特定 reviewer の proposal を選択可（default は
  `ORDER BY reviewed_at DESC, proposal_id DESC LIMIT 1`）。
- 複数 reviewer の verdict 集約は **Phase 10+**。

#### B5. truncated artifact の original 情報

`artifacts` テーブルに `original_bytes INTEGER` / `original_sha256 TEXT` 列を
追加。truncated 時のみ NOT NULL の運用（DB CHECK は付けない — backfill 中の
中間状態を許容）。

- 通常 artifact: 両列 NULL（stored = raw）
- truncated artifact: raw の長さと sha256 を記録
- `harness db stats` の artifact blobs セクションに truncated 統計を追加

### C. 安全モデルは不変

Phase 9 が変えるのは concurrency と runtime DB story の完結だけで、安全
モデルは不変: policy 検証 / 状態遷移 gate / `review auto` 境界 /
`source_mode` invariant はすべて維持。

`db restore` の利用中制約（Phase 8 docs）は A3 の DB-wide exclusive lock で
**実装側に解消**される。

## 4. schema v5

migration v5 で追加するもの:

### domain_locks

```sql
CREATE TABLE domain_locks (
  lock_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  domain_key         TEXT NOT NULL,
  repo_id            TEXT NOT NULL,
  domain             TEXT NOT NULL,
  holder_run_id      TEXT NOT NULL,
  holder_pid         INTEGER NOT NULL,
  holder_hostname    TEXT NOT NULL,
  acquired_at        TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  heartbeat_at       TEXT NOT NULL,
  released_at        TEXT,
  release_reason     TEXT,
  released_by        TEXT
);
CREATE UNIQUE INDEX domain_locks_active_idx
  ON domain_locks(domain_key) WHERE released_at IS NULL;
```

### review_proposals

```sql
CREATE TABLE review_proposals (
  proposal_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id             TEXT NOT NULL,
  reviewer           TEXT NOT NULL,
  decision           TEXT NOT NULL CHECK (decision IN
                       ('pending', 'approved', 'changes_requested', 'rejected')),
  required_changes_json        TEXT NOT NULL DEFAULT '[]',
  non_blocking_comments_json   TEXT NOT NULL DEFAULT '[]',
  out_of_scope_suggestions_json TEXT NOT NULL DEFAULT '[]',
  reviewed_at        TEXT NOT NULL,
  source_yaml        TEXT NOT NULL,
  source_sha256      TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  superseded_at      TEXT,
  processed_at       TEXT,
  review_decision_id TEXT
);
CREATE INDEX review_proposals_run_idx ON review_proposals(run_id, created_at);
CREATE UNIQUE INDEX review_proposals_active_reviewer_idx
  ON review_proposals(run_id, reviewer) WHERE superseded_at IS NULL;
```

### artifacts.original_*

```sql
ALTER TABLE artifacts ADD COLUMN original_bytes  INTEGER;
ALTER TABLE artifacts ADD COLUMN original_sha256 TEXT;
```

### runs.lease_*

```sql
ALTER TABLE runs ADD COLUMN lease_lock_id    INTEGER;
ALTER TABLE runs ADD COLUMN lease_token      INTEGER;
ALTER TABLE runs ADD COLUMN lease_domain_key TEXT;
```

## 5. サブフェーズ

実装計画 `tmp/phase9-concurrency-and-runtime-completion-plan.md` の §4 / §5
を参照。9-0（本書）→ 9-1 schema v5 → 9-2 maintenance lock 基盤 → 9-3
maintenance ops 適用 → 9-4 DB domain lock → 9-5 dual-lock → 9-6 lease/state
guard 分離 → 9-7 scratch lifecycle → 9-8 review_proposals → 9-9
original_* → 9-10 default OFF → 9-11 legacy 撤去 → 9-12 テスト → 9-13
docs/close。

## 6. スコープ外（Phase 10 以降）

- **file lock の完全撤去 + DB-lock-only 化** — full-path lease stealing
  integration test を Phase 10 で有効化
- **knowledge entry markdown / project profile / policy の DB canonical 化**
- **`dashboard serve`** / mutation UI
- **artifact body の外部ストア化（S3 等）**
- **archive DB 分離**
- **`stronger sandbox`**（Phase 3-7 deferred）
- **複数 reviewer / consensus** — `review_proposals` を集約する verdict
  semantics
- **review_proposals retention**（古い superseded proposal の vacuum）
