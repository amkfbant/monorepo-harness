import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { harnessPaths } from "../config/paths.js";
import { sha256 } from "./import/common.js";
import { runFingerprint } from "./import/runs.js";

/**
 * DB / file consistency checker (Phase 6-4).
 *
 * The DB is a read model built from files. `checkConsistency` recomputes
 * the source hashes the importer stored and reports where the DB has
 * drifted from `runs/` / `projects/` / `policies/`. The dashboard shows
 * this so an operator knows a stale DB needs `harness db import`.
 */

export type ConsistencyStatus =
  | "ok"
  | "drift"
  | "missing-file"
  | "missing-db";

export interface ConsistencyItem {
  /** "run" | "project" | "policy" */
  kind: string;
  /** runId / projectId / repoId */
  id: string;
  status: ConsistencyStatus;
  detail: string;
}

export interface ConsistencyReport {
  status: "ok" | "warn" | "error";
  checkedAt: string;
  counts: { ok: number; drift: number; missingFile: number; missingDb: number };
  items: ConsistencyItem[];
}

export function checkConsistency(opts: {
  db: Database.Database;
  harnessRoot: string;
}): ConsistencyReport {
  const paths = harnessPaths(opts.harnessRoot);
  const items: ConsistencyItem[] = [];
  checkRuns(opts.db, paths.runsDir, items);
  checkProjects(opts.db, paths.projectsDir, items);
  checkPolicies(opts.db, paths.policiesDir, items);
  checkBacklog(opts.db, paths.backlogDir, items);
  checkKnowledgeEntries(opts.db, opts.harnessRoot, items);
  checkExports(opts.db, paths, opts.harnessRoot, items);

  const counts = { ok: 0, drift: 0, missingFile: 0, missingDb: 0 };
  for (const it of items) {
    if (it.status === "ok") counts.ok += 1;
    else if (it.status === "drift") counts.drift += 1;
    else if (it.status === "missing-file") counts.missingFile += 1;
    else counts.missingDb += 1;
  }
  const clean = items.every((i) => i.status === "ok");
  return {
    status: clean ? "ok" : "warn",
    checkedAt: new Date().toISOString(),
    counts,
    items,
  };
}

function checkRuns(
  db: Database.Database,
  runsDir: string,
  items: ConsistencyItem[],
): void {
  const dbRuns = db
    .prepare(
      "SELECT run_id, source_meta_sha256 AS h, source_mode AS mode FROM runs",
    )
    .all() as { run_id: string; h: string; mode: string }[];
  const dbIds = new Set(dbRuns.map((r) => r.run_id));

  for (const r of dbRuns) {
    // a db-first run's `runs` row is canonical and its `source_meta_sha256`
    // is not maintained — the file-fingerprint drift check does not apply.
    // Its export freshness is covered by `checkExports` instead.
    if (r.mode === "db-first") continue;
    const runDir = join(runsDir, r.run_id);
    const metaPath = join(runDir, "meta.json");
    if (!existsSync(metaPath)) {
      items.push({
        kind: "run",
        id: r.run_id,
        status: "missing-file",
        detail: "run dir is absent (cleaned?) but the DB still has the run",
      });
      continue;
    }
    const fp = runFingerprint(runDir, readFileSync(metaPath, "utf8"));
    items.push(
      fp === r.h
        ? { kind: "run", id: r.run_id, status: "ok", detail: "" }
        : {
            kind: "run",
            id: r.run_id,
            status: "drift",
            detail: "run files changed since import — re-run `db import`",
          },
    );
  }

  if (!existsSync(runsDir)) return;
  for (const e of readdirSync(runsDir, { withFileTypes: true })) {
    if (!e.isDirectory() || dbIds.has(e.name)) continue;
    if (!existsSync(join(runsDir, e.name, "meta.json"))) continue;
    items.push({
      kind: "run",
      id: e.name,
      status: "missing-db",
      detail: "run exists on disk but not in the DB — re-run `db import`",
    });
  }
}

function checkProjects(
  db: Database.Database,
  projectsDir: string,
  items: ConsistencyItem[],
): void {
  // join to the CURRENT profile version and use the importer-recorded
  // profile_path — never assume the filename equals the project_id, and
  // never compare against a stale older profile version.
  const rows = db
    .prepare(
      `SELECT p.project_id AS project_id, p.profile_path AS path,
              pp.source_sha256 AS h
       FROM projects p
       JOIN project_profiles pp
         ON pp.project_id = p.project_id AND pp.version = p.profile_version`,
    )
    .all() as { project_id: string; path: string | null; h: string }[];
  const dbIds = new Set(rows.map((r) => r.project_id));

  for (const r of rows) {
    if (r.path === null || !existsSync(r.path)) {
      items.push({
        kind: "project",
        id: r.project_id,
        status: "missing-file",
        detail: "profile file is gone but the DB still has the project",
      });
      continue;
    }
    const h = sha256(readFileSync(r.path, "utf8"));
    items.push(
      h === r.h
        ? { kind: "project", id: r.project_id, status: "ok", detail: "" }
        : {
            kind: "project",
            id: r.project_id,
            status: "drift",
            detail: "profile changed since import — re-run `db import`",
          },
    );
  }

  if (!existsSync(projectsDir)) return;
  // missing-db: keyed on the parsed project_id, not the filename stem.
  for (const f of readdirSync(projectsDir)) {
    if (!f.endsWith(".yaml")) continue;
    let projectId: string | null = null;
    try {
      const doc = parseYaml(
        readFileSync(join(projectsDir, f), "utf8"),
      ) as Record<string, unknown> | null;
      projectId =
        doc && typeof doc.project_id === "string" ? doc.project_id : null;
    } catch {
      projectId = null; // a malformed profile is surfaced via import_errors
    }
    if (projectId === null || dbIds.has(projectId)) continue;
    items.push({
      kind: "project",
      id: projectId,
      status: "missing-db",
      detail: "profile exists on disk but not in the DB",
    });
  }
}

function checkPolicies(
  db: Database.Database,
  policiesDir: string,
  items: ConsistencyItem[],
): void {
  const dbGen = db
    .prepare(
      `SELECT repo_id, repo_policy_sha256 AS h, provenance_json
       FROM policy_generations`,
    )
    .all() as { repo_id: string; h: string; provenance_json: string }[];
  const dbRepoIds = new Set(dbGen.map((g) => g.repo_id));

  for (const g of dbGen) {
    const path = join(policiesDir, "repos", `${g.repo_id}.yaml`);
    if (!existsSync(path)) {
      items.push({
        kind: "policy",
        id: g.repo_id,
        status: "missing-file",
        detail: "generated policy file is gone but the DB still has it",
      });
      continue;
    }
    const h = sha256(readFileSync(path, "utf8"));
    if (h !== g.h) {
      items.push({
        kind: "policy",
        id: g.repo_id,
        status: "drift",
        detail: "generated policy YAML changed since import",
      });
      continue;
    }
    // the policy YAML matches — also verify the provenance sidecar, which
    // can drift on its own (e.g. catalog version bump regenerated it).
    const sidecar = join(policiesDir, "repos", `${g.repo_id}.generated.json`);
    if (!existsSync(sidecar)) {
      items.push({
        kind: "policy",
        id: g.repo_id,
        status: "missing-file",
        detail: "provenance sidecar is gone but the DB still has it",
      });
    } else if (readFileSync(sidecar, "utf8") !== g.provenance_json) {
      items.push({
        kind: "policy",
        id: g.repo_id,
        status: "drift",
        detail: "provenance sidecar changed since import",
      });
    } else {
      items.push({ kind: "policy", id: g.repo_id, status: "ok", detail: "" });
    }
  }

  // missing-db: a generated-policy sidecar on disk with no DB row — the
  // policy read model is stale (mirrors importPolicies' sidecar scan).
  const reposDir = join(policiesDir, "repos");
  if (!existsSync(reposDir)) return;
  for (const f of readdirSync(reposDir)) {
    if (!f.endsWith(".generated.json")) continue;
    const repoId = f.slice(0, -".generated.json".length);
    if (dbRepoIds.has(repoId)) continue;
    items.push({
      kind: "policy",
      id: repoId,
      status: "missing-db",
      detail: "generated policy sidecar on disk but not in the DB",
    });
  }
}

const BACKLOG_STATUS_DIRS = ["open", "doing", "done", "deferred"];

/**
 * Backlog has no source-hash column, so this is an existence check only:
 * a DB item with no file → missing-file; a file with no DB row →
 * missing-db. Content drift is not detected (re-import to refresh).
 */
function checkBacklog(
  db: Database.Database,
  backlogDir: string,
  items: ConsistencyItem[],
): void {
  const dbIds = new Set(
    (
      db.prepare("SELECT item_id FROM backlog_items").all() as {
        item_id: string;
      }[]
    ).map((r) => r.item_id),
  );
  const fileIds = new Set<string>();
  for (const status of BACKLOG_STATUS_DIRS) {
    const dir = join(backlogDir, status);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".yaml")) fileIds.add(f.slice(0, -".yaml".length));
    }
  }
  for (const id of dbIds) {
    if (!fileIds.has(id)) {
      items.push({
        kind: "backlog",
        id,
        status: "missing-file",
        detail: "backlog item in the DB but not on disk",
      });
    }
  }
  for (const id of fileIds) {
    if (!dbIds.has(id)) {
      items.push({
        kind: "backlog",
        id,
        status: "missing-db",
        detail: "backlog item on disk but not in the DB",
      });
    }
  }
}

/** Existence check for promoted knowledge entries (`docs/knowledge/**`). */
function checkKnowledgeEntries(
  db: Database.Database,
  harnessRoot: string,
  items: ConsistencyItem[],
): void {
  const knowledgeDir = join(harnessRoot, "docs", "knowledge");
  const dbIds = new Set(
    (
      db.prepare("SELECT entry_id FROM knowledge_entries").all() as {
        entry_id: string;
      }[]
    ).map((r) => r.entry_id),
  );
  const fileIds = new Set<string>();
  if (existsSync(knowledgeDir)) {
    for (const kindDir of readdirSync(knowledgeDir, { withFileTypes: true })) {
      if (!kindDir.isDirectory()) continue;
      for (const f of readdirSync(join(knowledgeDir, kindDir.name))) {
        if (f.endsWith(".md")) {
          fileIds.add(join("docs", "knowledge", kindDir.name, f));
        }
      }
    }
  }
  for (const id of dbIds) {
    if (!fileIds.has(id)) {
      items.push({
        kind: "knowledge",
        id,
        status: "missing-file",
        detail: "promoted knowledge entry in the DB but not on disk",
      });
    }
  }
  for (const id of fileIds) {
    if (!dbIds.has(id)) {
      items.push({
        kind: "knowledge",
        id,
        status: "missing-db",
        detail: "promoted knowledge entry on disk but not in the DB",
      });
    }
  }
}

/**
 * Export-tracking checks (Phase 7-11). Two kinds of stale export:
 *  - a runtime row whose `export_status` is `dirty` (export pending) or
 *    `failed` (export errored) — the DB moved ahead of its files.
 *  - an `exported_files` entry whose recorded sha256 no longer matches
 *    the file on disk (a file hand-edited, or lost since export).
 */
function checkExports(
  db: Database.Database,
  paths: { runsDir: string; backlogDir: string },
  harnessRoot: string,
  items: ConsistencyItem[],
): void {
  // `knowledge_entries` is intentionally absent: a promoted entry's `.md`
  // is file-backed (the `.md` is canonical), so the row is a read model
  // that is never `dirty` — `checkKnowledgeEntries` covers it instead.
  const RUNTIME: { table: string; kind: string; idColumn: string }[] = [
    { table: "runs", kind: "export:run", idColumn: "run_id" },
    { table: "backlog_items", kind: "export:backlog", idColumn: "item_id" },
    {
      table: "knowledge_candidates",
      kind: "export:knowledge-candidate",
      idColumn: "candidate_id",
    },
  ];
  for (const t of RUNTIME) {
    const rows = db
      .prepare(
        `SELECT ${t.idColumn} AS id, export_status AS s, last_export_error AS e
         FROM ${t.table} WHERE export_status IN ('dirty', 'failed')`,
      )
      .all() as { id: string; s: string; e: string | null }[];
    for (const r of rows) {
      items.push({
        kind: t.kind,
        id: r.id,
        status: "drift",
        detail:
          r.s === "failed"
            ? `export failed: ${r.e ?? "unknown error"} — run \`db export-files\``
            : "export pending (dirty) — run `db export-files`",
      });
    }
  }

  // exported_files sha256 vs the actual file on disk.
  const files = db
    .prepare(
      `SELECT scope_type AS t, scope_id AS id, relative_path AS p,
              sha256 AS h FROM exported_files`,
    )
    .all() as { t: string; id: string; p: string; h: string }[];
  for (const f of files) {
    const abs = resolveExportedPath(f, paths, harnessRoot);
    if (abs === null) continue;
    if (!existsSync(abs)) {
      items.push({
        kind: `export:${f.t}`,
        id: f.id,
        status: "missing-file",
        detail: `exported file ${f.p} is gone — run \`db export-files\``,
      });
      continue;
    }
    if (sha256(readFileSync(abs)) !== f.h) {
      items.push({
        kind: `export:${f.t}`,
        id: f.id,
        status: "drift",
        detail: `exported file ${f.p} changed since export — run \`db export-files\``,
      });
    }
  }
}

/** Resolve an `exported_files` row to an absolute path by scope type. */
function resolveExportedPath(
  f: { t: string; id: string; p: string },
  paths: { runsDir: string; backlogDir: string },
  harnessRoot: string,
): string | null {
  if (f.t === "run") return join(paths.runsDir, f.id, f.p);
  if (f.t === "backlog_item") return join(paths.backlogDir, f.p);
  if (f.t === "knowledge_entry") return join(harnessRoot, f.p);
  return null;
}

/** Render a ConsistencyReport as a human-readable block. */
export function formatConsistencyReport(r: ConsistencyReport): string {
  const lines = [
    `db consistency: ${r.status}`,
    `  ok: ${r.counts.ok}  drift: ${r.counts.drift}  ` +
      `missing-file: ${r.counts.missingFile}  missing-db: ${r.counts.missingDb}`,
  ];
  for (const it of r.items) {
    if (it.status === "ok") continue;
    lines.push(`  [${it.status}] ${it.kind} ${it.id} — ${it.detail}`);
  }
  lines.push("");
  return lines.join("\n");
}
