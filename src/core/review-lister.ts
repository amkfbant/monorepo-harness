import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RUN_STATUSES,
  SAFETY_STATUSES,
  type RunMeta,
  type RunStatus,
  type SafetyStatus,
} from "../logging/run-log.js";

const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES);
const SAFETY_STATUS_SET: ReadonlySet<string> = new Set(SAFETY_STATUSES);

export interface CommandSummary {
  ok: number;
  total: number;
}

export interface ReviewListEntry {
  runId: string;
  domain: string;
  status: RunStatus;
  safetyStatus: SafetyStatus | null;
  reviewer: string | null;
  reviewedAt: string | null;
  parentRunId: string | null;
  /** ok/total for policy.allowedCommands; null when the run ran no commands */
  commandSummary: CommandSummary | null;
  changedFilesCount: number | null;
  secretSuspectCount: number | null;
  ignoredUntrackedCount: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A run dir whose meta.json is missing / unparseable / inconsistent. */
export interface InvalidRunEntry {
  runId: string;
  error: string;
}

export interface ListResult {
  valid: ReviewListEntry[];
  invalid: InvalidRunEntry[];
}

export interface ListOpts {
  runsDir: string;
  /**
   * Status filter. When omitted, the default review queue
   * (needs_review + changes_requested) is used. When `all` is true this
   * is ignored.
   */
  statuses?: string[];
  /** include runs of every status (overrides the default queue + statuses) */
  all?: boolean;
  /** restrict to a single domain */
  domain?: string;
  /** cap the number of valid entries returned (after sort) */
  limit?: number;
}

const RUN_DIR_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]+$/;

/** The default "review queue": what an operator most often wants to see. */
const DEFAULT_QUEUE: RunStatus[] = ["needs_review", "changes_requested"];

export async function listReviews(opts: ListOpts): Promise<ListResult> {
  // Validate limit at the core boundary — the CLI also checks, but other
  // callers must not silently get "no limit" (NaN/-1) or a truncated
  // float (1.5 → slice keeps 1).
  if (
    opts.limit !== undefined &&
    (!Number.isInteger(opts.limit) || opts.limit < 0)
  ) {
    throw new RangeError(
      `listReviews: limit must be a non-negative integer (got ${String(opts.limit)})`,
    );
  }
  if (!existsSync(opts.runsDir)) return { valid: [], invalid: [] };
  const entries = await readdir(opts.runsDir);
  const runIds = entries.filter((e) => RUN_DIR_RE.test(e));

  const valid: ReviewListEntry[] = [];
  const invalid: InvalidRunEntry[] = [];
  for (const runId of runIds) {
    const loaded = await loadEntry(opts.runsDir, runId);
    if ("error" in loaded) invalid.push(loaded);
    else valid.push(loaded);
  }

  // status filter
  let filtered = valid;
  if (!opts.all) {
    const wanted =
      opts.statuses && opts.statuses.length > 0
        ? new Set(opts.statuses)
        : new Set<string>(DEFAULT_QUEUE);
    filtered = filtered.filter((r) => wanted.has(r.status));
  }
  // domain filter
  if (opts.domain !== undefined) {
    filtered = filtered.filter((r) => r.domain === opts.domain);
  }

  // newest first by startedAt; entries without a valid timestamp sort last
  filtered.sort((a, b) => {
    if (a.startedAt === null && b.startedAt === null) return 0;
    if (a.startedAt === null) return 1;
    if (b.startedAt === null) return -1;
    return b.startedAt.localeCompare(a.startedAt);
  });

  if (opts.limit !== undefined) {
    filtered = filtered.slice(0, opts.limit);
  }

  // invalid runs are sorted by runId for stable output
  invalid.sort((a, b) => a.runId.localeCompare(b.runId));

  return { valid: filtered, invalid };
}

function isCommandResultShape(
  r: unknown,
): r is { exitCode: number; timedOut: boolean } {
  return (
    typeof r === "object" &&
    r !== null &&
    typeof (r as { exitCode?: unknown }).exitCode === "number" &&
    typeof (r as { timedOut?: unknown }).timedOut === "boolean"
  );
}

/**
 * Returns the ok/total summary, or throws if commandResults is present but
 * malformed (so loadEntry can route the run dir to `invalid`).
 */
function commandSummaryOf(meta: RunMeta): CommandSummary | null {
  const results = (meta as { commandResults?: unknown }).commandResults;
  if (results === undefined || results === null) return null;
  if (!Array.isArray(results)) {
    throw new Error("commandResults is not an array");
  }
  if (results.length === 0) return null;
  for (const r of results) {
    if (!isCommandResultShape(r)) {
      throw new Error("commandResults has a malformed entry");
    }
  }
  const ok = results.filter(
    (r) => r.exitCode === 0 && !r.timedOut,
  ).length;
  return { ok, total: results.length };
}

async function loadEntry(
  runsDir: string,
  runId: string,
): Promise<ReviewListEntry | InvalidRunEntry> {
  const metaPath = join(runsDir, runId, "meta.json");
  let raw: string;
  try {
    raw = await readFile(metaPath, "utf8");
  } catch (e) {
    return { runId, error: `meta.json unreadable: ${(e as Error).message}` };
  }
  let meta: RunMeta;
  try {
    meta = JSON.parse(raw) as RunMeta;
  } catch (e) {
    return { runId, error: `meta.json invalid JSON: ${(e as Error).message}` };
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return { runId, error: "meta.json is not an object" };
  }
  // meta.runId must be a string and match the directory name. A
  // non-string / missing / mismatched runId is a structural inconsistency.
  if (typeof meta.runId !== "string" || meta.runId !== runId) {
    return {
      runId,
      error: `meta.runId (${String(meta.runId)}) does not match directory name`,
    };
  }
  // status must be a known RunStatus; an unknown value means meta.json is
  // corrupt or from an incompatible version — route to invalid rather than
  // silently dropping it from the default filter.
  if (
    typeof meta.status !== "string" ||
    !RUN_STATUS_SET.has(meta.status)
  ) {
    return {
      runId,
      error: `meta.json has unknown status: ${String(meta.status)}`,
    };
  }
  // safetyStatus is optional; if present it must be a known value.
  if (
    meta.safetyStatus !== undefined &&
    (typeof meta.safetyStatus !== "string" ||
      !SAFETY_STATUS_SET.has(meta.safetyStatus))
  ) {
    return {
      runId,
      error: `meta.json has unknown safetyStatus: ${String(meta.safetyStatus)}`,
    };
  }

  let commandSummary: CommandSummary | null;
  try {
    commandSummary = commandSummaryOf(meta);
  } catch (e) {
    return { runId, error: `meta.json: ${(e as Error).message}` };
  }

  return {
    runId,
    domain: typeof meta.domain === "string" ? meta.domain : "?",
    status: meta.status,
    safetyStatus: meta.safetyStatus ?? null,
    reviewer: typeof meta.reviewer === "string" ? meta.reviewer : null,
    reviewedAt: typeof meta.reviewedAt === "string" ? meta.reviewedAt : null,
    parentRunId:
      typeof meta.parentRunId === "string" ? meta.parentRunId : null,
    commandSummary,
    changedFilesCount:
      typeof meta.changedFilesCount === "number"
        ? meta.changedFilesCount
        : null,
    secretSuspectCount:
      typeof meta.secretSuspectCount === "number"
        ? meta.secretSuspectCount
        : null,
    ignoredUntrackedCount:
      typeof meta.ignoredUntrackedCount === "number"
        ? meta.ignoredUntrackedCount
        : null,
    startedAt: typeof meta.startedAt === "string" ? meta.startedAt : null,
    finishedAt: typeof meta.finishedAt === "string" ? meta.finishedAt : null,
  };
}

function cell(v: string | number | null): string {
  return v === null ? "-" : String(v);
}

/**
 * Render valid entries as a fixed-column table. Columns grow to the widest
 * cell; runIds are never truncated (operators copy-paste them).
 */
export function formatTable(result: ListResult): string {
  const { valid } = result;
  if (valid.length === 0) return "no runs\n";
  const cols = [
    "runId",
    "domain",
    "status",
    "safety",
    "reviewer",
    "parent",
    "commands",
    "secrets",
    "ignored",
    "startedAt",
  ];
  const rows = valid.map((e) => [
    e.runId,
    cell(e.domain),
    cell(e.status),
    cell(e.safetyStatus),
    e.reviewer ?? "-",
    e.parentRunId ?? "-",
    e.commandSummary
      ? `${e.commandSummary.ok}/${e.commandSummary.total}`
      : "-",
    cell(e.secretSuspectCount),
    cell(e.ignoredUntrackedCount),
    cell(e.startedAt),
  ]);
  const widths = cols.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => r[i]?.length ?? 1)),
  );
  const fmt = (cells: readonly string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!, " ")).join("  ");
  return [fmt(cols), ...rows.map((r) => fmt(r))].join("\n") + "\n";
}

/**
 * Render the full result as JSON. validRuns / invalidRuns are kept
 * separate so automation can branch on structural errors.
 */
export function formatJson(result: ListResult): string {
  return (
    JSON.stringify(
      { validRuns: result.valid, invalidRuns: result.invalid },
      null,
      2,
    ) + "\n"
  );
}
