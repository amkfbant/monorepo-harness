import { stringify } from "yaml";
import type { Violation } from "../policy/path-policy-validator.js";
import type { RunStatus } from "../logging/run-log.js";

export interface KnowledgeInputs {
  runId: string;
  domain: string;
  status: RunStatus;
  violations: readonly Violation[];
  /** count of redacted secret-shaped files */
  secretSuspectCount: number;
  /** count of untracked files filtered out by policy.ignoreUntracked */
  ignoredUntrackedCount: number;
  /** combined tracked + (kept) untracked changed file count */
  changedFilesCount: number;
  /** codex exit code; used to disambiguate empty-diff from crashed runs */
  codexExitCode: number;
  /** true when the codex timeout fired */
  codexTimedOut: boolean;
}

export type CandidateKind =
  | "policy_violation"
  | "policy_improvement"
  | "domain_rule"
  | "secret_suspect"
  | "ignored_untracked_output"
  | "codex_no_changes";

interface Candidate {
  kind: CandidateKind;
  domain: string;
  title: string;
  content: string;
  evidence: string[];
  confidence: "low" | "medium" | "high";
  status: "candidate";
}

export function buildKnowledgeCandidates(i: KnowledgeInputs): string {
  const candidates: Candidate[] = [];

  if (i.violations.length > 0) {
    candidates.push({
      kind: "policy_violation",
      domain: i.domain,
      title: "Codex wrote outside the domain scope",
      content:
        `${i.violations.length} path(s) violated policy. ` +
        "Review whether the workflow needs a cross-domain step, or whether " +
        "the prompt failed to convey scope.",
      evidence: [i.runId],
      confidence: "high",
      status: "candidate",
    });
  }

  if (i.secretSuspectCount > 0) {
    candidates.push({
      kind: "secret_suspect",
      domain: i.domain,
      title: "Codex created files matching secret heuristic",
      content:
        `${i.secretSuspectCount} untracked file(s) had filename or content ` +
        "matching a secret pattern. Confirm the worktree directly; the " +
        "artifact patch redacted their bytes.",
      evidence: [i.runId],
      confidence: "medium",
      status: "candidate",
    });
  }

  if (i.ignoredUntrackedCount > 0) {
    candidates.push({
      kind: "ignored_untracked_output",
      domain: i.domain,
      title: "Codex produced ignored output (build artifacts / caches)",
      content:
        `${i.ignoredUntrackedCount} untracked file(s) were filtered by ` +
        "policy.ignoreUntracked. If these are unintended (e.g. codex ran a " +
        "build), consider tightening the goal prompt.",
      evidence: [i.runId],
      confidence: "low",
      status: "candidate",
    });
  }

  // No-change run: codex exited cleanly with zero diff. Often indicates
  // codex self-refused due to a prompt/policy conflict (see scenario 3 in
  // docs/mvp-validation-report.md). Skip when codex itself failed.
  if (
    i.codexExitCode === 0 &&
    !i.codexTimedOut &&
    i.changedFilesCount === 0 &&
    i.violations.length === 0
  ) {
    candidates.push({
      kind: "codex_no_changes",
      domain: i.domain,
      title: "Codex finished cleanly without changing any files",
      content:
        "Possible causes: codex self-refused (prompt conflicted with policy " +
        "guidance), the task was already satisfied, or the prompt was " +
        "ambiguous. Inspect codex-output.log for the rationale.",
      evidence: [i.runId],
      confidence: "low",
      status: "candidate",
    });
  }

  return stringify({ candidates });
}
