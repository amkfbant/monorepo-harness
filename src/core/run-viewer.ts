import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunMeta } from "../logging/run-log.js";
import { findBacklogItemForRun } from "./backlog.js";
import {
  readRunMetaFromDb,
  readRunEventsFromDb,
  listRunArtifactsFromDb,
  readRunSourceModeFromDb,
} from "./run-db-reader.js";

/**
 * Phase 10-4: source mode selector for `harness run show / artifacts /
 * timeline`. Phase 9 introduced an implicit DB-first preference based on
 * `export_status`; Phase 10-4 exposes it as an explicit `--source` flag.
 *
 * - `auto` (default): db-first runs read from the DB whenever
 *   `export_status != 'synced'`; otherwise file-first as Phase 6-9.
 * - `db`: DB is the only source. A `legacy-file` run is rejected with
 *   `RunViewError`.
 * - `files`: file dir is the only source. Useful for debugging stale
 *   scratch dirs or comparing exported files with the DB.
 */
export type RunViewSource = "auto" | "db" | "files";

/**
 * Phase 9 post-close (second review) P1-1 fix — decide whether to read
 * the DB before the file for this run. A `db-first` run whose
 * `export_status` is NOT `synced` means the file dir, if it exists, may
 * be a stale scratch materialization (review auto) or a leftover from a
 * prior export. The DB is canonical in that case, so the viewer prefers
 * it. `synced` runs (the operator opted in to compatibility export) keep
 * the existing file-first behavior.
 *
 * Phase 10-4: respects `source` — `db` always returns true (DB-only),
 * `files` always returns false (file-only), `auto` keeps the Phase 9
 * heuristic.
 */
function shouldPreferDbForRun(
  dbPath: string | undefined,
  runId: string,
  source: RunViewSource = "auto",
): boolean {
  if (source === "files") return false;
  if (source === "db") return dbPath !== undefined;
  if (dbPath === undefined) return false;
  const info = readRunSourceModeFromDb(dbPath, runId);
  if (info === null) return false;
  // Phase 10-4 post-review P1 — design §3.D D1 says `auto + db-first`
  // always reads the DB and ignores runDir, regardless of export_status.
  // Phase 9 used `export_status !== 'synced'` as the gate; Phase 10
  // tightens this to "every db-first run is DB-canonical in auto mode".
  return info.sourceMode === "db-first";
}

/**
 * Phase 10-4: warning footer rendered for an `auto` view when the run's
 * `export_status` is in a non-synced state. Returns an empty string if
 * nothing to surface (or if `source` is explicit `db`/`files`).
 */
function exportStatusWarning(
  dbPath: string | undefined,
  runId: string,
  source: RunViewSource,
): string {
  if (source !== "auto" || dbPath === undefined) return "";
  const info = readRunSourceModeFromDb(dbPath, runId);
  if (info === null || info.sourceMode !== "db-first") return "";
  if (info.exportStatus === "synced") return "";
  if (info.exportStatus === undefined || info.exportStatus === null) return "";
  return (
    `\nNote: file export status = ${info.exportStatus}. ` +
    `Files in runs/${runId}/ may be stale.\n` +
    `      Use --source files to inspect files explicitly, or ` +
    `\`harness db export-files --run ${runId}\` to refresh the export.\n`
  );
}

/**
 * Phase 10-4: reject a `--source db` view on a `legacy-file` run.
 * Legacy-file runs do not live in the DB-canonical world; the operator
 * must drop `--source db` (or run `db migrate-legacy`).
 */
function assertSourceCompat(
  dbPath: string | undefined,
  runId: string,
  source: RunViewSource,
): void {
  if (source !== "db" || dbPath === undefined) return;
  const info = readRunSourceModeFromDb(dbPath, runId);
  if (info !== null && info.sourceMode === "legacy-file") {
    throw new RunViewError(
      `run ${runId}: --source db is not supported for legacy-file runs. ` +
        "Use --source files, or run `harness db migrate-legacy` first.",
    );
  }
}

export class RunViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunViewError";
  }
}

// Same shape as review-lister's RUN_DIR_RE — a `run-` prefixed segment
// with no path separators. No length cap, so a
// legitimately long runId (long domain slug) is never rejected here.
const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]+$/;

function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new RunViewError(`invalid runId: ${JSON.stringify(runId)}`);
  }
}

/**
 * Read a run's `meta.json`. The exported file is canonical when present;
 * with file export OFF (or after `cleanup` removed the run dir) it falls
 * back to the db-first run's `meta_json` so a DB-only run still renders.
 */
async function readMeta(
  runsDir: string,
  runId: string,
  dbPath?: string,
  source: RunViewSource = "auto",
): Promise<RunMeta> {
  assertSourceCompat(dbPath, runId, source);
  // Phase 9 post-close P1-1 / Phase 10-4 — db-first run with
  // export_status != synced (or explicit --source db): DB is canonical,
  // prefer it over a (possibly stale scratch) meta.json.
  if (shouldPreferDbForRun(dbPath, runId, source) && dbPath !== undefined) {
    const fromDb = readRunMetaFromDb(dbPath, runId);
    if (fromDb !== null) return fromDb;
    if (source === "db") {
      throw new RunViewError(
        `run ${runId} not found in DB (--source db)`,
      );
    }
  }
  if (source !== "db") {
    const metaPath = join(runsDir, runId, "meta.json");
    if (existsSync(metaPath)) {
      try {
        return JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
      } catch (e) {
        throw new RunViewError(
          `meta.json for ${runId} is unreadable: ${(e as Error).message}`,
        );
      }
    }
    if (source === "files") {
      // Phase 10-4 post-review P2 #2: distinguish "run dir missing" from
      // "run does not exist anywhere" for --source files debug usage.
      throw new RunViewError(
        `run ${runId}: run dir not found (--source files). ` +
          "The DB may still have this run — drop --source or use --source db.",
      );
    }
  }
  // At this point: source is 'auto' (file lookup missed) or 'db' (top
  // branch missed). Both should fall back to DB if available.
  if (dbPath !== undefined) {
    const fromDb = readRunMetaFromDb(dbPath, runId);
    if (fromDb !== null) return fromDb;
  }
  throw new RunViewError(`run ${runId} not found`);
}

/**
 * A one-screen summary of a run. Missing artifacts degrade gracefully.
 * When `backlogDir` is given, the run's backlog item (if any) is derived
 * by scanning the backlog — the link lives only on the backlog side.
 * `dbPath` enables the DB fallback for a run with no exported files.
 */
export async function renderRunShow(
  runsDir: string,
  runId: string,
  backlogDir?: string,
  dbPath?: string,
  source: RunViewSource = "auto",
): Promise<string> {
  assertRunId(runId);
  const meta = await readMeta(runsDir, runId, dbPath, source);
  const lines: string[] = [
    `Run: ${runId}`,
    `Domain: ${meta.domain ?? "?"}`,
    `Status: ${meta.status ?? "?"}`,
    `Safety: ${meta.safetyStatus ?? "?"}`,
  ];
  if (meta.reviewer) lines.push(`Reviewer: ${meta.reviewer}`);
  if (meta.parentRunId) lines.push(`Parent: ${meta.parentRunId}`);
  if (meta.rootRunId) lines.push(`Root: ${meta.rootRunId}`);
  if (typeof meta.rerunAttempt === "number") {
    lines.push(`Attempt: ${meta.rerunAttempt}`);
  }
  lines.push(
    "",
    "Files:",
    `  changed: ${meta.changedFilesCount ?? 0}`,
    `  secret suspects: ${meta.secretSuspectCount ?? 0}`,
    `  ignored untracked: ${meta.ignoredUntrackedCount ?? 0}`,
  );

  const cmds = Array.isArray(meta.commandResults) ? meta.commandResults : [];
  lines.push("", "Commands:");
  if (cmds.length === 0) {
    lines.push("  (none)");
  } else {
    for (const c of cmds) {
      const ok = c.exitCode === 0 && !c.timedOut;
      const state = c.timedOut ? "timeout" : ok ? "ok" : `exit ${c.exitCode}`;
      lines.push(`  ${c.command}: ${state} ${(c.durationMs / 1000).toFixed(1)}s`);
    }
  }

  // a run is "reviewed" only once review process stamped reviewedAt.
  // before that, meta.status (needs_review / failed-*) is NOT a decision.
  lines.push("", "Review:");
  if (meta.reviewedAt) {
    lines.push(`  decision: ${meta.status ?? "?"}`);
    lines.push(`  reviewer: ${meta.reviewer ?? "(none)"}`);
    lines.push(`  reviewedAt: ${meta.reviewedAt}`);
  } else {
    lines.push("  (not reviewed)");
  }

  if (meta.prUrl) {
    lines.push("", "PR:", `  ${meta.prUrl}`);
  }
  if (backlogDir !== undefined) {
    const itemId = await findBacklogItemForRun(backlogDir, runId);
    if (itemId) lines.push("", "Backlog item:", `  ${itemId}`);
  }

  const attribution = meta.assetAttribution;
  if (
    attribution !== undefined ||
    meta.project?.profileRevisionId !== undefined ||
    meta.project?.profileSource !== undefined
  ) {
    lines.push("", "Asset attribution:");
    if (meta.project?.profileSource !== undefined) {
      lines.push(`  profileSource: ${meta.project.profileSource}`);
    }
    const profileRevision =
      attribution?.projectProfileRevisionId ?? meta.project?.profileRevisionId;
    if (profileRevision !== undefined) {
      lines.push(`  projectProfileRevisionId: ${profileRevision}`);
    }
    if (attribution?.effectivePolicySnapshotId !== undefined) {
      lines.push(
        `  effectivePolicySnapshotId: ${attribution.effectivePolicySnapshotId}`,
      );
    }
    if (
      attribution?.knowledgeRevisionIds !== undefined &&
      attribution.knowledgeRevisionIds.length > 0
    ) {
      lines.push(
        `  knowledgeRevisionIds: ${attribution.knowledgeRevisionIds.join(", ")}`,
      );
    }
  }

  lines.push("", "Artifacts:");
  for (const a of await artifactLines(runsDir, runId, dbPath, source)) {
    lines.push(`  ${a}`);
  }
  lines.push("");
  const warn = exportStatusWarning(dbPath, runId, source);
  if (warn !== "") lines.push(warn);
  return lines.join("\n");
}

/** events.jsonl rendered as an ordered, human-readable timeline. */
export async function renderRunTimeline(
  runsDir: string,
  runId: string,
  dbPath?: string,
  source: RunViewSource = "auto",
): Promise<string> {
  assertRunId(runId);
  // run must exist, but a missing/empty event stream is fine
  await readMeta(runsDir, runId, dbPath, source);
  const preferDb = shouldPreferDbForRun(dbPath, runId, source);
  const eventsPath = join(runsDir, runId, "events.jsonl");
  const lines = [`Timeline: ${runId}`];
  let n = 0;
  let skipped = 0;
  const push = (ev: Record<string, unknown>): void => {
    n += 1;
    lines.push(`  ${String(n).padStart(2, "0")}. ${formatEvent(ev)}`);
  };

  if (source !== "db" && !preferDb && existsSync(eventsPath)) {
    let raw: string;
    try {
      raw = await readFile(eventsPath, "utf8");
    } catch (e) {
      throw new RunViewError(
        `events.jsonl for ${runId} is unreadable: ${(e as Error).message}`,
      );
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // a corrupt line must not consume an event ordinal — the ordinal
        // is meant to read as "the Nth event", not "the Nth line".
        skipped += 1;
      }
    }
  } else if (source !== "files") {
    // no exported events.jsonl — fall back to the DB-stored events.
    const fromDb =
      dbPath !== undefined ? readRunEventsFromDb(dbPath, runId) : null;
    if (fromDb === null) return `Timeline: ${runId}\n  (no events.jsonl)\n`;
    for (const ev of fromDb) push(ev);
  } else {
    return `Timeline: ${runId}\n  (no events.jsonl)\n`;
  }

  if (n === 0) lines.push("  (no events)");
  if (skipped > 0) lines.push(`  (skipped ${skipped} unparseable line(s))`);
  lines.push("");
  return lines.join("\n");
}

function formatEvent(ev: Record<string, unknown>): string {
  const type = typeof ev.type === "string" ? ev.type : "(unknown)";
  // surface the few fields most worth seeing inline, per event type
  const extras: string[] = [];
  for (const k of [
    "stage",
    "status",
    "decision",
    "exitCode",
    "timedOut",
    "allPassed",
    "count",
    "prNumber",
    "reviewer",
    "error",
    "reason",
  ]) {
    if (ev[k] !== undefined) extras.push(`${k}=${JSON.stringify(ev[k])}`);
  }
  // a timestamp if the event carries one (most do not)
  const ts =
    typeof ev.createdAt === "string"
      ? ev.createdAt
      : typeof ev.decidedAt === "string"
        ? ev.decidedAt
        : typeof ev.failedAt === "string"
          ? ev.failedAt
          : undefined;
  return `${type}${extras.length > 0 ? ` ${extras.join(" ")}` : ""}${ts ? ` @ ${ts}` : ""}`;
}

/** The artifact files present in the run dir (or the DB manifest). */
export async function renderRunArtifacts(
  runsDir: string,
  runId: string,
  dbPath?: string,
  source: RunViewSource = "auto",
): Promise<string> {
  assertRunId(runId);
  await readMeta(runsDir, runId, dbPath, source);
  const lines = [`Artifacts: ${runId}`];
  for (const a of await artifactLines(runsDir, runId, dbPath, source)) {
    lines.push(`  ${a}`);
  }
  lines.push("");
  const warn = exportStatusWarning(dbPath, runId, source);
  if (warn !== "") lines.push(warn);
  return lines.join("\n");
}

/**
 * Artifact listing for a run: the run dir's files when it exists, else the
 * `artifacts` manifest from the DB so a DB-only / cleaned run still lists.
 */
async function artifactLines(
  runsDir: string,
  runId: string,
  dbPath?: string,
  source: RunViewSource = "auto",
): Promise<string[]> {
  // Phase 9 post-close P1-1 / Phase 10-4 — DB is canonical for an
  // unsynced db-first run or when --source db is explicit.
  if (shouldPreferDbForRun(dbPath, runId, source) && dbPath !== undefined) {
    const fromDb = listRunArtifactsFromDb(dbPath, runId);
    if (fromDb !== null) return fromDb.length > 0 ? fromDb : ["(none)"];
  }
  if (source !== "db") {
    const runDir = join(runsDir, runId);
    if (existsSync(runDir)) return artifactList(runDir);
  }
  if (source !== "files" && dbPath !== undefined) {
    const fromDb = listRunArtifactsFromDb(dbPath, runId);
    if (fromDb !== null) return fromDb.length > 0 ? fromDb : ["(none)"];
  }
  return ["(none)"];
}

/**
 * Artifact listing for a run dir: regular files directly under it, plus
 * each subdirectory (commands/ review-evaluations/ …) with an entry
 * count so deeper artifacts are at least discoverable.
 */
async function artifactList(runDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch {
    return ["(run dir unreadable)"];
  }
  const out = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const d of dirs) {
    let count = 0;
    try {
      count = (await readdir(join(runDir, d))).length;
    } catch {
      // unreadable subdir — still surface its name
    }
    out.push(`${d}/ (${count} ${count === 1 ? "entry" : "entries"})`);
  }
  return out.length > 0 ? out : ["(none)"];
}
