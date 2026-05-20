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

function setupHarness(opts?: { ignoreUntracked?: string[] }): string {
  const root = mkdtempSync(join(tmpdir(), "harness-root-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  const ignoreBlock =
    opts?.ignoreUntracked && opts.ignoreUntracked.length > 0
      ? `ignore_untracked:\n${opts.ignoreUntracked.map((p) => `  - ${p}`).join("\n")}\n`
      : "";
  writeFileSync(
    join(root, "policies/global.yaml"),
    `always_deny_write:\n  - .git/**\n  - package.json\n${ignoreBlock}`,
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

  it("ends a healthy run at needs_review + safetyStatus=allowed with full artifact set", async () => {
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
      stderr: "warning: nothing\n",
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
    expect(r.safetyStatus).toBe("allowed");
    const runDir = join(harness, "runs", r.runId);
    expect(existsSync(join(runDir, "summary.md"))).toBe(true);
    expect(existsSync(join(runDir, "final-diff.patch"))).toBe(true);
    expect(existsSync(join(runDir, "untracked-files.patch"))).toBe(true);
    expect(existsSync(join(runDir, "untracked-files.txt"))).toBe(true);
    expect(existsSync(join(runDir, "knowledge-candidates.yaml"))).toBe(true);
    expect(existsSync(join(runDir, "review-request.md"))).toBe(true);
    expect(existsSync(join(runDir, "review-decision.yaml"))).toBe(true);
    expect(readFileSync(join(runDir, "final-diff.patch"), "utf8")).toMatch(
      /\+export const x = 1;/,
    );
    expect(readFileSync(join(runDir, "untracked-files.patch"), "utf8")).toMatch(
      /\+export const n = 1;/,
    );
    const summary = readFileSync(join(runDir, "summary.md"), "utf8");
    expect(summary).toMatch(/applied 2 files/);
    expect(summary).toMatch(/warning: nothing/);
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.safetyStatus).toBe("allowed");
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
    expect(r.safetyStatus).toBe("denied");
    const runDir = join(harness, "runs", r.runId);
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(
      /package\.json.*deny_write/,
    );
    expect(existsSync(join(harness, "workspaces", r.runId, "repo"))).toBe(true);
  });

  it("ignore_untracked filters .gitignore'd output without making it invisible", async () => {
    harness = setupHarness({ ignoreUntracked: ["dist/**"] });
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        // legit in-scope edit
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 2;\n",
        );
        // throwaway build output: not in scope, but explicitly ignored.
        mkdirSync(join(cwd, "dist"), { recursive: true });
        writeFileSync(join(cwd, "dist/out.js"), "compiled\n");
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
    // Without ignore_untracked filter, dist/out.js would be 'not_in_write_scope'
    // and fail the run. With filter, it surfaces in the summary but does NOT
    // block validation.
    expect(r.status).toBe("needs_review");
    expect(r.safetyStatus).toBe("allowed");
    const runDir = join(harness, "runs", r.runId);
    const summary = readFileSync(join(runDir, "summary.md"), "utf8");
    expect(summary).toMatch(/Ignored by ignore_untracked/);
    expect(summary).toMatch(/dist\/out\.js/);
  });

  it("captures .gitignored output as a violation when not in ignore_untracked", async () => {
    // ensure target repo has a .gitignore covering dist/
    writeFileSync(join(repoPath, ".gitignore"), "dist/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: repoPath });
    execFileSync("git", ["commit", "-qm", "ignore"], { cwd: repoPath });

    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        mkdirSync(join(cwd, "dist"), { recursive: true });
        writeFileSync(join(cwd, "dist/out.js"), "compiled\n");
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
    expect(r.safetyStatus).toBe("denied");
  });

  it("flags codex timeout as failed-codex-timeout but still records policy denied (orthogonal)", async () => {
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        // touch a deny_write path AND timeout — both should surface
        writeFileSync(join(cwd, "package.json"), "{}\n");
      },
      timedOut: true,
      exitCode: -1,
      stdout: "partial work\n",
      stderr: "killed by SIGKILL\n",
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
    expect(r.safetyStatus).toBe("denied");
    const runDir = join(harness, "runs", r.runId);
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.status).toBe("failed-codex-timeout");
    expect(meta.safetyStatus).toBe("denied");
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(/TIMEOUT/);
    expect(readFileSync(join(runDir, "review-request.md"), "utf8")).toMatch(
      /killed by SIGKILL/,
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
