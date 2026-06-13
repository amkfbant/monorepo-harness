import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import {
  MIGRATIONS,
  runMigrations,
  currentSchemaVersion,
  readSchemaVersion,
} from "../../../src/db/migrations.js";
import {
  ALL_TABLE_NAMES,
  CURRENT_TABLE_NAMES,
  DROPPED_TABLE_NAMES,
  SCHEMA_VERSION,
} from "../../../src/db/schema.js";
import { HitchRepository } from "../../../src/hitch/repository.js";

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-db-"));
  return join(dir, ".harness", "harness.sqlite");
}

function tableNames(dbPath: string): Set<string> {
  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    return new Set(rows.map((r) => r.name));
  } finally {
    db.close();
  }
}

function hasSchemaObject(
  db: Database.Database,
  type: "table" | "index",
  name: string,
): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?")
      .get(type, name) !== undefined
  );
}

function applyMigrationsBefore(db: Database.Database, version: number): void {
  db.prepare(
    `CREATE TABLE schema_migrations (
       version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
     )`,
  ).run();
  for (const m of MIGRATIONS.filter((migration) => migration.version < version)) {
    for (const stmt of m.statements) db.prepare(stmt).run();
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(m.version, m.name, new Date().toISOString());
  }
}

describe("runMigrations", () => {
  it("creates the latest schema with every table on a fresh DB", () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const r = runMigrations(db);
    db.close();
    expect(r.version).toBe(SCHEMA_VERSION);
    expect(r.applied).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
      22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
    const tables = tableNames(dbPath);
    expect(tables.has("schema_migrations")).toBe(true);
    expect(ALL_TABLE_NAMES).toContain("db_stats_snapshots");
    expect(DROPPED_TABLE_NAMES).toContain("db_stats_snapshots");
    expect(CURRENT_TABLE_NAMES).not.toContain("db_stats_snapshots");
    for (const t of CURRENT_TABLE_NAMES) {
      expect(tables.has(t)).toBe(true);
    }
    for (const t of DROPPED_TABLE_NAMES) {
      expect(tables.has(t)).toBe(false);
    }
  });

  it("rebuilds hitch_lifecycle_events in v29 without loosening constraints", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 29);
      expect(currentSchemaVersion(db)).toBe(28);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "hitch-v29",
        title: "v29",
        createdBy: "test",
        createdSource: "cli",
      });
      db.prepare(
        `INSERT INTO hitch_lifecycle_events
           (event_id, hitch_id, event, reason, created_at, created_by)
         VALUES ('event-old', 'hitch-v29', 'closed', 'done',
           '2026-06-13T00:00:00.000Z', 'test')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO hitch_lifecycle_events
               (event_id, hitch_id, event, reason, created_at, created_by)
             VALUES ('event-too-new', 'hitch-v29', 'pr_adopted', 'new',
               '2026-06-13T00:00:01.000Z', 'test')`,
          )
          .run(),
      ).toThrow(/CHECK/i);

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([29, 30]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "index", "hitch_lifecycle_events_hitch_idx")).toBe(
        true,
      );

      const preserved = db
        .prepare("SELECT event, reason FROM hitch_lifecycle_events WHERE event_id = ?")
        .get("event-old") as { event: string; reason: string } | undefined;
      expect(preserved).toEqual({ event: "closed", reason: "done" });

      for (const event of ["reopened", "closed", "cancelled", "pr_adopted", "updated"]) {
        db.prepare(
          `INSERT INTO hitch_lifecycle_events
             (event_id, hitch_id, event, reason, created_at, created_by)
           VALUES (?, 'hitch-v29', ?, 'why', '2026-06-13T00:00:02.000Z',
             'test')`,
        ).run(`event-${event}`, event);
      }
      expect(() =>
        db
          .prepare(
            `INSERT INTO hitch_lifecycle_events
               (event_id, hitch_id, event, reason, created_at, created_by)
             VALUES ('event-bad', 'hitch-v29', 'bad', 'why',
               '2026-06-13T00:00:03.000Z', 'test')`,
          )
          .run(),
      ).toThrow(/CHECK/i);
      expect(() =>
        db
          .prepare(
            `INSERT INTO hitch_lifecycle_events
               (event_id, hitch_id, event, created_at, created_by)
             VALUES ('event-null-reason', 'hitch-v29', 'updated',
               '2026-06-13T00:00:04.000Z', 'test')`,
          )
          .run(),
      ).toThrow(/NOT NULL/i);
      expect(() =>
        db
          .prepare(
            `INSERT INTO hitch_lifecycle_events
               (event_id, hitch_id, event, reason, created_at)
             VALUES ('event-null-actor', 'hitch-v29', 'updated', 'why',
               '2026-06-13T00:00:05.000Z')`,
          )
          .run(),
      ).toThrow(/NOT NULL/i);

      const fks = db
        .prepare("PRAGMA foreign_key_list(hitch_lifecycle_events)")
        .all() as { table: string; from: string; to: string; on_delete: string }[];
      expect(fks).toContainEqual(
        expect.objectContaining({
          table: "hitch_sessions",
          from: "hitch_id",
          to: "hitch_id",
          on_delete: "CASCADE",
        }),
      );
      db.prepare("DELETE FROM hitch_sessions WHERE hitch_id = 'hitch-v29'").run();
      const remaining = db
        .prepare(
          "SELECT COUNT(*) AS n FROM hitch_lifecycle_events WHERE hitch_id = 'hitch-v29'",
        )
        .get() as { n: number };
      expect(remaining.n).toBe(0);

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("creates domain_lock_contention in v28 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 28);
      expect(currentSchemaVersion(db)).toBe(27);
      expect(hasSchemaObject(db, "table", "domain_lock_contention")).toBe(false);

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([28, 29, 30]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "table", "domain_lock_contention")).toBe(true);
      expect(
        hasSchemaObject(db, "index", "domain_lock_contention_domain_observed_idx"),
      ).toBe(true);
      const indexColumns = db
        .prepare("PRAGMA index_info(domain_lock_contention_domain_observed_idx)")
        .all() as { name: string }[];
      expect(indexColumns.map((r) => r.name)).toEqual([
        "repo_id",
        "domain",
        "observed_at",
      ]);

      const columns = db.prepare("PRAGMA table_info(domain_lock_contention)").all() as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }[];
      expect(columns.find((r) => r.name === "contention_id")).toMatchObject({
        type: "TEXT",
        pk: 1,
      });
      for (const name of ["domain_key", "observed_at"]) {
        expect(columns.find((r) => r.name === name)).toMatchObject({
          type: "TEXT",
          notnull: 1,
        });
      }
      for (const name of ["repo_id", "domain", "holder_run_id", "contender_hostname"]) {
        expect(columns.find((r) => r.name === name)).toMatchObject({
          type: "TEXT",
          notnull: 0,
        });
      }
      expect(columns.find((r) => r.name === "contender_pid")).toMatchObject({
        type: "INTEGER",
        notnull: 0,
      });

      db.prepare(
        `INSERT INTO domain_lock_contention
           (contention_id, domain_key, repo_id, domain, holder_run_id,
            contender_pid, contender_hostname, observed_at)
         VALUES ('dlc-v28', 'demo::apps/web', 'demo', 'apps/web', 'run-a',
           200, 'h2', '2026-06-13T00:00:00.000Z')`,
      ).run();
      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("recreates run_usage in v30 with per-invocation primary key and preserves v26 rows", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 30);
      expect(currentSchemaVersion(db)).toBe(29);

      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, updated_at)
         VALUES ('run-v30', 'demo', 'apps/web', 'domain-coding', 'main',
           'needs_review', '2026-06-13T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO run_usage
           (run_id, model, input_tokens, cached_input_tokens, output_tokens,
            reasoning_output_tokens, total_tokens, usage_source, created_at)
         VALUES ('run-v30', 'gpt-5', 10, 2, 5, 1, 15, 'exact',
           '2026-06-13T00:00:00.000Z')`,
      ).run();

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([30]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);

      const columns = db
        .prepare("PRAGMA table_info(run_usage)")
        .all() as { name: string; type: string; notnull: number; pk: number }[];
      expect(columns.map((r) => r.name)).toEqual([
        "run_id",
        "kind",
        "seq",
        "model",
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
        "usage_source",
        "created_at",
      ]);
      expect(columns.find((r) => r.name === "run_id")).toMatchObject({
        type: "TEXT",
        notnull: 1,
        pk: 1,
      });
      expect(columns.find((r) => r.name === "kind")).toMatchObject({
        type: "TEXT",
        notnull: 1,
        pk: 2,
      });
      expect(columns.find((r) => r.name === "seq")).toMatchObject({
        type: "INTEGER",
        notnull: 1,
        pk: 3,
      });
      expect(hasSchemaObject(db, "index", "run_usage_run_idx")).toBe(true);

      const migrated = db
        .prepare(
          `SELECT run_id, kind, seq, model, input_tokens, cached_input_tokens,
                  output_tokens, reasoning_output_tokens, total_tokens,
                  usage_source, created_at
             FROM run_usage
            WHERE run_id = ?`,
        )
        .get("run-v30") as Record<string, unknown> | undefined;
      expect(migrated).toEqual({
        run_id: "run-v30",
        kind: "coder",
        seq: 0,
        model: "gpt-5",
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 5,
        reasoning_output_tokens: 1,
        total_tokens: 15,
        usage_source: "exact",
        created_at: "2026-06-13T00:00:00.000Z",
      });

      db.prepare(
        `INSERT INTO run_usage
           (run_id, kind, seq, usage_source, created_at)
         VALUES ('run-v30', 'coder', 1, 'unavailable',
           '2026-06-13T00:00:01.000Z')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO run_usage
               (run_id, kind, seq, usage_source, created_at)
             VALUES ('run-v30', 'coder', 1, 'unavailable',
               '2026-06-13T00:00:02.000Z')`,
          )
          .run(),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO run_usage
               (run_id, kind, seq, usage_source, created_at)
             VALUES ('run-v30', 'planner', 2, 'unavailable',
               '2026-06-13T00:00:03.000Z')`,
          )
          .run(),
      ).toThrow(/CHECK/i);

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("creates metrics_snapshots in v27 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 27);
      expect(currentSchemaVersion(db)).toBe(26);
      expect(hasSchemaObject(db, "table", "metrics_snapshots")).toBe(false);

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([27, 28, 29, 30]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "table", "metrics_snapshots")).toBe(true);
      expect(hasSchemaObject(db, "index", "metrics_snapshots_created_idx")).toBe(
        true,
      );
      expect(
        hasSchemaObject(db, "index", "metrics_snapshots_scope_created_idx"),
      ).toBe(true);

      const columns = db
        .prepare("PRAGMA table_info(metrics_snapshots)")
        .all() as { name: string; type: string; notnull: number; pk: number }[];
      expect(columns.find((r) => r.name === "snapshot_id")).toMatchObject({
        type: "TEXT",
        notnull: 0,
        pk: 1,
      });
      for (const name of ["created_at", "payload_json"]) {
        expect(columns.find((r) => r.name === name)).toMatchObject({
          type: "TEXT",
          notnull: 1,
        });
      }
      for (const name of ["project_id", "repo_id", "domain"]) {
        expect(columns.find((r) => r.name === name)).toMatchObject({
          type: "TEXT",
          notnull: 0,
        });
      }
      expect(columns.find((r) => r.name === "payload_schema")).toMatchObject({
        type: "INTEGER",
        notnull: 1,
      });

      db.prepare(
        `INSERT INTO metrics_snapshots
           (snapshot_id, created_at, project_id, repo_id, domain, payload_json)
         VALUES ('msnap-v27', '2026-06-13T00:00:00.000Z',
           'demo', 'repo-a', 'apps/web', '{}')`,
      ).run();
      const row = db
        .prepare(
          "SELECT payload_schema FROM metrics_snapshots WHERE snapshot_id = ?",
        )
        .get("msnap-v27") as { payload_schema: number } | undefined;
      expect(row?.payload_schema).toBe(1);

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("creates run_usage from v26 and upgrades it to the latest per-invocation shape", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 26);
      expect(currentSchemaVersion(db)).toBe(25);
      expect(hasSchemaObject(db, "table", "run_usage")).toBe(false);

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([26, 27, 28, 29, 30]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "table", "run_usage")).toBe(true);

      const columns = db
        .prepare("PRAGMA table_info(run_usage)")
        .all() as { name: string; type: string; notnull: number; pk: number }[];
      expect(columns.map((r) => r.name)).toEqual([
        "run_id",
        "kind",
        "seq",
        "model",
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
        "usage_source",
        "created_at",
      ]);
      expect(columns.find((r) => r.name === "run_id")).toMatchObject({
        type: "TEXT",
        notnull: 1,
        pk: 1,
      });
      expect(columns.find((r) => r.name === "kind")).toMatchObject({
        type: "TEXT",
        notnull: 1,
        pk: 2,
      });
      expect(columns.find((r) => r.name === "seq")).toMatchObject({
        type: "INTEGER",
        notnull: 1,
        pk: 3,
      });
      expect(columns.find((r) => r.name === "model")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      for (const name of [
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
      ]) {
        expect(columns.find((r) => r.name === name)).toMatchObject({
          type: "INTEGER",
          notnull: 0,
        });
      }
      expect(columns.find((r) => r.name === "usage_source")).toMatchObject({
        type: "TEXT",
        notnull: 1,
      });
      expect(columns.find((r) => r.name === "created_at")).toMatchObject({
        type: "TEXT",
        notnull: 1,
      });

      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, updated_at)
         VALUES ('run-v26', 'demo', 'apps/web', 'domain-coding', 'main',
           'needs_review', '2026-06-13T00:00:00.000Z')`,
      ).run();
      db.prepare(
        `INSERT INTO run_usage
           (run_id, kind, seq, input_tokens, cached_input_tokens, output_tokens,
            reasoning_output_tokens, total_tokens, usage_source, created_at)
         VALUES ('run-v26', 'coder', 0, 10, 2, 5, 1, 15, 'exact',
           '2026-06-13T00:00:00.000Z')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO run_usage (run_id, kind, seq, usage_source, created_at)
             VALUES ('run-v26-bad', 'coder', 0, 'exact',
               '2026-06-13T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow();
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, updated_at)
         VALUES ('run-v26-bad-source', 'demo', 'apps/web', 'domain-coding',
           'main', 'needs_review', '2026-06-13T00:00:00.000Z')`,
      ).run();
      expect(() =>
        db
          .prepare(
            `INSERT INTO run_usage (run_id, kind, seq, usage_source, created_at)
             VALUES ('run-v26-bad-source', 'coder', 0, 'self_reported',
               '2026-06-13T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/CHECK/i);

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("adds run execution environment provenance columns in v25 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 25);
      expect(currentSchemaVersion(db)).toBe(24);
      const before = db
        .prepare("PRAGMA table_info(runs)")
        .all() as { name: string }[];
      expect(before.map((r) => r.name)).not.toContain("harness_version");
      expect(before.map((r) => r.name)).not.toContain("schema_version_at_run");
      expect(before.map((r) => r.name)).not.toContain("codex_model");
      expect(before.map((r) => r.name)).not.toContain("codex_binary_version");
      expect(before.map((r) => r.name)).not.toContain("prompt_sha256");

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([25, 26, 27, 28, 29, 30]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      const after = db
        .prepare("PRAGMA table_info(runs)")
        .all() as { name: string; type: string; notnull: number }[];
      expect(after.find((r) => r.name === "harness_version")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(after.find((r) => r.name === "schema_version_at_run")).toMatchObject({
        type: "INTEGER",
        notnull: 0,
      });
      expect(after.find((r) => r.name === "codex_model")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(after.find((r) => r.name === "codex_binary_version")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });
      expect(after.find((r) => r.name === "prompt_sha256")).toMatchObject({
        type: "TEXT",
        notnull: 0,
      });

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("adds review_proposals.prompt_provenance_json in v24 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 24);
      expect(currentSchemaVersion(db)).toBe(23);
      const before = db
        .prepare("PRAGMA table_info(review_proposals)")
        .all() as { name: string }[];
      expect(before.map((r) => r.name)).not.toContain("prompt_provenance_json");

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([24, 25, 26, 27, 28, 29, 30]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      const after = db
        .prepare("PRAGMA table_info(review_proposals)")
        .all() as { name: string; type: string; notnull: number }[];
      const column = after.find((r) => r.name === "prompt_provenance_json");
      expect(column).toMatchObject({ type: "TEXT", notnull: 0 });

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("creates hitch_lifecycle_events in v23 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 23);
      expect(currentSchemaVersion(db)).toBe(22);
      expect(hasSchemaObject(db, "table", "hitch_lifecycle_events")).toBe(false);

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([23, 24, 25, 26, 27, 28, 29, 30]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "table", "hitch_lifecycle_events")).toBe(true);
      expect(hasSchemaObject(db, "index", "hitch_lifecycle_events_hitch_idx")).toBe(
        true,
      );

      expect(() =>
        db
          .prepare(
            `INSERT INTO hitch_lifecycle_events
               (event_id, hitch_id, event, reason, created_at, created_by)
             VALUES ('event-bad', 'missing', 'reopened', 'why',
               '2026-06-12T00:00:00.000Z', 'test')`,
          )
          .run(),
      ).toThrow();

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("drops db_stats_snapshots in v22 and stays idempotent", () => {
    const db = openDb(freshDbPath());
    try {
      applyMigrationsBefore(db, 22);
      expect(currentSchemaVersion(db)).toBe(21);
      expect(hasSchemaObject(db, "table", "db_stats_snapshots")).toBe(true);
      expect(hasSchemaObject(db, "index", "db_stats_snapshots_created_idx")).toBe(
        true,
      );
      db.prepare(
        "INSERT INTO db_stats_snapshots (created_at, stats_json) VALUES (?, ?)",
      ).run("2026-06-12T00:00:00.000Z", "{}");

      const upgraded = runMigrations(db);
      expect(upgraded.applied).toEqual([22, 23, 24, 25, 26, 27, 28, 29, 30]);
      expect(upgraded.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "table", "db_stats_snapshots")).toBe(false);
      expect(hasSchemaObject(db, "index", "db_stats_snapshots_created_idx")).toBe(
        false,
      );

      const again = runMigrations(db);
      expect(again.applied).toEqual([]);
      expect(again.version).toBe(SCHEMA_VERSION);
      expect(hasSchemaObject(db, "table", "db_stats_snapshots")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("creates the runs indexes", () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    runMigrations(db);
    const idx = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    db.close();
    expect(idx).toContain("runs_project_idx");
    expect(idx).toContain("runs_status_idx");
  });

  it("is idempotent — a second run applies nothing", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    const r2 = runMigrations(db);
    db.close();
    expect(r2.applied).toEqual([]);
    expect(r2.version).toBe(SCHEMA_VERSION);
  });

  it("currentSchemaVersion is 0 before any migration, latest after", () => {
    const db = openDb(freshDbPath());
    expect(currentSchemaVersion(db)).toBe(0);
    runMigrations(db);
    expect(currentSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("rejects a DB stamped with a newer schema version", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(999, "from-the-future", new Date().toISOString());
    expect(() => runMigrations(db)).toThrow(/newer than this harness/);
    db.close();
  });

  it("readSchemaVersion returns 0 without creating schema_migrations", () => {
    const db = openDb(freshDbPath());
    expect(readSchemaVersion(db)).toBe(0);
    // it must not have created the table
    const present = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
      )
      .get();
    expect(present).toBeUndefined();
    runMigrations(db);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("openDb throws a DbError when the file is not a SQLite database", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-db-"));
    const bogus = join(dir, "harness.sqlite");
    writeFileSync(bogus, "this is not a database\n");
    expect(() => openDb(bogus)).toThrow(/not a database/);
  });
});
