import type { Violation } from "../policy/path-policy-validator.js";
import type {
  PolicySalvageInfo,
  RunStatus,
  SafetyStatus,
} from "../logging/run-log.js";
import type { DiffStat } from "../git/diff.js";
import type { ChangeBudget } from "../policy/schema.js";
import type {
  DiffBudgetBreach,
  DiffBudgetValidationResult,
} from "../policy/diff-budget-validator.js";
import { redactSecretLines } from "./secret-scan.js";
import { pushPolicySalvageSection } from "./policy-salvage.js";

export interface ChangeBudgetReport {
  status: DiffBudgetValidationResult["status"];
  disabled: boolean;
  stage: "post-codex" | "post-command";
  budget: ChangeBudget;
  breaches: readonly DiffBudgetBreach[];
}

export interface SummaryInputs {
  runId: string;
  domain: string;
  goal: string;
  status: RunStatus;
  safetyStatus: SafetyStatus;
  changedPaths: readonly string[];
  untrackedPaths: readonly string[];
  ignoredUntrackedPaths: readonly string[];
  secretSuspectPaths: readonly string[];
  violations: readonly Violation[];
  diffStat?: DiffStat;
  changeBudget?: ChangeBudgetReport;
  codexExitCode: number;
  codexTimedOut: boolean;
  commandResults?: readonly CommandReport[];
  codexStdoutTail: string;
  codexStderrTail: string;
  codexEventsSummary?: string;
  diffCollectionError?: string;
  policySalvage?: PolicySalvageInfo;
}

interface CommandReport {
  command: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

function fencedRedactedTail(s: string): string[] {
  return ["```", redactSecretLines(s).trim() || "(empty)", "```"];
}

function pushChangeBudget(
  lines: string[],
  stat: DiffStat | undefined,
  report: ChangeBudgetReport | undefined,
): void {
  if (stat === undefined && report === undefined) return;
  lines.push("");
  lines.push("## Change budget");
  if (stat !== undefined) {
    lines.push(
      `- Stat: filesChanged=${stat.filesChanged}, insertions=${stat.insertions}, deletions=${stat.deletions}, deletedFiles=${stat.deletedFiles}`,
    );
  }
  if (report === undefined) {
    lines.push("- Status: not evaluated");
    return;
  }
  lines.push(`- Stage: ${report.stage}`);
  lines.push(`- Status: ${report.status}`);
  lines.push(
    `- Limits: deleted_lines<=${report.budget.maxDeletedLines}, total_changed_lines<=${report.budget.maxTotalChangedLines}, deleted_files<=${report.budget.maxDeletedFiles}, changed_files<=${report.budget.maxChangedFiles}`,
  );
  if (report.disabled) {
    lines.push(
      report.breaches.length === 0
        ? "- Change budget enforce=false: pre-review budget gate disabled; evaluation retained for audit."
        : "- Change budget enforce=false: budget breach allowed to proceed to review; inspect the breached metrics below.",
    );
  }
  if (report.breaches.length === 0) {
    lines.push("- Breaches: (none)");
  } else {
    lines.push("- Breaches:");
    for (const b of report.breaches) {
      lines.push(`  - ${b.metric}: actual ${b.actual} > limit ${b.limit}`);
    }
  }
}

function pushCommandResults(
  lines: string[],
  results: readonly CommandReport[] | undefined,
): void {
  if (results === undefined || results.length === 0) return;
  const ok = results.filter((r) => r.exitCode === 0 && !r.timedOut).length;
  lines.push("");
  lines.push("## Commands");
  lines.push(`- Result: ${ok}/${results.length} ok`);
  for (const r of results) {
    const status = r.timedOut ? "timeout" : `exit ${r.exitCode}`;
    lines.push(
      `- ${redactSecretLines(r.command)}: ${status}, ${Math.round(r.durationMs)}ms`,
    );
  }
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
  if (i.secretSuspectPaths.length > 0) {
    lines.push("");
    lines.push("## Secret-shaped files (content REDACTED in artifacts)");
    for (const p of i.secretSuspectPaths) lines.push(`- ${p}`);
  }
  lines.push("");
  lines.push("## Policy violations");
  if (i.violations.length === 0) {
    lines.push("- (none)");
  } else {
    for (const v of i.violations) lines.push(`- ${v.path} (${v.reason})`);
  }
  pushPolicySalvageSection(lines, i.policySalvage);
  pushChangeBudget(lines, i.diffStat, i.changeBudget);
  pushCommandResults(lines, i.commandResults);
  lines.push("");
  lines.push("## Codex output (stdout tail)");
  lines.push(...fencedRedactedTail(i.codexStdoutTail));
  lines.push("");
  lines.push("## Codex output (stderr tail)");
  lines.push(...fencedRedactedTail(i.codexStderrTail));
  lines.push("");
  if (i.codexEventsSummary !== undefined && i.codexEventsSummary !== "") {
    lines.push("## codex events (tail, redacted)");
    lines.push(i.codexEventsSummary);
    lines.push("");
  }
  return lines.join("\n");
}
