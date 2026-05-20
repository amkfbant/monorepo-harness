import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { parse as parseYaml } from "yaml";
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
    expect(r.ignoredUntrackedCount).toBe(1);
    const runDir = join(harness, "runs", r.runId);
    const summary = readFileSync(join(runDir, "summary.md"), "utf8");
    expect(summary).toMatch(/Ignored by ignore_untracked/);
    expect(summary).toMatch(/dist\/out\.js/);
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.ignoredUntrackedCount).toBe(1);
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

  it("never writes denied untracked content into artifacts (security boundary)", async () => {
    // Codex drops a .env-like file at the repo root. This is out of scope
    // (apps/user/** is the write scope) AND likely contains secrets.
    // The path should appear in violations + untracked-denied.txt but the
    // content (SECRET=hunter2) must never land in any artifact.
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(join(cwd, ".env"), "SECRET=hunter2\n");
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
    // untracked-files.patch should NOT exist (no allowed untracked) OR
    // must not contain the secret.
    const utPatchPath = join(runDir, "untracked-files.patch");
    if (existsSync(utPatchPath)) {
      expect(readFileSync(utPatchPath, "utf8")).not.toMatch(/hunter2/);
    }
    // untracked-denied.txt should exist and reference the path with sha256
    // but NOT include the bytes.
    const deniedPath = join(runDir, "untracked-denied.txt");
    expect(existsSync(deniedPath)).toBe(true);
    const denied = readFileSync(deniedPath, "utf8");
    expect(denied).not.toMatch(/hunter2/);
    expect(denied).toMatch(/\.env\s+size=\d+\s+sha256=[0-9a-f]{64}/);
    // summary still surfaces the violation
    expect(readFileSync(join(runDir, "summary.md"), "utf8")).toMatch(
      /\.env.*not_in_write_scope/,
    );
  });

  it("never follows symlinks when generating untracked artifacts", async () => {
    const outside = mkdtempSync(join(tmpdir(), "harness-secret-"));
    writeFileSync(join(outside, "secret"), "SUPERSECRET\n");
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        // in-scope path that symlinks out of the repo entirely
        symlinkSync(join(outside, "secret"), join(cwd, "apps/user/leak.ts"));
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
    // Path is in scope, so policy allows it — but content must NOT have
    // been read across the symlink.
    expect(r.safetyStatus).toBe("allowed");
    const runDir = join(harness, "runs", r.runId);
    const utPatch = readFileSync(
      join(runDir, "untracked-files.patch"),
      "utf8",
    );
    expect(utPatch).not.toMatch(/SUPERSECRET/);
    expect(utPatch).toMatch(/@@ symlink @@/);
  });

  it("writes resolved-policy.yaml as actual YAML", async () => {
    const runner = createFakeCodexRunner({ edit: async () => {} });
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
    const runDir = join(harness, "runs", r.runId);
    const raw = readFileSync(join(runDir, "resolved-policy.yaml"), "utf8");
    expect(raw.trimStart().startsWith("{")).toBe(false);
    const parsed = parseYaml(raw) as { domain: string; codex: { sandbox: string } };
    expect(parsed.domain).toBe("apps/user");
    expect(parsed.codex.sandbox).toBe("workspace-write");
  });

  it("redacts secret-shaped untracked files even when path policy allows them", async () => {
    // apps/user/** is the allowed write scope, so policy alone would let
    // .env.local through. The secret scanner must keep its content out
    // of artifacts anyway, and surface the count.
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1;\n",
        );
        writeFileSync(
          join(cwd, "apps/user/.env.local"),
          "DB_URL=postgres://user:hunter2@host/db\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n",
        );
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
    expect(r.status).toBe("needs_review");
    expect(r.safetyStatus).toBe("allowed");
    expect(r.secretSuspectCount).toBe(1);
    const runDir = join(harness, "runs", r.runId);
    const untrackedPatch = readFileSync(
      join(runDir, "untracked-files.patch"),
      "utf8",
    );
    expect(untrackedPatch).not.toMatch(/hunter2/);
    expect(untrackedPatch).not.toMatch(/AKIAIOSFODNN7EXAMPLE/);
    expect(untrackedPatch).toMatch(/@@ secret-suspect/);
    // Index artifact lists the suspect with its trigger reasons.
    const secretsList = readFileSync(
      join(runDir, "untracked-secrets.txt"),
      "utf8",
    );
    expect(secretsList).toMatch(/apps\/user\/\.env\.local/);
    expect(secretsList).toMatch(/filename:\.env/);
    expect(secretsList).toMatch(/content:aws-access-key-id/);
    // Review surfaces flag it prominently.
    expect(readFileSync(join(runDir, "review-request.md"), "utf8")).toMatch(
      /Secret-shaped files/,
    );
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.secretSuspectCount).toBe(1);
  });

  it("finalizes meta as failed-internal-error when codex runner throws after createRunLog", async () => {
    // simulate an unexpected runner-level crash (not a normal non-zero exit).
    const exploder = {
      async run(): Promise<never> {
        throw new Error("runner exploded");
      },
    };
    await expect(
      runDomainCoding({
        harnessRoot: harness,
        repoPath,
        repoId: "t",
        domain: "apps/user",
        goal: "x",
        baseBranch: "main",
        codexRunner: exploder,
        now: new Date("2026-05-20T00:00:00Z"),
      }),
    ).rejects.toThrow(/runner exploded/);
    // find the orphaned run dir (createRunLog succeeded before the throw)
    const { readdirSync } = await import("node:fs");
    const runDirs = readdirSync(join(harness, "runs"));
    expect(runDirs.length).toBe(1);
    const meta = JSON.parse(
      readFileSync(join(harness, "runs", runDirs[0]!, "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("failed-internal-error");
    expect(meta.safetyStatus).toBe("skipped");
    expect(meta.finishedAt).toBeDefined();
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
