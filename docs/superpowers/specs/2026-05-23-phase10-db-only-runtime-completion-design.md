# Phase 10 — DB-only runtime completion 設計書

**作成日:** 2026-05-23
**対象:** `phase9-close` (+ post-close fix 第 1, 2 弾) 後の `monorepo-harness`
**実装計画:** `tmp/phase10-16-design-plans/phase10-db-only-runtime-completion-plan.md`
**ステータス:** 設計確定（Phase 10-0）。実装は 10-1 以降。

---

## 1. 位置づけ — Phase 9 が残した転位

```txt
Phase 6: files = write-source,        DB = read-source
Phase 7: DB = write-source,           files = compatibility export
Phase 8: DB = runtime complete,       files = optional / migration-only
Phase 9: concurrency safety + runtime DB story 完結
Phase 10: transition 状態の閉鎖（dual-lock 撤去 + 整理 + 整合）
```

Phase 9 は transition phase だった。Phase 8 binary と Phase 9 binary が同居しても破綻しないよう、file lock と DB lock を **dual-lock** として並走させた。同様に、scratch runDir と compatibility export はコード上同一の materialize 経路に乗り、`HARNESS_EXPORT_FILES` フラグだけで分岐していた。viewer は runDir があれば file を優先し、runtime コードには `source_mode === 'legacy-file'` の dead-ish branch が残った。review process は最新 proposal を読むのみで、processing 中に新しい proposal が届いたときの safety は浅かった。

Phase 10 はこれらを閉じる。Phase 10 close 時点で:

```txt
domain serialization:    DB domain lock only
runtime source of truth: DB
files:                   明示的 compat export OR scratch materialize (役割が table 上で区別される)
viewer:                  DB-canonical 優先 (--source files は debug のみ)
review:                  proposal_id + source_sha256 + state_version + operation_id で idempotent
legacy runtime branch:   runtime command から削除済 (recovery は maintenance command に閉じ込め)
```

Phase 10 のスコープは **runtime** に限定する。human-authored assets (project profile YAML / policy YAML / knowledge markdown) の DB canonical 化は Phase 14。

---

## 2. canonical 境界（Phase 10 確定値）

Phase 9 から境界は変えない。境界の意味を「Phase 10 では本当に DB 一択で読み書きする」と狭める:

```txt
DB canonical（Phase 6〜9 で確定、Phase 10 で唯一の経路に）:
  run state / events / review decision / changed files / policy violations /
  backlog state / knowledge decision state / PR state / cleanup action /
  artifact manifest + artifact body（top-level + nested）/
  review proposal / domain lock state

file-authored canonical（Phase 14 まで DB 化しない）:
  knowledge entry の markdown body（docs/knowledge/**/*.md）
  project profile（projects/*.yaml）
  policy（policies/repos/*.yaml、global.yaml）

files = (1) compat export — operator が明示要求した永続 export
            exported_files + runs.export_status='synced' を更新
        (2) scratch materialize — review/pr/external command のための一時 file
            run_materializations にだけ記録、exported_files は更新しない
            完了後 (TTL 経過 or 明示 cleanup) に削除
```

`HARNESS_EXPORT_FILES` の default OFF は Phase 9 のまま。Phase 10 で名前や意味を変えない。

---

## 3. 確定した設計判断

### A. file domain lock 完全撤去 & DB-only domain lock

#### A1. 削除と維持

**削除対象 (runtime code から)**:

```txt
src/workspace/domain-lock.ts                       (runtime usage を削除し、ファイル自体は Phase 10-1 で削除)
.harness/locks/<domain>.lock を取得する経路        (workflow-runner / cli/lock.ts)
lock list / release の file source branch          (cli/lock.ts)
file-only stale lock cleanup logic                  (cli/lock.ts)
```

**維持対象**:

```txt
src/workspace/db-domain-lock.ts                    (Phase 9 で導入、lease/heartbeat/fencing token を実装)
domain_locks テーブル                              (Phase 9 schema v5)
runs.lease_lock_id / lease_token / lease_domain_key (Phase 9 schema v5)
harness lock list / release の DB source           (cli/lock.ts は DB-only に絞る)
```

#### A2. lock migrate コマンドの扱い

`harness lock migrate` は Phase 9 で **未作成** だった (P2-6 で見送り)。Phase 10 でも作らない。代わりに、Phase 10 起動時に `.harness/locks/*.lock` が残っていれば **無視 + 1 回 warning** を stderr に出す:

```
warning: legacy file domain lock found at .harness/locks/<domain>.lock — ignored.
         Phase 10 uses DB domain locks (domain_locks table) exclusively.
         You can safely delete .harness/locks/.
```

`HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING=1` で抑制可。

#### A3. lock ordering の簡素化

Phase 9 の通常 write 経路は次の 5 段:

```
1. shared maintenance lock
2. open DB
3. acquire file domain lock
4. acquire DB domain lock
5. execute
```

Phase 10 は (3) を削除する:

```
1. shared maintenance lock
2. open DB
3. acquire DB domain lock
4. execute
5. release DB domain lock
6. close DB
7. release shared maintenance lock
```

destructive maintenance (exclusive) の手順は Phase 9 のまま。

### B. DB lease stealing semantics の確定

Phase 9 では dual-lock のため、`runDomainCoding` 経路で実際に DB lease stealing が観測される機会はなかった。Phase 10 で file lock が消えると lease stealing が initially 発生する経路 (`runDomainCoding` 自体) が増える。Phase 10-0 では次の semantics を確定する。

#### B1. 観測経路

```
process A:
  acquire domain DB lease (lock_id = X, lease_token = X, expires_at = now+5min)
  run starts, RunLog.setStatus('coding')
  ... (heartbeat 停止 — SIGSTOP / GC pause / event loop block)

lease expires (heartbeat_at + LEASE_DURATION < now):

process B:
  acquire same domain DB lease →
    soft-release expired A's row (release_reason='expired', released_by='steal:<B-info>')
    INSERT new lease (lock_id = Y, lease_token = Y)
    runs.lease_lock_id := Y for B's run

process A resumes:
  next guarded write executes assertActiveLease(db, { lockId: X, runId: A's runId, now })
  → EXISTS check fails (A's row has released_at IS NOT NULL)
  → write throws LeaseLostError
  → workflow-runner catches LeaseLostError
  → A finalizes its run as `failed` with reason='lease-stolen' using
    an UNGUARDED finalize path (see B2)
  → process A exits 1
```

#### B2. stale writer の finalization (B が DB を壊さない要件)

stale writer (A) の次 guarded write は失敗する。これだけでは A の `runs.status` が `coding` のまま残り、後続の `db doctor` で異常扱いになる。Phase 10 では:

- `LeaseLostError` を catch した workflow-runner は、**unguarded finalize path** で `runs.status = 'failed'`、`runs.failure_reason = 'lease-stolen'`、`runs.lease_lost_at = now` を書く。
- この path は `assertActiveLease` を回らないが、次の **expected-status guard + lost-lease ownership guard + state_version bump** を組み合わせて守る:

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

- **`AND lease_lock_id=:lostLockId` の意義** (post-review P1): A が `LeaseLostError` を catch した時点と finalize SQL の発行までの間に、同じ `run_id` が rerun されて新 lease を持ち、新 attempt が `status='coding'` で走り始めていても、A は **自身が失った lease_lock_id 行のみを finalize** する。新 attempt の live 状態を誤って `failed` にしない。
- state_version bump で finalize を runtime state transition として記録し、後続 read からも変更が検出できる (§3.E の CAS と統一)。
- B が並行で A の run row を触ることはない (run_id が異なるため)。よって lost update は発生しない。
- post-run table (review/cleanup/pr/backlog) は **触らない**。A の run は domain operation を完了していないため。

これにより:

- B の lease/run は影響を受けない (B は B 自身の run_id にしか write しない)。
- A の run は `failed` で確定し、`db doctor` の orphan run 検出から外れる。
- DB の global state は壊れない (各 write が run_id 単位で分離されているため)。

#### B3. minimum orphan detection (Phase 15 待たず)

Phase 15 で `db doctor` が完成するが、Phase 10-2 では最小限の orphan 検出をテストで使う:

```sql
-- "expired but not released" 警告
SELECT * FROM domain_locks
WHERE released_at IS NULL
  AND expires_at < datetime('now', '-1 minute');

-- "orphan in-progress run" 警告 (post-review P3: NOT IN は NULL-unsafe なので NOT EXISTS)
SELECT r.* FROM runs r
WHERE r.status = 'coding'
  AND NOT EXISTS (
    SELECT 1 FROM domain_locks dl
    WHERE dl.lock_id = r.lease_lock_id
      AND dl.released_at IS NULL
  );
```

これらは Phase 10-2 で integration test fixture として書く。Phase 15 の `db doctor` 本実装は同じ SQL を再利用する。

### C. materialize / export の分離

#### C1. 概念分離

```txt
compat-export:
  - operator が明示的に "永続 file artifact が欲しい" と要求した
  - exported_files に row、runs.export_status='synced' に更新
  - db check-consistency / db doctor の対象
  - rmSync / cleanup は明示コマンド経由のみ

scratch:
  - review / pr / external command を実行するために一時的に file を作りたい
  - run_materializations に row、exported_files は **触らない**
  - 完了後 (TTL 経過 OR 明示 cleanup) に rmSync で削除
  - DB canonical state ではない
  - cleanup 漏れは db doctor の警告対象 (scratch past TTL)
```

#### C2. API 形状 (実装は Phase 10-3)

```ts
type MaterializePurpose = "scratch" | "compat-export";

materializeRun(db, {
  runId,
  purpose: "scratch",
  ttlMs?: number,
  reason: string,
}): MaterializationHandle;
// scratch のみ受け付ける薄い helper として export。compat-export は別経路。

exportRun(db, {
  runId,
  purpose: "compat-export",
  force?: boolean,
}): ExportReport;
// 既存 db/export-files.ts の関数を rename + 明示 purpose 化
```

`materializeRun({ purpose: 'compat-export' })` は **エラー** (`InvalidArgumentError`)。両 API を 1 関数に束ねない。

#### C3. scratch lifecycle

- `materializeRun({ purpose: 'scratch', ttlMs })` で row を INSERT (`status='active', expires_at = now + ttlMs`)。
- 呼び出し元は handle.cleanup() を finally で呼ぶ。cleanup は `rmSync(path, { recursive: true, force: true })` + row を `status='cleaned', cleaned_at = now` に update。
- 失敗時 (`HARNESS_KEEP_SCRATCH_ON_FAILURE=1` set 時のみ) は path を残し、row を `status='failed'` に update + `error_message` を記録。次の `harness db materialize cleanup --expired` で回収可能。
- `harness db materialize cleanup --expired` は `expires_at < now AND status = 'active'` を rmSync + cleaned 化。
- post-run command (`harness review process` の git diff 生成、`harness pr create` の patch 添付) は scratch を使う。compat-export は使わない。

#### C4. exported_files との関係

`run_materializations.purpose = 'scratch'` は **絶対に** `exported_files` を更新しない。`runs.export_status` も更新しない。これは Phase 10-3 で test invariant として書く。

### D. DB-canonical viewer

#### D1. 解決ルール

`harness run show <runId> --source <db|files|auto>` の `--source auto` (default):

```txt
auto:
  case source_mode = 'db-first':
    DB を読む。runDir が在っても無視 (stale 可能性あり)。
    runDir が DB と inconsistent な場合は warning footer に表示。

  case source_mode = 'legacy-file':
    Phase 10 runtime では原則発生しない (10-6 で legacy branch 撤去後)。
    read-only inspection (=db migrate-legacy 等の maintenance) でのみ存在し得る。
    その時は files を読む。

--source db:
  DB のみ。runDir が在っても読まない。`source_mode = 'legacy-file'` の run は reject。

--source files:
  runDir のみ。DB が在っても読まない。debug 用。`source_mode='db-first'` でも許す
  (operator が "diff 確認したい" 等の意図がある)。
```

#### D2. artifact body 読み込み

`harness run artifacts <runId>` は manifest を DB から読む。body 取得は `--source` に従う:

- auto / db: `artifact_blobs` (top-level) または `artifact_blob_chunks` から復元
- files: runDir から `fs.readFile`

`export_status` が `disabled / dirty / failed / removed` の場合、`auto` でも warning を 1 行表示:

```
Note: file export status = dirty. Files in runs/<runId>/ may be stale.
      Use --source files to inspect files explicitly.
```

#### D3. review proposal / decision viewer も DB を優先

`harness review list` / `harness review show <runId>` は Phase 9 で DB を読むようになっている。Phase 10 で再確認 + `--source files` を debug 用に追加 (sidecar YAML が残っている場合の確認手段)。

### E. review process idempotency hardening

#### E1. guard 条件

`review process` の core mutation は次を **transaction 内で** 全部満たすことを確認する:

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

`changes = 0` → `StateConflictError` を投げる。CLI/API は最新 proposal の再確認をユーザーに促す。

#### E2. operation_id 重複

`processReviewDecision` 内で `operation_id` をすでに使っている (Phase 7-5)。Phase 10-5 では:

- 同一 `(operation_id, target_run_id)` の record が存在し、結果が同一なら **idempotent no-op** (既存結果を返す)。
- 結果が違う場合は `OperationReplayConflictError`。

詳細な transaction flow は §3.E.5 を参照。

#### E2-bis. Operation transaction flow (normative, post-review P2)

review process の operation は次の単一 SQLite transaction (`BEGIN IMMEDIATE`)
内で実行する。**guard SQL 単体ではなく flow 全体を normative とする** ことで、
operation replay の組み合わせを完全に cover する:

```
TX BEGIN IMMEDIATE

1. operation claim:
   SELECT * FROM operations
    WHERE operation_type = 'review.process'
      AND target_run_id = :runId
      AND idempotency_key = :operationId;

   case row exists AND status = 'succeeded':
     if request_hash == :requestHash:
       → idempotent no-op、stored result_json を返す
     else:
       → OperationReplayConflictError (different intent, same key)

   case row exists AND status = 'running':
     → OperationInFlightError (異プロセス処理中)

   case row exists AND status = 'failed':
     → 既存 row を UPDATE で再 claim ('running' 化、started_at 更新)
     (idempotency_key の再試行を許容)

   case no row:
     INSERT operations (operation_id, operation_type, target_run_id,
                        idempotency_key, status='running', request_hash,
                        input_json, created_at, started_at);

2. proposal CAS (= E1 の guard SQL):
   UPDATE review_proposals
      SET processed_at = :now, review_decision_id = :decisionId
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

   case changes = 0:
     UPDATE operations SET status='failed', error_code='state_conflict',
                           completed_at=:now WHERE operation_id=:operationId;
     → StateConflictError

3. decision INSERT + run state update:
   INSERT review_decisions (...);
   UPDATE runs SET status=:nextStatus, state_version=state_version+1,
                   reviewed_at=:now WHERE run_id=:runId AND state_version=:expectedStateVersion;
   (UPDATE 失敗 = race → StateConflictError、operation を failed/state_conflict 化)

4. operation 完了化:
   UPDATE operations SET status='succeeded', result_json=:result,
                         completed_at=:now WHERE operation_id=:operationId;

TX COMMIT
```

**request_hash の計算**:

```
request_hash = sha256(canonical_json({
  proposal_id:           :proposalId,
  source_sha256:         :expectedSourceSha,
  expected_status:       :expectedStatus,
  expected_state_version::expectedStateVersion,
  decision_payload:      :decisionPayloadCanonical,
}))
```

operation_id を再送した時に request_hash が一致するか確認することで、CLI/API
client の意図的な再送と、別意図の同 key 衝突を区別する。

**operation transaction の意味**:

- step 1-4 を `BEGIN IMMEDIATE` 内に閉じることで、proposal CAS が成立した
  瞬間と operation succeeded 記録の間で他プロセスが review process を
  仕掛けることを完全に排除する。
- `BEGIN IMMEDIATE` は SQLite で writer lock を即時取得するため、複数
  client の review process が並行発生しても、最大 1 つだけが proposal CAS
  まで進める。

#### E3. state_version

Phase 9 まで `runs` に `state_version` 列はない。Phase 10-3 または 10-5 で:

```sql
ALTER TABLE runs ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;
```

を schema v6 で追加。すべての runtime state transition は `state_version = state_version + 1` する。`UPDATE runs SET state_version = state_version + 1, ... WHERE run_id = ? AND state_version = ?` の CAS で守る。

state_version の bump 対象 (initial set):

- `RunLog.setStatus` / `setSafetyStatus`
- `processReviewDecision`
- `cleanupRun`
- `createPullRequest`
- `rerunFromReview`
- §B2 の **stale writer clean finalize** (`UPDATE runs SET status='failed', ... WHERE ... AND lease_lock_id=:lostLockId`)

bump しない:

- artifact ingest (write が頻繁、衝突は run_id 単位で防ぐ)
- heartbeat (lease 側の更新で十分)
- run_events / changed_files / policy_violations の INSERT

state_version の存在は Phase 11 で consensus evaluator の "consensus 再計算が必要かどうか" 判定にも流用できる。Phase 10 では runtime guard としてのみ使う。

#### E5. state_version rollout safety (post-review P2)

schema v6 migration が `runs.state_version DEFAULT 0` を追加した瞬間から、E1
の guard SQL は `AND state_version = :expectedStateVersion` で CAS する。
途中状態 (state_version 列はあるが bump しない writer が残る) は CAS が
false-positive (差分 0) を返し続け、review process が永続的に conflict に
なるリスクがある。

これを避けるため、Phase 10-5 の commit は **次を 1 commit / 1 sub-phase 内で
一体的に landing** させる:

1. `runs.state_version` 列の migration (schema v6 の一部)
2. 上記 bump 対象 writer 全てに `state_version = state_version + 1` を追加
   (`RunLog.setStatus` / `setSafetyStatus` / `processReviewDecision` /
    `cleanupRun` / `createPullRequest` / `rerunFromReview` / B2 finalize)
3. review process の CAS guard (E1) を有効化
4. lease-stolen clean finalize の guard を有効化 (B2)
5. fixture / integration test

**feature flag による段階的有効化は行わない** (途中状態 = 危険状態)。

migration boundary を1 commit に閉じることで、Phase 10-3 (run_materializations
+ state_version migration) と Phase 10-5 (CAS 有効化) の間に **state_version
を bump しない CI / 開発分岐が混在しない**ようにする。

実装順序の選択:

- Option α: Phase 10-3 で migration v6 をマージ + bump 対象 writer 全更新 +
  CAS 有効化 (= 10-3 と 10-5 のコード変更を 10-3 で全部 land)。
- Option β: Phase 10-3 で migration のみ追加し、state_version は当面
  bump しない / 読まない。Phase 10-5 で bump + CAS を 1 commit で有効化。

Phase 10 は Option β を採る (sub-phase boundary を保つ、commit 粒度の整合)。
ただし **Phase 10-3 から Phase 10-5 までの間 = state_version 列は存在するが
未使用** であり、この期間に review process の CAS を有効化してはいけない。
Phase 10-3 commit message + Phase 10-5 spec に明記する。

#### E4. CLI UX

```
$ harness review process <runId>
error: review proposal state changed since you read it.
       Latest active proposal:    proposal_id=12, reviewer=codex, source_sha256=abcd…
       Run state:                 status=in-review, state_version=4
       You attempted to process:  proposal_id=11, source_sha256=ef01…
       Re-run with the latest proposal, or use --proposal 12 explicitly.
```

### F. runtime legacy branch 撤去範囲

#### F1. 撤去対象 (runtime rows のみ)

```
runs
run_events
review_decisions
review_proposals
artifacts
command_results
run_changed_files
policy_violations
cleanup records
pr records
```

これらに対する runtime write 経路から `if (sourceMode === 'legacy-file') { ... }` 分岐を削除。

撤去対象コード:

```
src/core/cleanup.ts
src/core/pr-creator.ts
src/core/rerun.ts
src/core/review-processor.ts
src/core/backlog-db.ts
src/core/knowledge-db.ts        (knowledge decision state のみ。markdown body は別 phase)
src/db/scopes.ts                (sourceMode resolution helper の legacy branch)
```

#### F2. 撤去しない (= Phase 14 マター)

```
project profile YAML
policy YAML
docs/knowledge/**/*.md
```

これらは file-authored canonical のまま。`knowledge_entries` テーブルの body 関連列は触らない。

#### F3. 起動 guard

Phase 9-11 で導入した `assertNoLegacyRuntimeRows(db)` は維持。Phase 10 の legacy-row 検出は次のメッセージにする:

```
error: legacy-file runtime rows detected (runs / backlog_items / knowledge_candidates).
       Phase 10 runtime does not support legacy-file rows.
       Run `harness db migrate-legacy` or `harness db import --force-legacy-reconcile`.
       This message comes from assertNoLegacyRuntimeRows(db).
```

bypass:

```
db migrate-legacy
db import --force-legacy-reconcile
db doctor
db check-consistency
```

これらは legacy rows を読む必要があるため、startup guard を通さない (既に Phase 9-11 でこの設計)。

---

## 4. schema v6

migration v6 で追加するもの:

### 4.1 run_materializations

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

`purpose='compat-export'` を schema CHECK で **reserved for future use** として
許可するが、Phase 10 内では INSERT も SELECT も **行わない** (post-review P3
で曖昧さを除去)。compat-export tracking は既存 `exported_files` で完結し、
`run_materializations` には `purpose='scratch'` 行のみが入る。compat-export
row を実際に書き始める計画は Phase 15 (`db doctor` が compat export の
TTL/orphan を追跡する必要が出たとき) に判断する。

run_materializations を読む queries (`db doctor` / `db materialize cleanup`)
は **`WHERE purpose = 'scratch'` を必ず明示する**ことで、将来 compat-export
が混入しても誤動作しないようにする。

### 4.2 runs.state_version

```sql
ALTER TABLE runs ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0;
```

既存 run には DEFAULT 0 が入る。Phase 10-5 以降の state transition で +1 する。

### 4.3 migration の順序

`src/db/schema.ts` の `SCHEMA_VERSION = 5` → `6`。Phase 10-3 (run_materializations) と Phase 10-5 (state_version) の両方を **同一 v6 migration** にまとめて扱う。理由:

- 1 phase に schema version を 2 つ消費する価値が薄い
- materialize/export 分離と review idempotency は両方とも transition 閉じであり、close 単位での "v6 = Phase 10" の対応が読みやすい

Phase 10-3 で migration を書き、Phase 10-5 で同一 migration に state_version を足す形になる (順序逆でも可)。Phase 10-3 と 10-5 のどちらかが先行 commit する時、もう一方の ALTER も同じ migration ブロックに居る前提で組む。

---

## 5. CLI 変更計画

### 5.1 lock

```bash
harness lock list                            # DB locks のみ表示。file source 表示廃止
harness lock release --domain <d> [--run-id <id>] [--force]
                                             # DB lock のみ release
                                             # stale (expires_at < now) は --force なしで release 可
```

`harness lock migrate` は **無し**。`.harness/locks/*.lock` が残っていても起動 warning 1 回のみ。

### 5.2 materialize / export

```bash
harness db materialize --run <runId> [--ttl 1h] [--out <dir>]
                                             # scratch materialize。runDir を作って path 出力
harness db materialize cleanup [--expired] [--run <runId>]
                                             # scratch cleanup

harness db export-files --run <runId>
harness db export-files --project <projectId>
harness db export-files --all
                                             # compat export。exported_files + export_status='synced' を更新
```

### 5.3 run show / artifacts

```bash
harness run show <runId> [--source db|files|auto]      # default = auto
harness run artifacts <runId> [--source db|files|auto] # default = auto
```

Phase 9 まで `--source` 自体が無かった (default が files-first の暗黙)。Phase 10 で **explicit option** として追加し、default を auto に切り替える。

### 5.4 review

```bash
harness review list [--source db|files]      # default = db。--source files は debug
harness review show <runId>                  # 同上
harness review process <runId> [--proposal <id>] [--reviewer <name>]
                                             # 後述 idempotency guard
```

---

## 6. サブフェーズ

```
10-0  Design finalization                  ← 本書
10-1  Remove file domain lock
10-2  Real DB lease stealing tests
10-3  Materialize/export separation (schema v6 — run_materializations)
10-4  DB-canonical run/artifact viewer
10-5  Review process idempotency hardening (schema v6 — runs.state_version)
10-6  Runtime legacy branch dead code removal
10-7  Docs / close package
```

`tmp/phase10/phase10-overview.md` および `tmp/phase10-16-design-plans/phase10-db-only-runtime-completion-plan.md` §7 と一致。

---

## 7. Close conditions (= 受け入れ条件)

```
[ ] file domain lock が runtime から完全撤去されている
[ ] domain serialization が DB domain lock のみで成立する
[ ] lease stealing full integration test がある
[ ] stale writer の write が DB を壊さず reject される
[ ] materialize と export が分離されている (table 上で区別)
[ ] scratch materialize が exported_files / export_status を更新しない
[ ] run/artifact viewer が DB-canonical data を優先する
[ ] review process が proposal_id / source_sha256 / active state / state_version で guard される
[ ] runtime legacy-file branch が削除されている
[ ] existing tests green
[ ] npm run typecheck green
[ ] docs / close report / phase10-close tag
```

各 close condition と sub-phase の対応:

| Condition | Sub-phase |
|---|---|
| file domain lock 完全撤去 | 10-1 |
| DB lock のみで serialization | 10-1 + 10-2 |
| lease stealing integration test | 10-2 |
| stale writer reject + DB safe | 10-2 (semantics) + 10-1 (実装) |
| materialize / export 分離 | 10-3 |
| scratch が exported_files 更新しない | 10-3 (invariant test) |
| viewer DB-canonical 優先 | 10-4 |
| review process guard | 10-5 |
| legacy-file branch 削除 | 10-6 |
| existing tests / typecheck green | 全 sub-phase |
| docs / close report / tag | 10-7 |

---

## 8. Phase 11 への接続点

Phase 11 は review_proposals を governance layer に拡張する:

- **reviewer identity** (reviewers table) — Phase 10 で proposal に `reviewer` 文字列のみ。Phase 11 で `reviewer_id` (FK) に正規化。
- **review rule snapshot** (run_review_rule_snapshots) — Phase 10 で `runs.state_version` が出来るので、rule snapshot の stable reference に使える (rule 変更しても `state_version` で再評価可否を切り替えられる)。
- **consensus** — 複数 proposal の集約。Phase 10-5 の idempotency guard はそのまま consensus evaluator にも適用される (consensus も `state_version` で守られる)。
- **proposal lifecycle** (active / superseded / processed / archived) — Phase 10 で `superseded_at` / `processed_at` は既にある。Phase 11 で `lifecycle_status` 列を追加して状態機械化。

Phase 10 close の時点で **将来の Phase 11 を縛らない設計** を確認する観点:

- proposal の `reviewer` 列を `reviewer_id` に rename しても compat 取れるか → Phase 11 で alias 列 + view で対応可能。
- `state_version` を consensus 再計算 trigger に流用しても問題ないか → Phase 10 で意味を "runtime state の lamport clock" として定義しておけば、consensus も同じ意味で使える。

---

## 9. スコープ外（Phase 11 以降）

- 複数 reviewer consensus / N-of-M approval (= Phase 11)
- dashboard serve / HTTP API (= Phase 12)
- mutation API / dashboard からの approve / cleanup (= Phase 13)
- project profile / policy / knowledge markdown の DB canonical 化 (= Phase 14)
- external blob store (= Phase 16)
- archive DB (= Phase 15)
- stronger sandbox (= Phase 3-7 deferred)

---

## 10. Risks (Phase 10 固有)

### Risk 10-α: DB lock only にすると hidden race が露出する

dual-lock 撤去前は file lock が先に block していたため、DB lease stealing 経路は実質上の hot path ではなかった。Phase 10 で hot path になる。

**Mitigation:**
- Phase 10-2 で integration test を先に書く (10-1 より先に lease stealing test を組む選択肢もあり)。
- LEASE_DURATION_MS / HEARTBEAT_INTERVAL_MS / LOCK_BUSY_TIMEOUT_MS の test 専用 short override を許す env を追加 (`HARNESS_LEASE_DURATION_MS` 等)。
- `assertActiveLease` を transaction 内 SELECT EXISTS に統一 (Phase 9 §A2 のまま)。

### Risk 10-β: scratch cleanup で debug artifact が消えて困る

review/pr 失敗時、scratch を即削除すると operator が現場検証できない。

**Mitigation:**
- `HARNESS_KEEP_SCRATCH_ON_FAILURE=1` set 時は失敗時 path を残す。row を `status='failed'` で保持。
- `harness db materialize cleanup --expired` で後から回収可能。
- run_materializations.reason / metadata_json で debug 情報を残す。

### Risk 10-γ: viewer DB-first 化で existing scripts が壊れる

これまで `runs/<runId>/` を `cat` していた script は、scratch cleanup 後に file が無くなって失敗する。

**Mitigation:**
- `--source files` debug flag を案内。
- compat export を script に組み込む手順を docs/specs/cli.md で示す (`harness db export-files --run <id>` を script の前段に置く)。
- `run show` の auto モードでの warning に "use --source files explicitly" を含める。

### Risk 10-δ: legacy branch removal が disaster recovery 経路を弱める

`source_mode='legacy-file'` を runtime command から削除すると、災害時に legacy DB から復旧する経路が痩せる。

**Mitigation:**
- Phase 9-11 で導入した bypass list (`db migrate-legacy` / `db import --force-legacy-reconcile` / `db doctor` / `db check-consistency`) を維持。これらの maintenance command に閉じ込める。
- close report に recovery path を明記。

### Risk 10-ε: schema v6 migration が runtime を壊す

`run_materializations` 追加と `runs.state_version` 追加を同一 migration v6 でまとめる。idempotent 化を確認する。

**Mitigation:**
- migration test を 10-3 開始時に RED で書く。
- v5 DB → v6 DB → v5 DB rollback (= 単純 ALTER TABLE では rollback 困難) は **行わない**。v5 ← v6 は DB backup からの restore で対応 (Phase 15 で formalize)。
- v6 migration が冪等であること (二度実行で失敗しない) を test。

---

## 11. Out-of-design 判断 (=今書かない)

- `run_materializations.purpose='compat-export'` 行を実際に INSERT する経路は Phase 10 では作らない。compat-export tracking は既存 `exported_files` でやる。run_materializations は **scratch のみ** が現実運用。
- scratch の TTL default 値は **無し** (= 必ず明示) にする。default を持つと cleanup タイミングがコード散在する。
- 起動 warning の集約 (legacy file lock / export OFF / deprecation 諸々) は Phase 10 では各 sub-phase が個別に warn する。集約 warning is out of scope。

---

## 12. 参考

- 元計画書: `tmp/phase10-16-design-plans/phase10-db-only-runtime-completion-plan.md`
- Phase 9 設計: `docs/superpowers/specs/2026-05-23-phase9-concurrency-and-runtime-completion-design.md`
- Phase 9 close report: `docs/reports/2026-05-23-phase9-close.md`
- Phase 10 overview (tmp): `tmp/phase10/phase10-overview.md`
- Phase 10-0 detailed plan (tmp): `tmp/phase10/phase10-0-design-finalization.md`
