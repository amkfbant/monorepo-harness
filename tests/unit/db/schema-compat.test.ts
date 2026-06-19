import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, DbError } from "../../../src/db/connection.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "../../../src/db/migrations.js";
import { SCHEMA_VERSION } from "../../../src/db/schema.js";
import {
  evaluateSchemaCompatibility,
  assertSchemaCompatibleForMigrate,
} from "../../../src/db/schema-compat.js";

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-schema-compat-"));
  return join(dir, ".harness", "harness.sqlite");
}

/** Stamp an extra `schema_migrations` row to simulate a newer DB. */
function stampVersion(db: ReturnType<typeof openDb>, version: number): void {
  db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  ).run(version, `simulated-v${version}`, new Date().toISOString());
}

/** Delete the top applied migration row to simulate an older DB (vN-1). */
function dropTopVersion(db: ReturnType<typeof openDb>): void {
  db.prepare(
    "DELETE FROM schema_migrations WHERE version = (SELECT max(version) FROM schema_migrations)",
  ).run();
}

describe("evaluateSchemaCompatibility (pure)", () => {
  it("equal db/harness version → kind 'ok'", () => {
    const r = evaluateSchemaCompatibility(33, 33);
    expect(r.kind).toBe("ok");
    expect(r.dbVersion).toBe(33);
    expect(r.harnessVersion).toBe(33);
  });

  it("db newer than harness → 'db-newer-than-harness' with actionable upgrade-harness guidance", () => {
    const r = evaluateSchemaCompatibility(40, 33);
    expect(r.kind).toBe("db-newer-than-harness");
    expect(r.message).toMatch(/newer than this harness/);
    expect(r.message).toMatch(/upgrade the harness/);
    expect(r.message).toMatch(/release-and-upgrade\.md#db-schema-version-skew/);
  });

  it("db older than harness → 'harness-newer-than-db' with 'harness db migrate' guidance, NOT upgrade-the-harness", () => {
    const r = evaluateSchemaCompatibility(20, 33);
    expect(r.kind).toBe("harness-newer-than-db");
    expect(r.message).toMatch(/harness db migrate/);
    expect(r.message).not.toMatch(/upgrade the harness/);
  });

  it("default harnessVersion param resolves to LATEST_SCHEMA_VERSION", () => {
    const r = evaluateSchemaCompatibility(LATEST_SCHEMA_VERSION);
    expect(r.kind).toBe("ok");
    expect(r.harnessVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(LATEST_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });
});

describe("assertSchemaCompatibleForMigrate (DB read-only guard)", () => {
  it("DB stamped one version newer than latest → THROWS DbError", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    stampVersion(db, LATEST_SCHEMA_VERSION + 1);
    expect(() => assertSchemaCompatibleForMigrate(db)).toThrow(DbError);
    expect(() => assertSchemaCompatibleForMigrate(db)).toThrow(
      /newer than this harness/,
    );
    db.close();
  });

  it("DB stamped far-future version → THROWS", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    stampVersion(db, 999);
    expect(() => assertSchemaCompatibleForMigrate(db)).toThrow(DbError);
    db.close();
  });

  it("fresh DB (version 0) → no-op (does not throw)", () => {
    const db = openDb(freshDbPath());
    expect(() => assertSchemaCompatibleForMigrate(db)).not.toThrow();
    db.close();
  });

  it("DB at latest (equal) → no-op (does not throw)", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    expect(() => assertSchemaCompatibleForMigrate(db)).not.toThrow();
    db.close();
  });

  it("DB older than latest → no-op (older path must proceed to migrate, not block)", () => {
    const db = openDb(freshDbPath());
    runMigrations(db);
    dropTopVersion(db);
    expect(() => assertSchemaCompatibleForMigrate(db)).not.toThrow();
    db.close();
  });
});
