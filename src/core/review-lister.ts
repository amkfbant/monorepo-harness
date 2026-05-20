import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunMeta, RunStatus, SafetyStatus } from "../logging/run-log.js";

export interface ReviewListEntry {
  runId: string;
  domain: string | "?";
  status: RunStatus | "?";
  safetyStatus: SafetyStatus | "?";
  changedFilesCount: number | "?";
  secretSuspectCount: number | "?";
  ignoredUntrackedCount: number | "?";
  startedAt: string | "?";
  /** error if meta.json is unreadable / malformed; entry still listed */
  error?: string;
}

export interface ListOpts {
  runsDir: string;
  /** include statuses other than needs_review */
  all?: boolean;
}

const RUN_DIR_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]+$/;

export async function listReviews(
  opts: ListOpts,
): Promise<ReviewListEntry[]> {
  if (!existsSync(opts.runsDir)) return [];
  const entries = await readdir(opts.runsDir);
  const runIds = entries.filter((e) => RUN_DIR_RE.test(e));

  const results: ReviewListEntry[] = [];
  for (const runId of runIds) {
    results.push(await loadEntry(opts.runsDir, runId));
  }

  const filtered = opts.all
    ? results
    : results.filter((r) => r.status === "needs_review" || r.error);

  // newest first by startedAt; entries without a valid timestamp sort last
  filtered.sort((a, b) => {
    if (a.startedAt === "?" && b.startedAt === "?") return 0;
    if (a.startedAt === "?") return 1;
    if (b.startedAt === "?") return -1;
    return b.startedAt.localeCompare(a.startedAt);
  });

  return filtered;
}

async function loadEntry(
  runsDir: string,
  runId: string,
): Promise<ReviewListEntry> {
  const metaPath = join(runsDir, runId, "meta.json");
  try {
    const raw = await readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as RunMeta;
    return {
      runId,
      domain: typeof meta.domain === "string" ? meta.domain : "?",
      status: meta.status ?? "?",
      safetyStatus: meta.safetyStatus ?? "?",
      changedFilesCount:
        typeof meta.changedFilesCount === "number"
          ? meta.changedFilesCount
          : "?",
      secretSuspectCount:
        typeof meta.secretSuspectCount === "number"
          ? meta.secretSuspectCount
          : "?",
      ignoredUntrackedCount:
        typeof meta.ignoredUntrackedCount === "number"
          ? meta.ignoredUntrackedCount
          : "?",
      startedAt: typeof meta.startedAt === "string" ? meta.startedAt : "?",
    };
  } catch (e) {
    return {
      runId,
      domain: "?",
      status: "?",
      safetyStatus: "?",
      changedFilesCount: "?",
      secretSuspectCount: "?",
      ignoredUntrackedCount: "?",
      startedAt: "?",
      error: (e as Error).message,
    };
  }
}

/**
 * Render the list as a fixed-column table. Width 'auto' grows columns
 * as needed; never truncates runIds (operators need them to copy-paste
 * into the next CLI call).
 */
export function formatTable(entries: readonly ReviewListEntry[]): string {
  if (entries.length === 0) return "no runs\n";
  const cols = [
    "runId",
    "domain",
    "status",
    "safety",
    "changed",
    "secrets",
    "ignored",
    "startedAt",
  ];
  const rows = entries.map((e) =>
    e.error
      ? [e.runId, "?", "?", "?", "?", "?", "?", `unreadable: ${e.error}`]
      : [
          e.runId,
          String(e.domain),
          String(e.status),
          String(e.safetyStatus),
          String(e.changedFilesCount),
          String(e.secretSuspectCount),
          String(e.ignoredUntrackedCount),
          String(e.startedAt),
        ],
  );

  const widths = cols.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => r[i]?.length ?? 1)),
  );
  const fmt = (cells: readonly string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!, " ")).join("  ");
  return [fmt(cols), ...rows.map((r) => fmt(r))].join("\n") + "\n";
}
