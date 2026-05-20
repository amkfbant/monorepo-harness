import { describe, it, expect } from "vitest";
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

function setupHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-cli-rp-"));
  mkdirSync(join(root, "runs/run-X"), { recursive: true });
  writeFileSync(
    join(root, "runs/run-X/meta.json"),
    JSON.stringify(
      {
        runId: "run-X",
        repoId: "t",
        repoPath: "/tmp/t",
        domain: "apps/user",
        workflow: "domain-coding",
        baseBranch: "main",
        baseSha: "abc",
        runBranch: "harness/x",
        status: "needs_review",
        startedAt: "2026-05-20T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(root, "runs/run-X/events.jsonl"), "");
  writeFileSync(
    join(root, "runs/run-X/review-decision.yaml"),
    [
      "runId: run-X",
      "domain: apps/user",
      "decision: approved",
      "required_changes: []",
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      "reviewer: alice",
      "reviewed_at: 2026-05-20T12:00:00Z",
      "",
    ].join("\n"),
  );
  return root;
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

describe("harness review process", () => {
  it("approves a needs_review run and updates meta + emits event", () => {
    const root = setupHarness();
    const { stdout, status } = run(
      ["review", "process", "--run-id", "run-X"],
      root,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/needs_review.*approved/);
    expect(stdout).toMatch(/reviewer=alice/);
    const meta = JSON.parse(
      readFileSync(join(root, "runs/run-X/meta.json"), "utf8"),
    );
    expect(meta.status).toBe("approved");
    const events = readFileSync(join(root, "runs/run-X/events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events[0]?.type).toBe("review_processed");
  });

  it("errors on pending decision", () => {
    const root = setupHarness();
    writeFileSync(
      join(root, "runs/run-X/review-decision.yaml"),
      [
        "runId: run-X",
        "domain: apps/user",
        "decision: pending",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: null",
        "reviewed_at: null",
        "",
      ].join("\n"),
    );
    const { stdout, status } = run(
      ["review", "process", "--run-id", "run-X"],
      root,
    );
    expect(status).toBe(1); // gate refusal: exit 1, not 2
    expect(stdout).toMatch(/pending/);
  });

  it("returns exit code 1 (not 2) for runId mismatch", () => {
    const root = setupHarness();
    writeFileSync(
      join(root, "runs/run-X/review-decision.yaml"),
      [
        "runId: run-something-else",
        "domain: apps/user",
        "decision: approved",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: alice",
        "reviewed_at: 2026-05-21T00:00:00Z",
        "",
      ].join("\n"),
    );
    const { status } = run(
      ["review", "process", "--run-id", "run-X"],
      root,
    );
    expect(status).toBe(1);
  });

  it("returns exit code 1 (not 2) for missing run directory", () => {
    const root = setupHarness();
    const { status } = run(
      ["review", "process", "--run-id", "run-does-not-exist"],
      root,
    );
    expect(status).toBe(1);
  });

  it("returns exit code 1 (not 2) for malformed review-decision.yaml", () => {
    const root = setupHarness();
    writeFileSync(
      join(root, "runs/run-X/review-decision.yaml"),
      "this: is: not: valid: yaml: {\n",
    );
    const { status } = run(
      ["review", "process", "--run-id", "run-X"],
      root,
    );
    expect(status).toBe(1);
  });

  it("warns when reviewer is null but still processes", () => {
    const root = setupHarness();
    writeFileSync(
      join(root, "runs/run-X/review-decision.yaml"),
      [
        "runId: run-X",
        "domain: apps/user",
        "decision: approved",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: null",
        "reviewed_at: 2026-05-20T12:00:00Z",
        "",
      ].join("\n"),
    );
    const { stdout, status } = run(
      ["review", "process", "--run-id", "run-X"],
      root,
    );
    expect(status).toBe(0);
    expect(stdout).toMatch(/warning.*reviewer field is null/i);
    const meta = JSON.parse(
      readFileSync(join(root, "runs/run-X/meta.json"), "utf8"),
    );
    expect(meta.status).toBe("approved");
  });
});
