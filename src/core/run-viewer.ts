import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunMeta } from "../logging/run-log.js";

export class RunViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunViewError";
  }
}

// Same shape as review-lister's RUN_DIR_RE / run-index's run id check —
// a `run-` prefixed segment with no path separators. No length cap, so a
// legitimately long runId (long domain slug) is never rejected here.
const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]+$/;

function assertRunId(runId: string): void {
  if (!RUN_ID_RE.test(runId)) {
    throw new RunViewError(`invalid runId: ${JSON.stringify(runId)}`);
  }
}

async function readMeta(runsDir: string, runId: string): Promise<RunMeta> {
  const metaPath = join(runsDir, runId, "meta.json");
  if (!existsSync(metaPath)) {
    throw new RunViewError(`run ${runId} not found`);
  }
  try {
    return JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
  } catch (e) {
    throw new RunViewError(
      `meta.json for ${runId} is unreadable: ${(e as Error).message}`,
    );
  }
}

/** A one-screen summary of a run. Missing artifacts degrade gracefully. */
export async function renderRunShow(
  runsDir: string,
  runId: string,
): Promise<string> {
  assertRunId(runId);
  const meta = await readMeta(runsDir, runId);
  const runDir = join(runsDir, runId);
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
  if (meta.backlogItemId) {
    lines.push("", "Backlog item:", `  ${meta.backlogItemId}`);
  }

  lines.push("", "Artifacts:");
  for (const a of await artifactList(runDir)) lines.push(`  ${a}`);
  lines.push("");
  return lines.join("\n");
}

/** events.jsonl rendered as an ordered, human-readable timeline. */
export async function renderRunTimeline(
  runsDir: string,
  runId: string,
): Promise<string> {
  assertRunId(runId);
  // run must exist (meta.json), but a missing/empty events.jsonl is fine
  await readMeta(runsDir, runId);
  const eventsPath = join(runsDir, runId, "events.jsonl");
  if (!existsSync(eventsPath)) {
    return `Timeline: ${runId}\n  (no events.jsonl)\n`;
  }
  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf8");
  } catch (e) {
    throw new RunViewError(
      `events.jsonl for ${runId} is unreadable: ${(e as Error).message}`,
    );
  }
  const lines = [`Timeline: ${runId}`];
  let n = 0;
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // a corrupt line must not consume an event ordinal — the ordinal
      // is meant to read as "the Nth event", not "the Nth line".
      skipped += 1;
      continue;
    }
    n += 1;
    lines.push(`  ${String(n).padStart(2, "0")}. ${formatEvent(ev)}`);
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

/** The artifact files present in the run dir. */
export async function renderRunArtifacts(
  runsDir: string,
  runId: string,
): Promise<string> {
  assertRunId(runId);
  await readMeta(runsDir, runId);
  const runDir = join(runsDir, runId);
  const lines = [`Artifacts: ${runId}`];
  for (const a of await artifactList(runDir)) lines.push(`  ${a}`);
  lines.push("");
  return lines.join("\n");
}

/** Sorted list of regular files directly under the run dir. */
async function artifactList(runDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch {
    return ["(run dir unreadable)"];
  }
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  // also surface the commands/ subdir if present
  if (entries.some((e) => e.isDirectory() && e.name === "commands")) {
    files.push("commands/");
  }
  return files.length > 0 ? files : ["(none)"];
}
