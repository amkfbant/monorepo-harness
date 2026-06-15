import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPullRequest,
  pushReviewedBranchForEscalation,
  type PrPublisher,
  type PrPublishInputs,
} from "../../src/core/pr-creator.js";
import { computeReviewedFingerprint } from "../../src/core/reviewed-fingerprint.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

interface Fixture {
  root: string;
  runId: string;
  bareRemote: string;
}

/**
 * Build a harness root with one run: a target repo with a bare remote,
 * a run worktree on the run branch with an uncommitted change, and a
 * meta.json with the given status.
 */
async function setup(
  status: string,
  safetyStatus = "allowed",
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "harness-pr-"));
  mkdirSync(join(root, "runs"), { recursive: true });
  mkdirSync(join(root, "workspaces"), { recursive: true });

  // target repo
  const target = mkdtempSync(join(tmpdir(), "harness-pr-target-"));
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "T"]);
  mkdirSync(join(target, "apps/x"), { recursive: true });
  writeFileSync(join(target, "apps/x/f.ts"), "export const v = 0;\n");
  git(target, ["add", "."]);
  git(target, ["commit", "-qm", "init"]);

  // bare remote + push main
  const bareRemote = mkdtempSync(join(tmpdir(), "harness-pr-bare-")) + ".git";
  execFileSync("git", ["init", "-q", "--bare", bareRemote]);
  git(target, ["remote", "add", "origin", bareRemote]);
  git(target, ["push", "-q", "-u", "origin", "main"]);

  const runId = "run-20260521-apps-x-pr01";
  const runBranch = `harness/${runId}/apps-x`;
  const worktree = join(root, "workspaces", runId, "repo");
  git(target, ["worktree", "add", "-q", "-b", runBranch, worktree, "main"]);
  // an uncommitted codex change in the worktree
  writeFileSync(join(worktree, "apps/x/f.ts"), "export const v = 1;\n");

  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  // meta.reviewed carries the reviewed paths + a content fingerprint over
  // the worktree, computed the same way the workflow-runner would.
  const reviewedPaths = ["apps/x/f.ts"];
  const fingerprint = await computeReviewedFingerprint(worktree, reviewedPaths);
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        runId,
        domain: "apps/x",
        status,
        runBranch,
        reviewer: "knkn",
        reviewedAt: "2026-05-21T00:00:00Z",
        reviewed: { paths: reviewedPaths, fingerprint },
        safetyStatus,
        startedAt: "2026-05-21T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(runDir, "events.jsonl"), "");
  writeFileSync(
    join(runDir, "codex-prompt.md"),
    "x\n\nGoal:\nadd a v constant\n\nTarget domain:\napps/x\n",
  );
  return { root, runId, bareRemote };
}

/** A publisher that records its inputs and returns a fixed PR. */
function fakePublisher(): PrPublisher & { calls: PrPublishInputs[] } {
  const calls: PrPublishInputs[] = [];
  return {
    calls,
    async publish(inputs: PrPublishInputs) {
      calls.push(inputs);
      return { url: "https://github.com/amkfbant/mini-commerce/pull/7", number: 7 };
    },
  };
}

describe("createPullRequest", () => {
  it("E3-6-1: turns an approved run into a PR", async () => {
    const f = await setup("approved");
    const pub = fakePublisher();
    const r = await createPullRequest({
      runsDir: join(f.root, "runs"),
      workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
      runId: f.runId,
      base: "main",
      draft: true,
      publisher: pub,
    });
    expect(r.prNumber).toBe(7);
    expect(r.draft).toBe(true);
    expect(pub.calls).toHaveLength(1);
    expect(pub.calls[0]?.draft).toBe(true);
    expect(pub.calls[0]?.body).toMatch(/add a v constant/);
    // meta records the PR
    const meta = JSON.parse(
      readFileSync(join(f.root, "runs", f.runId, "meta.json"), "utf8"),
    );
    expect(meta.prUrl).toBe("https://github.com/amkfbant/mini-commerce/pull/7");
    expect(meta.prNumber).toBe(7);
    // events record pr_created
    const events = readFileSync(
      join(f.root, "runs", f.runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events.find((e) => e.type === "pr_created")).toBeDefined();
    // the run branch was pushed to the bare remote
    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).toMatch(/harness\/run-20260521-apps-x-pr01/);
  });

  it("E3-6-2: refuses a needs_review run", async () => {
    const f = await setup("needs_review");
    await expect(
      createPullRequest({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
        runId: f.runId,
        base: "main",
        draft: true,
        publisher: fakePublisher(),
      }),
    ).rejects.toThrow(/only approved runs/);
  });

  it("E3-6-3: refuses a failed-policy-violation run", async () => {
    const f = await setup("failed-policy-violation");
    await expect(
      createPullRequest({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
        runId: f.runId,
        base: "main",
        draft: true,
        publisher: fakePublisher(),
      }),
    ).rejects.toThrow(/only approved runs/);
  });

  it("refuses a changes_requested run", async () => {
    const f = await setup("changes_requested");
    await expect(
      createPullRequest({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
        runId: f.runId,
        base: "main",
        draft: true,
        publisher: fakePublisher(),
      }),
    ).rejects.toThrow(/only approved runs/);
  });

  it("salvage refuses an approved run instead of bypassing the PR gate", async () => {
    const f = await setup("approved");
    await expect(
      pushReviewedBranchForEscalation({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
      }),
    ).rejects.toThrow(/expected needs_review/);
  });

  it("salvage refuses safetyStatus=denied", async () => {
    const f = await setup("needs_review", "denied");
    await expect(
      pushReviewedBranchForEscalation({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
      }),
    ).rejects.toThrow(/expected allowed/);
    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).not.toMatch(/harness\/run-20260521-apps-x-pr01/);
  });

  it("refuses to create a second PR for the same run", async () => {
    const f = await setup("approved");
    const opts = {
      runsDir: join(f.root, "runs"),
      workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
      runId: f.runId,
      base: "main",
      draft: true,
      publisher: fakePublisher(),
    };
    await createPullRequest(opts);
    await expect(createPullRequest(opts)).rejects.toThrow(
      /already has a PR/,
    );
  });

  it("commits only reviewed paths, not ignore_untracked files", async () => {
    const f = await setup("approved");
    // an ignored build artifact sits in the worktree but is NOT in the
    // run's diff_collected reviewed paths — it must stay out of the PR.
    const worktree = join(f.root, "workspaces", f.runId, "repo");
    mkdirSync(join(worktree, "apps/x/dist"), { recursive: true });
    writeFileSync(join(worktree, "apps/x/dist/bundle.js"), "built\n");
    await createPullRequest({
      runsDir: join(f.root, "runs"),
      workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
      runId: f.runId,
      base: "main",
      draft: true,
      publisher: fakePublisher(),
    });
    // the pushed commit contains f.ts but NOT dist/bundle.js
    const committed = git(worktree, [
      "show",
      "--name-only",
      "--pretty=format:",
      "HEAD",
    ]).trim();
    expect(committed).toMatch(/apps\/x\/f\.ts/);
    expect(committed).not.toMatch(/dist\/bundle\.js/);
  });

  it("refuses to push when the branch already contains an unreviewed commit", async () => {
    const f = await setup("approved");
    const worktree = join(f.root, "workspaces", f.runId, "repo");
    writeFileSync(join(worktree, "apps/x/extra.ts"), "export const extra = 1;\n");
    git(worktree, ["add", "apps/x/extra.ts"]);
    git(worktree, ["commit", "-qm", "unreviewed local commit"]);

    // The push guard now refuses earlier — HEAD carries commit history beyond
    // base (the unreviewed local commit), so the fail-closed HEAD == base check
    // rejects before the branch-diff path gate is reached. This is still a hard
    // REFUSAL: the run has no prior failed PR, so no recovery is attempted.
    await expect(
      createPullRequest({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
        base: "main",
        draft: true,
        publisher: fakePublisher(),
      }),
    ).rejects.toThrow(
      /has commit history beyond base.*refusing to push unreviewed history/s,
    );

    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).not.toMatch(/harness\/run-20260521-apps-x-pr01/);
  });

  it("P0: refuses an intermediate reviewed-path commit even when the final content matches the fingerprint", async () => {
    // Regression for the codex P0: an intermediate commit touches ONLY a
    // reviewed path with transient/secret content, then a later commit
    // restores the reviewed content. The NET branch diff (base..HEAD) is only
    // reviewed paths and the working tree matches the recorded fingerprint, so
    // the fingerprint + branch-diff-subset gates BOTH pass — yet the
    // intermediate (secret) commit is still on the branch. The HEAD == base
    // guard must refuse, so that unreviewed history never reaches origin.
    const f = await setup("approved");
    const worktree = join(f.root, "workspaces", f.runId, "repo");
    // intermediate commit on the reviewed path with transient/secret content
    writeFileSync(
      join(worktree, "apps/x/f.ts"),
      'export const TOKEN = "sk-secret-leak";\n',
    );
    git(worktree, ["add", "apps/x/f.ts"]);
    git(worktree, ["commit", "-qm", "transient secret (reviewed path)"]);
    // restore the reviewed content so the working tree matches the fingerprint
    writeFileSync(join(worktree, "apps/x/f.ts"), "export const v = 1;\n");
    git(worktree, ["add", "apps/x/f.ts"]);
    git(worktree, ["commit", "-qm", "restore reviewed content"]);
    // sanity: the working tree now matches the recorded reviewed fingerprint
    const reviewedFp = await computeReviewedFingerprint(worktree, [
      "apps/x/f.ts",
    ]);
    const meta = JSON.parse(
      readFileSync(join(f.root, "runs", f.runId, "meta.json"), "utf8"),
    );
    expect(reviewedFp).toBe(meta.reviewed.fingerprint);

    await expect(
      createPullRequest({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
        base: "main",
        draft: true,
        publisher: fakePublisher(),
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
    expect(remoteBranches).not.toMatch(/harness\/run-20260521-apps-x-pr01/);
  });

  it("P1: refuses a one-commit-beyond-base worktree that still has reviewed content to stage", async () => {
    // codex P1 (history-shape gate ordering): the gate sees EXACTLY one clean
    // commit beyond base (here a pre-existing commit with an attacker-chosen
    // message), but an untracked reviewed file is still present. A bare
    // "count==1 && clean tracked" check would pass; then `git add` stages the
    // untracked reviewed file and a SECOND commit is created on top of the
    // unreviewed first one — pushing its history. The post-`git add`
    // stage-nothing invariant must refuse instead.
    const f = await setup("approved");
    const worktree = join(f.root, "workspaces", f.runId, "repo");
    // A second reviewed path that the run produced as a NEW (untracked) file.
    writeFileSync(join(worktree, "apps/x/g.ts"), "export const g = 2;\n");
    const reviewedPaths = ["apps/x/f.ts", "apps/x/g.ts"];
    const fingerprint = await computeReviewedFingerprint(worktree, reviewedPaths);
    const metaPath = join(f.root, "runs", f.runId, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.reviewed = { paths: reviewedPaths, fingerprint };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    // Commit ONLY the tracked reviewed change with an attacker-chosen message;
    // leave g.ts untracked. HEAD is now base + 1 clean commit, g.ts pending.
    git(worktree, ["add", "apps/x/f.ts"]);
    git(worktree, ["commit", "-qm", "unreviewed message: sk-secret-leak"]);
    // sanity: working tree matches the recorded reviewed fingerprint
    expect(await computeReviewedFingerprint(worktree, reviewedPaths)).toBe(
      meta.reviewed.fingerprint,
    );

    await expect(
      createPullRequest({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
        base: "main",
        draft: true,
        publisher: fakePublisher(),
      }),
    ).rejects.toThrow(/refusing to add a second commit onto pre-existing history/);

    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).not.toMatch(/harness\/run-20260521-apps-x-pr01/);
  });

  it("P1: refuses when a reviewed file drifted after approval", async () => {
    const f = await setup("approved");
    // someone edits a reviewed path AFTER the run was approved
    const worktree = join(f.root, "workspaces", f.runId, "repo");
    writeFileSync(
      join(worktree, "apps/x/f.ts"),
      "export const v = 999; // drifted\n",
    );
    await expect(
      createPullRequest({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
        base: "main",
        draft: true,
        publisher: fakePublisher(),
      }),
    ).rejects.toThrow(/drifted since the run was reviewed/);
  });

  it("rejects an invalid runId", async () => {
    await expect(
      createPullRequest({
        runsDir: "/tmp",
        workspacesDir: "/tmp",
        locksDir: "/tmp",
        runId: "../escape",
        base: "main",
        draft: true,
        publisher: fakePublisher(),
      }),
    ).rejects.toThrow(/invalid runId/);
  });
});
