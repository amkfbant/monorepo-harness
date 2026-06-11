import type { WorkspaceInspection } from "./agent-workspace.js";

/**
 * Recovery briefing for an agent workspace (W2c). Reconstructs the
 * AUTHORITATIVE state deterministically — the git inspection plus the linked
 * hitch's convergence decision — and overlays the latest advisory checkpoint
 * note for context. The note is never trusted to drive the recommendation: the
 * `nextSteps` are projected from the deterministic signals only (§0 asymmetry).
 */

export interface RecoveryHitchConvergence {
  decision: string;
  reason: string;
  nextActionKind: string;
}

export interface RecoveryHitch {
  hitchId: string;
  /** null when the linked hitch no longer exists (a dangling advisory link). */
  convergence: RecoveryHitchConvergence | null;
}

export interface RecoveryCheckpoint {
  note: string | null;
  createdAt: string;
  createdBy: string;
}

export interface RecoveryBriefingInput {
  inspection: WorkspaceInspection;
  objective: string | null;
  hitch: RecoveryHitch | null;
  latestCheckpoint: RecoveryCheckpoint | null;
}

export interface RecoveryBriefing extends RecoveryBriefingInput {
  /** deterministic, ordered actions derived from git + hitch state only. */
  nextSteps: string[];
}

/** Deterministic next steps from git + hitch signals (never from the note). */
function computeNextSteps(input: RecoveryBriefingInput): string[] {
  const { inspection: insp, hitch } = input;
  const steps: string[] = [];

  if (insp.dirtyFiles.length > 0) {
    steps.push(
      `commit or stash ${insp.dirtyFiles.length} uncommitted file(s)`,
    );
  }
  if (insp.baseResolved && insp.ahead > 0) {
    steps.push(
      `push ${insp.branch} and open/update a PR ` +
        `(${insp.ahead} commit(s) ahead of ${insp.base})`,
    );
  }
  if (insp.baseResolved && insp.behind > 0) {
    steps.push(
      `integrate ${insp.base} into ${insp.branch} (${insp.behind} behind)`,
    );
  }

  if (hitch !== null) {
    if (hitch.convergence === null) {
      steps.push(
        `linked hitch ${hitch.hitchId} no longer exists — re-link or clear it`,
      );
    } else {
      const { decision, reason, nextActionKind } = hitch.convergence;
      switch (decision) {
        case "needs_fix":
          steps.push(`run the coder for hitch ${hitch.hitchId} (needs_fix: ${reason})`);
          break;
        case "needs_classification":
          steps.push(
            `classify unknown-scope findings for hitch ${hitch.hitchId}`,
          );
          break;
        case "continue":
          // `continue` carries an authoritative next action. Handle the known
          // kinds explicitly; an unrecognized kind is fail-closed (escalate)
          // rather than guessing "review".
          if (nextActionKind === "defer_followups") {
            steps.push(
              `defer out-of-scope follow-ups for hitch ${hitch.hitchId} before closing`,
            );
          } else if (nextActionKind === "run_close_check") {
            steps.push(
              `run review / record close-check evidence for hitch ${hitch.hitchId}`,
            );
          } else {
            steps.push(
              `hitch ${hitch.hitchId} needs an unsupported action ` +
                `(continue/${nextActionKind}) — escalate`,
            );
          }
          break;
        case "close_ready":
          steps.push(`close hitch ${hitch.hitchId} and open the PR`);
          break;
        case "closed":
        case "cancel":
          break; // terminal — nothing to do for the hitch
        case "diverging":
        case "budget_exhausted":
        case "escalate":
          steps.push(`escalate hitch ${hitch.hitchId} (${decision}: ${reason})`);
          break;
        default:
          // an unrecognized decision is fail-closed: escalate, never guess.
          steps.push(
            `hitch ${hitch.hitchId} has an unrecognized convergence decision ` +
              `(${decision}) — escalate`,
          );
      }
    }
  }

  if (steps.length === 0) {
    steps.push("workspace is clean and up to date — nothing pending");
  }
  return steps;
}

export function buildRecoveryBriefing(
  input: RecoveryBriefingInput,
): RecoveryBriefing {
  return { ...input, nextSteps: computeNextSteps(input) };
}
