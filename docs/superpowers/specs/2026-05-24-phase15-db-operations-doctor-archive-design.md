# Phase 15 — DB operations / doctor / archive / backup 設計書

**作成日:** 2026-05-24
**対象:** `phase14-close` (commit `4220a46`) 後の `monorepo-harness`
**実装計画:** `tmp/phase10-16-design-plans/phase15-db-operations-doctor-archive-plan.md`
**ステータス:** 設計確定 (Phase 15-0)。

---

## 1. 位置づけ

Phase 10〜14 で DB は runtime / review / mutation audit / human-authored
assets の canonical store になった。Phase 15 は **運用基盤** を land
する:

- DB health check (doctor)
- 安全な repair (whitelist)
- backup / restore / verify / rotate
- archive (古い runs / blobs / operations を別 DB に)
- stats delta / snapshots
- checkpoint / vacuum policy
- upgrade-check (Phase 16 readiness)

加えて Phase 14 で deferred な asset CLI minimum も Phase 15-2 doctor
check で間接的に絡める (full asset CLI は post-Phase-15)。

---

## 2. Canonical 境界

schema v10:

```
doctor_runs            check execution の per-run記録
doctor_findings        個別 check finding (severity / status / message)
repair_actions         repair の audit trail
backup_catalog         backup snapshot metadata
archive_catalog        archive DB metadata (path / sha / range)
db_stats_snapshots     point-in-time DB stats (size / counts)
```

すべて new tables。既存 row への影響なし。

---

## 3. 確定した設計判断

### A. Doctor check registry

```ts
interface DoctorCheck {
  id: string;             // e.g. 'artifact.blob.missing'
  category: string;       // 'artifacts' / 'runtime' / 'locks' / 'assets'
  severity: 'info'|'warn'|'error'|'critical';
  run(db: Database): DoctorFinding[];
  repairable?: (finding: DoctorFinding) => RepairAction | null;
}
```

Phase 15-2 minimum で 6-8 checks:

1. `artifact.blob.missing` — `artifacts.storage='db'` で blob 不在
2. `runtime.orphan_run` — `runs.status='coding'` で lease released
3. `lock.expired_active` — `domain_locks.expires_at < now` で
   `released_at IS NULL`
4. `assets.dirty_export` — `asset_exports.status='dirty'` (Phase 14
   連携)
5. `scratch.expired` — `run_materializations.status='active' AND
   expires_at < now`
6. `proposals.orphan_processed` — `review_proposals.processed_at IS
   NOT NULL AND review_decision_id IS NULL`

`harness db doctor --json` で structured output、各 finding の
`repairable: boolean` で repair 経由を案内。

### B. Repair (whitelist)

```ts
interface RepairAction {
  id: string;
  description: string;
  apply(db: Database): void;
}
```

Phase 15-3 minimum で 3-4 actions:

1. `lock.release_expired` — `UPDATE domain_locks SET released_at=now,
   release_reason='expired-by-repair' WHERE expires_at < now AND
   released_at IS NULL`
2. `scratch.cleanup_expired` — `markScratchFailed` on stale active rows
3. `exported_files.remove_orphan` — exported_files row pointing to
   missing file

repair は dry-run default、`--apply` で実行。各 repair も
`repair_actions` row として audit。

### C. Backup lifecycle

既存 `harness db backup` (Phase 6) を拡張:
- backup_catalog row INSERT (manifest + sha256 + counts)
- `--rotate N` で N 件まで保持、古いものは削除
- `harness db backup list` / `verify <id>` / `restore --from <id>`

backup manifest (JSON):

```json
{
  "backupId": "...",
  "createdAt": "...",
  "schemaVersion": 10,
  "sqliteSha256": "...",
  "sizeBytes": 123,
  "counts": { "runs": 100, "artifacts": 1000 }
}
```

### D. Archive DB

`harness db archive --before <date>`:

1. exclusive maintenance lock
2. 対象 rows を select (terminal runs / 関連 blobs / operations /
   proposals / decisions)
3. 新 SQLite DB (`.harness/archives/<id>.sqlite`) を作る
4. copy rows + blobs
5. verify (PRAGMA integrity_check + counts)
6. archive_catalog row INSERT
7. (copy-only mode default; --move で main DB から削除)

`harness run show <runId> --include-archives` で read-time fallback。

### E. Stats snapshot / vacuum policy

```bash
harness db stats snapshot      # db_stats_snapshots に row INSERT
harness db stats delta --from <snapshotId>
harness db vacuum [--dry-run]  # backup-before-vacuum default
harness db checkpoint [--truncate]
```

cron guidance docs に記載 (weekly backup --rotate 7 + doctor +
checkpoint, monthly vacuum / archive)。

### F. Upgrade-check

```bash
harness db upgrade-check --target phase16
```

8-10 readiness checks (schema version / legacy rows / dirty exports /
unverified backups / archive candidate volume / blob corruption / asset
conflicts / open operations)。JSON output。

---

## 4. Schema v10

```sql
CREATE TABLE doctor_runs (
  doctor_run_id TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  status        TEXT NOT NULL,
  summary_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE doctor_findings (
  finding_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  doctor_run_id TEXT NOT NULL,
  check_id      TEXT NOT NULL,
  severity      TEXT NOT NULL,
  status        TEXT NOT NULL,
  message       TEXT NOT NULL,
  repairable    INTEGER NOT NULL DEFAULT 0,
  details_json  TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (doctor_run_id) REFERENCES doctor_runs(doctor_run_id)
);
CREATE TABLE repair_actions (
  repair_id    TEXT PRIMARY KEY,
  finding_id   INTEGER,
  action_type  TEXT NOT NULL,
  dry_run      INTEGER NOT NULL,
  status       TEXT NOT NULL,
  result_json  TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE backup_catalog (
  backup_id      TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT NOT NULL,
  verified_at    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('available','missing','failed')),
  manifest_json  TEXT NOT NULL
);
CREATE TABLE archive_catalog (
  archive_id     TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  range_start    TEXT,
  range_end      TEXT,
  schema_version INTEGER NOT NULL,
  sha256         TEXT,
  status         TEXT NOT NULL CHECK (status IN ('attached','detached','missing')),
  metadata_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE db_stats_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL,
  stats_json  TEXT NOT NULL
);
```

---

## 5. Sub-phase

```
15-0  Design                                              ← 本書
15-1  Schema v10 (6 new tables + indexes)
15-2  db doctor (check registry + 6-8 fixtures + CLI --json)
15-3  db repair (whitelist 3-4 actions + dry-run default)
15-4  backup lifecycle (catalog + list/verify/restore/rotate)
15-5  archive DB (catalog + copy-only build + read-time fallback)
15-6  stats snapshot + checkpoint/vacuum policy docs
15-7  upgrade-check (8-10 readiness checks + JSON)
15-8  Docs / close
```

---

## 6. Close conditions

(plan §14 と同じ; 11 items)

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| repair が data loss を起こす | whitelist + dry-run default + backup recommendation |
| archive move が参照を壊す | copy-only default; --move は eligible strict + verify-before-delete |
| backup false sense of safety | verify command + manifest sha + PRAGMA integrity_check |
| scope 巨大 | 各 sub-phase infrastructure-only minimum (Phase 14 と同じ approach); 詳細 CLI / advanced 機能は post-close |

---

## 8. Phase 14 deferred の扱い

Phase 14 で deferred な:
- 3 種 asset CLI (project / policy / knowledge import/edit/export)
- runtime loader DB-first 切替
- asset compat export loop

これらは Phase 15 で **doctor の repair として** 部分的に取り込む
(`asset.dirty_export` repair で recordAssetExport を呼ぶ等)。full CLI
は Phase 16 + post-close work へ送る。
