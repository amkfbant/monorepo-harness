import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunMeta } from "../logging/run-log.js";
import { findBacklogItemForRun } from "./backlog.js";
import {
  readRunMetaFromDb,
  readRunEventsFromDb,
  listRunArtifactsFromDb,
} from "./run-db-reader.js";

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
): Promise<RunMeta> {
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
): Promise<string> {
  assertRunId(runId);
  const meta = await readMeta(runsDir, runId, dbPath);
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

  lines.push("", "Artifacts:");
  for (const a of await artifactLines(runsDir, runId, dbPath)) {
    lines.push(`  ${a}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** events.jsonl rendered as an ordered, human-readable timeline. */
export async function renderRunTimeline(
  runsDir: string,
  runId: string,
  dbPath?: string,
): Promise<string> {
  assertRunId(runId);
  // run must exist, but a missing/empty event stream is fine
  await readMeta(runsDir, runId, dbPath);
  const eventsPath = join(runsDir, runId, "events.jsonl");
  const lines = [`Timeline: ${runId}`];
  let n = 0;
  let skipped = 0;
  const push = (ev: Record<string, unknown>): void => {
    n += 1;
    lines.push(`  ${String(n).padStart(2, "0")}. ${formatEvent(ev)}`);
  };

  if (existsSync(eventsPath)) {
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
  } else {
    // no exported events.jsonl — fall back to the DB-stored events.
    const fromDb =
      dbPath !== undefined ? readRunEventsFromDb(dbPath, runId) : null;
    if (fromDb === null) return `Timeline: ${runId}\n  (no events.jsonl)\n`;
    for (const ev of fromDb) push(ev);
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
): Promise<string> {
  assertRunId(runId);
  await readMeta(runsDir, runId, dbPath);
  const lines = [`Artifacts: ${runId}`];
  for (const a of await artifactLines(runsDir, runId, dbPath)) {
    lines.push(`  ${a}`);
  }
  lines.push("");
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
): Promise<string[]> {
  const runDir = join(runsDir, runId);
  if (existsSync(runDir)) return artifactList(runDir);
  if (dbPath !== undefined) {
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
