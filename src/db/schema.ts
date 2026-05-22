/**
 * harness DB schema (Phase 6).
 *
 * The DB (`.harness/harness.sqlite`) is a read model: in Phase 6 it is
 * built from `runs/` / `projects/` / `policies/` / `backlog/` / knowledge
 * files by `db import --from-files`. Files stay the write-side source of
 * truth; the DB can always be deleted and rebuilt.
 *
 * `schema.ts` holds the DDL only. The migration runner (`migrations.ts`)
 * applies it; repositories (`repositories/`) own the queries.
 */

/** Current (latest) schema version produced by the migrations. */
export const SCHEMA_VERSION = 4;

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

/** Every data table at the latest schema version (v1 + v2 + v4). */
export const ALL_TABLE_NAMES: readonly string[] = [
  ...V1_TABLE_NAMES,
  ...V2_TABLE_NAMES,
  ...V4_TABLE_NAMES,
];
