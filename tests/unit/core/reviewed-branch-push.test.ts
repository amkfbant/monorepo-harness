import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGitPathList,
  assertPathsSubset,
  pushReviewedBranchForEscalation,
} from "../../../src/core/reviewed-branch-push.js";
import { computeReviewedFingerprint } from "../../../src/core/reviewed-fingerprint.js";

describe("parseGitPathList (git diff -z parsing)", () => {
  it("splits NUL-terminated paths and preserves leading/trailing whitespace", () => {
    // `git diff -z --name-only` emits NUL-terminated paths with a trailing NUL.
    expect(parseGitPathList("a\0 a\0b/c\0")).toEqual(["a", " a", "b/c"]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseGitPathList("")).toEqual([]);
  });

  it("keeps a whitespace path distinct from a reviewed path (subset gate holds)", () => {
    // Reviewed set is exactly {"a"}; an existing change adds the distinct path
    // " a". With line-trimming this would collapse to "a" and slip past the
    // gate; with exact NUL parsing it must be rejected as unreviewed.
    const reviewed = ["a"];
    const changed = parseGitPathList("a\0 a\0");
    expect(() => assertPathsSubset(changed, reviewed, "branch diff")).toThrow(
      /unreviewed path/,
    );
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

interface SalvageFixture {
  root: string;
  runId: string;
  worktree: string;
  bareRemote: string;
}

/**
 * A harness root with one `needs_review` / safetyStatus=`allowed` run ready
 * for the salvage push path (`pushReviewedBranchForEscalation`): a target repo
 * with a bare remote, a run worktree on the run branch with an uncommitted
 * reviewed change, and a meta.json carrying the reviewed fingerprint.
 */
async function setupSalvage(): Promise<SalvageFixture> {
  const root = mkdtempSync(join(tmpdir(), "harness-salvage-"));
  mkdirSync(join(root, "runs"), { recursive: true });
  mkdirSync(join(root, "workspaces"), { recursive: true });

  const target = mkdtempSync(join(tmpdir(), "harness-salvage-target-"));
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "T"]);
  mkdirSync(join(target, "apps/x"), { recursive: true });
  writeFileSync(join(target, "apps/x/f.ts"), "export const v = 0;\n");
  git(target, ["add", "."]);
  git(target, ["commit", "-qm", "init"]);

  const bareRemote =
    mkdtempSync(join(tmpdir(), "harness-salvage-bare-")) + ".git";
  execFileSync("git", ["init", "-q", "--bare", bareRemote]);
  git(target, ["remote", "add", "origin", bareRemote]);
  git(target, ["push", "-q", "-u", "origin", "main"]);

  const runId = "run-20260521-apps-x-salv1";
  const runBranch = `harness/${runId}/apps-x`;
  const worktree = join(root, "workspaces", runId, "repo");
  git(target, ["worktree", "add", "-q", "-b", runBranch, worktree, "main"]);
  // an uncommitted codex change in the worktree
  writeFileSync(join(worktree, "apps/x/f.ts"), "export const v = 1;\n");

  // the run's base SHA — the salvage path validates HEAD against this.
  const baseSha = git(worktree, ["rev-parse", "main"]).trim();

  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const reviewedPaths = ["apps/x/f.ts"];
  const fingerprint = await computeReviewedFingerprint(worktree, reviewedPaths);
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        runId,
        domain: "apps/x",
        status: "needs_review",
        safetyStatus: "allowed",
        runBranch,
        baseSha,
        reviewer: "knkn",
        reviewedAt: "2026-05-21T00:00:00Z",
        reviewed: { paths: reviewedPaths, fingerprint },
        startedAt: "2026-05-21T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(runDir, "events.jsonl"), "");
  return { root, runId, worktree, bareRemote };
}

describe("pushReviewedBranchForEscalation (salvage push guard)", () => {
  it("pushes a clean HEAD == base worktree (happy path)", async () => {
    const f = await setupSalvage();
    const r = await pushReviewedBranchForEscalation({
      runsDir: join(f.root, "runs"),
      workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
      runId: f.runId,
    });
    expect(r.committed).toBe(true);
    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).toMatch(/harness\/run-20260521-apps-x-salv1/);
  });

  it("P0: refuses an intermediate reviewed-path commit even when the final content matches the fingerprint", async () => {
    // Regression for the codex P0: an intermediate commit touches ONLY the
    // reviewed path with transient/secret content, then a later commit
    // restores the reviewed content so the working tree matches the recorded
    // fingerprint. The NET branch diff is only reviewed paths and the
    // fingerprint matches, so the fingerprint + branch-diff-subset gates BOTH
    // pass — yet the intermediate (secret) commit is still on the branch. The
    // HEAD == base guard must refuse so that history never reaches origin.
    const f = await setupSalvage();
    // intermediate commit on the reviewed path with transient/secret content
    writeFileSync(
      join(f.worktree, "apps/x/f.ts"),
      'export const TOKEN = "sk-secret-leak";\n',
    );
    git(f.worktree, ["add", "apps/x/f.ts"]);
    git(f.worktree, ["commit", "-qm", "transient secret (reviewed path)"]);
    // restore the reviewed content so the working tree matches the fingerprint
    writeFileSync(join(f.worktree, "apps/x/f.ts"), "export const v = 1;\n");
    git(f.worktree, ["add", "apps/x/f.ts"]);
    git(f.worktree, ["commit", "-qm", "restore reviewed content"]);
    // sanity: the working tree matches the recorded reviewed fingerprint
    const fp = await computeReviewedFingerprint(f.worktree, ["apps/x/f.ts"]);
    const meta = JSON.parse(
      readFileSync(join(f.root, "runs", f.runId, "meta.json"), "utf8"),
    );
    expect(fp).toBe(meta.reviewed.fingerprint);

    await expect(
      pushReviewedBranchForEscalation({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
      }),
    ).rejects.toThrow(
      /has commit history beyond base.*refusing to push unreviewed history/s,
    );

    // the intermediate (secret) commit never reached origin
    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).not.toMatch(/harness\/run-20260521-apps-x-salv1/);
  });
});
