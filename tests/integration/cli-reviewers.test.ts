import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { ReviewerRepository } from "../../src/db/repositories/reviewers.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function setupHarness(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-reviewers-cli-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
    const reviewers = new ReviewerRepository(db);
    reviewers.add({
      reviewerId: "bob",
      reviewerType: "human",
      displayName: "Bob",
      groupId: "reviewers",
    });
    reviewers.add({
      reviewerId: "alice",
      reviewerType: "human",
      displayName: "Alice",
      groupId: "reviewers",
    });
    reviewers.add({
      reviewerId: "security-lead",
      reviewerType: "human",
      displayName: "Security Lead",
      groupId: "security",
    });
  } finally {
    db.close();
  }
  return root;
}

function run(args: string[], harnessRoot: string): RunResult {
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, HARNESS_ROOT: harnessRoot },
    encoding: "utf8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

describe("harness review reviewers", () => {
  it("list --group filters reviewers using deterministic reviewer_id order", () => {
    const root = setupHarness();
    const result = run(
      ["review", "reviewers", "list", "--group", "reviewers"],
      root,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const rows = result.stdout.trim().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("alice");
    expect(rows[1]).toContain("bob");
    expect(result.stdout).not.toContain("security-lead");
    expect(result.stdout).not.toContain("codex");
  });

  it("list --group prints none for an empty group", () => {
    const root = setupHarness();
    const result = run(
      ["review", "reviewers", "list", "--group", "missing"],
      root,
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("(none)\n");
    expect(result.stderr).toBe("");
  });
});
