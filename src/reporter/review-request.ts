import type { Violation } from "../policy/path-policy-validator.js";
import type { RunStatus } from "../logging/run-log.js";

export interface ReviewRequestInputs {
  runId: string;
  domain: string;
  goal: string;
  status: RunStatus;
  baseSha: string;
  runBranch: string;
  worktreePath: string;
  changedPaths: readonly string[];
  untrackedPaths: readonly string[];
  violations: readonly Violation[];
  codexExitCode: number;
  codexTimedOut: boolean;
  codexStdoutTail: string;
  finalDiffPath: string;
  summaryPath: string;
  knowledgeCandidatesPath: string;
  reviewDecisionPath: string;
}

export function buildReviewRequest(i: ReviewRequestInputs): string {
  const lines: string[] = [];
  lines.push(`# Review request: ${i.runId}`);
  lines.push("");
  lines.push(`- Status: **${i.status}**`);
  lines.push(`- Domain: \`${i.domain}\``);
  lines.push(`- Goal: ${i.goal}`);
  lines.push(`- Base commit: \`${i.baseSha}\``);
  lines.push(`- Run branch: \`${i.runBranch}\``);
  lines.push(`- Worktree: \`${i.worktreePath}\``);
  lines.push(
    `- Codex exit code: ${i.codexExitCode}${i.codexTimedOut ? " (TIMEOUT)" : ""}`,
  );
  lines.push("");
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
  lines.push("");
  lines.push("## Policy validation");
  if (i.violations.length === 0) {
    lines.push("- no violations");
  } else {
    for (const v of i.violations) lines.push(`- \`${v.path}\` — ${v.reason}`);
  }
  lines.push("");
  lines.push("## Artifacts");
  lines.push(`- diff: \`${i.finalDiffPath}\``);
  lines.push(`- summary: \`${i.summaryPath}\``);
  lines.push(`- knowledge candidates: \`${i.knowledgeCandidatesPath}\``);
  lines.push(`- review decision: \`${i.reviewDecisionPath}\``);
  lines.push("");
  lines.push("## Codex output (tail)");
  lines.push("```");
  lines.push(i.codexStdoutTail.trim() || "(empty)");
  lines.push("```");
  lines.push("");
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
