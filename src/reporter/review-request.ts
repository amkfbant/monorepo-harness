import type { Violation } from "../policy/path-policy-validator.js";
import type { RunStatus, SafetyStatus } from "../logging/run-log.js";
import type { DiffStat } from "../git/diff.js";
import type { ChangeBudgetReport } from "./summary.js";

export interface ReviewRequestInputs {
  runId: string;
  domain: string;
  goal: string;
  status: RunStatus;
  safetyStatus: SafetyStatus;
  baseSha: string;
  runBranch: string;
  worktreePath: string;
  changedPaths: readonly string[];
  untrackedPaths: readonly string[];
  ignoredUntrackedPaths: readonly string[];
  secretSuspectPaths: readonly string[];
  violations: readonly Violation[];
  diffStat?: DiffStat;
  changeBudget?: ChangeBudgetReport;
  codexExitCode: number;
  codexTimedOut: boolean;
  codexStdoutTail: string;
  codexStderrTail: string;
  codexEventsSummary?: string;
  diffCollectionError?: string;
  finalDiffPath: string;
  untrackedPatchPath?: string;
  summaryPath: string;
  knowledgeCandidatesPath: string;
  reviewDecisionPath: string;
}

function fenced(s: string): string[] {
  return ["```", s.trim() || "(empty)", "```"];
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
      "- Change budget disabled: enforce=false is a fail-open operator override.",
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

export function buildReviewRequest(i: ReviewRequestInputs): string {
  const lines: string[] = [];
  lines.push(`# Review request: ${i.runId}`);
  lines.push("");
  lines.push(`- Status: **${i.status}**`);
  lines.push(`- Safety status: **${i.safetyStatus}**`);
  lines.push(`- Domain: \`${i.domain}\``);
  lines.push(`- Goal: ${i.goal}`);
  lines.push(`- Base commit: \`${i.baseSha}\``);
  lines.push(`- Run branch: \`${i.runBranch}\``);
  lines.push(`- Worktree: \`${i.worktreePath}\``);
  lines.push(
    `- Codex exit code: ${i.codexExitCode}${i.codexTimedOut ? " (TIMEOUT)" : ""}`,
  );
  lines.push("");
  if (i.diffCollectionError) {
    lines.push("## ⚠ Diff collection failed");
    lines.push(`- error: ${i.diffCollectionError}`);
    lines.push("- policy validation was skipped");
    lines.push("- treat artifacts as incomplete");
    lines.push("");
  }
  lines.push("## Changed files (tracked)");
  if (i.changedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const p of i.changedPaths) lines.push(`- \`${p}\``);
  }
  lines.push("");
  lines.push("## New files (untracked)");
  if (i.untrackedPaths.length === 0) {
    lines.push("- (none)");
  } else {
    for (const p of i.untrackedPaths) lines.push(`- \`${p}\``);
  }
  if (i.ignoredUntrackedPaths.length > 0) {
    lines.push("");
    lines.push("## Ignored by ignore_untracked (not validated)");
    for (const p of i.ignoredUntrackedPaths) lines.push(`- \`${p}\``);
  }
  if (i.secretSuspectPaths.length > 0) {
    lines.push("");
    lines.push("## ⚠ Secret-shaped files (content REDACTED in artifacts)");
    lines.push(
      "Filename or content matched a secret heuristic. Inspect the worktree directly to confirm.",
    );
    for (const p of i.secretSuspectPaths) lines.push(`- \`${p}\``);
  }
  lines.push("");
  lines.push("## Policy validation");
  if (i.violations.length === 0) {
    lines.push("- no violations");
  } else {
    for (const v of i.violations) lines.push(`- \`${v.path}\` — ${v.reason}`);
  }
  pushChangeBudget(lines, i.diffStat, i.changeBudget);
  lines.push("");
  lines.push("## Artifacts");
  lines.push(`- diff (tracked): \`${i.finalDiffPath}\``);
  if (i.untrackedPatchPath) {
    lines.push(`- diff (untracked, synthetic): \`${i.untrackedPatchPath}\``);
  }
  lines.push(`- summary: \`${i.summaryPath}\``);
  lines.push(`- knowledge candidates: \`${i.knowledgeCandidatesPath}\``);
  lines.push(`- review decision: \`${i.reviewDecisionPath}\``);
  lines.push("");
  lines.push("## Codex output (stdout tail)");
  lines.push(...fenced(i.codexStdoutTail));
  lines.push("");
  lines.push("## Codex output (stderr tail)");
  lines.push(...fenced(i.codexStderrTail));
  lines.push("");
  if (i.codexEventsSummary !== undefined && i.codexEventsSummary !== "") {
    lines.push("## codex events (tail, redacted)");
    lines.push(i.codexEventsSummary);
    lines.push("");
  }
  lines.push("## Review checklist");
  lines.push("- [ ] Goal addressed by the diff");
  lines.push("- [ ] Changes scoped to writable domain");
  lines.push("- [ ] No unintended side effects (deletions, imports, lockfiles)");
  lines.push("- [ ] Tests adjusted or added as needed");
  lines.push("- [ ] Knowledge candidates reviewed");
  lines.push("");
  lines.push(
    "When done, fill in `review-decision.yaml` (decision + comments).",
  );
  lines.push("");
  return lines.join("\n");
}
