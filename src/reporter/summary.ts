import type { Violation } from "../policy/path-policy-validator.js";
import type { RunStatus, SafetyStatus } from "../logging/run-log.js";

export interface SummaryInputs {
  runId: string;
  domain: string;
  goal: string;
  status: RunStatus;
  safetyStatus: SafetyStatus;
  changedPaths: readonly string[];
  untrackedPaths: readonly string[];
  ignoredUntrackedPaths: readonly string[];
  violations: readonly Violation[];
  codexExitCode: number;
  codexTimedOut: boolean;
  codexStdoutTail: string;
  codexStderrTail: string;
  diffCollectionError?: string;
}

function fenced(s: string): string[] {
  return ["```", s.trim() || "(empty)", "```"];
}

export function buildSummary(i: SummaryInputs): string {
  const lines: string[] = [];
  lines.push(`# Run ${i.runId}`);
  lines.push("");
  lines.push(`- Domain: ${i.domain}`);
  lines.push(`- Goal: ${i.goal}`);
  lines.push(`- Status: ${i.status}`);
  lines.push(`- Safety status: ${i.safetyStatus}`);
  lines.push(
    `- Codex exit code: ${i.codexExitCode}${i.codexTimedOut ? " (TIMEOUT)" : ""}`,
  );
  lines.push("");
  if (i.diffCollectionError) {
    lines.push("## Diff collection");
    lines.push(`- failed: ${i.diffCollectionError}`);
    lines.push("- policy validation was skipped");
    lines.push("");
  }
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
  if (i.ignoredUntrackedPaths.length > 0) {
    lines.push("");
    lines.push("## Ignored by ignore_untracked (not validated)");
    for (const p of i.ignoredUntrackedPaths) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("## Policy violations");
  if (i.violations.length === 0) {
    lines.push("- (none)");
  } else {
    for (const v of i.violations) lines.push(`- ${v.path} (${v.reason})`);
  }
  lines.push("");
  lines.push("## Codex output (stdout tail)");
  lines.push(...fenced(i.codexStdoutTail));
  lines.push("");
  lines.push("## Codex output (stderr tail)");
  lines.push(...fenced(i.codexStderrTail));
  lines.push("");
  return lines.join("\n");
}
