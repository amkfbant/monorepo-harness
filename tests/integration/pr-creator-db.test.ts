import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPullRequest,
  type PrPublisher,
  type PrPublishInputs,
} from "../../src/core/pr-creator.js";
import { computeReviewedFingerprint } from "../../src/core/reviewed-fingerprint.js";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";

/**
 * Phase 7-10 — `pr create` DB-first: the pull request is recorded in
 * `pull_requests` as the canonical record, creation is idempotent, and a
 * failed external creation is recoverable.
 */

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

interface Fixture {
  root: string;
  runId: string;
  dbPath: string;
}

/** A harness root with one db-first approved run ready for `pr create`. */
async function setup(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "harness-prdb-"));
  mkdirSync(join(root, "runs"), { recursive: true });
  mkdirSync(join(root, "workspaces"), { recursive: true });

  const target = mkdtempSync(join(tmpdir(), "harness-prdb-target-"));
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "T"]);
  mkdirSync(join(target, "apps/x"), { recursive: true });
  writeFileSync(join(target, "apps/x/f.ts"), "export const v = 0;\n");
  git(target, ["add", "."]);
  git(target, ["commit", "-qm", "init"]);
  const bareRemote = mkdtempSync(join(tmpdir(), "harness-prdb-bare-")) + ".git";
  execFileSync("git", ["init", "-q", "--bare", bareRemote]);
  git(target, ["remote", "add", "origin", bareRemote]);
  git(target, ["push", "-q", "-u", "origin", "main"]);

  const runId = "run-20260522-apps-x-prdb1";
  const runBranch = `harness/${runId}/apps-x`;
  const worktree = join(root, "workspaces", runId, "repo");
  git(target, ["worktree", "add", "-q", "-b", runBranch, worktree, "main"]);
  writeFileSync(join(worktree, "apps/x/f.ts"), "export const v = 1;\n");

  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const fingerprint = await computeReviewedFingerprint(worktree, [
    "apps/x/f.ts",
  ]);
  const meta = {
    runId,
    repoId: "x-repo",
    domain: "apps/x",
    status: "approved",
    safetyStatus: "allowed",
    runBranch,
    reviewer: "knkn",
    reviewedAt: "2026-05-22T00:00:00Z",
    reviewed: { paths: ["apps/x/f.ts"], fingerprint },
    startedAt: "2026-05-22T00:00:00Z",
  };
  writeFileSync(
    join(runDir, "meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
  );
  writeFileSync(join(runDir, "events.jsonl"), "");
  writeFileSync(
    join(runDir, "codex-prompt.md"),
    "x\n\nGoal:\nadd a v constant\n\nTarget domain:\napps/x\n",
  );

  // seed a db-first run row mirroring meta.json
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       run_branch, status, started_at, updated_at, source_mode, db_revision,
       meta_json)
     VALUES (?, 'x-repo', 'apps/x', 'domain-coding', 'main', ?, 'approved',
       '2026-05-22T00:00:00Z', '2026-05-22T00:00:00Z', 'db-first', 1, ?)`,
  ).run(runId, runBranch, `${JSON.stringify(meta, null, 2)}`);
  db.close();

  return { root, runId, dbPath };
}

function fakePublisher(): PrPublisher & { calls: PrPublishInputs[] } {
  const calls: PrPublishInputs[] = [];
  return {
    calls,
    async publish(inputs: PrPublishInputs) {
      calls.push(inputs);
      return { url: "https://github.com/o/r/pull/7", number: 7 };
    },
  };
}

function optsFor(f: Fixture, publisher: PrPublisher) {
  return {
    runsDir: join(f.root, "runs"),
    workspacesDir: join(f.root, "workspaces"),
    locksDir: join(f.root, "locks"),
    dbPath: f.dbPath,
    runId: f.runId,
    base: "main",
    draft: true,
    publisher,
  };
}

function pullRequestRow(dbPath: string, runId: string): Record<string, unknown> {
  const db = openDb(dbPath);
  runMigrations(db);
  const row = db
    .prepare("SELECT * FROM pull_requests WHERE run_id = ?")
    .get(runId) as Record<string, unknown>;
  db.close();
  return row;
}

describe("pr create DB-first", () => {
  it("records the PR in pull_requests and the run row", async () => {
    const f = await setup();
    const r = await createPullRequest(optsFor(f, fakePublisher()));
    expect(r.prNumber).toBe(7);

    const pr = pullRequestRow(f.dbPath, f.runId);
    expect(pr.status).toBe("created");
    expect(pr.url).toBe("https://github.com/o/r/pull/7");
    expect(pr.external_pr_id).toBe("7");
    expect(pr.provider).toBe("github");

    const db = openDb(f.dbPath);
    runMigrations(db);
    const run = db
      .prepare("SELECT pr_url, pr_number FROM runs WHERE run_id = ?")
      .get(f.runId) as { pr_url: string; pr_number: number };
    db.close();
    expect(run.pr_url).toBe("https://github.com/o/r/pull/7");
    expect(run.pr_number).toBe(7);
    // meta.json was re-exported from the DB with the PR fields
    const meta = JSON.parse(
      readFileSync(join(f.root, "runs", f.runId, "meta.json"), "utf8"),
    ) as { prUrl: string };
    expect(meta.prUrl).toBe("https://github.com/o/r/pull/7");
  });

  it("gates a db-first run from the DB even if meta.json is deleted (P1-3)", async () => {
    const f = await setup();
    // a db-first run's meta.json is a compatibility export — delete it
    const { rmSync } = await import("node:fs");
    rmSync(join(f.root, "runs", f.runId, "meta.json"));
    const r = await createPullRequest(optsFor(f, fakePublisher()));
    expect(r.prNumber).toBe(7);
    // the PR was recorded against the run from its DB-canonical state
    expect(pullRequestRow(f.dbPath, f.runId).status).toBe("created");
  });

  it("is idempotent — a second create returns the recorded PR", async () => {
    const f = await setup();
    await createPullRequest(optsFor(f, fakePublisher()));
    const second = fakePublisher();
    const r = await createPullRequest(optsFor(f, second));
    // the recorded PR short-circuits — no second external publish
    expect(second.calls).toHaveLength(0);
    expect(r.prNumber).toBe(7);
  });

  it("records a failed external creation, recoverable on retry", async () => {
    const f = await setup();
    const failing: PrPublisher = {
      async publish() {
        throw new Error("gh: network down");
      },
    };
    await expect(
      createPullRequest(optsFor(f, failing)),
    ).rejects.toThrow(/network down/);
    expect(pullRequestRow(f.dbPath, f.runId).status).toBe("failed");

    // a retry with a working publisher recovers the same row to created
    const r = await createPullRequest(optsFor(f, fakePublisher()));
    expect(r.prNumber).toBe(7);
    expect(pullRequestRow(f.dbPath, f.runId).status).toBe("created");
  });
});
