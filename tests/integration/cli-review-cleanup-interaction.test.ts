import { describe, it, expect } from "vitest";
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
import { createWorktree } from "../../src/workspace/git-worktree.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

interface Setup {
  root: string;
  runId: string;
  worktreePath: string;
  repo: string;
}

async function setup(decisionYaml: string): Promise<Setup> {
  const root = mkdtempSync(join(tmpdir(), "harness-rc-"));
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
  const runId = "run-rc-interaction-001";
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
        status: "needs_review",
        startedAt: "2026-05-21T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "runs", runId, "events.jsonl"), "");
  writeFileSync(join(root, "runs", runId, "review-decision.yaml"), decisionYaml);
  return { root, runId, worktreePath: wt.path, repo };
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

const APPROVED_YAML = [
  "runId: run-rc-interaction-001",
  "domain: apps/user",
  "decision: approved",
  "required_changes: []",
  "non_blocking_comments: []",
  "out_of_scope_suggestions: []",
  "reviewer: alice",
  "reviewed_at: 2026-05-21T00:00:00Z",
  "",
].join("\n");

describe("T5: review process + cleanup sequential interaction", () => {
  it("review-then-cleanup: meta becomes approved, then cleaned", async () => {
    const s = await setup(APPROVED_YAML);

    const r1 = run(["review", "process", "--run-id", s.runId], s.root);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toMatch(/needs_review.*approved/);

    const r2 = run(["cleanup", "--run-id", s.runId], s.root);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/previousStatus=approved/);
    expect(existsSync(s.worktreePath)).toBe(false);
    const meta = JSON.parse(
      readFileSync(join(s.root, "runs", s.runId, "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("cleaned");
  });

  it("cleanup-then-review (with --force): meta becomes cleaned; review then rejects with exit 1", async () => {
    const s = await setup(APPROVED_YAML);

    // bring the run to a force-eligible state first (needs_review→failed
    // wouldn't be reachable here without breaking the test setup, so we
    // use --force to test the gate sequence).
    const r1 = run(
      ["cleanup", "--run-id", s.runId, "--force"],
      s.root,
    );
    expect(r1.status).toBe(0);

    const r2 = run(["review", "process", "--run-id", s.runId], s.root);
    expect(r2.status).toBe(1); // ReviewGateError → exit 1
    expect(r2.stdout).toMatch(/status is "cleaned"/);
  });
});
