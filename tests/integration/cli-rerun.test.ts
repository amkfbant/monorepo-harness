import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function run(
  args: string[],
  harnessRoot: string,
  extraEnv: NodeJS.ProcessEnv = {},
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: harnessRoot, ...extraEnv },
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

function setupParent(opts: {
  status: string;
  decision: string;
  requiredChanges?: string[];
}): { root: string; runId: string; repoPath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-rerun-cli-"));
  mkdirSync(join(root, "policies/repos"), { recursive: true });
  writeFileSync(
    join(root, "policies/global.yaml"),
    "always_deny_write: []\nignore_untracked: []\n",
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

  // bare target repo (not actually used because we stub the codex bin)
  const repoPath = mkdtempSync(join(tmpdir(), "harness-target-"));
  const g = (a: string[]) =>
    execFileSync("git", a, { cwd: repoPath, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  mkdirSync(join(repoPath, "apps/user/src"), { recursive: true });
  writeFileSync(
    join(repoPath, "apps/user/src/profile.ts"),
    "export const x = 0;\n",
  );
  g(["add", "."]);
  g(["commit", "-qm", "init"]);

  const runId = "run-20260521-apps-user-parent01";
  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        runId,
        repoId: "t",
        repoPath,
        domain: "apps/user",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha: "abc",
        runBranch: `harness/${runId}/x`,
        status: opts.status,
        startedAt: "2026-05-21T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(runDir, "events.jsonl"), "");
  const required = opts.requiredChanges ?? ["fix the validation message"];
  writeFileSync(
    join(runDir, "review-decision.yaml"),
    [
      `runId: ${runId}`,
      "domain: apps/user",
      `decision: ${opts.decision}`,
      `required_changes:\n${required.map((c) => `  - "${c}"`).join("\n")}`,
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      "reviewer: alice",
      "reviewed_at: 2026-05-21T00:10:00Z",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(runDir, "codex-prompt.md"),
    [
      "You are working on a monorepo domain task.",
      "",
      "Goal:",
      "Add category validation to product search.",
      "",
      "Target domain:",
      "apps/user",
    ].join("\n"),
  );
  return { root, runId, repoPath };
}

// A fake codex binary that just edits a file in the worktree. The cwd is
// the worktree path (passed via -C). We bypass real codex by intercepting
// HARNESS_CODEX_BIN.
function writeFakeCodexBin(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-fake-codex-"));
  const bin = join(dir, "codex");
  // Just create a deterministic change. The harness needs status=needs_review
  // so writing inside scope is enough.
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      // -C <worktree-path> is passed as 4th flag; capture from args.
      "WT=$3",
      'echo "export const fake = 42;" > "$WT/apps/user/src/fake.ts"',
      'echo "fake codex done"',
      "exit 0",
    ].join("\n"),
  );
  execFileSync("chmod", ["+x", bin]);
  return bin;
}

describe("harness rerun --from-review", () => {
  it("exit 1 when --from-review parent is in approved (not changes_requested)", () => {
    const s = setupParent({ status: "approved", decision: "approved" });
    const r = run(["rerun", "--from-review", s.runId], s.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/changes_requested/);
  });

  it("exit 1 when decision is not changes_requested", () => {
    const s = setupParent({
      status: "changes_requested",
      decision: "approved",
    });
    const r = run(["rerun", "--from-review", s.runId], s.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/decision=changes_requested/);
  });

  it("exit 1 on path-traversal --from-review value", () => {
    const s = setupParent({
      status: "changes_requested",
      decision: "changes_requested",
    });
    const r = run(["rerun", "--from-review", "../escape"], s.root);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/invalid parentRunId/);
  });

  it("spawns a new run with parentRunId recorded in meta.json", () => {
    const s = setupParent({
      status: "changes_requested",
      decision: "changes_requested",
      requiredChanges: ["use err() consistently", "add empty-string test"],
    });
    const fakeBin = writeFakeCodexBin(s.root);
    const r = run(["rerun", "--from-review", s.runId], s.root, {
      HARNESS_CODEX_BIN: fakeBin,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/parentRunId=run-20260521-apps-user-parent01/);
    // new runId is on the first token after "run="
    const newRunId = r.stdout.match(/run=([\w.-]+)/)?.[1];
    expect(newRunId).toBeDefined();
    expect(newRunId).not.toBe(s.runId);
    const meta = JSON.parse(
      readFileSync(join(s.root, "runs", newRunId!, "meta.json"), "utf8"),
    );
    expect(meta.parentRunId).toBe(s.runId);
    // codex-prompt.md should embed the required_changes block
    const prompt = readFileSync(
      join(s.root, "runs", newRunId!, "codex-prompt.md"),
      "utf8",
    );
    expect(prompt).toMatch(/use err\(\) consistently/);
    expect(prompt).toMatch(/add empty-string test/);
  });

  it("records rootRunId / rerunAttempt in the child meta.json", () => {
    const s = setupParent({
      status: "changes_requested",
      decision: "changes_requested",
    });
    const fakeBin = writeFakeCodexBin(s.root);
    const r = run(["rerun", "--from-review", s.runId], s.root, {
      HARNESS_CODEX_BIN: fakeBin,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/rootRunId=run-20260521-apps-user-parent01/);
    expect(r.stdout).toMatch(/rerunAttempt=1/);
    const newRunId = r.stdout.match(/run=([\w.-]+)/)?.[1];
    const meta = JSON.parse(
      readFileSync(join(s.root, "runs", newRunId!, "meta.json"), "utf8"),
    );
    expect(meta.rootRunId).toBe(s.runId);
    expect(meta.rerunAttempt).toBe(1);
  });

  it("exit 1 when --max-attempts is exceeded", () => {
    const s = setupParent({
      status: "changes_requested",
      decision: "changes_requested",
    });
    // make the parent look like it is already attempt 2
    const metaPath = join(s.root, "runs", s.runId, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.rerunAttempt = 2;
    meta.rootRunId = "run-20260521-apps-user-root";
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const r = run(
      ["rerun", "--from-review", s.runId, "--max-attempts", "2"],
      s.root,
      {},
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/exceeding --max-attempts 2/);
  });

  it("'rerun' without --from-review exits 1 with a hint", () => {
    const s = setupParent({
      status: "changes_requested",
      decision: "changes_requested",
    });
    const r = run(["rerun"], s.root, {});
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/requires --from-review/);
  });

  it("'rerun chain' prints the chain for a run", () => {
    const s = setupParent({
      status: "changes_requested",
      decision: "changes_requested",
    });
    // add a child run dir pointing at the parent
    const childId = "run-20260521-apps-user-child9";
    const childDir = join(s.root, "runs", childId);
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(childDir, "meta.json"),
      JSON.stringify({
        runId: childId,
        domain: "apps/user",
        status: "needs_review",
        parentRunId: s.runId,
        rootRunId: s.runId,
        rerunAttempt: 1,
        startedAt: "2026-05-21T01:00:00Z",
      }),
    );
    const r = run(["rerun", "chain", "--run-id", childId], s.root, {});
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/run-20260521-apps-user-parent01/);
    expect(r.stdout).toMatch(/run-20260521-apps-user-child9.*needs_review/);
  });
});
