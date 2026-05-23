import type Database from "better-sqlite3";

/**
 * Phase 9-11 legacy-file removal gate.
 *
 * Phase 8 kept the `source_mode='legacy-file'` routing as a safety net.
 * Phase 9 enforces `db migrate-legacy` first: each runtime write command
 * asserts no legacy-file rows remain in the runtime tables it touches.
 *
 * Scope is **runs and backlog_items only** — those are the tables where
 * `legacy-file` ↔ `db-first` is a pure migration toggle. The plan
 * originally listed `knowledge_candidates` too, but `syncCandidate` uses
 * `source_mode='legacy-file'` as the "not yet decided" marker for newly
 * synced candidates, so a brand-new knowledge candidate would otherwise
 * trip this gate (see knowledge-db.ts `syncRun`). `knowledge_entries`
 * stays file-authored (Phase 8 design judgment B). `db migrate-legacy`
 * / `db import --force-legacy-reconcile` / `db init` / `db migrate` are
 * NOT gated (they exist to clear / recover the very state checked here).
 */

const RUNTIME_TABLES_CHECKED: readonly string[] = [
  "runs",
  "backlog_items",
];

export class LegacyRowsFoundError extends Error {
  constructor(public readonly counts: Record<string, number>) {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const detail = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(", ");
    super(
      `${total} legacy-file row(s) remain (${detail}); run ` +
        `'harness db migrate-legacy' to convert them to db-first first.`,
    );
    this.name = "LegacyRowsFoundError";
  }
}

/**
 * Throw `LegacyRowsFoundError` if any runtime table still has
 * `source_mode='legacy-file'` rows. Each table's existence is checked so
 * a partially-migrated DB (older schema) does not blow up.
 */
export function assertNoLegacyRuntimeRows(db: Database.Database): void {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const table of RUNTIME_TABLES_CHECKED) {
    const present = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(table);
    if (present === undefined) continue;
    // older schemas may not have `source_mode` on every table; guard with
    // a column probe so the gate degrades to a no-op there.
    const hasColumn = db
      .prepare(
        "SELECT 1 FROM pragma_table_info(?) WHERE name = 'source_mode'",
      )
      .get(table);
    if (hasColumn === undefined) continue;
    const row = db
      .prepare(
        `SELECT count(*) AS n FROM ${table} WHERE source_mode = 'legacy-file'`,
      )
      .get() as { n: number };
    counts[table] = row.n;
    total += row.n;
  }
  if (total > 0) throw new LegacyRowsFoundError(counts);
}
