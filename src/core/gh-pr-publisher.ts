import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  PrPublisher,
  PrPublishInputs,
  PrPublishResult,
  PrMerger,
  PrMergeInputs,
  PrMergeResult,
} from "./pr-creator.js";
import { PrGateError } from "./pr-creator.js";

/**
 * A `gh` invocation that exceeded its timeout. Subclass of PrGateError so
 * it still maps to exit 1, but distinguishable so the idempotency lookup
 * does not swallow it.
 */
class GhTimeoutError extends PrGateError {
  constructor(message: string) {
    super(message);
    this.name = "GhTimeoutError";
  }
}

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
 * A PrMerger backed by `gh`. Idempotent: it first checks the PR state and
 * returns without re-merging an already-merged PR. Each `gh` call is bounded
 * by a timeout so a hang fails loudly (the timeout is never swallowed).
 */
export function createGhPrMerger(
  ghBin = "gh",
  timeoutMs = DEFAULT_GH_TIMEOUT_MS,
): PrMerger {
  return {
    async merge(inputs: PrMergeInputs): Promise<PrMergeResult> {
      // Invariant: this destructive primitive ALWAYS requires the reviewed
      // commit — checked before anything else, including the already-merged
      // no-op, so an unpinned call can never succeed.
      if (inputs.expectedHeadSha === undefined) {
        throw new PrGateError(
          `refusing to merge PR #${inputs.prNumber} without an expectedHeadSha (reviewed commit)`,
        );
      }
      const view = await viewPr(ghBin, inputs, timeoutMs);
      // idempotency: never attempt a second merge on an already-merged PR.
      if (view.merged) {
        // fail-closed: the already-merged PR must be the one we reviewed — a
        // concurrently-merged different commit must not be reported as our
        // success.
        if (view.headSha !== inputs.expectedHeadSha) {
          throw new PrGateError(
            `PR #${inputs.prNumber} is already merged at a different commit ` +
              `(expected ${inputs.expectedHeadSha}, head ${view.headSha ?? "unknown"}); refusing to report success`,
          );
        }
        return { merged: true, alreadyMerged: true };
      }
      await runGh(
        ghBin,
        [
          "pr",
          "merge",
          String(inputs.prNumber),
          "--match-head-commit",
          inputs.expectedHeadSha,
          `--${inputs.method}`,
        ],
        inputs.repoDir,
        timeoutMs,
      );
      return { merged: true, alreadyMerged: false };
    },
  };
}

/**
 * Phase 3: a CI-green probe for the auto-merge gate. It reads the PR head OID
 * AND its check rollup in ONE atomic `gh pr view` snapshot, so the checks it
 * evaluates are provably for that exact commit — there is no before/after
 * window that an A→B→A head swap could exploit. Green requires
 * headRefOid === expectedHeadSha AND every check in the rollup successful.
 * Fail-closed: a head mismatch, an empty rollup (no CI evidence), any
 * non-success check, a timeout, or an error all return false.
 */
export function createGhCiStatus(
  repoDir: string,
  ghBin = "gh",
  timeoutMs = DEFAULT_GH_TIMEOUT_MS,
): (prNumber: number, expectedHeadSha: string) => Promise<boolean> {
  return async (prNumber: number, expectedHeadSha: string) => {
    try {
      const out = await runGh(
        ghBin,
        ["pr", "view", String(prNumber), "--json", "headRefOid,statusCheckRollup"],
        repoDir,
        timeoutMs,
      );
      const parsed = JSON.parse(out.trim() || "{}") as {
        headRefOid?: unknown;
        statusCheckRollup?: unknown;
      };
      // The rollup is for THIS head OID; binding it to the reviewed commit
      // makes the green judgement provably about the commit we will merge.
      if (parsed.headRefOid !== expectedHeadSha) return false;
      const rollup = parsed.statusCheckRollup;
      if (!Array.isArray(rollup) || rollup.length === 0) return false;
      return rollup.every(isCheckGreen);
    } catch {
      return false;
    }
  };
}

/**
 * A single `statusCheckRollup` entry is green when a CheckRun completed with a
 * benign conclusion, or a legacy StatusContext is SUCCESS. Anything else
 * (pending, failure, error, unknown shape) is NOT green (fail-closed).
 */
function isCheckGreen(check: unknown): boolean {
  const c = check as { state?: unknown; status?: unknown; conclusion?: unknown };
  if (typeof c.state === "string") {
    return c.state.toUpperCase() === "SUCCESS";
  }
  if (typeof c.status === "string" && c.status.toUpperCase() !== "COMPLETED") {
    return false;
  }
  const conclusion =
    typeof c.conclusion === "string" ? c.conclusion.toUpperCase() : "";
  return (
    conclusion === "SUCCESS" ||
    conclusion === "NEUTRAL" ||
    conclusion === "SKIPPED"
  );
}

/**
 * Read the PR's merged state + head commit in one `gh pr view`. A timeout
 * fails loudly (never swallowed); a malformed payload yields a null headSha,
 * which the merger treats as fail-closed.
 */
async function viewPr(
  ghBin: string,
  inputs: PrMergeInputs,
  timeoutMs: number,
): Promise<{ merged: boolean; headSha: string | null }> {
  const out = await runGh(
    ghBin,
    ["pr", "view", String(inputs.prNumber), "--json", "state,mergedAt,headRefOid"],
    inputs.repoDir,
    timeoutMs,
  );
  try {
    const parsed = JSON.parse(out.trim() || "{}") as {
      state?: unknown;
      mergedAt?: unknown;
      headRefOid?: unknown;
    };
    const merged =
      parsed.state === "MERGED" || typeof parsed.mergedAt === "string";
    const headSha =
      typeof parsed.headRefOid === "string" && parsed.headRefOid !== ""
        ? parsed.headRefOid
        : null;
    return { merged, headSha };
  } catch {
    return { merged: false, headSha: null };
  }
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
  } catch (e) {
    // a timeout must fail loudly — do NOT silently fall through to create.
    if (e instanceof GhTimeoutError) throw e;
    // a non-timeout failure (no network / not a gh repo) — fall through
    // to create, which surfaces its own error.
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
          new GhTimeoutError(
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
