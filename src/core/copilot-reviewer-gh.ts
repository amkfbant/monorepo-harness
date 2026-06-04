import { spawn } from "node:child_process";
import type {
  CopilotReviewer,
  CopilotReviewPollResult,
} from "./copilot-reviewer.js";

const DEFAULT_GH_TIMEOUT_MS = 120_000;

/** GitHub's Copilot reviewer posts its review under this bot login. */
const COPILOT_BOT_LOGIN = "copilot-pull-request-reviewer";

/**
 * A `CopilotReviewer` backed by the GitHub `gh` CLI. `request` adds the
 * "Copilot" reviewer to the PR; `poll` checks whether the Copilot bot has
 * posted a review yet. `gh` resolves owner/repo from `repoDir` (its cwd).
 * Each call is bounded by a timeout so a hang fails loudly (request → the
 * orchestration retries; poll → it is swallowed best-effort).
 */
export function createGhCopilotReviewer(
  repoDir: string,
  ghBin = "gh",
  timeoutMs = DEFAULT_GH_TIMEOUT_MS,
): CopilotReviewer {
  return {
    async request(prNumber: number): Promise<void> {
      await runGh(
        ghBin,
        [
          "api",
          "--method",
          "POST",
          `repos/{owner}/{repo}/pulls/${prNumber}/requested_reviewers`,
          "-f",
          "reviewers[]=Copilot",
        ],
        repoDir,
        timeoutMs,
      );
    },
    async poll(prNumber: number): Promise<CopilotReviewPollResult> {
      const out = await runGh(
        ghBin,
        ["pr", "view", String(prNumber), "--json", "reviews"],
        repoDir,
        timeoutMs,
      );
      const parsed = JSON.parse(out.trim() || "{}") as {
        reviews?: Array<{ author?: { login?: unknown } }>;
      };
      const reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
      const reviewed = reviews.some(
        (r) => r?.author?.login === COPILOT_BOT_LOGIN,
      );
      return reviewed ? "reviewed" : "pending";
    },
  };
}

function runGh(
  ghBin: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghBin, args as string[], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`failed to run ${ghBin}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`gh ${args[0]} timed out after ${timeoutMs}ms`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `gh ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`,
          ),
        );
      }
    });
  });
}
