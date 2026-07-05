import type {
  HitchOrchestrationResult,
  OrchestrationProgressEvent,
} from "../../hitch/orchestrator-types.js";

export function formatHitchOrchestrateResultLine(
  hitchId: string,
  result: HitchOrchestrationResult,
  link: { linked: boolean; agent?: string },
): string {
  const last = result.steps.at(-1);
  return (
    `hitch=${hitchId} outcome=${result.outcome}` +
    ` decision=${result.finalDecision || "unknown"}` +
    ` steps=${result.steps.length}` +
    (last !== undefined ? ` last_action=${last.action}` : "") +
    (last !== undefined ? ` last_detail=${quoteCliField(last.detail)}` : "") +
    (result.draft !== undefined ? ` draft=${result.draft}` : "") +
    (result.prUrl !== undefined ? ` pr=${result.prUrl}` : "") +
    (result.escalateReason !== undefined
      ? ` escalate=${result.escalateReason}`
      : "") +
    (link.linked ? ` workspace=${link.agent}` : "") +
    ` next_action=${quoteCliField(recommendedHitchOrchestrateNextAction(hitchId, result))}`
  );
}

export function formatHitchOrchestrateProgressLine(
  event: OrchestrationProgressEvent,
): string {
  const base =
    `hitch ${event.hitchId}: step ${event.step}` +
    ` decision=${event.decision}` +
    ` action=${event.action}`;
  if (event.kind === "step_started") return `${base} started`;
  if (event.kind === "step_heartbeat") {
    return `${base} still-running elapsed=${formatElapsed(event.elapsedMs)}`;
  }
  if (event.kind === "step_completed") {
    return `${base} completed detail=${quoteCliField(event.detail)} elapsed=${formatElapsed(event.elapsedMs)}`;
  }
  return `${base} failed detail=${quoteCliField(event.detail)} elapsed=${formatElapsed(event.elapsedMs)}`;
}

function quoteCliField(value: string): string {
  return JSON.stringify(value);
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.ceil(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m${rest}s`;
}

function recommendedHitchOrchestrateNextAction(
  hitchId: string,
  result: HitchOrchestrationResult,
): string {
  switch (result.outcome) {
    case "closed":
    case "cancelled":
    case "merged":
      return "none";
    case "pr_created":
      return "wait for PR review/CI, then run hitch await-merge or merge manually";
    case "push_retry_pending":
      return `re-run hitch orchestrate ${hitchId}`;
    case "close_ready":
      return `run hitch orchestrate ${hitchId} to publish a PR`;
    case "waiting":
      return `attach required evidence, then run hitch check-convergence ${hitchId}`;
    case "escalated":
      return `inspect hitch status ${hitchId} and resolve escalation`;
    case "max_steps_exhausted":
      return `re-run hitch orchestrate ${hitchId} if the latest step made progress`;
  }
}
