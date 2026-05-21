import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Shared helpers for the file importers (Phase 6-3).
 *
 * Every importer is idempotent: it upserts by stable id, and records
 * malformed input in `import_errors` instead of throwing — one bad file
 * never aborts the whole import.
 */

/**
 * sha256 hex of a string or buffer (source-hash idempotency / drift).
 * A Buffer is hashed byte-accurately — used for binary artifacts where a
 * UTF-8 decode would corrupt the digest.
 */
export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Per-source import counters, accumulated into the ImportReport. */
export interface ImportCounters {
  projects: number;
  policies: number;
  runs: number;
  runsSkipped: number;
  backlogItems: number;
  knowledgeCandidates: number;
  knowledgeEntries: number;
  errors: number;
}

export function emptyCounters(): ImportCounters {
  return {
    projects: 0,
    policies: 0,
    runs: 0,
    runsSkipped: 0,
    backlogItems: 0,
    knowledgeCandidates: 0,
    knowledgeEntries: 0,
    errors: 0,
  };
}

/**
 * Record a malformed source file. Upserts on `source_path` so a repeated
 * import does not accumulate duplicate error rows, and a file that was
 * fixed since the last import is cleared by `clearImportError`.
 */
export function recordImportError(
  db: Database.Database,
  counters: ImportCounters,
  sourcePath: string,
  kind: string,
  error: string,
): void {
  db.prepare(
    `INSERT INTO import_errors (source_path, kind, error, observed_at)
     VALUES (@source_path, @kind, @error, @observed_at)
     ON CONFLICT (source_path) DO UPDATE SET
       kind = excluded.kind,
       error = excluded.error,
       observed_at = excluded.observed_at`,
  ).run({
    source_path: sourcePath,
    kind,
    error: error.slice(0, 2000),
    observed_at: new Date().toISOString(),
  });
  counters.errors += 1;
}

/** Clear a stale error row once its source file imports cleanly again. */
export function clearImportError(
  db: Database.Database,
  sourcePath: string,
): void {
  db.prepare("DELETE FROM import_errors WHERE source_path = ?").run(
    sourcePath,
  );
}
