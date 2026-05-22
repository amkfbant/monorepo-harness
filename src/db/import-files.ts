import { join } from "node:path";
import type Database from "better-sqlite3";
import { harnessPaths } from "../config/paths.js";
import {
  emptyCounters,
  pruneOrphanImportErrors,
  type ImportCounters,
} from "./import/common.js";
import { importProjects } from "./import/projects.js";
import { importPolicies } from "./import/policies.js";
import { importRuns } from "./import/runs.js";
import { importBacklog } from "./import/backlog.js";
import { importKnowledge } from "./import/knowledge.js";

/**
 * File importer (Phase 6-3).
 *
 * `runFullImport` builds the DB read model from `runs/` / `projects/` /
 * `policies/` / `backlog/` / `docs/knowledge/`. It is idempotent: a run
 * whose `meta.json` is unchanged is skipped, and every importer upserts
 * by stable id. Malformed source files are recorded in `import_errors`
 * rather than aborting the import.
 */

export interface ImportReport extends ImportCounters {
  durationMs: number;
}

export interface ImportOptions {
  harnessRoot: string;
  /** when true, every data table is emptied before the import */
  reset?: boolean;
  /**
   * when true, a `db-first` runtime row is overwritten from its files
   * instead of being skipped — the explicit disaster-recovery escape
   * hatch (`db import --force-legacy-reconcile`). Off by normal import.
   */
  forceLegacyReconcile?: boolean;
}

/**
 * File-derived tables emptied entirely by `--reset`. These hold nothing
 * DB-canonical — they are rebuilt from `projects/` / `policies/` files.
 */
const RESET_TABLES_FILE_DERIVED = [
  "import_errors",
  "policy_generations",
  "domains",
  "project_profiles",
  "projects",
];

/**
 * Runtime tables that carry `source_mode`. `--reset` clears only their
 * `legacy-file` rows: a `db-first` row is DB-canonical (Phase 7), and a
 * reset — performed by every read-only scoped command via
 * `withRefreshedDb` — must not silently demigrate it back to
 * `legacy-file`. A `legacy-file` row is still dropped so a since-deleted
 * source file does not linger.
 */
const RESET_TABLES_RUNTIME = [
  "runs",
  "backlog_items",
  "knowledge_candidates",
  "knowledge_entries",
];

/**
 * Child tables keyed to a runtime parent. After the parents are cleared,
 * a row whose parent is gone is an orphan and removed; a child of a
 * surviving `db-first` parent is kept.
 */
const RESET_CHILD_TABLES: { table: string; key: string; parent: string }[] = [
  { table: "run_events", key: "run_id", parent: "runs" },
  { table: "command_results", key: "run_id", parent: "runs" },
  { table: "review_decisions", key: "run_id", parent: "runs" },
  { table: "review_required_changes", key: "run_id", parent: "runs" },
  { table: "run_changed_files", key: "run_id", parent: "runs" },
  { table: "policy_violations", key: "run_id", parent: "runs" },
  { table: "artifacts", key: "run_id", parent: "runs" },
  { table: "run_context_packs", key: "run_id", parent: "runs" },
  { table: "run_context_pack_files", key: "run_id", parent: "runs" },
  { table: "backlog_run_links", key: "item_id", parent: "backlog_items" },
];

export function runFullImport(
  db: Database.Database,
  opts: ImportOptions,
): ImportReport {
  const started = Date.now();
  const paths = harnessPaths(opts.harnessRoot);
  const counters = emptyCounters();

  if (opts.reset === true) {
    const tx = db.transaction(() => {
      for (const t of RESET_TABLES_FILE_DERIVED) {
        db.prepare(`DELETE FROM ${t}`).run();
      }
      // a db-first runtime row is canonical — keep it; drop legacy-file rows.
      for (const t of RESET_TABLES_RUNTIME) {
        db.prepare(`DELETE FROM ${t} WHERE source_mode != 'db-first'`).run();
      }
      // drop child rows orphaned by the runtime deletes above; children of a
      // surviving db-first parent stay.
      for (const c of RESET_CHILD_TABLES) {
        db.prepare(
          `DELETE FROM ${c.table}
           WHERE ${c.key} NOT IN (SELECT ${c.key} FROM ${c.parent})`,
        ).run();
      }
    });
    tx();
  }
  // NOTE: a non-reset import does NOT wipe `import_errors`. Each importer
  // clears its own source on success / re-records on failure, and a
  // skipped run keeps its errors (the malformed file is unchanged). Stale
  // rows for since-deleted source files are pruned at the end.

  const force = opts.forceLegacyReconcile === true;
  importProjects(db, paths.projectsDir, counters);
  importPolicies(db, paths.policiesDir, counters);
  importRuns(db, paths.runsDir, counters, force);
  importBacklog(db, paths.backlogDir, counters, force);
  importKnowledge(
    db,
    paths.runsDir,
    join(opts.harnessRoot, "docs", "knowledge"),
    counters,
  );

  pruneOrphanImportErrors(db);
  // report the FINAL import_errors row count — a skipped run's preserved
  // error is not re-counted by `counters.errors`, so query the table.
  const errors = (
    db.prepare("SELECT count(*) AS n FROM import_errors").get() as {
      n: number;
    }
  ).n;
  return { ...counters, errors, durationMs: Date.now() - started };
}

/** Render an ImportReport as a human-readable block. */
export function formatImportReport(r: ImportReport): string {
  return [
    "db import (from files):",
    `  projects:             ${r.projects}`,
    `  policy generations:   ${r.policies}`,
    `  runs:                 ${r.runs} (skipped ${r.runsSkipped} unchanged)`,
    `  backlog items:        ${r.backlogItems}`,
    `  knowledge candidates: ${r.knowledgeCandidates}`,
    `  knowledge entries:    ${r.knowledgeEntries}`,
    `  import errors:        ${r.errors}`,
    `  elapsed:              ${r.durationMs} ms`,
    "",
  ].join("\n");
}
