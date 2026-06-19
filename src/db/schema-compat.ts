import type Database from "better-sqlite3";
import { DbError } from "./connection.js";
import { SCHEMA_VERSION } from "./schema.js";
import { readSchemaVersion } from "./migrations.js";

/**
 * Deterministic DB-vs-harness schema-version skew classification (issue #271).
 *
 * The only skew guard used to be a late terse throw inside `runMigrations`, and
 * `runUpgradeCheck` lumped every mismatch as an undifferentiated `blocked`
 * without telling the operator which direction to fix. This module centralizes
 * the classification into one pure function so the same actionable guidance is
 * produced at every DB-open choke point (migrate preflight, orchestrate
 * preflight, upgrade-check) with no duplication.
 *
 * Pure integer arithmetic on schema versions — no LLM output, self-report, or
 * review verdict ever influences the decision (fail-closed).
 */

export type SchemaSkewKind =
  | "ok"
  | "db-newer-than-harness"
  | "harness-newer-than-db";

export interface SchemaCompatibility {
  readonly kind: SchemaSkewKind;
  readonly dbVersion: number;
  readonly harnessVersion: number;
  readonly message: string;
}

/** Runbook anchor in docs/ops/release-and-upgrade.md for the skew guidance. */
const SKEW_RUNBOOK = "docs/ops/release-and-upgrade.md#db-schema-version-skew";

/**
 * Classify the relationship between an on-disk DB schema version and the
 * version this harness produces. Pure: no DB access, no mutation. Returns a new
 * object describing the skew kind and an actionable multi-line message.
 */
export function evaluateSchemaCompatibility(
  dbVersion: number,
  harnessVersion: number = SCHEMA_VERSION,
): SchemaCompatibility {
  if (dbVersion > harnessVersion) {
    const message =
      `DB schema version ${dbVersion} is newer than this harness supports ` +
      `(${harnessVersion}). The ops harness (driver) is behind the DB. ` +
      `Fix: upgrade the harness to a build that knows schema v${dbVersion}:\n` +
      `  cd <ops checkout> && git fetch --tags origin && ` +
      `git checkout vX.Y.Z && npm ci && harness db migrate\n` +
      `See ${SKEW_RUNBOOK}.`;
    return {
      kind: "db-newer-than-harness",
      dbVersion,
      harnessVersion,
      message,
    };
  }
  if (dbVersion < harnessVersion) {
    const message =
      `DB schema version ${dbVersion} is older than this harness ` +
      `(v${harnessVersion}) — run \`harness db migrate\` to apply pending ` +
      `migrations. See ${SKEW_RUNBOOK}.`;
    return {
      kind: "harness-newer-than-db",
      dbVersion,
      harnessVersion,
      message,
    };
  }
  return {
    kind: "ok",
    dbVersion,
    harnessVersion,
    message: `DB schema at v${dbVersion} matches this harness.`,
  };
}

/**
 * Fail-closed migrate-preflight guard. Reads the on-disk version with
 * `readSchemaVersion` (read-only safe — does NOT create `schema_migrations`)
 * and throws a structured `DbError` ONLY for the `db-newer-than-harness` case.
 *
 * The older-DB (`harness-newer-than-db`) and equal (`ok`) cases are a no-op so
 * the existing additive migrate path proceeds unchanged — the directional guard
 * must never block a legitimate forward migration.
 */
export function assertSchemaCompatibleForMigrate(db: Database.Database): void {
  const dbVersion = readSchemaVersion(db);
  const result = evaluateSchemaCompatibility(dbVersion);
  if (result.kind === "db-newer-than-harness") {
    throw new DbError(result.message);
  }
}
