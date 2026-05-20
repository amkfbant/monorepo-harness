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
  writeFileSync(join(repo, "apps/user/src/profile.ts"), "export const x = 0;\n");
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

  it("creates a run, edits inside scope, validates, and writes artifacts", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1; // edited\n",
        );
      },
      stdout: "ok\n",
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      keepWorktree: true,
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("success");
    const runDir = join(harness, "runs", r.runId);
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
    expect(existsSync(join(runDir, "final-diff.patch"))).toBe(true);
    expect(existsSync(join(runDir, "knowledge-candidates.yaml"))).toBe(true);
    expect(readFileSync(join(runDir, "final-diff.patch"), "utf8")).toMatch(
      /\+export const x = 1;/,
    );
  });

  it("rejects when codex edits outside the write scope", async () => {
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
      keepWorktree: true,
      codexRunner: runner,
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(r.status).toBe("failed-policy-violation");
    const runDir = join(harness, "runs", r.runId);
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(
      /package\.json.*deny_write/,
    );
  });

  it("rejects concurrent runs on the same domain", async () => {
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
      keepWorktree: false,
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
        keepWorktree: false,
        codexRunner: fast,
        now: new Date("2026-05-20T00:00:01Z"),
      }),
    ).rejects.toThrow(/locked/);
    await p1;
  });
});
