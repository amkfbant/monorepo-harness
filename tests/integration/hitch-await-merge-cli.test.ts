import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessPaths } from "../../src/config/paths.js";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { HitchRepository } from "../../src/hitch/repository.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

function runCli(root: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: root },
    }).toString();
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      code: err.status ?? 1,
    };
  }
}

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-awaitmerge-cli-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  return root;
}

function seedGoal(root: string, hitchId: string, repoId: string): void {
  const { db, close } = openManagedDb({ dbPath: harnessPaths(root).dbPath });
  try {
    runMigrations(db);
    new HitchRepository(db).createSession({
      hitchId,
      title: "t",
      description: "d",
      repoId,
      domain: "docs",
      createdBy: "test",
      createdSource: "worker",
    });
  } finally {
    close();
  }
}

describe("hitch await-merge CLI validation (repo scoping)", () => {
  it("requires exactly one of <hitch-id> or --all", () => {
    const r = runCli(newRoot(), ["hitch", "await-merge", "--repo", "/x"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/exactly one of/);
  });

  it("requires --repo", () => {
    const r = runCli(newRoot(), ["hitch", "await-merge", "some-hitch"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--repo/);
  });

  it("--all requires --repo-id (must not span repos)", () => {
    const r = runCli(newRoot(), ["hitch", "await-merge", "--all", "--repo", "/x"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--repo-id/);
  });

  it("single hitch: rejects a --repo-id that does not match the hitch's repo", () => {
    const root = newRoot();
    seedGoal(root, "goal-rs", "repo-a");
    const r = runCli(root, [
      "hitch",
      "await-merge",
      "goal-rs",
      "--repo",
      "/x",
      "--repo-id",
      "repo-b",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/belongs to repo "repo-a", not "repo-b"/);
  });
});
