// Agent backend selection (#191) — chooses the codex or claude runner for a
// role and resolves the advisory claude model. Both runners satisfy
// CodexExecRunner, so every consumer downstream is backend-agnostic; only the
// telemetry/redaction dispatch in workflow-runner-inner needs to know which
// backend ran, and it reads the SAME resolveAgentBackend(role) — so the runner
// and its usage/redaction handling are consistent by construction (same env,
// same process).
//
// claude is OPT-IN: the default is always 'codex', keeping codex's OS-sandbox
// behavior the safe default (#191 F15 decision: native guard + hygiene, claude
// default-disabled). Env-based to match the existing HARNESS_CODEX_BIN /
// HARNESS_CODEX_MODEL selector convention; a policy-level selector is a future
// enhancement.
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import { createClaudeCliRunner } from "../claude/claude-cli-runner.js";
import type { SandboxMode } from "../policy/schema.js";

export type AgentBackend = "codex" | "claude";
export type RunnerRole = "coder" | "reviewer";

const ENV_BY_ROLE: Record<RunnerRole, string> = {
  coder: "HARNESS_CODER_BACKEND",
  reviewer: "HARNESS_REVIEWER_BACKEND",
};

// claude tool surfaces per role — the analogue of codex's sandbox
// workspace-write (coder: edit + run) vs read-only (reviewer: inspect only;
// Bash/Write/Edit withheld so a reviewer cannot mutate the worktree).
export const CLAUDE_CODER_TOOLS = ["Bash", "Read", "Edit", "Write"];
export const CLAUDE_REVIEWER_TOOLS = ["Read", "Grep", "Glob"];

/**
 * Which backend drives this role. Default 'codex'; only the exact string
 * 'claude' opts in (any other value fail-closes to 'codex').
 */
export function resolveAgentBackend(role: RunnerRole): AgentBackend {
  return process.env[ENV_BY_ROLE[role]] === "claude" ? "claude" : "codex";
}

export interface ResolveAgentRunnerOpts {
  role: RunnerRole;
  codexBin: string;
  /** codex-only — claude's write boundary is its cwd (#191 F15), not a sandbox. */
  sandbox?: SandboxMode;
  approvalPolicy?: string;
  timeoutMs?: number;
  envAllowlist?: readonly string[];
  /** Optional claude --model injection / telemetry advisory. */
  claudeModel?: string | null;
}

/**
 * Construct the runner for a role per resolveAgentBackend. The claude branch
 * ignores codex-only knobs (sandbox/approval/envAllowlist) and selects the
 * role's tool surface; cwd=worktree (set by the runner) is the write boundary.
 */
export function resolveAgentRunner(o: ResolveAgentRunnerOpts): CodexExecRunner {
  if (resolveAgentBackend(o.role) === "claude") {
    return createClaudeCliRunner({
      tools:
        o.role === "coder" ? CLAUDE_CODER_TOOLS : CLAUDE_REVIEWER_TOOLS,
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.claudeModel ? { model: o.claudeModel } : {}),
    });
  }
  return createCodexCliRunner({
    codexBin: o.codexBin,
    ...(o.sandbox !== undefined ? { sandbox: o.sandbox } : {}),
    ...(o.approvalPolicy !== undefined
      ? { approvalPolicy: o.approvalPolicy }
      : {}),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.envAllowlist !== undefined ? { envAllowlist: o.envAllowlist } : {}),
  });
}

/**
 * Advisory claude model for agent-usage telemetry — mirror of resolveCodexModel:
 * the policy-declared model if present, else HARNESS_CLAUDE_MODEL, else null.
 * Best-effort metadata (the per-turn model is always recorded from the stream).
 */
export function resolveClaudeModel(policyModel?: string | null): string | null {
  if (policyModel !== undefined && policyModel !== null && policyModel !== "") {
    return policyModel;
  }
  const env = process.env.HARNESS_CLAUDE_MODEL;
  return env !== undefined && env !== "" ? env : null;
}
