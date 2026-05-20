import { describe, it, expect } from "vitest";
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
import { createWorktree } from "../../src/workspace/git-worktree.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

async function setupRun(status: string): Promise<{
  root: string;
  runId: string;
  worktreePath: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "harness-cleanup-cli-"));
  const repo = mkdtempSync(join(tmpdir(), "harness-target-"));
  const g = (a: string[]) =>
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "x\n");
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
    .toString()
    .trim();
  const runId = "run-cli-cleanup-001";
  const runBranch = `harness/${runId}/x`;
  const wt = await createWorktree({
    repoPath: repo,
    worktreesDir: join(root, "workspaces"),
    runId,
    branch: runBranch,
    base: baseSha,
  });
  mkdirSync(join(root, "runs", runId), { recursive: true });
  writeFileSync(
    join(root, "runs", runId, "meta.json"),
    JSON.stringify(
      {
        runId,
        repoId: "t",
        repoPath: repo,
        domain: "apps/user",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha,
        runBranch,
        status,
        startedAt: "2026-05-20T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "runs", runId, "events.jsonl"), "");
  return { root, runId, worktreePath: wt.path };
}

function run(
  args: string[],
  harnessRoot: string,
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: harnessRoot },
    }).toString();
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      status: err.status ?? 1,
    };
  }
}

describe("harness cleanup", () => {
  it("cleans up an approved run (worktree gone, run dir kept, meta=cleaned)", async () => {
    const s = await setupRun("approved");
    const { stdout, status } = run(
      ["cleanup", "--run-id", s.runId],
      s.root,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/worktreeRemoved=true/);
    expect(existsSync(s.worktreePath)).toBe(false);
    expect(existsSync(join(s.root, "runs", s.runId, "meta.json"))).toBe(true);
    const meta = JSON.parse(
      readFileSync(join(s.root, "runs", s.runId, "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("cleaned");
  });

  it("refuses to clean up needs_review without --force", async () => {
    const s = await setupRun("needs_review");
    const { stdout, status } = run(
      ["cleanup", "--run-id", s.runId],
      s.root,
    );
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/needs_review/);
    expect(existsSync(s.worktreePath)).toBe(true);
  });

  it("--force allows cleanup of failed-codex", async () => {
    const s = await setupRun("failed-codex");
    const { status } = run(
      ["cleanup", "--run-id", s.runId, "--force"],
      s.root,
    );
    expect(status).toBe(0);
    expect(existsSync(s.worktreePath)).toBe(false);
  });

  it("refuses changes_requested even with --force", async () => {
    const s = await setupRun("changes_requested");
    const { stdout, status } = run(
      ["cleanup", "--run-id", s.runId, "--force"],
      s.root,
    );
    expect(status).not.toBe(0);
    expect(stdout).toMatch(/changes_requested/);
  });

  it("returns exit code 1 (not 2) for gate refusals so automation can branch", async () => {
    const s = await setupRun("needs_review");
    const { status } = run(["cleanup", "--run-id", s.runId], s.root);
    expect(status).toBe(1);
  });
});
