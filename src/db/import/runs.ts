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

/** Artifact kind keyed by the run-dir filename. */
const ARTIFACT_KINDS: Record<string, string> = {
  "meta.json": "meta",
  "events.jsonl": "events",
  "codex-prompt.md": "codex-prompt",
  "codex-output.log": "codex-output",
  "codex-error.log": "codex-error",
  "final-diff.patch": "diff",
  "summary.md": "summary",
  "review-request.md": "review-request",
  "review-decision.yaml": "review-decision",
  "resolved-policy.yaml": "resolved-policy",
  "knowledge-candidates.yaml": "knowledge-candidates",
  "context-pack-manifest.yaml": "context-pack-manifest",
};

function contentType(name: string): string {
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".jsonl")) return "application/x-ndjson";
  if (name.endsWith(".yaml")) return "text/yaml";
  if (name.endsWith(".patch")) return "text/x-patch";
  if (name.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

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
    .filter((e) => e.isFile())
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
): void {
  if (!existsSync(runsDir)) return;
  const entries = readdirSync(runsDir, { withFileTypes: true }).filter(
    (e) => e.isDirectory(),
  );

  const existingHash = db.prepare(
    "SELECT source_meta_sha256 AS h FROM runs WHERE run_id = ?",
  );
  const upsertRun = db.prepare(
    `INSERT INTO runs (run_id, repo_id, project_id, repo_path, domain, workflow,
       base_branch, base_sha, run_branch, status, safety_status, reviewer,
       reviewed_at, started_at, finished_at, parent_run_id, root_run_id,
       rerun_attempt, changed_files_count, ignored_untracked_count,
       secret_suspect_count, pr_url, pr_number, prompt_template_name,
       prompt_template_version, knowledge_context_path, imported_from,
       source_meta_sha256, source_meta_mtime_ms, updated_at)
     VALUES (@run_id, @repo_id, @project_id, @repo_path, @domain, @workflow,
       @base_branch, @base_sha, @run_branch, @status, @safety_status, @reviewer,
       @reviewed_at, @started_at, @finished_at, @parent_run_id, @root_run_id,
       @rerun_attempt, @changed_files_count, @ignored_untracked_count,
       @secret_suspect_count, @pr_url, @pr_number, @prompt_template_name,
       @prompt_template_version, @knowledge_context_path, @imported_from,
       @source_meta_sha256, @source_meta_mtime_ms, @updated_at)
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
    const existing = existingHash.get(runId) as { h: string | null } | undefined;
    if (existing && existing.h === fingerprint) {
      counters.runsSkipped += 1;
      continue;
    }

    const tx = db.transaction(() => {
      for (const del of deleteChild) del.run(runId);
      upsertRun.run(
        runRow(runId, meta, fingerprint, statSync(metaPath).mtimeMs),
      );
      importCommandResults(db, runId, meta);
      importEvents(db, runDir, runId);
      importReviewDecision(db, runDir, runId, counters);
      importArtifacts(db, runDir, runId);
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
  runId: string,
  meta: Record<string, unknown>,
  fingerprint: string,
  mtimeMs: number,
): Record<string, unknown> {
  const project = meta.project as { projectId?: string } | undefined;
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
    imported_from: "files",
    source_meta_sha256: fingerprint,
    source_meta_mtime_ms: Math.round(mtimeMs),
    // derived from the source mtime, not wall-clock time, so a re-import
    // (including `--reset`) of an unchanged run yields an identical row.
    updated_at: new Date(mtimeMs).toISOString(),
  };
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
}

function importArtifacts(
  db: Database.Database,
  runDir: string,
  runId: string,
): void {
  const insert = db.prepare(
    `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
       content_type, bytes, sha256, storage, created_at, redacted, secret_suspect)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'file', ?, 0, 0)`,
  );
  for (const file of readdirSync(runDir, { withFileTypes: true })) {
    if (!file.isFile()) continue;
    const name = file.name;
    const abs = join(runDir, name);
    const st = statSync(abs);
    insert.run(
      `${runId}:${name}`,
      runId,
      ARTIFACT_KINDS[name] ?? "other",
      name,
      contentType(name),
      st.size,
      // hash the raw bytes — an artifact may be binary, where a UTF-8
      // decode would corrupt the digest.
      sha256(readFileSync(abs)),
      new Date(st.mtimeMs).toISOString(),
    );
  }
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
}
