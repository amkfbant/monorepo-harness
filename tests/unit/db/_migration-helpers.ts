import { MIGRATIONS } from "../../../src/db/migrations.js";

// (#398) Shared derivation of migration version sequences for the db migration
// tests. Before this, every "applied == [seed+1 .. LATEST]" assertion hardcoded
// the full tail, so a single schema bump broke ~10 test files at once (and a
// missed update slipped through #395 salvage as a real P1). Deriving from the
// canonical MIGRATIONS ledger means adding migration vN+1 auto-extends every
// call site — the only edit a new migration needs is its own migration-vN.test.ts.
//
// NB: this file is intentionally NOT a `*.test.ts` so vitest does not collect it
// as a suite (matches the existing `_agent-usage-helpers.ts` convention).

/**
 * Migration versions strictly greater than `fromExclusive`, ascending, derived
 * from the canonical MIGRATIONS ledger. Mirrors `runMigrations`' own
 * `version > current` semantics: on a DB seeded through exactly `fromExclusive`,
 * `runMigrations(db).applied === migrationVersionsAbove(fromExclusive)`.
 *
 * Derived from MIGRATIONS (not a numeric `seq(start,end)`) so it stays correct
 * even if a version number is ever skipped — the runner is gap-tolerant and so
 * is this.
 */
export function migrationVersionsAbove(fromExclusive: number): number[] {
  return MIGRATIONS.map((m) => m.version)
    .filter((v) => v > fromExclusive)
    .sort((a, b) => a - b);
}

/** Every migration version, ascending (a fresh-DB full apply == seed 0). */
export function allMigrationVersions(): number[] {
  return migrationVersionsAbove(0);
}
