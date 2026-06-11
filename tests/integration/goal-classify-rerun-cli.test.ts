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

/** Seed a goal with ONE unknown-scope P1 finding (as an external review ingest
 *  would). Classifying it in-scope makes the goal `needs_fix`. Returns the ids. */
function seed(): { root: string; hitchId: string; findingId: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-classify-rerun-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const { db, close } = openManagedDb({ dbPath: harnessPaths(root).dbPath });
  try {
    runMigrations(db);
    const repo = new HitchRepository(db);
    const hitchId = "goal-cr";
    repo.createSession({
      hitchId,
      title: "t",
      description: "d",
      repoId: "t",
      domain: "docs",
      createdBy: "test",
      createdSource: "worker",
    });
    const { finding } = repo.upsertFinding({
      hitchId,
      source: "codex", // external review origin
      severity: "P1",
      category: "external-review-changes-requested",
      scopeStatus: "unknown",
      summary: "address the reviewer's change request",
    });
    return { root, hitchId, findingId: finding.findingId };
  } finally {
    close();
  }
}

describe("goal finding classify --then-rerun (C#8)", () => {
  it("plain classify (no --then-rerun) keeps the original output", () => {
    const { root, findingId } = seed();
    const r = runCli(root, [
      "goal",
      "finding",
      "classify",
      findingId,
      "--scope",
      "in-scope",
      "--reason",
      "confirmed",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/scope=in_scope lifecycle=open/);
    expect(r.out).not.toMatch(/rerun=/); // no chain output on the default path
  });

  it("--then-rerun on an in-scope classification that yields needs_fix requires --repo", () => {
    const { root, findingId } = seed();
    // classifying the only unknown P1 in-scope → needs_fix → the chain triggers
    // and demands --repo (proving it reached the rerun path, gated by convergence).
    const r = runCli(root, [
      "goal",
      "finding",
      "classify",
      findingId,
      "--scope",
      "in-scope",
      "--reason",
      "confirmed",
      "--then-rerun",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/--then-rerun requires --repo/);
  });

  it("--then-rerun skips the chain when classification does NOT yield needs_fix", () => {
    const { root, findingId } = seed();
    // reverting to unknown leaves the goal `needs_classification` (not
    // needs_fix), so the chain is skipped — and no --repo is required because we
    // never reach the rerun. The skip reason is surfaced.
    const r = runCli(root, [
      "goal",
      "finding",
      "classify",
      findingId,
      "--scope",
      "unknown",
      "--reason",
      "still unsure",
      "--then-rerun",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/rerun=skipped\(not_needs_fix\)/);
  });
});
