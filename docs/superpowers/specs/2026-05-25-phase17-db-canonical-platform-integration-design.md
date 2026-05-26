# Phase 17 — DB canonical platform integration 設計書

**作成日:** 2026-05-25
**対象:** Phase 10-16 close + post-close fixes 後の `monorepo-harness`
**実装計画:** `docs/superpowers/plans/2026-05-25-phase17-db-canonical-platform-integration.md`
**ステータス:** Draft for Phase 17-0。

---

## 1. 位置づけ

Phase 10-13 で runtime / review / dashboard / mutation audit は DB-first
の形がかなり揃った。一方 Phase 14-16 は close 時点で infrastructure
landed であり、schema / repository / pure function はあるが、runtime /
CLI / dashboard / doctor / archive / storage read path への接続は未完成。

Phase 17 の目的は、DB が以下の中心として一貫して使われる状態にすること:

- runtime context (project profile / policy / knowledge)
- human-authored asset history and exports
- operation audit and idempotency
- archive / backup / doctor / repair
- artifact blob storage, including external-local object store
- dashboard / read-only API visibility

Phase 17 は "new feature pile" ではなく **integration and convergence**
フェーズ。Phase 14-16 の既存基盤を実運用の read/write path に接続し、
Phase 18 以降で拡張できる平台を固定する。

---

## 2. Canonical 境界

### Runtime

Phase 10 以降、run state / events / artifacts manifest / review decision /
operations は DB canonical。Phase 17 では runtime が参照する **入力側**
も DB-first にする。

### Project profile

```
canonical:
  project_profile_revisions + projects.current_profile_revision_id

compatibility:
  projects/*.yaml import/export
```

Runtime rule:
- DB current revision があれば DB を読む。
- DB row が無い場合のみ compatibility import / file fallback を使う。
- run metadata に `project_profile_revision_id` を保存する。

### Policy

```
canonical:
  policy_templates
  policy_generations
  effective_policy_snapshots

compatibility:
  policies/repos/*.yaml export/import
```

Runtime rule:
- run が実際に使う resolved policy は `effective_policy_snapshots` に固定する。
- existing compile path は snapshot materialization の実装として使う。
- run metadata に `effective_policy_snapshot_id` / policy generation provenance を保存する。

### Knowledge

```
canonical:
  knowledge_entries.current_revision_id
  knowledge_entry_revisions

compatibility:
  docs/knowledge/**/*.md import/export
```

Runtime rule:
- knowledge digest / prompt context は DB current revisions を source of truth とする。
- docs markdown は import/export source であり、runtime canonical read ではない。
- run metadata に consumed `knowledge_revision_ids` を保存する。

### Archive

```
canonical:
  main DB for active rows
  archive_catalog for archive DB inventory
  archive DBs for old read-only rows
```

Read rule:
- normal read path checks main DB first.
- archive fallback is explicit for expensive queries (`--include-archives`) but run-id lookup may fallback automatically where the caller asks for one run.
- archive DB is read-only in Phase 17.

### Blob storage

```
artifacts.storage = 'db':
  artifact_blobs / artifact_blob_chunks

artifacts.storage = 'external':
  external_artifact_blobs + blob_stores + BlobStore adapter
```

Phase 17 target is external-local only. S3 remains Phase 18+.

---

## 3. Phase 17 acceptance matrix

| Area | Acceptance | Evidence |
|---|---|---|
| Project profile | `run --project` can resolve from DB current profile revision | integration fixture A |
| Policy | run creates / reuses effective policy snapshot and links it to run metadata | fixture B + DB assertion |
| Knowledge | knowledge digest/context reads DB current revisions | fixture C |
| Asset CLI | project / policy / knowledge import-export-edit minimum exists | round-trip fixture H |
| Attribution | run metadata exposes project revision / policy snapshot / knowledge revisions | run show + DB assertion |
| Archive | archived run can be read through run show / API fallback | fixture D |
| External blob | run artifact body can be migrated to external-local and read back | fixture E |
| Blob doctor | missing / corrupt external object is reported | fixture F |
| Operations doctor | stale running operation is reported and safe repair can mark failed | fixture G |
| DB doctor | `harness db doctor --json` is operator-usable | CLI + JSON fixture |
| Repair | `harness db repair --dry-run` and `--apply --finding-id` support safe repairs only | CLI fixture |
| Upgrade-check | `harness db upgrade-check --target phase18` reports readiness | unit + CLI |
| Dashboard/API | read-only endpoints expose asset/storage/archive/doctor/operation status | dashboard server test |
| Compatibility | files can be exported/imported but are not runtime source when DB rows exist | round-trip tests |
| Verification | `npm run typecheck` and tests green | close report |

---

## 4. Required schema / migration work

### v12 table rebuild

Phase 17 needs schema v12 for two central changes:

1. `artifacts.storage CHECK` allows `'external'`.
2. operations idempotency model no longer blocks semantically valid retry.

`artifacts` requires SQLite table rebuild:

```sql
CREATE TABLE artifacts_new (... CHECK (storage IN ('file', 'db', 'external')));
INSERT INTO artifacts_new SELECT ... FROM artifacts;
DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;
CREATE INDEX ...;
```

The rebuild must preserve every existing column, index, and foreign-key relation.
Add a migration test that creates pre-v12 rows and verifies data + indexes after
rebuild.

### Operation idempotency

Current post-review behavior treats a failed/cancelled replay as a permanent
identity collision and asks callers to mint a new key. Phase 17 should decide
whether to keep this contract or move to a partial unique index that allows
retry attempts. Until decided, Phase 17 implementation must not silently change
the API contract.

Required deliverable:
- writer / operation coverage map before changing schema.
- tests for succeeded / pending / failed / cancelled replay behavior.

### Runtime attribution columns

Prefer additive nullable columns first:

- `runs.project_profile_revision_id`
- `runs.effective_policy_snapshot_id`
- `runs.knowledge_revision_ids_json`

If existing tables already have equivalent JSON metadata locations, use them
instead of adding columns, but close criteria require queryable / displayable
attribution.

---

## 5. CLI surface

Minimum Phase 17 CLI:

```bash
harness project import <path>
harness project export <project-id> --out <path>
harness project show <project-id>
harness project edit <project-id>

harness policy snapshot --project <project-id>
harness policy export --project <project-id> --out <path>

harness knowledge import --from-docs
harness knowledge export --to-docs
harness knowledge show <entry-id>
harness knowledge edit <entry-id>

harness db archive --before <date>
harness db archive list
harness db attach-archive <path>

harness db blob-store add local --id <store-id> --path <path>
harness db migrate-blobs --to external --store <store-id>
harness db migrate-blobs --to db [--store <store-id>]
harness db verify-blobs [--store <store-id>]
harness db gc-blobs [--dry-run|--apply]

harness db doctor [--json]
harness db doctor --deep [--json]
harness db repair --dry-run
harness db repair --apply --finding-id <id>
harness db upgrade-check --target phase18 [--json]
```

`edit` may use `$EDITOR` for Phase 17. If `$EDITOR` is absent, fail with a
clear message and suggest import/export.

---

## 6. Dashboard / API surface

Phase 17 is read visibility only; do not add new mutation endpoints unless a
sub-phase explicitly re-scopes.

Add read-only endpoints:

```txt
GET /api/assets/projects
GET /api/assets/policies
GET /api/assets/knowledge
GET /api/storage/blobs
GET /api/archives
GET /api/doctor/latest
GET /api/operations?status=running|failed|pending
```

Dashboard sections:
- asset status: current revisions, dirty exports, policy snapshots
- storage status: DB blobs, external blobs, missing/corrupt/truncated
- archive status: archive DBs, archived run counts, latest archive date
- doctor status: latest run, critical findings, repairable findings
- operation status: pending/running/stale/failed operations

Known constraint: `src/dashboard/server/server.ts` is already too large.
Phase 17 should split routes/auth/body parsing before adding much new surface,
or keep additions strictly table-driven and minimal until split lands.

---

## 7. Doctor / repair scope

Doctor checks to include or complete:

| Category | Check |
|---|---|
| runtime | missing run rows, orphan run_events, stale materialized dirs, dirty exports |
| review | active proposal / decision / consensus mismatch, processed proposal without decision |
| assets | project current pointer missing, policy snapshot without provenance, knowledge revision without body |
| artifacts | missing DB blob, corrupted DB blob, missing external catalog/status; `doctor --deep` verifies local external object bytes |
| archive | archive catalog path missing; Phase 17 archive is snapshot/fallback, not row-level offload |
| operations | pending/running operation older than threshold, operation without completion event |

Safe repairs only:
- mark stale operation failed
- rebuild derived stats
- mark expired scratch materialization failed / cleaned
- rebuild exported_files from current export
- recompute blob stats
- release expired DB lock with current `expires_at < now` guard

No destructive archive move or blob deletion without dry-run evidence and an
explicit `--apply`.

---

## 8. Sub-phases

| K | Title | Output |
|---|---|---|
| 17-0 | Spec / acceptance matrix | this design + overview + close matrix |
| 17-1 | DB canonical asset read path | project/policy/knowledge DB-first read |
| 17-2 | project / policy / knowledge import-export-edit CLI | minimum human editing UX |
| 17-3 | asset runtime attribution | run metadata links revisions/snapshots |
| 17-4 | archive DB read-time fallback | archive build/list/attach + run lookup |
| 17-5 | external blob runtime storage | v12 + external-local read/migrate/verify/GC |
| 17-6 | db doctor / repair / upgrade-check | operator quality gate |
| 17-7 | dashboard/API operational visibility | read-only asset/storage/archive/doctor views |
| 17-8 | end-to-end fixture matrix | A-H fixture matrix green |
| 17-9 | docs / close package | close report + triage update |

Implementation order may swap 17-4 and 17-5 if schema v12 is the blocking path.
Do not start 17-5 without the v12 rebuild plan and tests.

---

## 9. End-to-end fixture matrix

| ID | Fixture | Required proof |
|---|---|---|
| A | DB project profile from run | `run --project` succeeds without using file profile when DB current revision exists |
| B | DB policy snapshot | run records `effective_policy_snapshot_id` and uses snapshot body |
| C | DB knowledge digest | digest/context reads DB revision body |
| D | archived run fallback | `run show` can find a run only present in archive DB |
| E | external blob artifact | artifact body migrated to external-local is readable by run show / API |
| F | corrupted external blob | doctor reports missing/corrupt external object |
| G | stale operation | doctor reports and repair marks stale operation failed |
| H | asset round-trip | project/policy/knowledge import/export preserves semantic body |

---

## 10. Close conditions

```
[ ] project profile が DB-first read path で使われる
[ ] policy effective snapshot が DB にあり、run に紐づく
[ ] knowledge entries/revisions が DB-first に読まれる
[ ] project / policy / knowledge の import/export/edit CLI がある
[ ] run metadata / run show から asset attribution を追える
[ ] archive DB の read-time fallback がある
[ ] external blob storage を runtime が読める
[ ] migrate-blobs / verify-blobs / gc-blobs がある
[ ] db doctor / repair --dry-run / upgrade-check がある
[ ] dashboard/API に asset/storage/archive/doctor/operation status が出る
[ ] end-to-end fixture matrix A-H が通る
[ ] typecheck / tests green
[ ] docs / close report 更新
```

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| DB/file split-brain remains hidden | DB-first read path + explicit import/export compatibility labels |
| schema v12 table rebuild corrupts artifacts | rebuild tests + backup recommendation + index verification |
| doctor produces false confidence | every readiness check must cite exact tables and failure mode |
| external blob migration loses data | DB unchanged until external put/head succeeds; verify before optional delete |
| dashboard monolith becomes harder to change | split or table-drive routes before broad visibility additions |
| Phase 17 too large | acceptance matrix is ordered; close partial work by sub-phase reports if needed |
