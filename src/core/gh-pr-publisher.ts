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

/**
 * A PrPublisher backed by the GitHub `gh` CLI. `gh pr create` prints the
 * created PR's URL to stdout; the PR number is parsed from it.
 */
export function createGhPrPublisher(ghBin = "gh"): PrPublisher {
  return {
    async publish(inputs: PrPublishInputs): Promise<PrPublishResult> {
      // pass the body via a temp file — it is multi-line markdown.
      const bodyFile = join(
        tmpdir(),
        `harness-pr-body-${process.pid}-${Date.now()}.md`,
      );
      await writeFile(bodyFile, inputs.body, "utf8");
      try {
        // idempotency: if a PR already exists for this head branch,
        // return it instead of failing on a duplicate `gh pr create`.
        const existing = await findExistingPr(ghBin, inputs);
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
        const out = await runGh(ghBin, args, inputs.repoDir);
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
 * Look for a PR already open for this head branch. Returns it if found —
 * making publish idempotent even when a prior run created the PR but
 * failed before recording it in meta.json.
 */
async function findExistingPr(
  ghBin: string,
  inputs: PrPublishInputs,
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
        "all",
        "--json",
        "url,number",
        "--limit",
        "1",
      ],
      inputs.repoDir,
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
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ghBin, args as string[], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) =>
      reject(new PrGateError(`failed to run ${ghBin}: ${e.message}`)),
    );
    child.on("close", (code) => {
      if (code === 0) {
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
