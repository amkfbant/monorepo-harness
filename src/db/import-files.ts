import { join } from "node:path";
import type Database from "better-sqlite3";
import { harnessPaths } from "../config/paths.js";
import { emptyCounters, type ImportCounters } from "./import/common.js";
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
}

/** Data tables emptied by `--reset` (everything except db_meta). */
const RESET_TABLES = [
  "import_errors",
  "knowledge_entries",
  "knowledge_candidates",
  "backlog_run_links",
  "backlog_items",
  "run_context_pack_files",
  "run_context_packs",
  "artifacts",
  "policy_violations",
  "run_changed_files",
  "review_required_changes",
  "review_decisions",
  "command_results",
  "run_events",
  "runs",
  "policy_generations",
  "domains",
  "project_profiles",
  "projects",
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
      for (const t of RESET_TABLES) db.prepare(`DELETE FROM ${t}`).run();
    });
    tx();
  } else {
    // a full import re-records every error fresh — clear stale rows so a
    // since-deleted source file does not linger in import_errors.
    db.prepare("DELETE FROM import_errors").run();
  }

  importProjects(db, paths.projectsDir, counters);
  importPolicies(db, paths.policiesDir, counters);
  importRuns(db, paths.runsDir, counters);
  importBacklog(db, paths.backlogDir, counters);
  importKnowledge(
    db,
    paths.runsDir,
    join(opts.harnessRoot, "docs", "knowledge"),
    counters,
  );

  return { ...counters, durationMs: Date.now() - started };
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
