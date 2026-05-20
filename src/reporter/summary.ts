import type { Violation } from "../policy/path-policy-validator.js";
import type { RunMeta } from "../logging/run-log.js";

export interface SummaryInputs {
  runId: string;
  domain: string;
  goal: string;
  status: RunMeta["status"];
  changedPaths: readonly string[];
  violations: readonly Violation[];
  codexExitCode: number;
}

export function buildSummary(i: SummaryInputs): string {
  const lines: string[] = [];
  lines.push(`# Run ${i.runId}`);
  lines.push("");
  lines.push(`- Domain: ${i.domain}`);
  lines.push(`- Goal: ${i.goal}`);
  lines.push(`- Status: ${i.status}`);
  lines.push(`- Codex exit code: ${i.codexExitCode}`);
  lines.push("");
  lines.push("## Changed files");
  if (i.changedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const p of i.changedPaths) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("## Policy violations");
  if (i.violations.length === 0) {
    lines.push("- (none)");
  } else {
    for (const v of i.violations) lines.push(`- ${v.path} (${v.reason})`);
  }
  lines.push("");
  return lines.join("\n");
}
