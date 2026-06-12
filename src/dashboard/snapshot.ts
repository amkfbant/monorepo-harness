import { existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations, readSchemaVersion } from "../db/migrations.js";
import { runFullImport } from "../db/import-files.js";
import { checkConsistency } from "../db/consistency.js";
import { DbDashboardDataSource } from "./data-source.js";
import type {
  DbMetricsSummary,
  DbInboxSummary,
  DbKnowledgeDigest,
  DbBacklogSummary,
} from "../db/repositories/aggregates.js";
import type {
  DbHitchMetricsSummary,
  DbMcpConfirmationSummary,
} from "../db/repositories/convergence-aggregates.js";
import type { DashboardRunSummary } from "../db/repositories/runs.js";

/**
 * Dashboard snapshot (Phase 6-7).
 *
 * `buildDashboardSnapshot` assembles ONE read-only object from the DB
 * read model — the dashboard's single source of truth. It composes the
 * `DashboardDataSource` aggregates with the consistency checker so the
 * UI can show whether the DB it is reading is stale.
 */

export interface DashboardFilters {
  projectId?: string;
  repoId?: string;
}

export interface ProjectSummary {
  projectId: string;
  repoId: string;
  description: string | null;
  domainCount: number;
  runCount: number;
  /** a generated repo policy (with provenance) was imported for this repo */
  hasGeneratedPolicy: boolean;
  /** consistency of the project's profile vs the DB */
  consistency: "ok" | "drift" | "missing-file" | "missing-db" | "unknown";
}

export interface DashboardWarning {
  level: "warn" | "error";
  message: string;
}

export interface DashboardSnapshot {
  generatedAt: string;
  dbPath: string;
  dbSchemaVersion: number;
  /** total runs in the DB read model (unfiltered) */
  importedRuns: number;
  consistencyStatus: "ok" | "warn" | "error";
  filters: DashboardFilters;
  projects: ProjectSummary[];
  overview: DbMetricsSummary;
  hitchMetrics: DbHitchMetricsSummary;
  mcpConfirmations: DbMcpConfirmationSummary;
  inbox: DbInboxSummary;
  recentRuns: DashboardRunSummary[];
  backlog: DbBacklogSummary;
  knowledge: DbKnowledgeDigest;
  warnings: DashboardWarning[];
}

/** How many recent runs the snapshot carries. */
const RECENT_RUNS = 15;

export function buildDashboardSnapshot(opts: {
  db: Database.Database;
  harnessRoot: string;
  dbPath: string;
  filters?: DashboardFilters;
  now?: Date;
}): DashboardSnapshot {
  const { db } = opts;
  const filters = opts.filters ?? {};
  const now = opts.now ?? new Date();
  const ds = new DbDashboardDataSource(db);

  const consistency = checkConsistency({
    db,
    harnessRoot: opts.harnessRoot,
  });
  const importedRuns = (
    db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }
  ).n;

  const projects = buildProjectSummaries(db, consistency.items, filters);

  const warnings: DashboardWarning[] = [];
  if (consistency.status !== "ok") {
    warnings.push({
      level: "warn",
      message:
        `the DB has drifted from files ` +
        `(${consistency.counts.drift} drift, ` +
        `${consistency.counts.missingDb} missing-db, ` +
        `${consistency.counts.missingFile} missing-file) — run \`harness db import --from-files\``,
    });
  }
  const importErrors = (
    db.prepare("SELECT count(*) AS n FROM import_errors").get() as {
      n: number;
    }
  ).n;
  if (importErrors > 0) {
    warnings.push({
      level: "warn",
      message: `${importErrors} source file(s) failed to import — see import_errors`,
    });
  }

  return {
    generatedAt: now.toISOString(),
    dbPath: opts.dbPath,
    dbSchemaVersion: readSchemaVersion(db),
    importedRuns,
    consistencyStatus: consistency.status,
    filters,
    projects,
    overview: ds.metricsSummary(filters),
    hitchMetrics: ds.hitchMetricsSummary(filters),
    mcpConfirmations: ds.mcpConfirmationSummary({}),
    inbox: ds.inboxSummary(filters),
    recentRuns: ds.listRuns({ ...filters, limit: RECENT_RUNS }),
    backlog: ds.backlogList(filters),
    knowledge: ds.knowledgeDigest(filters),
    warnings,
  };
}

export class DashboardSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardSnapshotError";
  }
}

/**
 * Open the DB and build a snapshot.
 *
 * `autoImport` (default true) rebuilds the read model (`harness.sqlite`,
 * a derived cache) from files first, so the snapshot is never stale —
 * this writes the DB cache, but never harness workflow state. With
 * `autoImport: false` the DB is opened READ-ONLY and read exactly as-is
 * (the dashboard touches nothing); if it does not exist that is an error.
 */
export function loadDashboardSnapshot(opts: {
  harnessRoot: string;
  filters?: DashboardFilters;
  autoImport?: boolean;
  now?: Date;
}): DashboardSnapshot {
  const { dbPath } = harnessPaths(opts.harnessRoot);
  const autoImport = opts.autoImport ?? true;
  const build = (db: Database.Database): DashboardSnapshot =>
    buildDashboardSnapshot({
      db,
      harnessRoot: opts.harnessRoot,
      dbPath,
      ...(opts.filters !== undefined ? { filters: opts.filters } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });

  if (!autoImport) {
    // read-only: never migrate or write the DB cache.
    if (!existsSync(dbPath)) {
      throw new DashboardSnapshotError(
        `DB not initialized (${dbPath}); run 'harness db import --from-files'`,
      );
    }
    const dbHandle = openManagedDb({ dbPath, readonly: true });
    try {
      return build(dbHandle.db);
    } finally {
      dbHandle.close();
    }
  }

  const dbHandle = openManagedDb({ dbPath });
  try {
    runMigrations(dbHandle.db);
    runFullImport(dbHandle.db, {
      harnessRoot: opts.harnessRoot,
      reset: true,
    });
    return build(dbHandle.db);
  } finally {
    dbHandle.close();
  }
}

function buildProjectSummaries(
  db: Database.Database,
  consistencyItems: { kind: string; id: string; status: string }[],
  filters: DashboardFilters,
): ProjectSummary[] {
  const projConsistency = new Map<string, string>();
  for (const it of consistencyItems) {
    if (it.kind === "project") projConsistency.set(it.id, it.status);
  }
  // the project list is scoped the same way the other sections are, so a
  // filtered snapshot is internally consistent.
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.projectId !== undefined) {
    where.push("project_id = ?");
    params.push(filters.projectId);
  }
  if (filters.repoId !== undefined) {
    where.push("repo_id = ?");
    params.push(filters.repoId);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT project_id, repo_id, description FROM projects ${whereSql}
       ORDER BY project_id`,
    )
    .all(...params) as {
    project_id: string;
    repo_id: string;
    description: string | null;
  }[];
  const domainCount = db.prepare(
    "SELECT count(*) AS n FROM domains WHERE project_id = ?",
  );
  const runCount = db.prepare(
    "SELECT count(*) AS n FROM runs WHERE project_id = ?",
  );
  // key by both project_id AND repo_id so a project whose repo.id changed
  // does not inherit a stale generation from the same project_id.
  const hasPolicy = db.prepare(
    "SELECT 1 FROM policy_generations WHERE project_id = ? AND repo_id = ? LIMIT 1",
  );
  return rows.map((r) => ({
    projectId: r.project_id,
    repoId: r.repo_id,
    description: r.description,
    domainCount: (domainCount.get(r.project_id) as { n: number }).n,
    runCount: (runCount.get(r.project_id) as { n: number }).n,
    hasGeneratedPolicy:
      hasPolicy.get(r.project_id, r.repo_id) !== undefined,
    consistency: (projConsistency.get(r.project_id) ??
      "unknown") as ProjectSummary["consistency"],
  }));
}
