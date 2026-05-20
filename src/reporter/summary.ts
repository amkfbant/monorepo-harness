import type { Violation } from "../policy/path-policy-validator.js";
import type { RunStatus } from "../logging/run-log.js";

export interface SummaryInputs {
  runId: string;
  domain: string;
  goal: string;
  status: RunStatus;
  changedPaths: readonly string[];
  untrackedPaths: readonly string[];
  violations: readonly Violation[];
  codexExitCode: number;
  codexTimedOut: boolean;
  /** tail of codex stdout (truncated); empty string when unavailable */
  codexStdoutTail: string;
}

export function buildSummary(i: SummaryInputs): string {
  const lines: string[] = [];
  lines.push(`# Run ${i.runId}`);
  lines.push("");
  lines.push(`- Domain: ${i.domain}`);
  lines.push(`- Goal: ${i.goal}`);
  lines.push(`- Status: ${i.status}`);
  lines.push(
    `- Codex exit code: ${i.codexExitCode}${i.codexTimedOut ? " (TIMEOUT)" : ""}`,
  );
  lines.push("");
  lines.push("## Changed files (tracked)");
  if (i.changedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const p of i.changedPaths) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("## New files (untracked)");
  if (i.untrackedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const p of i.untrackedPaths) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("## Policy violations");
  if (i.violations.length === 0) {
    lines.push("- (none)");
  } else {
    for (const v of i.violations) lines.push(`- ${v.path} (${v.reason})`);
  }
  lines.push("");
  lines.push("## Codex output (tail)");
  lines.push("```");
  lines.push(i.codexStdoutTail.trim() || "(empty)");
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
