/**
 * harness DB schema.
 *
 * The DB (`.harness/harness.sqlite`) evolved across four phases:
 *  - Phase 6 (v1): a read model built from files by `db import --from-files`.
 *  - Phase 7 (v2/v3): the DB-first write path — runtime state is DB-canonical.
 *  - Phase 8 (v4): runtime DB complete — artifact bodies move into the DB
 *    (`artifact_blobs`), file export becomes optional.
 *  - Phase 9 (v5): concurrency + runtime DB story completion —
 *    `domain_locks` (DB-backed domain lock with lease + heartbeat + fencing
 *    token = lock_id), `review_proposals` (DB-canonical review verdicts),
 *    `runs.lease_*` columns (fencing token stamp), `artifacts.original_*`
 *    (truncated artifact audit). `HARNESS_EXPORT_FILES` defaults OFF —
 *    files are compatibility export only.
 *
 * `schema.ts` holds the DDL only. The migration runner (`migrations.ts`)
 * applies it; repositories (`repositories/`) own the queries.
 */

/** Current (latest) schema version produced by the migrations. */
export const SCHEMA_VERSION = 22;

/**
 * v1 DDL — the read-side tables (overview §5). Each statement is run
 * individually inside the migration transaction. Write-side tables
 * (`artifact_blobs` / `project_check_results` / `domain_locks`) are
 * deliberately NOT created here; they arrive in a later migration.
 *
 * No FOREIGN KEY constraints are declared: the read model tolerates
 * dangling references exactly as the file model does (e.g. a backlog
 * item linking a run whose dir was cleaned). Referential integrity is
 * the importer's concern, not the schema's.
 */
export const MIGRATION_V1_STATEMENTS: readonly string[] = [
  // --- migration / db metadata --------------------------------------
  `CREATE TABLE db_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  )`,

  // --- projects / repos / domains -----------------------------------
  `CREATE TABLE projects (
    project_id TEXT PRIMARY KEY NOT NULL,
    repo_id TEXT NOT NULL,
    profile_path TEXT,
    profile_version INTEGER,
    description TEXT,
    repo_path TEXT,
    base_branch TEXT,
    package_manager TEXT,
    created_at TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE project_profiles (
    project_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    source_yaml TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    loaded_at TEXT NOT NULL,
    PRIMARY KEY (project_id, version)
  )`,
  // domain_key is a surrogate key: a composite (repo_id, domain_id,
  // project_id) would put NULL project_id into a PRIMARY KEY, which
  // SQLite treats as always-distinct. The importer derives domain_key
  // deterministically so upserts stay idempotent.
  `CREATE TABLE domains (
    domain_key TEXT PRIMARY KEY NOT NULL,
    project_id TEXT,
    repo_id TEXT NOT NULL,
    domain_id TEXT NOT NULL,
    root TEXT NOT NULL,
    kind TEXT,
    title TEXT
  )`,

  // --- generated policies + provenance ------------------------------
  `CREATE TABLE policy_generations (
    generation_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT,
    repo_id TEXT NOT NULL,
    profile_version INTEGER,
    policy_template_id TEXT,
    policy_template_version INTEGER,
    generated_at TEXT NOT NULL,
    repo_policy_yaml TEXT NOT NULL,
    global_policy_yaml TEXT,
    provenance_json TEXT NOT NULL,
    repo_policy_sha256 TEXT NOT NULL
  )`,

  // --- runs ----------------------------------------------------------
  `CREATE TABLE runs (
    run_id TEXT PRIMARY KEY NOT NULL,
    repo_id TEXT NOT NULL,
    project_id TEXT,
    repo_path TEXT,
    domain TEXT NOT NULL,
    workflow TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    base_sha TEXT,
    run_branch TEXT,
    status TEXT NOT NULL,
    safety_status TEXT,
    reviewer TEXT,
    reviewed_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    parent_run_id TEXT,
    root_run_id TEXT,
    rerun_attempt INTEGER,
    changed_files_count INTEGER,
    ignored_untracked_count INTEGER,
    secret_suspect_count INTEGER,
    pr_url TEXT,
    pr_number INTEGER,
    prompt_template_name TEXT,
    prompt_template_version INTEGER,
    knowledge_context_path TEXT,
    imported_from TEXT,
    source_meta_sha256 TEXT,
    source_meta_mtime_ms INTEGER,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX runs_project_idx ON runs(project_id, started_at)`,
  `CREATE INDEX runs_repo_idx ON runs(repo_id, started_at)`,
  `CREATE INDEX runs_domain_idx ON runs(repo_id, domain, started_at)`,
  `CREATE INDEX runs_status_idx ON runs(status, started_at)`,
  `CREATE INDEX runs_parent_idx ON runs(parent_run_id)`,
  `CREATE INDEX runs_root_idx ON runs(root_run_id)`,

  // --- run lifecycle events -----------------------------------------
  `CREATE TABLE run_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    occurred_at TEXT,
    payload_json TEXT NOT NULL,
    source_sha256 TEXT,
    UNIQUE (run_id, seq)
  )`,

  // --- command results ----------------------------------------------
  `CREATE TABLE command_results (
    run_id TEXT NOT NULL,
    command_index INTEGER NOT NULL,
    command_id TEXT,
    command TEXT NOT NULL,
    exit_code INTEGER,
    duration_ms INTEGER,
    timed_out INTEGER NOT NULL DEFAULT 0,
    stdout_artifact_id TEXT,
    stderr_artifact_id TEXT,
    PRIMARY KEY (run_id, command_index)
  )`,

  // --- changed files / policy violations ----------------------------
  `CREATE TABLE run_changed_files (
    run_id TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT,
    allowed INTEGER,
    source TEXT,
    PRIMARY KEY (run_id, path)
  )`,
  `CREATE TABLE policy_violations (
    run_id TEXT NOT NULL,
    path TEXT NOT NULL,
    rule TEXT NOT NULL,
    reason TEXT,
    PRIMARY KEY (run_id, path, rule)
  )`,

  // --- review decisions ---------------------------------------------
  `CREATE TABLE review_decisions (
    run_id TEXT PRIMARY KEY NOT NULL,
    decision TEXT NOT NULL,
    reviewer TEXT,
    summary TEXT,
    reviewed_at TEXT,
    source_yaml TEXT NOT NULL,
    source_sha256 TEXT NOT NULL
  )`,
  `CREATE TABLE review_required_changes (
    run_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    change_text TEXT NOT NULL,
    PRIMARY KEY (run_id, idx)
  )`,

  // --- artifacts (manifest only in v1; body stays file-backed) ------
  `CREATE TABLE artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT,
    kind TEXT NOT NULL,
    relative_path TEXT,
    content_type TEXT,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage TEXT NOT NULL DEFAULT 'file' CHECK (storage = 'file'),
    created_at TEXT,
    redacted INTEGER NOT NULL DEFAULT 0,
    secret_suspect INTEGER NOT NULL DEFAULT 0
  )`,

  // --- context packs -------------------------------------------------
  `CREATE TABLE run_context_packs (
    run_id TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    total_bytes INTEGER,
    capped INTEGER,
    manifest_yaml TEXT,
    PRIMARY KEY (run_id, pack_id)
  )`,
  `CREATE TABLE run_context_pack_files (
    run_id TEXT NOT NULL,
    pack_id TEXT NOT NULL,
    path TEXT NOT NULL,
    bytes INTEGER,
    included INTEGER NOT NULL,
    reason TEXT,
    PRIMARY KEY (run_id, pack_id, path)
  )`,

  // --- backlog -------------------------------------------------------
  `CREATE TABLE backlog_items (
    item_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT,
    repo_id TEXT,
    domain TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  `CREATE TABLE backlog_run_links (
    item_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (item_id, run_id)
  )`,

  // --- knowledge -----------------------------------------------------
  `CREATE TABLE knowledge_candidates (
    candidate_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL,
    project_id TEXT,
    repo_id TEXT,
    domain TEXT,
    kind TEXT NOT NULL,
    title TEXT,
    body TEXT,
    status TEXT NOT NULL,
    created_at TEXT,
    decided_at TEXT,
    reviewer TEXT,
    reason TEXT
  )`,
  `CREATE TABLE knowledge_entries (
    entry_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT,
    repo_id TEXT,
    domain TEXT,
    kind TEXT NOT NULL,
    path TEXT,
    title TEXT,
    body TEXT NOT NULL,
    frontmatter_json TEXT,
    created_at TEXT,
    source_candidate_id TEXT
  )`,

  // --- import bookkeeping -------------------------------------------
  `CREATE TABLE import_errors (
    source_path TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    error TEXT NOT NULL,
    observed_at TEXT NOT NULL
  )`,
];

/**
 * v2 DDL — Phase 7 (DB-first write path).
 *
 * Two kinds of change:
 *  - ALTER TABLE: adds `source_mode` (the migration invariant — file-first
 *    commands must not mutate `db-first` rows) and export bookkeeping
 *    columns to the four runtime tables. Existing rows imported by Phase 6
 *    default to `legacy-file`.
 *  - CREATE TABLE: `export_records` / `exported_files` track which DB
 *    revision was last exported to files; `operations` is the
 *    operation-id idempotency ledger; `pull_requests` / `cleanup_actions`
 *    make `pr create` / `cleanup` DB-first.
 *
 * `run_events` already declares `UNIQUE (run_id, seq)` in v1, so no event
 * uniqueness change is needed here.
 */
const RUNTIME_TABLES_GETTING_SOURCE_MODE: readonly string[] = [
  "runs",
  "backlog_items",
  "knowledge_candidates",
  "knowledge_entries",
];

export const MIGRATION_V2_STATEMENTS: readonly string[] = [
  // --- source_mode + export bookkeeping on the runtime tables ---------
  ...RUNTIME_TABLES_GETTING_SOURCE_MODE.flatMap((t) => [
    `ALTER TABLE ${t} ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'legacy-file'`,
    `ALTER TABLE ${t} ADD COLUMN db_revision INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE ${t} ADD COLUMN last_export_revision INTEGER`,
    `ALTER TABLE ${t} ADD COLUMN export_status TEXT NOT NULL DEFAULT 'synced'`,
    `ALTER TABLE ${t} ADD COLUMN last_exported_at TEXT`,
    `ALTER TABLE ${t} ADD COLUMN last_export_error TEXT`,
  ]),

  // --- export records ------------------------------------------------
  `CREATE TABLE export_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    db_revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_message TEXT,
    exported_files_json TEXT
  )`,
  `CREATE INDEX export_records_scope_idx
     ON export_records(scope_type, scope_id, id)`,
  `CREATE TABLE exported_files (
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    db_revision INTEGER NOT NULL,
    exported_at TEXT NOT NULL,
    PRIMARY KEY (scope_type, scope_id, relative_path)
  )`,

  // --- operation-id idempotency ledger -------------------------------
  `CREATE TABLE operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    command TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL
  )`,

  // --- pull requests (pr create DB-first) ----------------------------
  `CREATE TABLE pull_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    repo TEXT,
    branch TEXT,
    base_branch TEXT,
    title TEXT,
    url TEXT,
    external_pr_id TEXT,
    status TEXT NOT NULL,
    operation_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX pull_requests_run_idx ON pull_requests(run_id)`,

  // --- cleanup actions (cleanup DB-first) ----------------------------
  `CREATE TABLE cleanup_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target TEXT,
    status TEXT NOT NULL,
    executed_at TEXT NOT NULL,
    error_message TEXT
  )`,
  `CREATE INDEX cleanup_actions_run_idx ON cleanup_actions(run_id)`,
];

/**
 * v3 DDL — Phase 7-3.
 *
 * `runs.meta_json` holds the full canonical `meta.json` document for a
 * DB-first run. The flattened `runs` columns stay the query index; this
 * column is the lossless source the export writes back, so a run whose
 * `meta.json` carries fields without a dedicated column (full `project`
 * provenance, the `reviewed` fingerprint) still round-trips exactly.
 * Legacy / file-imported rows leave it NULL — the export falls back to
 * reconstructing `meta.json` from the columns.
 */
export const MIGRATION_V3_STATEMENTS: readonly string[] = [
  `ALTER TABLE runs ADD COLUMN meta_json TEXT`,
];

/**
 * v4 DDL — Phase 8 (runtime DB complete).
 *
 *  - `artifact_blobs` / `artifact_blob_chunks`: content-addressed artifact
 *    body storage (chunked SQLite BLOB). Phase 7 left artifact bodies
 *    file-backed; Phase 8 moves them into the DB.
 *  - `artifacts` is rebuilt: its v1 `CHECK (storage = 'file')` cannot be
 *    altered in place, so the table is recreated with `storage IN
 *    ('file','db')` and the new `blob_sha256` / `body_status` columns.
 *  - `pull_requests` gets a `UNIQUE(run_id)` index (one PR per run). Any
 *    pre-existing duplicate rows are de-duplicated (keep the latest `id`)
 *    before the index is created so the migration cannot fail on them.
 */
export const MIGRATION_V4_STATEMENTS: readonly string[] = [
  // --- artifact body storage ----------------------------------------
  // `sha256` content-addresses the STORED body — the bytes the blob holds
  // after truncation (over `HARD_MAX_BYTES`) and before compression. It is
  // the sha of exactly what `readArtifactBlob` returns, so `blob_sha256`
  // always matches the readable body. `bytes` is that stored length; an
  // over-max body keeps no separate original-size record — the artifact's
  // `body_status='truncated'` is the truncation signal.
  `CREATE TABLE artifact_blobs (
    sha256 TEXT PRIMARY KEY NOT NULL,
    bytes INTEGER NOT NULL CHECK (bytes >= 0),
    content_encoding TEXT NOT NULL DEFAULT 'identity'
      CHECK (content_encoding IN ('identity', 'gzip')),
    stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE artifact_blob_chunks (
    sha256 TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    content BLOB NOT NULL,
    PRIMARY KEY (sha256, chunk_index)
  )`,

  // --- pull-request attempt ledger -----------------------------------
  // a run keeps at most one canonical `pull_requests` row (UNIQUE below);
  // every prior / non-canonical attempt is preserved here so audit and
  // operation_id history is not lost when duplicates are de-duplicated.
  `CREATE TABLE pull_request_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    operation_id TEXT,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX pull_request_attempts_run_idx
     ON pull_request_attempts(run_id)`,

  // --- rebuild `artifacts` to allow storage='db' + body columns ------
  `CREATE TABLE artifacts_v4 (
    artifact_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT,
    kind TEXT NOT NULL,
    relative_path TEXT,
    content_type TEXT,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage TEXT NOT NULL DEFAULT 'file' CHECK (storage IN ('file', 'db')),
    blob_sha256 TEXT,
    body_status TEXT NOT NULL DEFAULT 'legacy_file',
    created_at TEXT,
    redacted INTEGER NOT NULL DEFAULT 0,
    secret_suspect INTEGER NOT NULL DEFAULT 0
  )`,
  `INSERT INTO artifacts_v4 (artifact_id, run_id, kind, relative_path,
     content_type, bytes, sha256, storage, blob_sha256, body_status,
     created_at, redacted, secret_suspect)
   SELECT artifact_id, run_id, kind, relative_path, content_type, bytes,
     sha256, storage, NULL, 'legacy_file', created_at, redacted,
     secret_suspect
   FROM artifacts`,
  `DROP TABLE artifacts`,
  `ALTER TABLE artifacts_v4 RENAME TO artifacts`,

  // --- pull_requests: one PR per run ---------------------------------
  // salvage every non-canonical (older) PR row into the attempt ledger
  // BEFORE deleting it, so no audit / operation_id history is lost.
  `INSERT INTO pull_request_attempts
     (run_id, operation_id, status, error_message, created_at)
   SELECT run_id, operation_id, status, NULL, created_at
   FROM pull_requests
   WHERE id NOT IN (SELECT MAX(id) FROM pull_requests GROUP BY run_id)`,
  `DELETE FROM pull_requests
   WHERE id NOT IN (SELECT MAX(id) FROM pull_requests GROUP BY run_id)`,
  `CREATE UNIQUE INDEX pull_requests_run_unique ON pull_requests(run_id)`,
];

/**
 * v5 DDL — Phase 9 (concurrency + runtime DB story 完結).
 *
 *  - `domain_locks`: lease-based domain locks with heartbeat and fencing
 *    tokens. `lock_id` is `INTEGER PRIMARY KEY AUTOINCREMENT` and acts as
 *    the fencing token (global monotonic). A partial unique index on
 *    `domain_key WHERE released_at IS NULL` enforces "at most one active
 *    lease per domain". Audit columns (`heartbeat_at` / `release_reason`
 *    / `released_by`) make operational debugging tractable.
 *  - `review_proposals`: DB-canonical store for `review auto` verdicts.
 *    A partial unique index on `(run_id, reviewer) WHERE
 *    superseded_at IS NULL` enforces "at most one active proposal per
 *    (run, reviewer)". `processed_at` / `review_decision_id` make
 *    `review process` idempotent (a re-processed proposal is a no-op).
 *  - `artifacts.original_bytes` / `original_sha256`: monotonic NULL ↔
 *    `body_status='truncated'` invariant — only truncated artifacts
 *    record the original (pre-truncation) size and sha. No CHECK is
 *    declared so backfill (`migrate-artifacts`) can set them in steps.
 *  - `runs.lease_lock_id` / `lease_token` / `lease_domain_key`: the
 *    active lease a run acquired. `lease_token` equals `lease_lock_id`
 *    (kept as a separate column for query readability).
 */
export const MIGRATION_V5_STATEMENTS: readonly string[] = [
  // --- domain_locks (Phase 9 — A1) ---------------------------------
  `CREATE TABLE domain_locks (
    lock_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_key       TEXT NOT NULL,
    repo_id          TEXT NOT NULL,
    domain           TEXT NOT NULL,
    holder_run_id    TEXT NOT NULL,
    holder_pid       INTEGER NOT NULL,
    holder_hostname  TEXT NOT NULL,
    acquired_at      TEXT NOT NULL,
    expires_at       TEXT NOT NULL,
    heartbeat_at     TEXT NOT NULL,
    released_at      TEXT,
    release_reason   TEXT,
    released_by      TEXT
  )`,
  `CREATE UNIQUE INDEX domain_locks_active_idx
     ON domain_locks(domain_key) WHERE released_at IS NULL`,
  `CREATE INDEX domain_locks_holder_idx ON domain_locks(holder_run_id)`,

  // --- review_proposals (Phase 9 — B4) -----------------------------
  `CREATE TABLE review_proposals (
    proposal_id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                        TEXT NOT NULL,
    reviewer                      TEXT NOT NULL,
    decision                      TEXT NOT NULL
      CHECK (decision IN ('pending', 'approved',
        'changes_requested', 'rejected')),
    required_changes_json         TEXT NOT NULL DEFAULT '[]',
    non_blocking_comments_json    TEXT NOT NULL DEFAULT '[]',
    out_of_scope_suggestions_json TEXT NOT NULL DEFAULT '[]',
    reviewed_at                   TEXT NOT NULL,
    source_yaml                   TEXT NOT NULL,
    source_sha256                 TEXT NOT NULL,
    created_at                    TEXT NOT NULL,
    superseded_at                 TEXT,
    processed_at                  TEXT,
    review_decision_id            TEXT
  )`,
  `CREATE INDEX review_proposals_run_idx
     ON review_proposals(run_id, created_at)`,
  `CREATE UNIQUE INDEX review_proposals_active_reviewer_idx
     ON review_proposals(run_id, reviewer) WHERE superseded_at IS NULL`,

  // --- artifacts.original_* (Phase 9 — B5) -------------------------
  `ALTER TABLE artifacts ADD COLUMN original_bytes  INTEGER`,
  `ALTER TABLE artifacts ADD COLUMN original_sha256 TEXT`,

  // --- runs.lease_* (Phase 9 — A1 fencing guard) -------------------
  `ALTER TABLE runs ADD COLUMN lease_lock_id    INTEGER`,
  `ALTER TABLE runs ADD COLUMN lease_token      INTEGER`,
  `ALTER TABLE runs ADD COLUMN lease_domain_key TEXT`,
];

/** Tables added by v2. */
export const V2_TABLE_NAMES: readonly string[] = [
  "export_records",
  "exported_files",
  "operations",
  "pull_requests",
  "cleanup_actions",
];

/** Tables added by v4 (Phase 8). */
export const V4_TABLE_NAMES: readonly string[] = [
  "artifact_blobs",
  "artifact_blob_chunks",
  "pull_request_attempts",
];

/** Tables added by v5 (Phase 9). */
export const V5_TABLE_NAMES: readonly string[] = [
  "domain_locks",
  "review_proposals",
];

/**
 * v6 DDL — Phase 10 (DB-only runtime completion).
 *
 *  - `run_materializations`: tracks scratch materializations
 *    (`runs/<id>/` directories created so post-run commands can spawn a
 *    codex / external tool over the run's files). Phase 9 left this
 *    lifecycle implicit; Phase 10-3 makes it explicit so `db doctor` can
 *    surface scratch leaks (`status='active' AND expires_at < now`).
 *    `purpose='compat-export'` is **reserved for future use** (Phase 15):
 *    Phase 10 reads / writes only `purpose='scratch'` rows. The existing
 *    `exported_files` table remains the canonical tracker for compat
 *    exports.
 *  - `runs.state_version`: monotonic counter bumped on every runtime
 *    state transition (`RunLog.setStatus` / `processReviewDecision` /
 *    `cleanupRun` / `createPullRequest` / `rerunFromReview` / the stale
 *    finalize path). The CAS that uses this column is **not** enabled
 *    by this migration — Phase 10-5 lands the writer-side bump and the
 *    `review process` guard together in one commit. Until then, the
 *    column simply tracks the default `0`.
 */
export const MIGRATION_V6_STATEMENTS: readonly string[] = [
  // --- run_materializations (Phase 10-3 — design §3.C) -----------
  `CREATE TABLE run_materializations (
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
  )`,
  `CREATE INDEX run_materializations_run_idx
     ON run_materializations(run_id, created_at)`,
  `CREATE INDEX run_materializations_expiry_idx
     ON run_materializations(status, expires_at)`,

  // --- runs.state_version (Phase 10-5 — design §3.E.E3) ----------
  // DEFAULT 0 means every existing Phase 9 row migrates with version 0.
  // Writers that bump this column come online in Phase 10-5.
  `ALTER TABLE runs ADD COLUMN state_version INTEGER NOT NULL DEFAULT 0`,
];

/** Tables added by v6 (Phase 10). */
export const V6_TABLE_NAMES: readonly string[] = [
  "run_materializations",
];

/**
 * v7 DDL — Phase 11 (review governance / consensus).
 *
 *  - `reviewers`: reviewer identity registry. Default rows (human / codex
 *    / codex-security / system) are seeded by `INSERT OR IGNORE` so the
 *    migration is idempotent across reruns.
 *  - `review_rules`: project/repo/domain-scoped rule templates with
 *    version history; `(scope, version)` is the addressable unit.
 *  - `run_review_rule_snapshots`: per-run effective rule freeze — once a
 *    run starts, profile changes do not retroactively alter its review
 *    semantics.
 *  - `review_consensus`: computed consensus rows, with a partial unique
 *    index for at-most-one active consensus per run.
 *  - `review_overrides`: human override audit log (actor / reason /
 *    decision).
 *  - `review_proposals` additions: `reviewer_id` (FK to reviewers,
 *    nullable for legacy rows) / `reviewer_type` / `model` /
 *    `prompt_sha256` / `context_pack_id` / `policy_generation_id` /
 *    `lifecycle_status` / `archived_at`.
 *  - `review_decisions` additions: `consensus_id` / `proposals_summary_json`
 *    so a consensus-mode decision carries the source consensus + proposals
 *    snapshot.
 *
 *  Existing Phase 9-10 `review_proposals` rows migrate with
 *  `lifecycle_status='active'` (DEFAULT) and `reviewer_id IS NULL`
 *  (legacy). Phase 11 consensus evaluator excludes `reviewer_id IS NULL`
 *  rows from group-membership checks (treats them as `reviewer_type=
 *  'unknown'`).
 */
export const MIGRATION_V7_STATEMENTS: readonly string[] = [
  // --- reviewers (Phase 11 — §A1) -----------------------------------
  `CREATE TABLE reviewers (
    reviewer_id       TEXT PRIMARY KEY,
    reviewer_type     TEXT NOT NULL CHECK (reviewer_type IN ('human', 'codex', 'external', 'system')),
    display_name      TEXT NOT NULL,
    group_id          TEXT,
    trust_level       TEXT NOT NULL DEFAULT 'normal'
      CHECK (trust_level IN ('advisory', 'normal', 'required', 'policy')),
    metadata_json     TEXT NOT NULL DEFAULT '{}',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  )`,
  // Default reviewer registry — Phase 11-2 seed (idempotent).
  `INSERT OR IGNORE INTO reviewers
     (reviewer_id, reviewer_type, display_name, group_id, trust_level, created_at, updated_at)
   VALUES
     ('human',          'human',  'Local human reviewer',   'humans',   'normal',   '2026-05-24T00:00:00Z', '2026-05-24T00:00:00Z'),
     ('codex',          'codex',  'Codex automated review', 'codex',    'normal',   '2026-05-24T00:00:00Z', '2026-05-24T00:00:00Z'),
     ('codex-security', 'codex',  'Codex security review',  'security', 'required', '2026-05-24T00:00:00Z', '2026-05-24T00:00:00Z'),
     ('system',         'system', 'System / harness',       'system',   'advisory', '2026-05-24T00:00:00Z', '2026-05-24T00:00:00Z')`,

  // --- review_rules (Phase 11 — §B3) --------------------------------
  `CREATE TABLE review_rules (
    rule_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id        TEXT,
    repo_id           TEXT,
    domain            TEXT,
    rule_version      INTEGER NOT NULL,
    source            TEXT NOT NULL CHECK (source IN ('project-profile', 'default', 'manual')),
    rule_json         TEXT NOT NULL,
    source_sha256     TEXT NOT NULL,
    created_at        TEXT NOT NULL
  )`,
  `CREATE INDEX review_rules_scope_idx
     ON review_rules(project_id, repo_id, domain, rule_version)`,

  // --- run_review_rule_snapshots (Phase 11 — §B2) -------------------
  `CREATE TABLE run_review_rule_snapshots (
    run_id            TEXT PRIMARY KEY,
    rule_id           INTEGER,
    rule_json         TEXT NOT NULL,
    source_sha256     TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (rule_id) REFERENCES review_rules(rule_id)
  )`,

  // --- review_consensus (Phase 11 — §C4) ----------------------------
  `CREATE TABLE review_consensus (
    consensus_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            TEXT NOT NULL,
    rule_sha256       TEXT NOT NULL,
    status            TEXT NOT NULL
      CHECK (status IN ('pending', 'approved', 'changes_requested', 'rejected')),
    summary_json      TEXT NOT NULL,
    evaluated_at      TEXT NOT NULL,
    evaluated_by      TEXT NOT NULL,
    source_proposals_json TEXT NOT NULL,
    superseded_at     TEXT,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX review_consensus_run_idx
     ON review_consensus(run_id, evaluated_at)`,
  `CREATE UNIQUE INDEX review_consensus_active_idx
     ON review_consensus(run_id) WHERE superseded_at IS NULL`,

  // --- review_overrides (Phase 11 — §D1) ----------------------------
  `CREATE TABLE review_overrides (
    override_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id            TEXT NOT NULL,
    consensus_id      INTEGER,
    actor_reviewer_id TEXT NOT NULL,
    decision          TEXT NOT NULL
      CHECK (decision IN ('approved', 'changes_requested', 'rejected')),
    reason            TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    source_sha256     TEXT,
    FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE,
    FOREIGN KEY (actor_reviewer_id) REFERENCES reviewers(reviewer_id),
    FOREIGN KEY (consensus_id) REFERENCES review_consensus(consensus_id)
  )`,
  `CREATE INDEX review_overrides_run_idx
     ON review_overrides(run_id, created_at)`,

  // --- review_proposals additions (Phase 11 — §A3, §E1) -------------
  `ALTER TABLE review_proposals ADD COLUMN reviewer_id TEXT REFERENCES reviewers(reviewer_id)`,
  `ALTER TABLE review_proposals ADD COLUMN reviewer_type TEXT`,
  `ALTER TABLE review_proposals ADD COLUMN model TEXT`,
  `ALTER TABLE review_proposals ADD COLUMN prompt_sha256 TEXT`,
  `ALTER TABLE review_proposals ADD COLUMN context_pack_id TEXT`,
  `ALTER TABLE review_proposals ADD COLUMN policy_generation_id TEXT`,
  `ALTER TABLE review_proposals ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active'
     CHECK (lifecycle_status IN ('active', 'superseded', 'processed', 'rejected_stale', 'archived'))`,
  `ALTER TABLE review_proposals ADD COLUMN archived_at TEXT`,

  // --- review_decisions additions (Phase 11 — §F) -------------------
  `ALTER TABLE review_decisions ADD COLUMN consensus_id INTEGER REFERENCES review_consensus(consensus_id)`,
  `ALTER TABLE review_decisions ADD COLUMN proposals_summary_json TEXT`,

  // Phase 11 post-close (whole-phase review P2 #3) — backfill
  // lifecycle_status for legacy rows that migrated as 'active' DEFAULT
  // despite already being superseded/processed. Idempotent because the
  // UPDATE is conditional on the existing lifecycle_status='active'.
  // processed wins over superseded: a processed row should never be
  // demoted to 'superseded' even if the row also carries superseded_at.
  `UPDATE review_proposals
      SET lifecycle_status = 'processed'
    WHERE lifecycle_status = 'active'
      AND processed_at IS NOT NULL`,
  `UPDATE review_proposals
      SET lifecycle_status = 'superseded'
    WHERE lifecycle_status = 'active'
      AND superseded_at IS NOT NULL
      AND processed_at IS NULL`,
];

/** Tables added by v7 (Phase 11). */
export const V7_TABLE_NAMES: readonly string[] = [
  "reviewers",
  "review_rules",
  "run_review_rule_snapshots",
  "review_consensus",
  "review_overrides",
];

/**
 * v8 DDL — Phase 13 (mutation API + operation audit).
 *
 *  - `operations` を Phase 7-5 軽量 schema (operation_id / command /
 *    scope_type / scope_id / result_json / created_at) から audit
 *    ledger shape に拡張する。新 columns はすべて nullable / DEFAULT
 *    付きで legacy 行 (= Phase 7-12 で `processReviewDecision` 等が
 *    insert した既存 row) は影響しない。
 *  - `operation_events`: per-operation timeline (state transitions /
 *    side-effect logs)。
 *  - `operations_idempotency_idx`: (operation_type, target_id,
 *    idempotency_key) UNIQUE (partial; idempotency_key IS NOT NULL).
 *
 *  Phase 13 minimum では `operation_confirmations` は作らない (CSRF
 *  token で十分; Phase 14+ で UX を上げるとき再検討)。
 */
export const MIGRATION_V8_STATEMENTS: readonly string[] = [
  `ALTER TABLE operations ADD COLUMN operation_type TEXT`,
  `ALTER TABLE operations ADD COLUMN target_type TEXT`,
  `ALTER TABLE operations ADD COLUMN target_id TEXT`,
  `ALTER TABLE operations ADD COLUMN actor TEXT`,
  `ALTER TABLE operations ADD COLUMN idempotency_key TEXT`,
  `ALTER TABLE operations ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE operations ADD COLUMN status TEXT NOT NULL DEFAULT 'succeeded'
     CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled'))`,
  `ALTER TABLE operations ADD COLUMN input_json TEXT`,
  `ALTER TABLE operations ADD COLUMN error_code TEXT`,
  `ALTER TABLE operations ADD COLUMN error_message TEXT`,
  `ALTER TABLE operations ADD COLUMN started_at TEXT`,
  `ALTER TABLE operations ADD COLUMN completed_at TEXT`,
  `ALTER TABLE operations ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'`,
  `CREATE UNIQUE INDEX operations_idempotency_idx
     ON operations(operation_type, target_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL`,
  `CREATE INDEX operations_target_idx
     ON operations(target_type, target_id, created_at)`,
  `CREATE INDEX operations_status_idx
     ON operations(status, created_at)`,

  `CREATE TABLE operation_events (
    event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL,
    seq          INTEGER NOT NULL,
    event_type   TEXT NOT NULL,
    message      TEXT,
    data_json    TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL,
    FOREIGN KEY (operation_id) REFERENCES operations(operation_id) ON DELETE CASCADE,
    UNIQUE(operation_id, seq)
  )`,
  `CREATE INDEX operation_events_op_idx ON operation_events(operation_id, seq)`,
];

/** Tables added by v8 (Phase 13). */
export const V8_TABLE_NAMES: readonly string[] = [
  "operation_events",
];

/**
 * v9 DDL — Phase 14 (human-authored assets DB canonical).
 *
 * Adds revision-based history tables for project profile / policy
 * template / knowledge entry, plus an `asset_exports` ledger that
 * tracks the compat-export files' sha + status.
 *
 * Existing `projects` / `knowledge_entries` rows migrate with the new
 * `current_*_revision_id` pointers = NULL. The Phase 14-2/14-4 import
 * paths create a `version=1` revision and update the pointer.
 *
 * `effective_policy_snapshots` is a derived table (per-run / per-scope
 * generated policy + provenance). It is recreated by `policy compile`.
 */
export const MIGRATION_V9_STATEMENTS: readonly string[] = [
  // --- project profile -----------------------------------------------
  `CREATE TABLE project_profile_revisions (
    revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  TEXT NOT NULL,
    version     INTEGER NOT NULL,
    body_yaml   TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    parsed_json TEXT NOT NULL,
    actor       TEXT NOT NULL,
    reason      TEXT,
    created_at  TEXT NOT NULL,
    supersedes_revision_id INTEGER,
    UNIQUE(project_id, version)
  )`,
  `CREATE INDEX project_profile_revisions_project_idx
     ON project_profile_revisions(project_id, version)`,
  `ALTER TABLE projects ADD COLUMN current_profile_revision_id INTEGER
     REFERENCES project_profile_revisions(revision_id)`,

  // --- policy --------------------------------------------------------
  `CREATE TABLE policy_templates (
    policy_template_id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_type  TEXT NOT NULL CHECK (scope_type IN
                  ('repo', 'project', 'domain', 'global')),
    scope_id    TEXT NOT NULL,
    version     INTEGER NOT NULL,
    body_yaml   TEXT NOT NULL,
    body_sha256 TEXT NOT NULL,
    parsed_json TEXT NOT NULL,
    actor       TEXT NOT NULL,
    reason      TEXT,
    created_at  TEXT NOT NULL,
    UNIQUE(scope_type, scope_id, version)
  )`,
  `CREATE INDEX policy_templates_scope_idx
     ON policy_templates(scope_type, scope_id, version)`,
  `CREATE TABLE effective_policy_snapshots (
    snapshot_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id                   TEXT,
    project_id               TEXT,
    repo_id                  TEXT,
    domain                   TEXT,
    template_revision_id     INTEGER REFERENCES policy_templates(policy_template_id),
    generated_policy_yaml    TEXT NOT NULL,
    generated_policy_sha256  TEXT NOT NULL,
    provenance_json          TEXT NOT NULL,
    created_at               TEXT NOT NULL
  )`,
  `CREATE INDEX effective_policy_snapshots_scope_idx
     ON effective_policy_snapshots(repo_id, domain, created_at)`,

  // --- knowledge entry markdown body --------------------------------
  `CREATE TABLE knowledge_entry_revisions (
    revision_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id         TEXT NOT NULL,
    version          INTEGER NOT NULL,
    body_markdown    TEXT NOT NULL,
    body_sha256      TEXT NOT NULL,
    frontmatter_json TEXT NOT NULL,
    title            TEXT,
    actor            TEXT NOT NULL,
    reason           TEXT,
    created_at       TEXT NOT NULL,
    supersedes_revision_id INTEGER,
    UNIQUE(entry_id, version)
  )`,
  `CREATE INDEX knowledge_entry_revisions_entry_idx
     ON knowledge_entry_revisions(entry_id, version)`,
  `ALTER TABLE knowledge_entries ADD COLUMN current_revision_id INTEGER
     REFERENCES knowledge_entry_revisions(revision_id)`,

  // --- compat export tracking ---------------------------------------
  `CREATE TABLE asset_exports (
    export_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_type    TEXT NOT NULL CHECK (asset_type IN
                    ('project_profile', 'policy_template',
                     'effective_policy', 'knowledge_entry')),
    asset_id      TEXT NOT NULL,
    revision_id   INTEGER NOT NULL,
    relative_path TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    exported_at   TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('synced', 'dirty', 'removed')),
    UNIQUE(asset_type, asset_id, relative_path)
  )`,
  `CREATE INDEX asset_exports_status_idx
     ON asset_exports(status, asset_type)`,
];

/** Tables added by v9 (Phase 14). */
export const V9_TABLE_NAMES: readonly string[] = [
  "project_profile_revisions",
  "policy_templates",
  "effective_policy_snapshots",
  "knowledge_entry_revisions",
  "asset_exports",
];

/**
 * v10 DDL — Phase 15 (DB operations / doctor / archive / backup).
 */
export const MIGRATION_V10_STATEMENTS: readonly string[] = [
  `CREATE TABLE doctor_runs (
    doctor_run_id TEXT PRIMARY KEY,
    started_at    TEXT NOT NULL,
    completed_at  TEXT,
    status        TEXT NOT NULL,
    summary_json  TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE doctor_findings (
    finding_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    doctor_run_id TEXT NOT NULL,
    check_id      TEXT NOT NULL,
    severity      TEXT NOT NULL CHECK (severity IN ('info','warn','error','critical')),
    status        TEXT NOT NULL CHECK (status IN ('ok','flagged','resolved')),
    message       TEXT NOT NULL,
    repairable    INTEGER NOT NULL DEFAULT 0,
    details_json  TEXT NOT NULL DEFAULT '{}',
    FOREIGN KEY (doctor_run_id) REFERENCES doctor_runs(doctor_run_id) ON DELETE CASCADE
  )`,
  `CREATE INDEX doctor_findings_run_idx ON doctor_findings(doctor_run_id, check_id)`,
  `CREATE TABLE repair_actions (
    repair_id    TEXT PRIMARY KEY,
    finding_id   INTEGER,
    action_type  TEXT NOT NULL,
    dry_run      INTEGER NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
    result_json  TEXT NOT NULL DEFAULT '{}',
    created_at   TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (finding_id) REFERENCES doctor_findings(finding_id)
  )`,
  `CREATE INDEX repair_actions_finding_idx ON repair_actions(finding_id, created_at)`,
  `CREATE TABLE backup_catalog (
    backup_id      TEXT PRIMARY KEY,
    path           TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    size_bytes     INTEGER NOT NULL,
    sha256         TEXT NOT NULL,
    verified_at    TEXT,
    status         TEXT NOT NULL CHECK (status IN ('available','missing','failed')),
    manifest_json  TEXT NOT NULL
  )`,
  `CREATE INDEX backup_catalog_created_idx ON backup_catalog(created_at)`,
  `CREATE TABLE archive_catalog (
    archive_id     TEXT PRIMARY KEY,
    path           TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    range_start    TEXT,
    range_end      TEXT,
    schema_version INTEGER NOT NULL,
    sha256         TEXT,
    status         TEXT NOT NULL CHECK (status IN ('attached','detached','missing')),
    metadata_json  TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE db_stats_snapshots (
    snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL,
    stats_json  TEXT NOT NULL
  )`,
  `CREATE INDEX db_stats_snapshots_created_idx ON db_stats_snapshots(created_at)`,
];

/** Tables added by v10 (Phase 15). */
export const V10_TABLE_NAMES: readonly string[] = [
  "doctor_runs",
  "doctor_findings",
  "repair_actions",
  "backup_catalog",
  "archive_catalog",
  "db_stats_snapshots",
];

/**
 * v11 DDL — Phase 16 (blob storage scale-out).
 *
 * 3 new tables for external blob store support. The existing
 * artifacts.storage CHECK (`IN ('file', 'db')`) remains in place;
 * Phase 16 minimum lands the catalog + repositories so the
 * infrastructure is ready, but actual `storage='external'` rows
 * require a CHECK relaxation that SQLite does not support via ALTER —
 * a table rebuild (post-Phase-16 work, schema v12) is needed before
 * artifacts rows can carry the new value. Until then the new tables
 * are usable as a manifest store for migration prep.
 */
export const MIGRATION_V11_STATEMENTS: readonly string[] = [
  `CREATE TABLE blob_stores (
    store_id      TEXT PRIMARY KEY,
    store_type    TEXT NOT NULL CHECK (store_type IN ('local', 's3')),
    config_json   TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    metadata_json TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE external_artifact_blobs (
    sha256           TEXT PRIMARY KEY,
    store_id         TEXT NOT NULL REFERENCES blob_stores(store_id),
    uri              TEXT NOT NULL,
    bytes            INTEGER NOT NULL,
    stored_bytes     INTEGER NOT NULL,
    content_encoding TEXT NOT NULL CHECK (content_encoding IN ('identity', 'gzip')),
    chunking         TEXT NOT NULL DEFAULT 'none',
    uploaded_at      TEXT NOT NULL,
    verified_at      TEXT,
    status           TEXT NOT NULL CHECK (status IN ('available', 'missing', 'corrupt')),
    metadata_json    TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE INDEX external_artifact_blobs_store_idx
     ON external_artifact_blobs(store_id, uploaded_at)`,
  `CREATE TABLE blob_migration_jobs (
    job_id        TEXT PRIMARY KEY,
    direction     TEXT NOT NULL CHECK (direction IN ('db-to-external', 'external-to-db')),
    store_id      TEXT,
    status        TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    completed_at  TEXT,
    input_json    TEXT NOT NULL,
    result_json   TEXT NOT NULL DEFAULT '{}',
    error_message TEXT
  )`,
];

/** Tables added by v11 (Phase 16). */
export const V11_TABLE_NAMES: readonly string[] = [
  "blob_stores",
  "external_artifact_blobs",
  "blob_migration_jobs",
];

/**
 * v12 DDL — Phase 17 (DB canonical platform integration).
 *
 *  - `artifacts.storage` is rebuilt to allow `external`, so Phase 16's
 *    BlobStore infrastructure can become an actual runtime storage state.
 *  - `runs` gains queryable asset attribution columns. `meta_json` remains
 *    the lossless document; these columns let dashboard / doctor / archive
 *    answer common provenance questions without JSON scans.
 */
export const MIGRATION_V12_STATEMENTS: readonly string[] = [
  `CREATE TABLE artifacts_v12 (
    artifact_id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT,
    kind TEXT NOT NULL,
    relative_path TEXT,
    content_type TEXT,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage TEXT NOT NULL DEFAULT 'file'
      CHECK (storage IN ('file', 'db', 'external')),
    blob_sha256 TEXT,
    body_status TEXT NOT NULL DEFAULT 'legacy_file',
    created_at TEXT,
    redacted INTEGER NOT NULL DEFAULT 0,
    secret_suspect INTEGER NOT NULL DEFAULT 0,
    original_bytes INTEGER,
    original_sha256 TEXT
  )`,
  `INSERT INTO artifacts_v12
     (artifact_id, run_id, kind, relative_path, content_type, bytes, sha256,
      storage, blob_sha256, body_status, created_at, redacted,
      secret_suspect, original_bytes, original_sha256)
   SELECT artifact_id, run_id, kind, relative_path, content_type, bytes,
      sha256, storage, blob_sha256, body_status, created_at, redacted,
      secret_suspect, original_bytes, original_sha256
     FROM artifacts`,
  `DROP TABLE artifacts`,
  `ALTER TABLE artifacts_v12 RENAME TO artifacts`,
  `ALTER TABLE runs ADD COLUMN project_profile_revision_id INTEGER
     REFERENCES project_profile_revisions(revision_id)`,
  `ALTER TABLE runs ADD COLUMN effective_policy_snapshot_id INTEGER
     REFERENCES effective_policy_snapshots(snapshot_id)`,
  `ALTER TABLE runs ADD COLUMN knowledge_revision_ids_json TEXT`,
  `CREATE INDEX runs_project_profile_revision_idx
     ON runs(project_profile_revision_id)`,
  `CREATE INDEX runs_effective_policy_snapshot_idx
     ON runs(effective_policy_snapshot_id)`,
];

/**
 * v13 DDL — Phase 18 (MCP confirmation and invocation audit).
 */
export const MIGRATION_V13_STATEMENTS: readonly string[] = [
  `CREATE TABLE mcp_confirmation_requests (
    confirmation_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    actor TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    input_json TEXT NOT NULL,
    preview_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','expired','consumed')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    confirmed_by TEXT,
    confirmed_at TEXT,
    consumed_operation_id TEXT
  )`,
  `CREATE INDEX mcp_confirmation_status_idx
     ON mcp_confirmation_requests(status, expires_at)`,
  `CREATE TABLE mcp_sessions (
    session_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    client_version TEXT,
    transport TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    permission_snapshot_json TEXT NOT NULL
  )`,
  `CREATE TABLE mcp_tool_invocations (
    invocation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_sha256 TEXT NOT NULL,
    arguments_redacted_json TEXT,
    result_status TEXT NOT NULL,
    operation_id TEXT,
    confirmation_id TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    error_message TEXT,
    FOREIGN KEY(session_id) REFERENCES mcp_sessions(session_id)
  )`,
  `CREATE INDEX mcp_tool_invocations_session_idx
     ON mcp_tool_invocations(session_id, started_at)`,
  `CREATE INDEX mcp_tool_invocations_tool_idx
     ON mcp_tool_invocations(tool_name, started_at)`,
];

/** Tables added by v13 (Phase 18). */
export const V13_TABLE_NAMES: readonly string[] = [
  "mcp_confirmation_requests",
  "mcp_sessions",
  "mcp_tool_invocations",
];

/**
 * v14 DDL — Phase 18 confirmation hardening.
 *
 * Confirmation requests must execute under the same MCP permission snapshot
 * that produced the preview. Without this, an explicit `--config` used by
 * `harness mcp serve` can be lost when `harness operation confirm` reloads
 * config out-of-band.
 */
export const MIGRATION_V14_STATEMENTS: readonly string[] = [
  `ALTER TABLE mcp_confirmation_requests
     ADD COLUMN permission_snapshot_json TEXT NOT NULL DEFAULT '{}'`,
];

/**
 * v15 DDL — Phase 18 post-review MCP hardening.
 *
 * Keep permission identity separate from self-reported initialize metadata, and
 * record confirmation handler failures without leaving requests stuck in the
 * intermediate `confirmed` state.
 */
export const MIGRATION_V15_STATEMENTS: readonly string[] = [
  `ALTER TABLE mcp_sessions ADD COLUMN reported_client_name TEXT`,
  `ALTER TABLE mcp_sessions ADD COLUMN reported_client_version TEXT`,
  `ALTER TABLE mcp_confirmation_requests ADD COLUMN error_message TEXT`,
];

/**
 * v16 DDL — Phase 19 (goal convergence controller).
 *
 * Phase 19 adds a goal-level control plane above runs, reviews, operations,
 * and backlog items. These tables record frozen scope, close conditions,
 * attempts, review cycles, findings, close-check evidence, and convergence
 * decisions so iterative agent work can converge, defer, or escalate instead
 * of expanding scope indefinitely.
 */
export const MIGRATION_V16_STATEMENTS: readonly string[] = [
  `CREATE TABLE goal_sessions (
    goal_id                   TEXT PRIMARY KEY,
    title                     TEXT NOT NULL,
    description               TEXT,
    project_id                TEXT,
    repo_id                   TEXT,
    domain                    TEXT,
    backlog_item_id           TEXT,
    status                    TEXT NOT NULL CHECK (status IN (
      'open',
      'in_progress',
      'close_ready',
      'closed',
      'diverging',
      'budget_exhausted',
      'escalated',
      'cancelled'
    )),
    scope_json                TEXT NOT NULL,
    close_conditions_json     TEXT NOT NULL,
    policy_json               TEXT NOT NULL,
    max_iterations            INTEGER NOT NULL,
    max_review_cycles         INTEGER NOT NULL,
    max_reruns                INTEGER NOT NULL,
    max_total_new_findings    INTEGER NOT NULL,
    current_iteration         INTEGER NOT NULL DEFAULT 0,
    current_review_cycle      INTEGER NOT NULL DEFAULT 0,
    created_by                TEXT NOT NULL,
    created_source            TEXT NOT NULL CHECK (created_source IN (
      'cli', 'mcp', 'dashboard', 'worker', 'import'
    )),
    created_at                TEXT NOT NULL,
    updated_at                TEXT NOT NULL,
    closed_at                 TEXT,
    close_summary             TEXT,
    escalation_reason         TEXT
  )`,
  `CREATE INDEX goal_sessions_status_idx
     ON goal_sessions(status, updated_at)`,
  `CREATE INDEX goal_sessions_project_idx
     ON goal_sessions(project_id, domain, status)`,

  `CREATE TABLE goal_attempts (
    attempt_id                TEXT PRIMARY KEY,
    goal_id                   TEXT NOT NULL REFERENCES goal_sessions(goal_id) ON DELETE CASCADE,
    iteration                 INTEGER NOT NULL,
    attempt_type              TEXT NOT NULL CHECK (attempt_type IN (
      'plan',
      'implement',
      'fix-review',
      'rerun',
      'validate',
      'close-check',
      'classify-findings',
      'defer-followups'
    )),
    status                    TEXT NOT NULL CHECK (status IN (
      'pending', 'running', 'succeeded', 'failed', 'cancelled'
    )),
    operation_id              TEXT,
    run_id                    TEXT,
    parent_attempt_id         TEXT,
    input_json                TEXT NOT NULL DEFAULT '{}',
    result_json               TEXT NOT NULL DEFAULT '{}',
    error_message             TEXT,
    started_at                TEXT,
    completed_at              TEXT,
    created_at                TEXT NOT NULL
  )`,
  `CREATE INDEX goal_attempts_goal_idx
     ON goal_attempts(goal_id, iteration, created_at)`,
  `CREATE INDEX goal_attempts_run_idx ON goal_attempts(run_id)`,
  `CREATE INDEX goal_attempts_operation_idx ON goal_attempts(operation_id)`,

  `CREATE TABLE goal_review_cycles (
    cycle_id                  TEXT PRIMARY KEY,
    goal_id                   TEXT NOT NULL REFERENCES goal_sessions(goal_id) ON DELETE CASCADE,
    cycle_number              INTEGER NOT NULL,
    review_mode               TEXT NOT NULL CHECK (review_mode IN (
      'initial', 'delta', 'close', 'regression', 'manual'
    )),
    trigger_attempt_id        TEXT,
    source_review_id          TEXT,
    source_run_id             TEXT,
    findings_seen             INTEGER NOT NULL DEFAULT 0,
    findings_new              INTEGER NOT NULL DEFAULT 0,
    findings_reopened         INTEGER NOT NULL DEFAULT 0,
    findings_fixed            INTEGER NOT NULL DEFAULT 0,
    findings_deferred         INTEGER NOT NULL DEFAULT 0,
    findings_in_scope_open    INTEGER NOT NULL DEFAULT 0,
    created_at                TEXT NOT NULL,
    completed_at              TEXT,
    summary                   TEXT
  )`,
  `CREATE UNIQUE INDEX goal_review_cycles_unique_idx
     ON goal_review_cycles(goal_id, cycle_number)`,

  `CREATE TABLE goal_findings (
    finding_id                TEXT PRIMARY KEY,
    goal_id                   TEXT NOT NULL REFERENCES goal_sessions(goal_id) ON DELETE CASCADE,
    stable_key                TEXT NOT NULL,
    duplicate_of             TEXT,
    source                    TEXT NOT NULL CHECK (source IN (
      'review', 'test', 'doctor', 'human', 'mcp', 'codex', 'other'
    )),
    source_ref                TEXT,
    source_attempt_id         TEXT,
    source_cycle_id           TEXT,
    severity                  TEXT NOT NULL CHECK (severity IN (
      'P0', 'P1', 'P2', 'P3', 'info'
    )),
    category                  TEXT NOT NULL,
    scope_status              TEXT NOT NULL CHECK (scope_status IN (
      'in_scope', 'out_of_scope', 'unknown', 'duplicate'
    )),
    lifecycle_status          TEXT NOT NULL CHECK (lifecycle_status IN (
      'open',
      'fixed',
      'reopened',
      'deferred',
      'duplicate',
      'out_of_scope',
      'escalated',
      'accepted_risk'
    )),
    summary                   TEXT NOT NULL,
    detail                    TEXT,
    file_path                 TEXT,
    symbol                    TEXT,
    suggested_fix             TEXT,
    first_seen_at             TEXT NOT NULL,
    last_seen_at              TEXT NOT NULL,
    fixed_at                  TEXT,
    deferred_at               TEXT,
    escalated_at              TEXT,
    reopen_count              INTEGER NOT NULL DEFAULT 0,
    deferred_backlog_item_id  TEXT,
    classification_reason     TEXT,
    resolution_note           TEXT
  )`,
  `CREATE UNIQUE INDEX goal_findings_stable_idx
     ON goal_findings(goal_id, stable_key)
    WHERE duplicate_of IS NULL`,
  `CREATE INDEX goal_findings_goal_status_idx
     ON goal_findings(goal_id, lifecycle_status, scope_status, severity)`,

  `CREATE TABLE goal_close_checks (
    check_id                  TEXT PRIMARY KEY,
    goal_id                   TEXT NOT NULL REFERENCES goal_sessions(goal_id) ON DELETE CASCADE,
    condition_id              TEXT NOT NULL,
    status                    TEXT NOT NULL CHECK (status IN (
      'pending', 'passed', 'failed', 'skipped', 'unknown'
    )),
    checked_at                TEXT NOT NULL,
    checked_by                TEXT NOT NULL,
    evidence_json             TEXT NOT NULL DEFAULT '{}',
    message                   TEXT
  )`,
  `CREATE INDEX goal_close_checks_goal_idx
     ON goal_close_checks(goal_id, checked_at)`,

  `CREATE TABLE goal_convergence_decisions (
    decision_id               TEXT PRIMARY KEY,
    goal_id                   TEXT NOT NULL REFERENCES goal_sessions(goal_id) ON DELETE CASCADE,
    cycle_id                  TEXT,
    attempt_id                TEXT,
    decision                  TEXT NOT NULL CHECK (decision IN (
      'continue',
      'needs_fix',
      'needs_classification',
      'close_ready',
      'closed',
      'diverging',
      'budget_exhausted',
      'escalate',
      'cancel'
    )),
    reason                    TEXT NOT NULL,
    metrics_json              TEXT NOT NULL DEFAULT '{}',
    recommended_next_action   TEXT,
    created_at                TEXT NOT NULL,
    created_by                TEXT NOT NULL
  )`,
  `CREATE INDEX goal_convergence_decisions_goal_idx
     ON goal_convergence_decisions(goal_id, created_at)`,
];

/**
 * v16 created six `goal_*` tables; v20 (SP-0) renames them to `hitch_*`. The
 * live name list is `V20_TABLE_NAMES` — there is no `V16_TABLE_NAMES` constant
 * (it would only duplicate the now-renamed surface and risk being mistaken for
 * the current table names). The v16 CREATE statements above intentionally still
 * say `goal_*` so the in-order migration chain has a `goal_*` surface for v20's
 * RENAME to act on.
 */

/**
 * v17 — agent workspaces (W2). An additive index over the per-agent git
 * worktrees created by `harness workspace`: git stays the source of truth for a
 * worktree's existence/branch, while this row carries the harness-side
 * coordination metadata git does not track (objective, advisory goal link,
 * heartbeat). `goal_id` is an advisory reference (no FK) so a deleted goal does
 * not cascade into workspaces; the service reconciles dangling links on read.
 */
export const MIGRATION_V17_STATEMENTS: readonly string[] = [
  `CREATE TABLE workspaces (
    workspace_id   TEXT PRIMARY KEY,
    agent          TEXT NOT NULL,
    repo_path      TEXT NOT NULL,
    branch         TEXT NOT NULL,
    worktree_path  TEXT NOT NULL,
    goal_id        TEXT,
    objective      TEXT,
    status         TEXT NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'archived')),
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    UNIQUE (repo_path, agent)
  )`,
  `CREATE INDEX workspaces_repo_idx ON workspaces(repo_path, status)`,
];

/** Tables added by v17 (W2 — agent workspaces). */
export const V17_TABLE_NAMES: readonly string[] = ["workspaces"];

/**
 * v18 — workspace checkpoints (W2b). Append-only advisory "save" records for an
 * agent workspace: an LLM narrative (`note`) plus a snapshot of the
 * deterministic state at that time (`head_sha`, `dirty_count`, advisory
 * `goal_id`). Recovery reconstructs the authoritative state from git/goals and
 * overlays the latest note — the note is never trusted to drive state.
 */
export const MIGRATION_V18_STATEMENTS: readonly string[] = [
  `CREATE TABLE workspace_checkpoints (
    checkpoint_id  TEXT PRIMARY KEY,
    workspace_id   TEXT NOT NULL
      REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    note           TEXT,
    head_sha       TEXT,
    dirty_count    INTEGER NOT NULL DEFAULT 0 CHECK (dirty_count >= 0),
    goal_id        TEXT,
    created_at     TEXT NOT NULL,
    created_by     TEXT NOT NULL
  )`,
  `CREATE INDEX workspace_checkpoints_ws_idx
     ON workspace_checkpoints(workspace_id, created_at)`,
];

/** Tables added by v18 (W2b — workspace checkpoints). */
export const V18_TABLE_NAMES: readonly string[] = ["workspace_checkpoints"];

/**
 * v19 — operational knowledge category (issue #57).
 *
 * The knowledge subsystem so far accumulates *codebase* knowledge only:
 * per-run candidates → promote → `knowledge_entries` → injected into coder
 * prompts. v19 adds an `operational` category for non-codebase knowledge
 * (toolchain / workflow / environment learnings discovered while operating
 * the harness). Operational entries are authored directly (no run-derived
 * candidate stage — there is no untrusted generator to gate) and reuse the
 * `knowledge_entry_revisions` history / deprecate machinery.
 *
 * Existing rows migrate with `category='codebase'` (the DEFAULT), so the
 * coder-prompt context path — which filters to `category='codebase'` —
 * keeps behaving exactly as before and operational knowledge can never
 * leak into a coder prompt (the safety boundary in issue #57).
 */
export const MIGRATION_V19_STATEMENTS: readonly string[] = [
  `ALTER TABLE knowledge_entries ADD COLUMN category TEXT NOT NULL
     DEFAULT 'codebase' CHECK (category IN ('codebase', 'operational'))`,
  `CREATE INDEX knowledge_entries_category_idx
     ON knowledge_entries(category, kind)`,
];

/** Tables added by v19 (operational knowledge — additive column only). */
export const V19_TABLE_NAMES: readonly string[] = [];

/**
 * v20 — rename goal_* → hitch_* (SP-0 rename refactor).
 *
 * Renames the six goal-convergence tables, the eight goal_id columns across
 * those tables plus workspaces/workspace_checkpoints, and recreates all ten
 * indexes under their hitch_* names. v16 DDL still creates goal_* so that
 * fresh DBs built by applying all migrations in order have a goal_* surface
 * for v20's RENAME to act on. This migration is additive-safe: a second
 * application is a no-op because runMigrations checks schema_migrations first.
 */
export const MIGRATION_V20_STATEMENTS: readonly string[] = [
  // --- table renames ---
  `ALTER TABLE goal_sessions RENAME TO hitch_sessions`,
  `ALTER TABLE goal_attempts RENAME TO hitch_attempts`,
  `ALTER TABLE goal_review_cycles RENAME TO hitch_review_cycles`,
  `ALTER TABLE goal_findings RENAME TO hitch_findings`,
  `ALTER TABLE goal_close_checks RENAME TO hitch_close_checks`,
  `ALTER TABLE goal_convergence_decisions RENAME TO hitch_convergence_decisions`,

  // --- column renames: goal_id → hitch_id in all 8 locations ---
  `ALTER TABLE hitch_sessions RENAME COLUMN goal_id TO hitch_id`,
  `ALTER TABLE hitch_attempts RENAME COLUMN goal_id TO hitch_id`,
  `ALTER TABLE hitch_review_cycles RENAME COLUMN goal_id TO hitch_id`,
  `ALTER TABLE hitch_findings RENAME COLUMN goal_id TO hitch_id`,
  `ALTER TABLE hitch_close_checks RENAME COLUMN goal_id TO hitch_id`,
  `ALTER TABLE hitch_convergence_decisions RENAME COLUMN goal_id TO hitch_id`,
  `ALTER TABLE workspaces RENAME COLUMN goal_id TO hitch_id`,
  `ALTER TABLE workspace_checkpoints RENAME COLUMN goal_id TO hitch_id`,

  // --- drop old indexes ---
  `DROP INDEX IF EXISTS goal_sessions_status_idx`,
  `DROP INDEX IF EXISTS goal_sessions_project_idx`,
  `DROP INDEX IF EXISTS goal_attempts_goal_idx`,
  `DROP INDEX IF EXISTS goal_attempts_run_idx`,
  `DROP INDEX IF EXISTS goal_attempts_operation_idx`,
  `DROP INDEX IF EXISTS goal_review_cycles_unique_idx`,
  `DROP INDEX IF EXISTS goal_findings_stable_idx`,
  `DROP INDEX IF EXISTS goal_findings_goal_status_idx`,
  `DROP INDEX IF EXISTS goal_close_checks_goal_idx`,
  `DROP INDEX IF EXISTS goal_convergence_decisions_goal_idx`,

  // --- recreate indexes under hitch_* names ---
  `CREATE INDEX hitch_sessions_status_idx
     ON hitch_sessions(status, updated_at)`,
  `CREATE INDEX hitch_sessions_project_idx
     ON hitch_sessions(project_id, domain, status)`,
  `CREATE INDEX hitch_attempts_hitch_idx
     ON hitch_attempts(hitch_id, iteration, created_at)`,
  `CREATE INDEX hitch_attempts_run_idx ON hitch_attempts(run_id)`,
  `CREATE INDEX hitch_attempts_operation_idx ON hitch_attempts(operation_id)`,
  `CREATE UNIQUE INDEX hitch_review_cycles_unique_idx
     ON hitch_review_cycles(hitch_id, cycle_number)`,
  `CREATE UNIQUE INDEX hitch_findings_stable_idx
     ON hitch_findings(hitch_id, stable_key)
    WHERE duplicate_of IS NULL`,
  `CREATE INDEX hitch_findings_hitch_status_idx
     ON hitch_findings(hitch_id, lifecycle_status, scope_status, severity)`,
  `CREATE INDEX hitch_close_checks_hitch_idx
     ON hitch_close_checks(hitch_id, checked_at)`,
  `CREATE INDEX hitch_convergence_decisions_hitch_idx
     ON hitch_convergence_decisions(hitch_id, created_at)`,
];

/** Tables renamed by v20 (SP-0 hitch rename). */
export const V20_TABLE_NAMES: readonly string[] = [
  "hitch_sessions",
  "hitch_attempts",
  "hitch_review_cycles",
  "hitch_findings",
  "hitch_close_checks",
  "hitch_convergence_decisions",
];

/**
 * v21 — course → phase roadmap layer (SP-1).
 *
 * Additive only: three new tables that index an aspirational roadmap on top of
 * the existing hitch (execution) layer. A `course` is a long-lived initiative;
 * `phases` form an ordered tree under a course (`parent_phase_id` self-ref);
 * `phase_hitches` is a 1:1 link table that attaches at most one phase to each
 * hitch session (the `hitch_id` PK enforces a hitch belongs to a single phase).
 * No existing table is altered, so all current behaviour is unchanged.
 */
export const MIGRATION_V21_STATEMENTS: readonly string[] = [
  `CREATE TABLE courses (
     course_id TEXT PRIMARY KEY NOT NULL, project_id TEXT, repo_id TEXT,
     title TEXT NOT NULL, description TEXT,
     status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
     created_by TEXT, created_source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX courses_project_idx ON courses(project_id, status)`,
  `CREATE TABLE phases (
     phase_id TEXT PRIMARY KEY NOT NULL,
     course_id TEXT NOT NULL REFERENCES courses(course_id) ON DELETE CASCADE,
     parent_phase_id TEXT REFERENCES phases(phase_id) ON DELETE CASCADE,
     title TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','closed','blocked')),
     scope_json TEXT, close_conditions_json TEXT, review_state_json TEXT,
     created_by TEXT, created_source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX phases_course_idx ON phases(course_id, parent_phase_id, position)`,
  `CREATE TABLE phase_hitches (
     hitch_id TEXT PRIMARY KEY NOT NULL REFERENCES hitch_sessions(hitch_id) ON DELETE CASCADE,
     phase_id TEXT NOT NULL REFERENCES phases(phase_id) ON DELETE CASCADE,
     linked_at TEXT NOT NULL
   )`,
  `CREATE INDEX phase_hitches_phase_idx ON phase_hitches(phase_id)`,
] as const;

/** Tables added by v21 (SP-1 — course → phase roadmap layer). */
export const V21_TABLE_NAMES = [
  "courses",
  "phases",
  "phase_hitches",
] as const;

/**
 * v22 — drop unused DB stats snapshot ledger.
 *
 * `db_stats_snapshots` was created by v10, but the snapshot/delta feature never
 * got wired into production callers. Keep the v10 DDL and table-name history
 * append-only, then remove the physical table here.
 */
export const MIGRATION_V22_STATEMENTS: readonly string[] = [
  "DROP INDEX IF EXISTS db_stats_snapshots_created_idx",
  "DROP TABLE IF EXISTS db_stats_snapshots",
];

/** Table names created by v1 — used by `db status` and tests. */
export const V1_TABLE_NAMES: readonly string[] = [
  "db_meta",
  "projects",
  "project_profiles",
  "domains",
  "policy_generations",
  "runs",
  "run_events",
  "command_results",
  "run_changed_files",
  "policy_violations",
  "review_decisions",
  "review_required_changes",
  "artifacts",
  "run_context_packs",
  "run_context_pack_files",
  "backlog_items",
  "backlog_run_links",
  "knowledge_candidates",
  "knowledge_entries",
  "import_errors",
];

/** Every data table ever created by this append-only migration history. */
export const ALL_TABLE_NAMES: readonly string[] = [
  ...V1_TABLE_NAMES,
  ...V2_TABLE_NAMES,
  ...V4_TABLE_NAMES,
  ...V5_TABLE_NAMES,
  ...V6_TABLE_NAMES,
  ...V7_TABLE_NAMES,
  ...V8_TABLE_NAMES,
  ...V9_TABLE_NAMES,
  ...V10_TABLE_NAMES,
  ...V11_TABLE_NAMES,
  ...V13_TABLE_NAMES,
  ...V20_TABLE_NAMES,
  ...V17_TABLE_NAMES,
  ...V18_TABLE_NAMES,
  ...V21_TABLE_NAMES,
];

/** Tables intentionally removed by later migrations. */
export const DROPPED_TABLE_NAMES: readonly string[] = ["db_stats_snapshots"];

const DROPPED_TABLE_NAME_SET = new Set<string>(DROPPED_TABLE_NAMES);

/** Data tables expected to exist at the latest schema version. */
export const CURRENT_TABLE_NAMES: readonly string[] = ALL_TABLE_NAMES.filter(
  (name) => !DROPPED_TABLE_NAME_SET.has(name),
);
