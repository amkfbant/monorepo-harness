import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunMeta, RunStatus } from "../logging/run-log.js";
import { removeWorktree } from "../workspace/git-worktree.js";

export interface CleanupOpts {
  runsDir: string;
  workspacesDir: string;
  runId: string;
  /** allow cleaning failed-* / needs_review / verified / generated runs */
  force?: boolean;
  /** override git invocation timeout */
  gitTimeoutMs?: number;
}

export interface CleanupResult {
  runId: string;
  /** true if a worktree existed and was removed by this call */
  worktreeRemoved: boolean;
  /** true if a branch was removed in the target repo by this call */
  branchRemoved: boolean;
  /** status BEFORE cleanup (post-cleanup is always "cleaned" or unchanged on no-op) */
  previousStatus: RunStatus;
}

interface CleanupGate {
  ok: boolean;
  reason?: string;
}

function checkCleanupAllowed(
  status: RunStatus,
  force: boolean,
): CleanupGate {
  if (status === "cleaned") return { ok: true }; // idempotent no-op
  if (status === "running") {
    return { ok: false, reason: "run is still active" };
  }
  if (status === "changes_requested") {
    return {
      ok: false,
      reason:
        "changes_requested runs are retry bases; mark them as rejected first if you want to discard the worktree",
    };
  }
  if (status === "approved" || status === "rejected") return { ok: true };
  if (force) return { ok: true };
  return {
    ok: false,
    reason: `status "${status}" cannot be cleaned without --force`,
  };
}

export async function cleanupRun(opts: CleanupOpts): Promise<CleanupResult> {
  const runDir = join(opts.runsDir, opts.runId);
  const metaPath = join(runDir, "meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;

  const gate = checkCleanupAllowed(meta.status, opts.force ?? false);
  if (!gate.ok) {
    throw new Error(`cannot cleanup ${opts.runId}: ${gate.reason}`);
  }

  const worktreePath = join(opts.workspacesDir, opts.runId, "repo");
  let worktreeRemoved = false;
  let branchRemoved = false;

  if (existsSync(worktreePath)) {
    try {
      await removeWorktree({
        repoPath: meta.repoPath,
        worktreePath,
        branch: meta.runBranch,
        ...(opts.gitTimeoutMs !== undefined
          ? { timeoutMs: opts.gitTimeoutMs }
          : {}),
      });
      worktreeRemoved = true;
      // removeWorktree also tries to delete the branch (best-effort), but
      // we can't tell from its return whether the branch was actually deleted.
      // Treat success here as both removed; if the branch was already gone
      // git just no-ops.
      branchRemoved = true;
    } catch (e) {
      throw new Error(
        `failed to remove worktree at ${worktreePath}: ${(e as Error).message}`,
      );
    }
  }

  const previousStatus = meta.status;
  if (meta.status !== "cleaned") {
    const updated: RunMeta = { ...meta, status: "cleaned" };
    await writeFile(metaPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    await appendFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({
        type: "cleaned",
        runId: opts.runId,
        previousStatus,
        worktreeRemoved,
        branchRemoved,
      })}\n`,
      "utf8",
    );
  }

  return {
    runId: opts.runId,
    worktreeRemoved,
    branchRemoved,
    previousStatus,
  };
}
