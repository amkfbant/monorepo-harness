import { MIGRATIONS } from "../../db/migrations.js";
import { harnessVersion } from "../../config/version.js";
import {
  createGitReader,
  gatherReleasePlanInput,
  ReleaseGatherError,
} from "../../release/release-git.js";
import { buildReleasePlan } from "../../release/release-plan.js";
import {
  errorResult,
  ok,
  type HarnessMcpToolResult,
} from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";

export interface ReleasePlanArgs {
  since?: string;
  to?: string;
}

/**
 * MCP read exposure of `harness release plan` (issue: agent-driven version-up).
 * Read-only: it shells out to git (rev-parse / show / log — no writes) and
 * reads source files; no DB, no mutation. Lets an MCP-driven agent get the
 * deterministic release-readiness + compatibility report directly.
 *
 * The analyzed repo is ALWAYS `context.harnessRoot` — there is no client-supplied
 * `repo` arg (which would let a read client read arbitrary local repos, bypassing
 * the MCP read boundary). Operators analyze other repos via the CLI `--repo`.
 */
export async function releasePlanTool(
  args: ReleasePlanArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const reader = createGitReader(context.harnessRoot);
  try {
    const input = await gatherReleasePlanInput(reader, {
      migrations: MIGRATIONS,
      currentVersion: harnessVersion(),
      ...(args.since !== undefined ? { since: args.since } : {}),
      ...(args.to !== undefined ? { to: args.to } : {}),
    });
    const plan = buildReleasePlan(input);
    const flags =
      plan.undeclaredBreaking.length > 0
        ? " — UNDECLARED breaking"
        : plan.analysisWarnings.length > 0
          ? " — analysis incomplete"
          : "";
    return ok(
      `release plan ${plan.since}..${plan.to}: ${plan.recommendedBump}` +
        (plan.recommendedVersion !== null ? ` → ${plan.recommendedVersion}` : "") +
        flags,
      plan,
    );
  } catch (e) {
    if (e instanceof ReleaseGatherError) {
      return errorResult(e.message, { reason: "release_gather_error" });
    }
    throw e;
  }
}
