import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import {
  sha256,
  recordImportError,
  clearImportError,
  type ImportCounters,
} from "./common.js";
import { recordRunArtifacts } from "../run-artifacts.js";

/** Child tables cleared before a run is re-imported (replace semantics). */
const RUN_CHILD_TABLES = [
  "run_events",
  "command_results",
  "review_decisions",
  "review_required_changes",
  "run_changed_files",
  "policy_violations",
  "artifacts",
  "run_context_packs",
  "run_context_pack_files",
];

/** Run source files folded into the fingerprint alongside meta.json. */
const RUN_SOURCE_FILES = [
  "events.jsonl",
  "review-decision.yaml",
  "context-pack-manifest.yaml",
];

/**
 * A hash over ALL of a run's source files — `meta.json`, the structured
 * child files, and the artifact listing (name + size + mtime). Stored in
 * `runs.source_meta_sha256`. The import skip and the 6-4 consistency
 * checker both use it, so a change to ANY run file (e.g. `review auto`
 * rewriting `review-decision.yaml` without touching `meta.json`) is
 * detected.
 */
export function runFingerprint(runDir: string, metaRaw: string): string {
  const parts: string[] = [metaRaw];
  for (const name of RUN_SOURCE_FILES) {
    const p = join(runDir, name);
    parts.push(existsSync(p) ? readFileSync(p, "utf8") : "");
  }
  const listing = readdirSync(runDir, { withFileTypes: true })
    // skip dotfiles — the Phase 7 export marker `.exporting` is transient
    // bookkeeping, not run state, and must not move the fingerprint.
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => {
      const st = statSync(join(runDir, e.name));
      return `${e.name}:${st.size}:${Math.round(st.mtimeMs)}`;
    })
    .sort();
  parts.push(listing.join("\n"));
  return sha256(parts.join("\0"));
}

/**
 * Import `runs/<runId>/` into the run tables. A run whose `meta.json`
 * sha256 already matches the stored `source_meta_sha256` is skipped;
 * otherwise its child rows are replaced. A malformed `meta.json` is
 * recorded in `import_errors`.
 *
 * `run_changed_files` / `policy_violations` are NOT populated in Phase
 * 6-3 — they require diff/artifact parsing and are deferred; the
 * dashboard uses the scalar `runs.changed_files_count` instead.
 */
export function importRuns(
  db: Database.Database,
  runsDir: string,
  counters: ImportCounters,
  forceLegacyReconcile = false,
): void {
  if (!existsSync(runsDir)) return;
  const entries = readdirSync(runsDir, { withFileTypes: true }).filter(
    (e) => e.isDirectory(),
  );

  const existingRun = db.prepare(
    "SELECT source_meta_sha256 AS h, source_mode AS mode FROM runs WHERE run_id = ?",
  );
  const upsertRun = db.prepare(
    `INSERT INTO runs (run_id, repo_id, project_id, repo_path, domain, workflow,
       base_branch, base_sha, run_branch, status, safety_status, reviewer,
       reviewed_at, started_at, finished_at, parent_run_id, root_run_id,
       rerun_attempt, changed_files_count, ignored_untracked_count,
       secret_suspect_count, pr_url, pr_number, prompt_template_name,
       prompt_template_version, knowledge_context_path,
       project_profile_revision_id, effective_policy_snapshot_id,
       knowledge_revision_ids_json, imported_from, source_meta_sha256,
       source_meta_mtime_ms, updated_at)
     VALUES (@run_id, @repo_id, @project_id, @repo_path, @domain, @workflow,
       @base_branch, @base_sha, @run_branch, @status, @safety_status, @reviewer,
       @reviewed_at, @started_at, @finished_at, @parent_run_id, @root_run_id,
       @rerun_attempt, @changed_files_count, @ignored_untracked_count,
       @secret_suspect_count, @pr_url, @pr_number, @prompt_template_name,
       @prompt_template_version, @knowledge_context_path,
       @project_profile_revision_id, @effective_policy_snapshot_id,
       @knowledge_revision_ids_json, @imported_from, @source_meta_sha256,
       @source_meta_mtime_ms, @updated_at)
     ON CONFLICT (run_id) DO UPDATE SET
       repo_id = excluded.repo_id, project_id = excluded.project_id,
       repo_path = excluded.repo_path, domain = excluded.domain,
       workflow = excluded.workflow, base_branch = excluded.base_branch,
       base_sha = excluded.base_sha, run_branch = excluded.run_branch,
       status = excluded.status, safety_status = excluded.safety_status,
       reviewer = excluded.reviewer, reviewed_at = excluded.reviewed_at,
       started_at = excluded.started_at, finished_at = excluded.finished_at,
       parent_run_id = excluded.parent_run_id, root_run_id = excluded.root_run_id,
       rerun_attempt = excluded.rerun_attempt,
       changed_files_count = excluded.changed_files_count,
       ignored_untracked_count = excluded.ignored_untracked_count,
       secret_suspect_count = excluded.secret_suspect_count,
       pr_url = excluded.pr_url, pr_number = excluded.pr_number,
       prompt_template_name = excluded.prompt_template_name,
       prompt_template_version = excluded.prompt_template_version,
       knowledge_context_path = excluded.knowledge_context_path,
       project_profile_revision_id = excluded.project_profile_revision_id,
       effective_policy_snapshot_id = excluded.effective_policy_snapshot_id,
       knowledge_revision_ids_json = excluded.knowledge_revision_ids_json,
       source_meta_sha256 = excluded.source_meta_sha256,
       source_meta_mtime_ms = excluded.source_meta_mtime_ms,
       updated_at = excluded.updated_at`,
  );
  const deleteChild = RUN_CHILD_TABLES.map((t) =>
    db.prepare(`DELETE FROM ${t} WHERE run_id = ?`),
  );

  for (const entry of entries) {
    const runId = entry.name;
    const runDir = join(runsDir, runId);
    const metaPath = join(runDir, "meta.json");
    if (!existsSync(metaPath)) continue; // not a run dir

    let meta: Record<string, unknown>;
    let metaRaw: string;
    try {
      metaRaw = readFileSync(metaPath, "utf8");
      const parsed = JSON.parse(metaRaw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("meta.json is not an object");
      }
      meta = parsed as Record<string, unknown>;
    } catch (e) {
      recordImportError(db, counters, metaPath, "run", (e as Error).message);
      continue;
    }

    const fingerprint = runFingerprint(runDir, metaRaw);
    const existing = existingRun.get(runId) as
      | { h: string | null; mode: string | null }
      | undefined;
    const reconcilingDbFirst =
      forceLegacyReconcile && existing?.mode === "db-first";
    // a `db-first` run is DB-canonical (Phase 7). Re-importing it from its
    // own exported files would be redundant at best and destructive at
    // worst — the importer cannot reconstruct `run_changed_files` /
    // `policy_violations`, which a DB-first run populates directly — so
    // it is skipped. Disaster-recovery reconciliation is a Phase 7-11
    // concern (`--force-legacy-reconcile`).
    if (existing && existing.mode === "db-first" && !forceLegacyReconcile) {
      counters.runsSkipped += 1;
      continue;
    }
    // a force-reconcile of a db-first run must always re-import: a
    // db-first row's `source_meta_sha256` is not maintained, so a
    // fingerprint match here would otherwise silently skip the explicit
    // overwrite (P2-a).
    if (existing && existing.h === fingerprint && !reconcilingDbFirst) {
      counters.runsSkipped += 1;
      continue;
    }
    const tx = db.transaction(() => {
      for (const del of deleteChild) del.run(runId);
      upsertRun.run(
        runRow(db, runId, meta, fingerprint, statSync(metaPath).mtimeMs),
      );
      // force-reconciling a db-first run: refresh `meta_json` from the file
      // and bump `db_revision` + mark `export_status = 'dirty'` so the
      // operator sees that the row moved and a re-export is due (P2-1).
      if (reconcilingDbFirst) {
        db.prepare(
          `UPDATE runs
             SET meta_json = ?, db_revision = db_revision + 1,
                 export_status = 'dirty', last_export_error = NULL
           WHERE run_id = ?`,
        ).run(metaRaw, runId);
      }
      importCommandResults(db, runId, meta);
      importEvents(db, runDir, runId);
      importReviewDecision(db, runDir, runId, counters);
      recordRunArtifacts(db, runDir, runId);
      importContextPacks(db, runDir, runId, counters);
    });
    tx();
    clearImportError(db, metaPath);
    counters.runs += 1;
  }
}

/** ---- helpers ----------------------------------------------------- */

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

function runRow(
  db: Database.Database,
  runId: string,
  meta: Record<string, unknown>,
  fingerprint: string,
  mtimeMs: number,
): Record<string, unknown> {
  const project = meta.project as
    | { projectId?: string; profileRevisionId?: unknown }
    | undefined;
  const assetAttribution = meta.assetAttribution as
    | {
        projectProfileRevisionId?: unknown;
        effectivePolicySnapshotId?: unknown;
        knowledgeRevisionIds?: unknown;
      }
    | undefined;
  const projectProfileRevisionId = resolveProjectProfileRevisionId(
    db,
    num(assetAttribution?.projectProfileRevisionId) ??
      num(project?.profileRevisionId),
    project?.projectId,
  );
  const effectivePolicySnapshotId = resolveEffectivePolicySnapshotId(
    db,
    num(assetAttribution?.effectivePolicySnapshotId),
    runId,
  );
  const knowledgeRevisionIds = resolveKnowledgeRevisionIds(
    db,
    Array.isArray(assetAttribution?.knowledgeRevisionIds)
      ? assetAttribution.knowledgeRevisionIds.filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n),
        )
      : undefined,
  );
  const promptTemplate = meta.promptTemplate as
    | { name?: string; version?: number }
    | undefined;
  const knowledgeContext = meta.knowledgeContext as
    | { contextFile?: string }
    | undefined;
  return {
    run_id: runId,
    repo_id: str(meta.repoId) ?? "(unknown)",
    project_id: project?.projectId ?? null,
    repo_path: str(meta.repoPath),
    domain: str(meta.domain) ?? "(unknown)",
    workflow: str(meta.workflow) ?? "domain-coding",
    base_branch: str(meta.baseBranch) ?? "main",
    base_sha: str(meta.baseSha),
    run_branch: str(meta.runBranch),
    status: str(meta.status) ?? "(unknown)",
    safety_status: str(meta.safetyStatus),
    reviewer: str(meta.reviewer),
    reviewed_at: str(meta.reviewedAt),
    started_at: str(meta.startedAt),
    finished_at: str(meta.finishedAt),
    parent_run_id: str(meta.parentRunId),
    root_run_id: str(meta.rootRunId),
    rerun_attempt: num(meta.rerunAttempt),
    changed_files_count: num(meta.changedFilesCount),
    ignored_untracked_count: num(meta.ignoredUntrackedCount),
    secret_suspect_count: num(meta.secretSuspectCount),
    pr_url: str(meta.prUrl),
    pr_number: num(meta.prNumber),
    prompt_template_name: promptTemplate?.name ?? null,
    prompt_template_version: promptTemplate?.version ?? null,
    knowledge_context_path: knowledgeContext?.contextFile ?? null,
    project_profile_revision_id: projectProfileRevisionId,
    effective_policy_snapshot_id: effectivePolicySnapshotId,
    knowledge_revision_ids_json:
      knowledgeRevisionIds !== undefined && knowledgeRevisionIds.length > 0
        ? JSON.stringify(knowledgeRevisionIds)
        : null,
    imported_from: "files",
    source_meta_sha256: fingerprint,
    source_meta_mtime_ms: Math.round(mtimeMs),
    // derived from the source mtime, not wall-clock time, so a re-import
    // (including `--reset`) of an unchanged run yields an identical row.
    updated_at: new Date(mtimeMs).toISOString(),
  };
}

function resolveProjectProfileRevisionId(
  db: Database.Database,
  revisionId: number | null,
  projectId?: string,
): number | null {
  if (revisionId !== null) {
    const row = db
      .prepare(
        `SELECT project_id FROM project_profile_revisions
         WHERE revision_id = ?`,
      )
      .get(revisionId) as { project_id: string } | undefined;
    if (
      row !== undefined &&
      (projectId === undefined || row.project_id === projectId)
    ) {
      return revisionId;
    }
  }
  if (projectId === undefined) return null;
  const current = db
    .prepare(
      `SELECT current_profile_revision_id FROM projects
       WHERE project_id = ?`,
    )
    .get(projectId) as
    | { current_profile_revision_id: number | null }
    | undefined;
  return current?.current_profile_revision_id ?? null;
}

function resolveEffectivePolicySnapshotId(
  db: Database.Database,
  snapshotId: number | null,
  runId: string,
): number | null {
  if (snapshotId === null) return null;
  const row = db
    .prepare(
      `SELECT run_id FROM effective_policy_snapshots
       WHERE snapshot_id = ?`,
    )
    .get(snapshotId) as { run_id: string | null } | undefined;
  if (row === undefined) return null;
  return row.run_id === null || row.run_id === runId ? snapshotId : null;
}

function resolveKnowledgeRevisionIds(
  db: Database.Database,
  revisionIds: number[] | undefined,
): number[] | undefined {
  if (revisionIds === undefined) return undefined;
  const exists = db.prepare(
    `SELECT 1 FROM knowledge_entry_revisions WHERE revision_id = ?`,
  );
  return revisionIds.filter((id) => exists.get(id) !== undefined);
}

function importCommandResults(
  db: Database.Database,
  runId: string,
  meta: Record<string, unknown>,
): void {
  const results = meta.commandResults;
  if (!Array.isArray(results)) return;
  const insert = db.prepare(
    `INSERT INTO command_results (run_id, command_index, command_id, command,
       exit_code, duration_ms, timed_out, stdout_artifact_id, stderr_artifact_id)
     VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL)`,
  );
  results.forEach((r, i) => {
    const c = r as Record<string, unknown>;
    insert.run(
      runId,
      i,
      str(c.command) ?? "(unknown)",
      num(c.exitCode),
      num(c.durationMs),
      c.timedOut === true ? 1 : 0,
    );
  });
}

function importEvents(
  db: Database.Database,
  runDir: string,
  runId: string,
): void {
  const path = join(runDir, "events.jsonl");
  if (!existsSync(path)) return;
  const insert = db.prepare(
    `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json, source_sha256)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const lines = readFileSync(path, "utf8").split("\n");
  let seq = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    let type = "malformed";
    let occurredAt: string | null = null;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      type = str(ev.type) ?? "unknown";
      occurredAt = str(ev.occurredAt) ?? str(ev.at) ?? null;
    } catch {
      // keep type = "malformed"; the raw line is still stored as payload
    }
    insert.run(runId, seq, type, occurredAt, line, sha256(line));
    seq += 1;
  }
}

function importReviewDecision(
  db: Database.Database,
  runDir: string,
  runId: string,
  counters: ImportCounters,
): void {
  const path = join(runDir, "review-decision.yaml");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  let doc: Record<string, unknown>;
  try {
    const parsed = parseYaml(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("review-decision.yaml is not an object");
    }
    doc = parsed as Record<string, unknown>;
  } catch (e) {
    // a malformed decision is non-fatal for the run, but is still recorded
    recordImportError(db, counters, path, "run", (e as Error).message);
    return;
  }
  db.prepare(
    `INSERT INTO review_decisions (run_id, decision, reviewer, summary,
       reviewed_at, source_yaml, source_sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    str(doc.decision) ?? "pending",
    str(doc.reviewer),
    str(doc.summary),
    str(doc.reviewed_at),
    raw,
    sha256(raw),
  );
  const changes = doc.required_changes;
  if (Array.isArray(changes)) {
    const insert = db.prepare(
      `INSERT INTO review_required_changes (run_id, idx, change_text)
       VALUES (?, ?, ?)`,
    );
    changes.forEach((c, i) => {
      if (typeof c === "string") insert.run(runId, i, c);
    });
  }
  // the decision parsed cleanly — clear any stale error from a prior import
  clearImportError(db, path);
}

function importContextPacks(
  db: Database.Database,
  runDir: string,
  runId: string,
  counters: ImportCounters,
): void {
  const path = join(runDir, "context-pack-manifest.yaml");
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  let doc: Record<string, unknown>;
  try {
    const parsed = parseYaml(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("context-pack-manifest.yaml is not an object");
    }
    doc = parsed as Record<string, unknown>;
  } catch (e) {
    recordImportError(db, counters, path, "run", (e as Error).message);
    return;
  }
  const packIds = Array.isArray(doc.packs)
    ? doc.packs.filter((p): p is string => typeof p === "string")
    : [];
  const totalBytes = num(doc.totalBytes);
  const capped = doc.capped === true ? 1 : 0;
  const insertPack = db.prepare(
    `INSERT INTO run_context_packs (run_id, pack_id, total_bytes, capped, manifest_yaml)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (run_id, pack_id) DO NOTHING`,
  );
  for (const packId of packIds) {
    insertPack.run(runId, packId, totalBytes, capped, raw);
  }
  const files = Array.isArray(doc.files) ? doc.files : [];
  const insertFile = db.prepare(
    `INSERT INTO run_context_pack_files (run_id, pack_id, path, bytes, included, reason)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, pack_id, path) DO NOTHING`,
  );
  for (const f of files) {
    const e = f as Record<string, unknown>;
    const packId = str(e.pack);
    const filePath = str(e.path);
    if (packId === null || filePath === null) continue;
    insertFile.run(
      runId,
      packId,
      filePath,
      num(e.bytes),
      e.included === true ? 1 : 0,
      str(e.reason),
    );
  }
  // the manifest parsed cleanly — clear any stale error from a prior import
  clearImportError(db, path);
}
