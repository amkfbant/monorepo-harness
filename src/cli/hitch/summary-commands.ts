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
import { buildHitchSummary } from "./summary-aggregate.js";
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
 * through an existing symlink target (writeFileSync would follow it out). A
 * not-yet-created subdirectory is still allowed. `course export`'s `--out` is
 * unguarded; tightening it is tracked separately (out of #84 scope).
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
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    reject("must not be a symlink");
  }
  return resolved;
}

export function registerHitchSummaryCommands(
  hitchCmd: Command,
  opts: RegisterHitchCommandsOptions,
): void {
  hitchCmd
    .command("summary")
    .description("summarize hitch sessions across a course (read-only)")
    .requiredOption("--course <id>", "course id to summarize")
    .option("--json", "emit the structured (redacted) summary as JSON", false)
    .option(
      "--out <path>",
      "write to a file within the current directory (defaults to stdout)",
    )
    .action((raw: Record<string, unknown>) => {
      withHitchErrorExit(() => {
        const courseId = String(raw.course);
        const summary = withHitchReadonlyDb(opts, ({ db }) =>
          buildHitchSummary(db, courseId),
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
