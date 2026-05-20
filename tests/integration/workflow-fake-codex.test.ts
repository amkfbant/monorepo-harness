import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDomainCoding } from "../../src/core/workflow-runner.js";
import { createFakeCodexRunner } from "../../src/codex/fake-codex-runner.js";

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-target-"));
  const g = (a: string[]) =>
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  mkdirSync(join(repo, "apps/user/src"), { recursive: true });
  writeFileSync(
    join(repo, "apps/user/src/profile.ts"),
    "export const x = 0;\n",
  );
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  return repo;
}

function setupHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-root-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  writeFileSync(
    join(root, "policies/global.yaml"),
    "always_deny_write:\n  - .git/**\n  - package.json\n",
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

describe("runDomainCoding (fake codex)", () => {
  let repoPath: string;
  let harness: string;
  beforeEach(() => {
    repoPath = setupRepo();
    harness = setupHarness();
  });

  it("ends a healthy run at needs_review with full artifact set", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1; // edited\n",
        );
        writeFileSync(
          join(cwd, "apps/user/src/new.ts"),
          "export const n = 1;\n",
        );
      },
      stdout: "applied 2 files\n",
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("needs_review");
    const runDir = join(harness, "runs", r.runId);
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
    expect(existsSync(join(runDir, "final-diff.patch"))).toBe(true);
    expect(existsSync(join(runDir, "knowledge-candidates.yaml"))).toBe(true);
    expect(existsSync(join(runDir, "review-request.md"))).toBe(true);
    expect(existsSync(join(runDir, "review-decision.yaml"))).toBe(true);
    expect(existsSync(join(runDir, "untracked-files.txt"))).toBe(true);
    expect(readFileSync(join(runDir, "final-diff.patch"), "utf8")).toMatch(
      /\+export const x = 1;/,
    );
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(
      /applied 2 files/,
    );
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.baseSha).toMatch(/^[0-9a-f]{40}$/);
    // worktree must still exist for review
    expect(existsSync(join(harness, "workspaces", r.runId, "repo"))).toBe(true);
  });

  it("rejects untracked writes outside the write scope", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(join(cwd, "package.json"), "{}\n");
      },
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("failed-policy-violation");
    const runDir = join(harness, "runs", r.runId);
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(
      /package\.json.*deny_write/,
    );
    // worktree preserved on failure for inspection
    expect(existsSync(join(harness, "workspaces", r.runId, "repo"))).toBe(true);
  });

  it("treats codex timeout as failed-codex-timeout and still saves diff", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 99;\n",
        );
      },
      timedOut: true,
      exitCode: -1,
      stdout: "partial work\n",
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "x",
      baseBranch: "main",
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("failed-codex-timeout");
    const runDir = join(harness, "runs", r.runId);
    expect(readFileSync(join(runDir, "final-diff.patch"), "utf8")).toMatch(
      /\+export const x = 99;/,
    );
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(
      /TIMEOUT/,
    );
  });

  it("rejects concurrent runs on the same domain via lockfile", async () => {
    const slow = createFakeCodexRunner({
      edit: async () => {
        await new Promise((res) => setTimeout(res, 200));
      },
    });
    const fast = createFakeCodexRunner({ edit: async () => {} });

    const p1 = runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "a",
      baseBranch: "main",
      codexRunner: slow,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    await new Promise((res) => setTimeout(res, 50));
    await expect(
      runDomainCoding({
        harnessRoot: harness,
        repoPath,
        repoId: "t",
        domain: "apps/user",
        goal: "b",
        baseBranch: "main",
        codexRunner: fast,
        now: new Date("2026-05-20T00:00:01Z"),
      }),
    ).rejects.toThrow(/locked/);
    await p1;
  });
});
