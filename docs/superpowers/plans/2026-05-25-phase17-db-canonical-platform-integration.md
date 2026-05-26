# Phase 17 implementation plan — DB canonical platform integration

**Date:** 2026-05-25
**Design:** `docs/superpowers/specs/2026-05-25-phase17-db-canonical-platform-integration-design.md`
**Starting point:** Phase 10-16 close + post-close review fixes
**Main triage source:** `docs/reports/2026-05-24-phase10-16-codex-review-triage.md`
**Schema target:** v12, if needed for `artifacts.storage='external'` and idempotency changes

## Goal

Make DB the consistent operational center for runtime context, assets,
operations, archive, blob storage, doctor/repair, and dashboard visibility.

Phase 14-16 landed infrastructure. Phase 17 connects it to runtime / CLI /
dashboard / doctor / import/export paths.

## Sub-phase list

| K | Title | Type | Close proof |
|---|---|---|---|
| 17-0 | Spec / acceptance matrix | docs | design + plan committed |
| 17-1 | DB canonical asset read path | feat(runtime) | run reads project/policy/knowledge from DB-first paths |
| 17-2 | project / policy / knowledge import-export-edit CLI | feat(cli) | round-trip tests |
| 17-3 | asset runtime attribution | feat(runtime/db) | run metadata links revisions/snapshots |
| 17-4 | archive DB read-time fallback | feat(db) | archived run lookup test |
| 17-5 | external blob runtime storage | feat(storage/db) | external-local migrate/read/verify/GC tests |
| 17-6 | db doctor / repair / upgrade-check | feat(db/cli) | JSON doctor + safe repair tests |
| 17-7 | dashboard/API operational visibility | feat(dashboard) | read-only endpoint tests |
| 17-8 | end-to-end fixture matrix | test | fixtures A-H green |
| 17-9 | docs / close package | docs | close report + final triage |

## Dependency order

1. 17-0 fixes the acceptance matrix.
2. 17-1 and 17-2 should land before 17-3; attribution needs stable asset IDs.
3. 17-5 depends on schema v12 if current `artifacts.storage` CHECK rejects `external`.
4. 17-6 should run after 17-4/17-5 minimum so doctor sees archive/external blob states.
5. 17-7 should avoid expanding the dashboard server monolith without either a split or a very small route table addition.
6. 17-8 runs after all behavior slices are present.

## Close conditions

```
[x] project profile が DB-first read path で使われる
[x] policy effective snapshot が DB にあり、run に紐づく
[x] knowledge entries/revisions が DB-first に読まれる
[x] project / policy / knowledge の import/export/edit CLI がある
[x] run metadata / run show から asset attribution を追える
[x] archive DB の read-time fallback がある
[x] external blob storage を runtime/API/export が読める
[x] migrate-blobs / verify-blobs / gc-blobs がある
[x] db doctor / repair --dry-run / upgrade-check がある
[x] dashboard/API に asset/storage/archive/doctor/operation status が出る
[~] end-to-end fixture matrix A-H が通る
[x] typecheck / targeted tests green
[ ] docs / close report 更新
```

## Fixture matrix

| ID | Scenario |
|---|---|
| A | DB project profile から run |
| B | DB policy snapshot 付き run |
| C | DB knowledge entry を digest / prompt context に表示 |
| D | archived run を `run show` / API fallback で読む |
| E | external blob artifact を `run show` / dashboard API で読む |
| F | corrupted external blob を doctor が検出 |
| G | stale operation を doctor が検出し safe repair できる |
| H | project / policy / knowledge export/import round-trip |

## Phase 17-0 status

- [x] Formal design created.
- [x] Acceptance matrix defined.
- [x] Sub-phase order and dependency map defined.
- [x] Phase 14-16 infrastructure-only scope carried forward explicitly.

## Progress

- 17-1 implemented: `prepareProjectRun` prefers
  `project_profile_revisions` via `projects.current_profile_revision_id`
  when present. Compatibility YAML remains fallback. Knowledge prompt context
  can read DB current revisions first and records consumed revision IDs.
- 17-2 implemented: minimum `project import/export/edit`, `policy
  snapshot/export`, and `knowledge import/export/show/edit` CLI surfaces are
  wired to the DB revision tables.
- 17-3 implemented: runtime records `runs.project_profile_revision_id`,
  `runs.effective_policy_snapshot_id`, and
  `runs.knowledge_revision_ids_json`; `run show` exposes the attribution.
- 17-4 implemented: run DB readers fall back to `archive_catalog` attached
  archive DBs for single-run lookup surfaces.
- 17-5 implemented: schema v12 allows `artifacts.storage='external'`; DB CLI
  exposes local blob-store registration, migrate to external/DB, verify, and
  GC; dashboard/API and export paths can read external-local artifacts.
- 17-6 implemented: DB CLI exposes archive, attach-archive, doctor, repair,
  upgrade-check, and blob commands. Doctor now detects external blob catalog
  gaps, unavailable external blobs, stale running/pending operations, and
  missing archive paths. `db doctor --deep` verifies local external object
  bytes before reporting blob status. Repair can safely mark stale running
  operations failed.
- 17-7 implemented: read-only dashboard/API endpoints expose assets, storage
  blobs, archives, latest doctor output, and external artifact body reads.
- Scope labels / deferred accuracy:
  - `db archive --before` is currently snapshot archive + attached archive
    fallback. Row-level offload/pruning remains future work.
  - Policy DB integration is complete for effective policy snapshots and run
    attribution. DB policy template editing/runtime sourcing is still partial.
  - External blob catalog remains one location per sha256; multi-store
    location history needs a Phase 18/19 schema decision.
  - Dashboard list pagination and dashboard server route splitting remain
    deferred.
- Verification:
  - `npm run typecheck` ✅
  - targeted Phase 17 tests: 66 passed ✅
  - schema-version regression subset: 67 passed ✅
  - `tests/integration/gh-pr-publisher.test.ts`: 1 passed ✅
  - full `npm test` visible suite reached all displayed tests pass, then the
    Vitest process did not exit and was stopped; no failing assertion was
    observed after the v12 expectation fixes.

Next implementation step: add/label explicit fixture-matrix A-H coverage and
write the Phase 17 close report/tag once the matrix is accepted.
