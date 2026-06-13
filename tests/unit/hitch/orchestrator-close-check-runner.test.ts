import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeReviewedFingerprint } from "../../../src/core/reviewed-fingerprint.js";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { HitchRepository } from "../../../src/hitch/repository.js";

const collectDiffMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/git/diff.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../src/git/diff.js")>(
      "../../../src/git/diff.js",
    );
  return {
    ...actual,
    collectDiff: collectDiffMock,
  };
});

describe("runCommandCloseChecks", () => {
  it("passes policy.limits.gitTimeoutMs to close-check diff collection", async () => {
    const { runCommandCloseChecks } = await import(
      "../../../src/hitch/orchestrator-close-check-runner.js"
    );
    collectDiffMock.mockResolvedValue({
      trackedChangedPaths: ["reviewed.txt"],
      stagedChangedPaths: [],
      untrackedPaths: [],
      patch: "",
    });
    const harnessRoot = mkdtempSync(join(tmpdir(), "harness-close-timeout-"));
    const dbPath = join(harnessRoot, ".harness", "harness.sqlite");
    const worktreePath = join(harnessRoot, "workspaces", "run-close", "repo");
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(join(harnessRoot, "policies", "repos"), { recursive: true });
    writeFileSync(join(worktreePath, "reviewed.txt"), "approved\n");
    writeFileSync(
      join(harnessRoot, "policies", "global.yaml"),
      [
        "always_deny_write: []",
        "ignore_untracked: []",
        "limits:",
        "  git_timeout_ms: 7",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(harnessRoot, "policies", "repos", "t.yaml"),
      [
        "repo_id: t",
        "read: []",
        "domains:",
        "  apps/user:",
        "    read: [apps/user/**]",
        "    write: [apps/user/**]",
        "    deny_write: []",
        "    commands:",
        "      allow:",
        "        - id: typecheck",
        "          cmd: node",
        "          args: [\"-e\", \"console.log('ok')\"]",
        "",
      ].join("\n"),
    );
    const fingerprint = await computeReviewedFingerprint(worktreePath, [
      "reviewed.txt",
    ]);
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-timeout",
        title: "Timeout",
        repoId: "t",
        domain: "apps/user",
        closeConditions: [
          { id: "typecheck", kind: "command", required: true },
        ],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.createAttempt({
        hitchId: "g-timeout",
        attemptType: "implement",
        status: "succeeded",
        runId: "run-close",
      });
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           base_sha, status, source_mode, db_revision, export_status,
           updated_at, meta_json)
         VALUES ('run-close', 't', 'apps/user', 'domain-coding', 'main',
           'base-sha', 'approved', 'db-first', 1, 'disabled',
           '2026-06-13T00:00:00.000Z', ?)`,
      ).run(JSON.stringify({ reviewed: { paths: ["reviewed.txt"], fingerprint } }));
    } finally {
      close();
    }

    await runCommandCloseChecks({
      deps: {
        dbPath,
        harnessRoot,
        createdBy: "worker",
      },
      hitchId: "g-timeout",
      resolveContext: () => ({
        repoPath: worktreePath,
        repoId: "t",
        domain: "apps/user",
        goal: "g",
        baseBranch: "main",
      }),
    });

    expect(collectDiffMock).toHaveBeenCalledTimes(2);
    expect(
      collectDiffMock.mock.calls.every(
        ([opts]) => opts?.timeoutMs === 7 && opts?.baseSha === "base-sha",
      ),
    ).toBe(true);
  });

  // P0 regression: a secret sitting JUST BEFORE the 8KiB tail boundary must be
  // withheld at the SOURCE. The old code sliced the last 8KiB BEFORE scanning,
  // so the token's prefix (`ghp_`) would be severed and its suffix would survive
  // into the recorded evidence (stdoutTail) and then the coder prompt.
  it("withholds a secret near the 8KiB tail boundary at the source (not just its prefix)", async () => {
    const { runCommandCloseChecks } = await import(
      "../../../src/hitch/orchestrator-close-check-runner.js"
    );
    collectDiffMock.mockResolvedValue({
      trackedChangedPaths: ["reviewed.txt"],
      stagedChangedPaths: [],
      untrackedPaths: [],
      patch: "",
    });
    const harnessRoot = mkdtempSync(join(tmpdir(), "harness-close-secret-"));
    const dbPath = join(harnessRoot, ".harness", "harness.sqlite");
    const worktreePath = join(harnessRoot, "workspaces", "run-close", "repo");
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(join(harnessRoot, "policies", "repos"), { recursive: true });
    writeFileSync(join(worktreePath, "reviewed.txt"), "approved\n");
    writeFileSync(
      join(harnessRoot, "policies", "global.yaml"),
      ["always_deny_write: []", "ignore_untracked: []", ""].join("\n"),
    );
    // The close-check command FAILS (exit 1) and prints ~9KiB of filler followed
    // by a GitHub token, so the token lands BEFORE the last 8KiB window.
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const tokenSuffix = token.slice(4); // what a slice-before-scan bug would leak
    const script =
      "process.stdout.write('F'.repeat(9000));" +
      `process.stdout.write('\\n${token}\\nlast line\\n');` +
      "process.exit(1);";
    writeFileSync(
      join(harnessRoot, "policies", "repos", "t.yaml"),
      [
        "repo_id: t",
        "read: []",
        "domains:",
        "  apps/user:",
        "    read: [apps/user/**]",
        "    write: [apps/user/**]",
        "    deny_write: []",
        "    commands:",
        "      allow:",
        "        - id: typecheck",
        "          cmd: node",
        `          args: ["-e", ${JSON.stringify(script)}]`,
        "",
      ].join("\n"),
    );
    const fingerprint = await computeReviewedFingerprint(worktreePath, [
      "reviewed.txt",
    ]);
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-secret",
        title: "Secret",
        repoId: "t",
        domain: "apps/user",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.createAttempt({
        hitchId: "g-secret",
        attemptType: "implement",
        status: "succeeded",
        runId: "run-close",
      });
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           base_sha, status, source_mode, db_revision, export_status,
           updated_at, meta_json)
         VALUES ('run-close', 't', 'apps/user', 'domain-coding', 'main',
           'base-sha', 'approved', 'db-first', 1, 'disabled',
           '2026-06-13T00:00:00.000Z', ?)`,
      ).run(
        JSON.stringify({ reviewed: { paths: ["reviewed.txt"], fingerprint } }),
      );
    } finally {
      close();
    }

    await runCommandCloseChecks({
      deps: { dbPath, harnessRoot, createdBy: "worker" },
      hitchId: "g-secret",
      resolveContext: () => ({
        repoPath: worktreePath,
        repoId: "t",
        domain: "apps/user",
        goal: "g",
        baseBranch: "main",
      }),
    });

    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      const check = new HitchRepository(db2)
        .listCloseChecks("g-secret")
        .find((c) => c.conditionId === "typecheck");
      const stdoutTail = String(check?.evidence?.["stdoutTail"] ?? "");
      // Neither the full token nor its 8KiB-severed suffix may survive.
      expect(stdoutTail).not.toContain(token);
      expect(stdoutTail).not.toContain(tokenSuffix);
      expect(stdoutTail).toContain("close-check output withheld");
    } finally {
      close2();
    }
  });
});
