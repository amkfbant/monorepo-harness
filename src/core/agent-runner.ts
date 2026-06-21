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
import { codexBinaryVersion } from "../codex/codex-version.js";
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
 * Which backend drives this role, mirroring resolveCodexModel's precedence
 * (policy/profile value > env > default) but SAFETY-INVERTED: only the exact
 * string 'claude' opts in at any layer; everything else fail-closes to 'codex'.
 *
 *   1. `policyBackend` — the per-project resolved.codex.backend (#191). Lets
 *      project A=claude / B=codex coexist in one ops driver without env juggling.
 *   2. HARNESS_*_BACKEND env — a global override for ops convenience / no-config
 *      runs (the role has no policy in scope, e.g. standalone `review auto`).
 *   3. default codex.
 */
export function resolveAgentBackend(
  role: RunnerRole,
  policyBackend?: AgentBackend,
): AgentBackend {
  if (policyBackend === "claude") return "claude";
  if (policyBackend === "codex") return "codex";
  return process.env[ENV_BY_ROLE[role]] === "claude" ? "claude" : "codex";
}

export interface ResolveAgentRunnerOpts {
  role: RunnerRole;
  codexBin: string;
  /**
   * Backend to use. Pass the value captured ONCE by the caller (the same value
   * threaded to the run as `coderBackend`) so the runner and the downstream
   * redaction/usage dispatch cannot disagree if HARNESS_*_BACKEND is mutated
   * mid-process. Omitted → resolved from env here.
   */
  backend?: AgentBackend;
  /** codex-only — claude's write boundary is its cwd (#191 F15), not a sandbox. */
  sandbox?: SandboxMode;
  approvalPolicy?: string;
  timeoutMs?: number;
  envAllowlist?: readonly string[];
  /** Optional claude --model injection / telemetry advisory. */
  claudeModel?: string | null;
}

/**
 * Construct the runner for a role per the given/resolved backend, returning the
 * runner AND the backend it was built from as ONE value. Callers thread the
 * returned `backend` to the run so the downstream redaction/usage dispatch
 * cannot diverge from the runner — the discriminator is never resolved twice
 * (the R1-P1b TOCTOU is unrepresentable). The claude branch ignores codex-only
 * knobs (sandbox/approval/envAllowlist) and selects the role's tool surface;
 * cwd=worktree (set by the runner) is the write boundary.
 */
export function resolveAgentRunner(o: ResolveAgentRunnerOpts): {
  runner: CodexExecRunner;
  backend: AgentBackend;
} {
  const backend = o.backend ?? resolveAgentBackend(o.role);
  if (backend === "claude") {
    return {
      backend,
      runner: createClaudeCliRunner({
        tools:
          o.role === "coder" ? CLAUDE_CODER_TOOLS : CLAUDE_REVIEWER_TOOLS,
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
        ...(o.claudeModel ? { model: o.claudeModel } : {}),
      }),
    };
  }
  return {
    backend,
    runner: createCodexCliRunner({
      codexBin: o.codexBin,
      ...(o.sandbox !== undefined ? { sandbox: o.sandbox } : {}),
      ...(o.approvalPolicy !== undefined
        ? { approvalPolicy: o.approvalPolicy }
        : {}),
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.envAllowlist !== undefined ? { envAllowlist: o.envAllowlist } : {}),
    }),
  };
}

/**
 * Per-project coder backend config (#191): the resolved policy's coder backend
 * and advisory claude model, threaded from the in-scope ResolvedPolicy.codex so
 * the helper picks the project's backend instead of only the global env.
 */
export interface CoderBackendOpts {
  backend?: AgentBackend;
  claudeModel?: string | null;
  /** Policy kill timeout (#191) — threaded so orchestrate/MCP coders honour it
   * like the CLI run/rerun paths (codex AND claude). */
  timeoutMs?: number;
}

/**
 * Build CoderBackendOpts from an in-scope ResolvedPolicy.codex, honouring
 * exactOptionalPropertyTypes (never pass an explicit `undefined`). Spread the
 * result into the coder helper: `coderRunnerDeps(bin, coderBackendOpts(resolved.codex))`.
 */
export function coderBackendOpts(codex: {
  backend?: AgentBackend;
  claudeModel?: string;
  timeoutMs?: number;
}): CoderBackendOpts {
  return {
    ...(codex.backend !== undefined ? { backend: codex.backend } : {}),
    ...(codex.claudeModel !== undefined ? { claudeModel: codex.claudeModel } : {}),
    ...(codex.timeoutMs !== undefined ? { timeoutMs: codex.timeoutMs } : {}),
  };
}

/**
 * Coder runner + backend as the `OrchestratorRunnerDeps` / construction-site
 * field pair, from ONE resolution (so the runner and its threaded backend can't
 * diverge). Spread into the deps object: `...coderRunnerDeps(codexBin, opts)`.
 * The coder always uses the workspace-write codex sandbox; claude ignores it.
 */
export function coderRunnerDeps(
  codexBin: string,
  opts?: CoderBackendOpts,
): {
  coderRunner: CodexExecRunner;
  coderBackend: AgentBackend;
  coderCodexBinaryVersion: string | null;
} {
  const claudeModel = resolveClaudeModel(opts?.claudeModel);
  const { runner, backend } = resolveAgentRunner({
    role: "coder",
    codexBin,
    sandbox: "workspace-write",
    backend: resolveAgentBackend("coder", opts?.backend),
    // policy > HARNESS_CLAUDE_MODEL > null (the runner's --model gets the env
    // fallback too, not just telemetry).
    ...(claudeModel !== null ? { claudeModel } : {}),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return {
    coderRunner: runner,
    coderBackend: backend,
    // #191: do not stamp a CODEX binary version onto a CLAUDE run's provenance
    // (it would falsely attribute the run to whatever codex is on PATH / null).
    coderCodexBinaryVersion:
      backend === "claude" ? null : codexBinaryVersion(codexBin),
  };
}

/**
 * Coder runner + backend as the `RunDomainCodingOpts` field pair (the `run` /
 * `rerun` entry points that call runDomainCoding directly), from ONE resolution.
 * Spread: `...coderRunFields(codexBin, opts)`. Default codex sandbox.
 */
export function coderRunFields(
  codexBin: string,
  opts?: CoderBackendOpts,
): {
  codexRunner: CodexExecRunner;
  coderBackend: AgentBackend;
  codexBinaryVersion: string | null;
} {
  const claudeModel = resolveClaudeModel(opts?.claudeModel);
  const { runner, backend } = resolveAgentRunner({
    role: "coder",
    codexBin,
    backend: resolveAgentBackend("coder", opts?.backend),
    ...(claudeModel !== null ? { claudeModel } : {}),
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return {
    codexRunner: runner,
    coderBackend: backend,
    // null for claude — see coderRunnerDeps.
    codexBinaryVersion: backend === "claude" ? null : codexBinaryVersion(codexBin),
  };
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
