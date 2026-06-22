// `harness hitch summary` (#84 Stage A) — I/O layer.
//
// Thin command: parse flags → read-only aggregate (summary-aggregate.ts) →
// pure render (reporter/hitch-summary.ts) → stdout or --out file. No DB writes,
// no state transitions. Output (Markdown default, --json for the structured
// projection) is already secret-redacted by the aggregate.

import {
  existsSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Command } from "commander";
import {
  HitchCliError,
  withHitchErrorExit,
  withHitchReadonlyDb,
  type RegisterHitchCommandsOptions,
} from "./helpers.js";
import { buildHitchSummary, type HitchSummaryFilter } from "./summary-aggregate.js";
import { renderHitchSummary } from "../../reporter/hitch-summary.js";

/** Deepest EXISTING ancestor of `p` (walk up), so we can realpath-check
 * containment without requiring the full `--out` path to exist yet. */
function deepestExisting(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return cur; // filesystem root
    cur = parent;
  }
  return cur;
}

/**
 * Resolve `--out` against the CWD and reject anything that escapes it
 * (fail-closed). Three layers: (1) lexical containment; (2) realpath the
 * deepest EXISTING ancestor so a symlinked directory cannot redirect the write
 * outside cwd (a lexical check alone follows no links); (3) refuse to write
 * through ANY symlink target — including a DANGLING one (writeFileSync would
 * follow it out). A not-yet-created plain subdirectory is still allowed.
 * `course export`'s `--out` is unguarded; tightening it is tracked separately
 * (out of #84 scope).
 */
export function resolveSummaryOutPath(out: string): string {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, out);
  const reject = (why: string): never => {
    throw new HitchCliError(`--out ${why} (got ${JSON.stringify(out)})`);
  };
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    reject("must resolve within the current directory");
  }
  const realCwd = realpathSync.native(cwd);
  const realAnchor = realpathSync.native(deepestExisting(resolved));
  if (realAnchor !== realCwd && !realAnchor.startsWith(realCwd + path.sep)) {
    reject("must resolve within the current directory");
  }
  // lstat does NOT follow the link, so this catches a DANGLING symlink too (its
  // target does not exist, so `existsSync` would return false and skip the
  // check, yet `writeFileSync` would still follow it out of cwd). A thrown
  // ENOENT means no entry at all — a fresh file path, which is allowed.
  let finalIsSymlink = false;
  try {
    finalIsSymlink = lstatSync(resolved).isSymbolicLink();
  } catch {
    finalIsSymlink = false;
  }
  if (finalIsSymlink) reject("must not be a symlink");
  return resolved;
}

/**
 * Parse an ISO-8601 instant flag to epoch-ms, fail-closed → HitchCliError
 * (exit 1). `Date.parse` accepts ISO-8601; NaN is a user input error.
 */
function parseInstantFlag(value: string, flag: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new HitchCliError(
      `${flag} must be an ISO-8601 timestamp (got ${JSON.stringify(value)})`,
    );
  }
  return ms;
}

export function registerHitchSummaryCommands(
  hitchCmd: Command,
  opts: RegisterHitchCommandsOptions,
): void {
  hitchCmd
    .command("summary")
    .description("summarize hitch sessions across a course (read-only)")
    .requiredOption("--course <id>", "course id to summarize")
    .option("--since <iso>", "include only hitches whose session updatedAt is at or after this ISO-8601 instant")
    .option("--until <iso>", "include only hitches whose session updatedAt is at or before this ISO-8601 instant")
    .option("--json", "emit the structured (redacted) summary as JSON", false)
    .option(
      "--out <path>",
      "write to a file within the current directory (defaults to stdout)",
    )
    .action((raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const courseId = String(raw.course);
        const sinceMs = typeof raw.since === "string" ? parseInstantFlag(raw.since, "--since") : undefined;
        const untilMs = typeof raw.until === "string" ? parseInstantFlag(raw.until, "--until") : undefined;
        if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) {
          throw new HitchCliError("--since must not be after --until");
        }
        const filter: HitchSummaryFilter = {
          ...(sinceMs !== undefined ? { sinceMs } : {}),
          ...(untilMs !== undefined ? { untilMs } : {}),
        };
        const summary = withHitchReadonlyDb(opts, ({ db }) =>
          buildHitchSummary(db, courseId, filter),
        );
        const text =
          raw.json === true
            ? `${JSON.stringify(summary, null, 2)}\n`
            : `${renderHitchSummary(summary)}\n`;
        if (typeof raw.out === "string" && raw.out !== "") {
          const dest = resolveSummaryOutPath(raw.out);
          writeFileSync(dest, text, "utf8");
          process.stdout.write(`wrote ${raw.out}\n`);
        } else {
          process.stdout.write(text);
        }
      });
    });
}
