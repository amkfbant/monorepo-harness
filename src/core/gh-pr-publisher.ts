import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  PrPublisher,
  PrPublishInputs,
  PrPublishResult,
} from "./pr-creator.js";
import { PrGateError } from "./pr-creator.js";

/** Default timeout for a single `gh` invocation. */
const DEFAULT_GH_TIMEOUT_MS = 120_000;

/**
 * A PrPublisher backed by the GitHub `gh` CLI. `gh pr create` prints the
 * created PR's URL to stdout; the PR number is parsed from it. Each `gh`
 * call is bounded by a timeout so a network / auth hang fails loudly.
 */
export function createGhPrPublisher(
  ghBin = "gh",
  timeoutMs = DEFAULT_GH_TIMEOUT_MS,
): PrPublisher {
  return {
    async publish(inputs: PrPublishInputs): Promise<PrPublishResult> {
      // pass the body via a temp file — it is multi-line markdown.
      const bodyFile = join(
        tmpdir(),
        `harness-pr-body-${process.pid}-${Date.now()}.md`,
      );
      await writeFile(bodyFile, inputs.body, "utf8");
      try {
        // idempotency: if an OPEN PR already exists for this head branch,
        // return it instead of failing on a duplicate `gh pr create`. A
        // closed PR is NOT reused — `gh pr create` opens a fresh one.
        const existing = await findOpenPr(ghBin, inputs, timeoutMs);
        if (existing) return existing;

        const args = [
          "pr",
          "create",
          "--base",
          inputs.base,
          "--head",
          inputs.head,
          "--title",
          inputs.title,
          "--body-file",
          bodyFile,
        ];
        if (inputs.draft) args.push("--draft");
        const out = await runGh(ghBin, args, inputs.repoDir, timeoutMs);
        const url = out.trim().split(/\s+/).pop() ?? "";
        const m = url.match(/\/pull\/(\d+)\b/);
        if (!m || !m[1]) {
          throw new PrGateError(
            `could not parse a PR URL from gh output: ${out.trim()}`,
          );
        }
        return { url, number: Number(m[1]) };
      } finally {
        await rm(bodyFile, { force: true });
      }
    },
  };
}

/**
 * Look for an OPEN PR on this head branch. Returns it if found — making
 * publish idempotent when a prior run created the PR but failed before
 * recording it in meta.json. `--state open` only: a closed PR for the
 * branch must not be treated as a successful (re)publish.
 */
async function findOpenPr(
  ghBin: string,
  inputs: PrPublishInputs,
  timeoutMs: number,
): Promise<PrPublishResult | null> {
  let out: string;
  try {
    out = await runGh(
      ghBin,
      [
        "pr",
        "list",
        "--head",
        inputs.head,
        "--state",
        "open",
        "--json",
        "url,number",
        "--limit",
        "1",
      ],
      inputs.repoDir,
      timeoutMs,
    );
  } catch {
    // listing failed (no network / not a gh repo) — fall through to create
    return null;
  }
  try {
    const arr = JSON.parse(out.trim() || "[]") as Array<{
      url?: unknown;
      number?: unknown;
    }>;
    const first = arr[0];
    if (
      first &&
      typeof first.url === "string" &&
      typeof first.number === "number"
    ) {
      return { url: first.url, number: first.number };
    }
  } catch {
    // unparseable — fall through to create
  }
  return null;
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
      reject(new PrGateError(`failed to run ${ghBin}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new PrGateError(
            `gh ${args[0]} ${args[1] ?? ""} timed out after ${timeoutMs}ms`,
          ),
        );
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new PrGateError(
            `gh ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`,
          ),
        );
      }
    });
  });
}
