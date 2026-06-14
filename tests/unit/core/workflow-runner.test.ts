import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDomainCoding,
  materializeParentWork,
  type ContinueFromSpec,
} from "../../../src/core/workflow-runner.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../../../src/policy/loader.js";
import { resolvePolicy } from "../../../src/policy/resolver.js";
import type { CodexExecRunner } from "../../../src/codex/codex-exec-runner.js";

// A target git repo with one tracked file inside the `apps/user` write scope.
function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-wf-target-"));
  const g = (a: string[]) =>
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  mkdirSync(join(repo, "apps/user/src"), { recursive: true });
  writeFileSync(join(repo, "apps/user/src/profile.ts"), "export const x = 0;\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  return repo;
}

function setupHarness(opts?: { ignoreUntracked?: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), "harness-wf-root-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  const ignoreBlock =
    opts?.ignoreUntracked && opts.ignoreUntracked.length > 0
      ? `ignore_untracked:\n${opts.ignoreUntracked.map((p) => `  - ${p}`).join("\n")}\n`
      : "ignore_untracked: []\n";
  writeFileSync(
    join(root, "policies/global.yaml"),
    `always_deny_write: []\n${ignoreBlock}`,
  );
  writeFileSync(
    join(root, "policies/repos/t.yaml"),
    [
      "repo_id: t",
      "read: []",
      "domains:",
      "  apps/user:",
      "    read: [apps/user/**]",
      "    write: [apps/user/**]",
      "    deny_write: []",
      "",
    ].join("\n"),
  );
  return root;
}

// A fake codex runner that applies `edit(cwd)` to the worktree, writes the log
// files codex would, and exits 0. Mirrors the pattern in the integration tests.
function editRunner(edit: (cwd: string) => void): CodexExecRunner {
  return {
    async run(input) {
      edit(input.worktreePath);
      writeFileSync(input.logPaths.stdout, "done\n", "utf8");
      writeFileSync(input.logPaths.stderr, "", "utf8");
      writeFileSync(input.logPaths.events, "", "utf8");
      return { exitCode: 0, timedOut: false, durationMs: 1 };
    },
  };
}

// A codex runner that makes NO change (the continuation carry-forward is the
// only source of the child's worktree state).
const noopRunner: CodexExecRunner = editRunner(() => {});

function gitHead(repo: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
    .toString()
    .trim();
}

function branchTip(repo: string, branch: string): string {
  return execFileSync("git", ["rev-parse", branch], { cwd: repo })
    .toString()
    .trim();
}

function readEvents(harness: string, runId: string): { type: string; [k: string]: unknown }[] {
  return readFileSync(join(harness, "runs", runId, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
}

function parentWorktree(harness: string, parentRunId: string): string {
  return join(harness, "workspaces", parentRunId, "repo");
}

async function resolvedTestPolicy(harness: string) {
  const global = await loadGlobalPolicy(join(harness, "policies/global.yaml"));
  const repo = await loadRepoPolicy(join(harness, "policies/repos/t.yaml"));
  return resolvePolicy(global, repo, "apps/user");
}

describe("runDomainCoding rerun continuation (#163)", () => {
  let repoPath: string;
  let harness: string;
  beforeEach(() => {
    repoPath = setupRepo();
    harness = setupHarness();
  });

  it("EFFICACY: a rerun materializes the parent run's UNCOMMITTED work into the child worktree, without committing on the parent branch", async () => {
    // Parent run: codex edits a tracked file + adds a new in-scope file. The
    // run leaves these UNCOMMITTED in workspaces/<parentId>/repo and the run
    // branch tip stays at baseSha (runDomainCoding never commits).
    const parent = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "first pass",
      baseBranch: "main",
      codexRunner: editRunner((cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1; // parent edit\n",
        );
        writeFileSync(join(cwd, "apps/user/src/new.ts"), "export const n = 1;\n");
      }),
    });
    expect(parent.status).toBe("needs_review");
    const parentWt = parentWorktree(harness, parent.runId);
    const baseSha = gitHead(repoPath);
    // The parent run branch tip equals the base (no commit was made).
    const parentBranch = `run/${parent.runId}/apps-user`;
    // (branch name comes from runBranchName; assert via meta instead.)
    const parentMeta = JSON.parse(
      readFileSync(join(harness, "runs", parent.runId, "meta.json"), "utf8"),
    ) as { baseSha: string; runBranch: string };
    expect(branchTip(repoPath, parentMeta.runBranch)).toBe(parentMeta.baseSha);

    // Child rerun: codex appends ANOTHER file. Continuation must carry forward
    // the parent's two uncommitted edits so the child amends in place.
    const continueFrom: ContinueFromSpec = {
      parentRunId: parent.runId,
      parentWorktreePath: parentWt,
    };
    const child = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "second pass",
      baseBranch: "main",
      codexRunner: editRunner((cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/added.ts"),
          "export const a = 2;\n",
        );
      }),
      continueFrom,
      resolvedBaseSha: parentMeta.baseSha,
      rootRunId: parent.runId,
      rerunAttempt: 1,
    });
    expect(child.status).toBe("needs_review");
    const childWt = parentWorktree(harness, child.runId);

    // The child worktree CONTAINS the parent's work (uncommitted) AND the
    // child's own amend. A fresh-from-base (inert) impl would carry NEITHER
    // parent file → this assertion fails against the inert impl.
    expect(readFileSync(join(childWt, "apps/user/src/profile.ts"), "utf8")).toBe(
      "export const x = 1; // parent edit\n",
    );
    expect(readFileSync(join(childWt, "apps/user/src/new.ts"), "utf8")).toBe(
      "export const n = 1;\n",
    );
    expect(readFileSync(join(childWt, "apps/user/src/added.ts"), "utf8")).toBe(
      "export const a = 2;\n",
    );

    // NO new commit anywhere: the child run branch tip is still the base, and
    // the parent run branch tip is unchanged.
    const childMeta = JSON.parse(
      readFileSync(join(harness, "runs", child.runId, "meta.json"), "utf8"),
    ) as { baseSha: string; runBranch: string };
    expect(childMeta.baseSha).toBe(baseSha);
    expect(branchTip(repoPath, childMeta.runBranch)).toBe(baseSha);
    expect(branchTip(repoPath, parentMeta.runBranch)).toBe(parentMeta.baseSha);

    // A continuation_materialized event records what was carried (audit).
    const matEvent = readEvents(harness, child.runId).find(
      (e) => e.type === "continuation_materialized",
    );
    expect(matEvent).toBeDefined();
    expect((matEvent as { paths?: string[] }).paths).toEqual(
      expect.arrayContaining([
        "apps/user/src/new.ts",
        "apps/user/src/profile.ts",
      ]),
    );
  });

  it("continueFrom absent → behavior identical to a normal fresh run (regression)", async () => {
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "fresh",
      baseBranch: "main",
      codexRunner: editRunner((cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 9;\n",
        );
      }),
    });
    expect(r.status).toBe("needs_review");
    const events = readEvents(harness, r.runId).map((e) => e.type);
    expect(events).not.toContain("continuation_materialized");
    expect(events).not.toContain("continuation_skipped");
  });

  it("POLICY-VIOLATION still caught: a parent-added write-scope-denied file makes the child fail-policy-violation against the freshly-resolved base", async () => {
    // Parent writes OUTSIDE the apps/user scope (a root-level file). The parent
    // run itself ends failed-policy-violation, but its worktree still holds the
    // out-of-scope file. The continuation must carry it as the child's
    // uncommitted state, where the child's OWN policy validation re-flags it.
    const parent = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "out of scope",
      baseBranch: "main",
      codexRunner: editRunner((cwd) => {
        writeFileSync(join(cwd, "apps/user/src/profile.ts"), "export const x = 1;\n");
        // tracked file outside the apps/user write scope:
        writeFileSync(join(cwd, "README.md"), "# touched out of scope\n");
        execFileSync("git", ["add", "README.md"], { cwd });
      }),
    });
    expect(parent.status).toBe("failed-policy-violation");
    const baseSha = gitHead(repoPath);

    const child = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "rerun",
      baseBranch: "main",
      codexRunner: noopRunner,
      continueFrom: {
        parentRunId: parent.runId,
        parentWorktreePath: parentWorktree(harness, parent.runId),
      },
      resolvedBaseSha: baseSha,
      rootRunId: parent.runId,
      rerunAttempt: 1,
    });
    expect(child.status).toBe("failed-policy-violation");
    const childMeta = JSON.parse(
      readFileSync(join(harness, "runs", child.runId, "meta.json"), "utf8"),
    ) as { baseSha: string };
    expect(childMeta.baseSha).toBe(baseSha);
  });

  it("FALLBACK parent_work_unavailable: a missing parent worktree → fresh-from-base + recorded reason, no throw", async () => {
    const baseSha = gitHead(repoPath);
    const child = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "rerun with missing parent",
      baseBranch: "main",
      codexRunner: editRunner((cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 5;\n",
        );
      }),
      continueFrom: {
        parentRunId: "run-does-not-exist",
        parentWorktreePath: join(harness, "workspaces", "run-does-not-exist", "repo"),
      },
      resolvedBaseSha: baseSha,
    });
    expect(child.status).toBe("needs_review");
    const skip = readEvents(harness, child.runId).find(
      (e) => e.type === "continuation_skipped",
    );
    expect(skip).toBeDefined();
    expect((skip as { reason?: string }).reason).toBe("parent_work_unavailable");
    // fresh-from-base: only the child's own edit is present.
    const childWt = parentWorktree(harness, child.runId);
    expect(existsSync(join(childWt, "apps/user/src/new.ts"))).toBe(false);
    expect(readFileSync(join(childWt, "apps/user/src/profile.ts"), "utf8")).toBe(
      "export const x = 5;\n",
    );
  });

  it("FALLBACK continueFromSkipped reason is recorded on the fresh path (resolver-declined)", async () => {
    const baseSha = gitHead(repoPath);
    const child = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "rerun base advanced",
      baseBranch: "main",
      codexRunner: editRunner((cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 7;\n",
        );
      }),
      // resolver declined (base advanced) — no continueFrom, just the reason.
      continueFromSkipped: "base_advanced",
      resolvedBaseSha: baseSha,
    });
    expect(child.status).toBe("needs_review");
    const skip = readEvents(harness, child.runId).find(
      (e) => e.type === "continuation_skipped",
    );
    expect(skip).toBeDefined();
    expect((skip as { reason?: string }).reason).toBe("base_advanced");
  });
});

describe("materializeParentWork (#163)", () => {
  let repoPath: string;
  let harness: string;
  beforeEach(() => {
    repoPath = setupRepo();
    harness = setupHarness();
  });

  // Build a worktree at baseSha and apply edits to it (uncommitted).
  function buildWorktree(name: string, baseSha: string, edit: (cwd: string) => void): string {
    const wt = join(harness, "workspaces", name, "repo");
    mkdirSync(join(harness, "workspaces", name), { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "--detach", wt, baseSha], {
      cwd: repoPath,
    });
    edit(wt);
    return wt;
  }

  it("copies added/modified content and removes deleted paths into the child (all uncommitted)", async () => {
    const baseSha = gitHead(repoPath);
    const policy = await resolvedTestPolicy(harness);
    const parentWt = buildWorktree("parent-a", baseSha, (cwd) => {
      // modify a tracked file
      writeFileSync(join(cwd, "apps/user/src/profile.ts"), "export const x = 2;\n");
      // add a new untracked in-scope file
      writeFileSync(join(cwd, "apps/user/src/added.ts"), "export const a = 1;\n");
    });
    // Build a parent that DELETES the tracked file to exercise the delete path.
    const baseSha2 = gitHead(repoPath);
    const parentDel = buildWorktree("parent-del", baseSha2, (cwd) => {
      execFileSync("git", ["rm", "-q", "apps/user/src/profile.ts"], { cwd });
    });

    const childWt = buildWorktree("child-a", baseSha, () => {});
    const outcome = await materializeParentWork({
      parentWorktreePath: parentWt,
      childWorktreePath: childWt,
      baseSha,
      policy,
      gitTimeoutMs: policy.limits.gitTimeoutMs,
    });
    expect(outcome.materialized).toBe(true);
    expect(outcome.paths).toEqual(
      expect.arrayContaining([
        "apps/user/src/profile.ts",
        "apps/user/src/added.ts",
      ]),
    );
    expect(readFileSync(join(childWt, "apps/user/src/profile.ts"), "utf8")).toBe(
      "export const x = 2;\n",
    );
    expect(readFileSync(join(childWt, "apps/user/src/added.ts"), "utf8")).toBe(
      "export const a = 1;\n",
    );

    // deletion: materializing the deleting parent into a fresh child removes it.
    const childDel = buildWorktree("child-del", baseSha2, () => {});
    const delOutcome = await materializeParentWork({
      parentWorktreePath: parentDel,
      childWorktreePath: childDel,
      baseSha: baseSha2,
      policy,
      gitTimeoutMs: policy.limits.gitTimeoutMs,
    });
    expect(delOutcome.materialized).toBe(true);
    expect(existsSync(join(childDel, "apps/user/src/profile.ts"))).toBe(false);
  });

  it("IGNORE-UNTRACKED: a parent dist/ artifact is EXCLUDED from materialization", async () => {
    const baseSha = gitHead(repoPath);
    // policy ignores apps/user/dist/** — those untracked files must NOT carry.
    const ignoreHarness = setupHarness({ ignoreUntracked: ["apps/user/dist/**"] });
    const global = await loadGlobalPolicy(
      join(ignoreHarness, "policies/global.yaml"),
    );
    const repo = await loadRepoPolicy(
      join(ignoreHarness, "policies/repos/t.yaml"),
    );
    const policy = resolvePolicy(global, repo, "apps/user");

    const parentWt = buildWorktree("parent-ign", baseSha, (cwd) => {
      writeFileSync(join(cwd, "apps/user/src/keep.ts"), "export const k = 1;\n");
      mkdirSync(join(cwd, "apps/user/dist"), { recursive: true });
      writeFileSync(join(cwd, "apps/user/dist/bundle.js"), "ignored\n");
    });
    const childWt = buildWorktree("child-ign", baseSha, () => {});
    const outcome = await materializeParentWork({
      parentWorktreePath: parentWt,
      childWorktreePath: childWt,
      baseSha,
      policy,
      gitTimeoutMs: policy.limits.gitTimeoutMs,
    });
    expect(outcome.materialized).toBe(true);
    expect(outcome.paths).toContain("apps/user/src/keep.ts");
    expect(outcome.paths).not.toContain("apps/user/dist/bundle.js");
    expect(existsSync(join(childWt, "apps/user/src/keep.ts"))).toBe(true);
    expect(existsSync(join(childWt, "apps/user/dist/bundle.js"))).toBe(false);
  });

  it("NO-LEAK: a parent secret-suspect untracked file is materialized UNCOMMITTED in the child (no commit involved)", async () => {
    const baseSha = gitHead(repoPath);
    const policy = await resolvedTestPolicy(harness);
    const parentWt = buildWorktree("parent-secret", baseSha, (cwd) => {
      writeFileSync(
        join(cwd, "apps/user/src/.env"),
        "AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE\n",
      );
    });
    const childWt = buildWorktree("child-secret", baseSha, () => {});
    const outcome = await materializeParentWork({
      parentWorktreePath: parentWt,
      childWorktreePath: childWt,
      baseSha,
      policy,
      gitTimeoutMs: policy.limits.gitTimeoutMs,
    });
    expect(outcome.materialized).toBe(true);
    // The file is present UNCOMMITTED in the child working tree (untracked),
    // so the child run's normal secret-suspect handling applies. It is NOT
    // staged/committed — git index has no entry for it.
    expect(existsSync(join(childWt, "apps/user/src/.env"))).toBe(true);
    const status = execFileSync(
      "git",
      ["status", "--porcelain", "apps/user/src/.env"],
      { cwd: childWt },
    )
      .toString()
      .trim();
    expect(status.startsWith("??")).toBe(true); // untracked, never staged
  });

  it("returns parent_work_unavailable for an empty (no-surface) parent worktree", async () => {
    const baseSha = gitHead(repoPath);
    const policy = await resolvedTestPolicy(harness);
    const parentWt = buildWorktree("parent-clean", baseSha, () => {});
    const childWt = buildWorktree("child-clean", baseSha, () => {});
    const outcome = await materializeParentWork({
      parentWorktreePath: parentWt,
      childWorktreePath: childWt,
      baseSha,
      policy,
      gitTimeoutMs: policy.limits.gitTimeoutMs,
    });
    expect(outcome.materialized).toBe(false);
    expect(outcome.skippedReason).toBe("parent_work_unavailable");
  });

  it("returns parent_work_unavailable when the parent worktree path does not exist", async () => {
    const baseSha = gitHead(repoPath);
    const policy = await resolvedTestPolicy(harness);
    const childWt = buildWorktree("child-noparent", baseSha, () => {});
    const outcome = await materializeParentWork({
      parentWorktreePath: join(harness, "workspaces", "nope", "repo"),
      childWorktreePath: childWt,
      baseSha,
      policy,
      gitTimeoutMs: policy.limits.gitTimeoutMs,
    });
    expect(outcome.materialized).toBe(false);
    expect(outcome.skippedReason).toBe("parent_work_unavailable");
  });
});
