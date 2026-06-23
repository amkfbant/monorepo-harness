import type Database from "better-sqlite3";
import { DbError } from "./connection.js";
import { assertSchemaCompatibleForMigrate } from "./schema-compat.js";
import {
  MIGRATION_V1_STATEMENTS,
  MIGRATION_V2_STATEMENTS,
  MIGRATION_V3_STATEMENTS,
  MIGRATION_V4_STATEMENTS,
  MIGRATION_V5_STATEMENTS,
  MIGRATION_V6_STATEMENTS,
  MIGRATION_V7_STATEMENTS,
  MIGRATION_V8_STATEMENTS,
  MIGRATION_V9_STATEMENTS,
  MIGRATION_V10_STATEMENTS,
  MIGRATION_V11_STATEMENTS,
  MIGRATION_V12_STATEMENTS,
  MIGRATION_V13_STATEMENTS,
  MIGRATION_V14_STATEMENTS,
  MIGRATION_V15_STATEMENTS,
  MIGRATION_V16_STATEMENTS,
  MIGRATION_V17_STATEMENTS,
  MIGRATION_V18_STATEMENTS,
  MIGRATION_V19_STATEMENTS,
  MIGRATION_V20_STATEMENTS,
  MIGRATION_V21_STATEMENTS,
  MIGRATION_V22_STATEMENTS,
  MIGRATION_V23_STATEMENTS,
  MIGRATION_V24_STATEMENTS,
  MIGRATION_V25_STATEMENTS,
  MIGRATION_V26_STATEMENTS,
  MIGRATION_V27_STATEMENTS,
  MIGRATION_V28_STATEMENTS,
  MIGRATION_V29_STATEMENTS,
  MIGRATION_V30_STATEMENTS,
  MIGRATION_V31_STATEMENTS,
  MIGRATION_V32_STATEMENTS,
  MIGRATION_V33_STATEMENTS,
  MIGRATION_V34_STATEMENTS,
  MIGRATION_V35_STATEMENTS,
  MIGRATION_V36_STATEMENTS,
  MIGRATION_V37_STATEMENTS,
  MIGRATION_V38_STATEMENTS,
  MIGRATION_V39_STATEMENTS,
  SCHEMA_VERSION,
} from "./schema.js";

/**
 * Schema migration runner (Phase 6).
 *
 * Each migration is a versioned set of DDL statements. `runMigrations`
 * applies every migration newer than the DB's current version, inside a
 * per-migration transaction, and is idempotent.
 */

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

/** Ordered list of all migrations this harness knows. */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "read-model-v1", statements: MIGRATION_V1_STATEMENTS },
  {
    version: 2,
    name: "db-first-write-v2",
    statements: MIGRATION_V2_STATEMENTS,
  },
  {
    version: 3,
    name: "run-meta-json-v3",
    statements: MIGRATION_V3_STATEMENTS,
  },
  {
    version: 4,
    name: "runtime-db-complete-v4",
    statements: MIGRATION_V4_STATEMENTS,
  },
  {
    version: 5,
    name: "concurrency-and-runtime-completion-v5",
    statements: MIGRATION_V5_STATEMENTS,
  },
  {
    version: 6,
    name: "db-only-runtime-completion-v6",
    statements: MIGRATION_V6_STATEMENTS,
  },
  {
    version: 7,
    name: "review-governance-v7",
    statements: MIGRATION_V7_STATEMENTS,
  },
  {
    version: 8,
    name: "mutation-api-operation-audit-v8",
    statements: MIGRATION_V8_STATEMENTS,
  },
  {
    version: 9,
    name: "human-authored-assets-db-canonical-v9",
    statements: MIGRATION_V9_STATEMENTS,
  },
  {
    version: 10,
    name: "db-operations-doctor-archive-v10",
    statements: MIGRATION_V10_STATEMENTS,
  },
  {
    version: 11,
    name: "blob-storage-scaleout-v11",
    statements: MIGRATION_V11_STATEMENTS,
  },
  {
    version: 12,
    name: "phase17-platform-integration-v12",
    statements: MIGRATION_V12_STATEMENTS,
  },
  {
    version: 13,
    name: "mcp-confirmation-audit-v13",
    statements: MIGRATION_V13_STATEMENTS,
  },
  {
    version: 14,
    name: "mcp-confirmation-permission-snapshot-v14",
    statements: MIGRATION_V14_STATEMENTS,
  },
  {
    version: 15,
    name: "mcp-identity-and-confirmation-failure-v15",
    statements: MIGRATION_V15_STATEMENTS,
  },
  {
    version: 16,
    name: "goal-convergence-controller-v16",
    statements: MIGRATION_V16_STATEMENTS,
  },
  {
    version: 17,
    name: "agent-workspaces-v17",
    statements: MIGRATION_V17_STATEMENTS,
  },
  {
    version: 18,
    name: "workspace-checkpoints-v18",
    statements: MIGRATION_V18_STATEMENTS,
  },
  {
    version: 19,
    name: "operational-knowledge-category-v19",
    statements: MIGRATION_V19_STATEMENTS,
  },
  {
    version: 20,
    name: "rename-goal-to-hitch",
    statements: MIGRATION_V20_STATEMENTS,
  },
  {
    version: 21,
    name: "course-phase-roadmap",
    statements: MIGRATION_V21_STATEMENTS,
  },
  {
    version: 22,
    name: "drop-db-stats-snapshots-v22",
    statements: MIGRATION_V22_STATEMENTS,
  },
  {
    version: 23,
    name: "hitch-lifecycle-events-v23",
    statements: MIGRATION_V23_STATEMENTS,
  },
  {
    version: 24,
    name: "review-prompt-provenance-v24",
    statements: MIGRATION_V24_STATEMENTS,
  },
  {
    version: 25,
    name: "run-execution-environment-provenance-v25",
    statements: MIGRATION_V25_STATEMENTS,
  },
  {
    version: 26,
    name: "run-usage-telemetry-v26",
    statements: MIGRATION_V26_STATEMENTS,
  },
  {
    version: 27,
    name: "metrics-snapshots-v27",
    statements: MIGRATION_V27_STATEMENTS,
  },
  {
    version: 28,
    name: "domain-lock-contention-v28",
    statements: MIGRATION_V28_STATEMENTS,
  },
  {
    version: 29,
    name: "hitch-lifecycle-events-adopt-update-v29",
    statements: MIGRATION_V29_STATEMENTS,
  },
  {
    version: 30,
    name: "run-usage-per-invocation-v30",
    statements: MIGRATION_V30_STATEMENTS,
  },
  {
    version: 31,
    name: "epic228_deliberation_v31",
    statements: MIGRATION_V31_STATEMENTS,
  },
  {
    version: 32,
    name: "epic228_review_refute_votes_v32",
    statements: MIGRATION_V32_STATEMENTS,
  },
  {
    version: 33,
    name: "epic228_phase_review_state_version_v33",
    statements: MIGRATION_V33_STATEMENTS,
  },
  {
    version: 34,
    name: "hitch-lifecycle-events-diverging-recovered-v34",
    statements: MIGRATION_V34_STATEMENTS,
  },
  {
    version: 35,
    name: "artifact-quarantined-marker-v35",
    statements: MIGRATION_V35_STATEMENTS,
  },
  {
    version: 36,
    name: "agent-usage-telemetry-v36",
    statements: MIGRATION_V36_STATEMENTS,
  },
  {
    version: 37,
    name: "agent-invocation-source-size-v37",
    statements: MIGRATION_V37_STATEMENTS,
  },
  {
    version: 38,
    name: "finding-deferred-issue-url-v38",
    statements: MIGRATION_V38_STATEMENTS,
  },
  {
    version: 39,
    name: "hitch-evidence-v39",
    statements: MIGRATION_V39_STATEMENTS,
  },
];

/** The newest schema version this harness can produce. */
export const LATEST_SCHEMA_VERSION = SCHEMA_VERSION;

const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

/** Versions already applied to this DB, ascending. */
export function appliedVersions(db: Database.Database): number[] {
  db.prepare(SCHEMA_MIGRATIONS_DDL).run();
  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all() as { version: number }[];
  return rows.map((r) => r.version);
}

/** Highest applied schema version, or 0 when the DB has no migrations. */
export function currentSchemaVersion(db: Database.Database): number {
  const applied = appliedVersions(db);
  return applied.length === 0 ? 0 : (applied[applied.length - 1] as number);
}

/**
 * Read the schema version WITHOUT creating `schema_migrations` — safe on a
 * read-only connection. A DB with no migrations table is version 0.
 */
export function readSchemaVersion(db: Database.Database): number {
  const present = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (present === undefined) return 0;
  const row = db
    .prepare("SELECT max(version) AS v FROM schema_migrations")
    .get() as { v: number | null };
  return row.v ?? 0;
}

export interface MigrateResult {
  /** versions applied by THIS call (empty when already up to date) */
  applied: number[];
  /** schema version after the call */
  version: number;
}

/**
 * Fail-closed migration-name integrity check (design §0.1 R12 / codex#252).
 *
 * `runMigrations` dedups by version only, so if a different branch landed the
 * same version number under a different name, our migration would be silently
 * skipped (`version-only` no-op) and its DDL never applied. Before applying any
 * migration we verify that, for every already-applied version that this harness
 * also defines, the stored name equals the expected name. A mismatch means a
 * conflicting migration took the slot — throw rather than silently skip.
 *
 * Returns early when `schema_migrations` is absent (a fresh DB has nothing to
 * validate). Stored versions this harness does not know about are ignored
 * (handled separately by the "version newer than supported" guard).
 */
export function assertMigrationNameIntegrity(db: Database.Database): void {
  const present = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (present === undefined) return;
  const expected = new Map<number, string>(
    MIGRATIONS.map((m) => [m.version, m.name]),
  );
  const rows = db
    .prepare("SELECT version, name FROM schema_migrations")
    .all() as { version: number; name: string }[];
  for (const row of rows) {
    const want = expected.get(row.version);
    if (want === undefined) continue;
    if (row.name !== want) {
      throw new DbError(
        `migration v${row.version} name mismatch / conflicting migration: ` +
          `applied=${row.name} expected=${want}. A different migration took ` +
          `this version slot; resolve the conflict before migrating (fail-closed)`,
      );
    }
  }
}

/**
 * Apply every migration newer than the DB's current version.
 *
 * Idempotent and concurrency-safe: each migration is applied inside an
 * IMMEDIATE write transaction that first re-checks whether the version is
 * already present, so two `db init`/`migrate` processes racing on a fresh
 * DB do not both run the same DDL — the loser simply finds the work done.
 * Per-migration transactions leave the DB at the last fully-applied
 * version if a later migration fails. A DB stamped with a version newer
 * than this harness knows is rejected rather than read with a mismatched
 * schema.
 */
export function runMigrations(db: Database.Database): MigrateResult {
  // Fail-closed skew guard (#271): reject a DB newer than this harness with
  // actionable, directional guidance. The older-DB path proceeds to migrate.
  // This reads the version read-only (no table creation), so ensure the
  // `schema_migrations` table exists before the insert loop below.
  assertSchemaCompatibleForMigrate(db);
  appliedVersions(db);
  assertMigrationNameIntegrity(db);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );
  const alreadyApplied = db.prepare(
    "SELECT 1 FROM schema_migrations WHERE version = ?",
  );
  const applied: number[] = [];
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  for (const m of ordered) {
    // .immediate() takes a write lock at BEGIN; the in-transaction recheck
    // means a concurrent runner that already applied this version makes
    // this step a no-op instead of failing on duplicate DDL.
    const step = db.transaction((): boolean => {
      if (alreadyApplied.get(m.version) !== undefined) return false;
      for (const stmt of m.statements) db.prepare(stmt).run();
      insert.run(m.version, m.name, new Date().toISOString());
      return true;
    });
    if (step.immediate()) applied.push(m.version);
  }
  return { applied, version: currentSchemaVersion(db) };
}
