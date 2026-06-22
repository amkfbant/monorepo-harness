// `harness hitch summary` (#84 Stage A) — I/O layer.
//
// Thin command: parse flags → read-only aggregate (summary-aggregate.ts) →
// pure render (reporter/hitch-summary.ts) → stdout or --out file. No DB writes,
// no state transitions. Output (Markdown default, --json for the structured
// projection) is already secret-redacted by the aggregate.

import { writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { Command } from "commander";
import {
  HitchCliError,
  withHitchErrorExit,
  withHitchRepo,
  type RegisterHitchCommandsOptions,
} from "./helpers.js";
import { buildHitchSummary } from "./summary-aggregate.js";
import { renderHitchSummary } from "../../reporter/hitch-summary.js";

/**
 * Resolve `--out` against the CWD and reject anything that escapes it
 * (fail-closed traversal guard). NOTE: this is a string-prefix check — a
 * symlink inside the CWD pointing outside is NOT caught (the bar is "no casual
 * traversal", matching reporter/secret-scan's philosophy). `course export`'s
 * `--out` is unguarded; tightening it is tracked separately (out of #84 scope).
 */
export function resolveSummaryOutPath(out: string): string {
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, out);
  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new HitchCliError(
      `--out must resolve within the current directory (got ${JSON.stringify(out)})`,
    );
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
        const summary = withHitchRepo(opts, ({ db }) =>
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
