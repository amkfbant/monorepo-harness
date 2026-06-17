import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFakeCodexRunner } from "../../src/codex/fake-codex-runner.js";
import { openDb } from "../../src/db/connection.js";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { createOrchestratorRunners } from "../../src/hitch/orchestrator-runners.js";
import { HitchRepository } from "../../src/hitch/repository.js";
import { HarnessMcpServer } from "../../src/mcp/server.js";
import {
  DEFAULT_MCP_CONFIG,
  type McpConfig,
} from "../../src/mcp/security/config.js";
import { prepareProjectRun } from "../../src/project/run-project.js";
import { CourseRepository } from "../../src/roadmap/course-repository.js";
import { createProductionCourseOrchestrator } from "../../src/roadmap/course-orchestrate-runtime.js";
import { PhaseRepository } from "../../src/roadmap/phase-repository.js";

interface Fixture {
  harnessRoot: string;
  dbPath: string;
  repoPath: string;
}

const ORIGINAL_CODEX_BIN = process.env.HARNESS_CODEX_BIN;

afterEach(() => {
  if (ORIGINAL_CODEX_BIN === undefined) {
    delete process.env.HARNESS_CODEX_BIN;
  } else {
    process.env.HARNESS_CODEX_BIN = ORIGINAL_CODEX_BIN;
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function setupFixture(): Fixture {
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-orch-project-"));
  mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
  mkdirSync(join(harnessRoot, "policies/repos"), { recursive: true });
  cpSync(join(process.cwd(), "templates"), join(harnessRoot, "templates"), {
    recursive: true,
  });

  writeFileSync(
    join(harnessRoot, "policies/global.yaml"),
    "always_deny_write: []\nignore_untracked: []\n",
  );
  writeFileSync(
    join(harnessRoot, "policies/repos/t.yaml"),
    [
      "repo_id: t",
      "read: []",
      "domains:",
      "  apps/user:",
      "    read: [apps/user/**, docs/**]",
      "    write: [apps/user/**, docs/**]",
      "    deny_write: []",
      "",
    ].join("\n"),
  );

  const repoPath = mkdtempSync(join(tmpdir(), "harness-orch-project-repo-"));
  git(repoPath, ["init", "-q", "-b", "main"]);
  git(repoPath, ["config", "user.email", "t@example.invalid"]);
  git(repoPath, ["config", "user.name", "Test"]);
  mkdirSync(join(repoPath, "apps/user/src"), { recursive: true });
  mkdirSync(join(repoPath, "docs"), { recursive: true });
  writeFileSync(join(repoPath, "apps/user/src/profile.ts"), "export const x = 0;\n");
  writeFileSync(join(repoPath, "docs/guide.md"), "# Guide\n\nInitial.\n");
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "target" }));
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-qm", "init"]);

  mkdirSync(join(harnessRoot, "projects"), { recursive: true });
  writeFileSync(
    join(harnessRoot, "projects/demo.yaml"),
    [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: t",
      `  path: ${JSON.stringify(repoPath)}`,
      "  package_manager: npm",
      "policy:",
      "  template: strict-monorepo-v1",
      "review:",
      "  mode: consensus",
      "  requirements:",
      "    - group: humans",
      "      min_approvals: 1",
      "      blocking_decisions: [changes_requested, rejected]",
      "domains:",
      "  - id: apps/user",
      "    root: apps/user",
      "    kind: app",
      "    read: [apps/user/**]",
      "    write: [apps/user/**]",
      "    deny_write: []",
      "",
    ].join("\n"),
  );

  return {
    harnessRoot,
    dbPath: join(harnessRoot, ".harness/harness.sqlite"),
    repoPath,
  };
}

function seedDrivableHitch(
  db: Database.Database,
  hitchId: string,
  projectId: string | null,
): void {
  const hitches = new HitchRepository(db);
  hitches.createSession({
    hitchId,
    title: "Fix project-scoped hitch",
    description: "Write docs from the fake coder",
    projectId,
    repoId: "t",
    domain: "apps/user",
    closeConditions: [{ id: "manual", kind: "manual", required: true }],
    createdBy: "test",
    createdSource: "worker",
  });
  hitches.upsertFinding({
    hitchId,
    source: "human",
    severity: "P1",
    category: "correctness",
    scopeStatus: "in_scope",
    summary: "needs a coder pass",
  });
}

function latestRunForHitch(dbPath: string, hitchId: string): {
  runId: string;
  status: string;
  provenance: { source?: string; project?: { projectId?: string } | null };
} {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT a.run_id AS runId, r.status AS status, s.provenance_json AS provenanceJson
           FROM hitch_attempts a
           JOIN runs r ON r.run_id = a.run_id
           JOIN effective_policy_snapshots s
             ON s.snapshot_id = r.effective_policy_snapshot_id
          WHERE a.hitch_id = ? AND a.run_id IS NOT NULL
          ORDER BY a.created_at DESC, a.attempt_id DESC
          LIMIT 1`,
      )
      .get(hitchId) as
      | { runId: string; status: string; provenanceJson: string }
      | undefined;
    if (row === undefined) throw new Error(`no run for hitch ${hitchId}`);
    return {
      runId: row.runId,
      status: row.status,
      provenance: JSON.parse(row.provenanceJson) as {
        source?: string;
        project?: { projectId?: string } | null;
      },
    };
  } finally {
    db.close();
  }
}

function reviewRuleSourceForRun(dbPath: string, runId: string): string {
  const db = openDb(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT rr.source AS source
           FROM run_review_rule_snapshots s
           JOIN review_rules rr ON rr.rule_id = s.rule_id
          WHERE s.run_id = ?`,
      )
      .get(runId) as { source: string } | undefined;
    if (row === undefined) throw new Error(`no review rule snapshot for ${runId}`);
    return row.source;
  } finally {
    db.close();
  }
}

function writeDocsCodexBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-orch-project-codex-"));
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      "echo '# Guide' > docs/guide.md",
      "echo '' >> docs/guide.md",
      "echo 'changed outside compiled project scope' >> docs/guide.md",
      "echo 'fake coder wrote docs'",
      "exit 0",
      "",
    ].join("\n"),
  );
  execFileSync("chmod", ["+x", bin]);
  return bin;
}

async function callTool(
  s: HarnessMcpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = (await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as { result: { structuredContent: Record<string, unknown> } };
  return response.result.structuredContent;
}

describe("project compiled policy in hitch/orchestrator paths", () => {
  it("uses compiled project policy for a coder run and denies raw-allowed docs writes", async () => {
    const f = setupFixture();
    const prepared = await prepareProjectRun({
      harnessRoot: f.harnessRoot,
      projectId: "demo",
      domain: "apps/user",
    });
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        runMigrations(db);
        seedDrivableHitch(db, "h-compiled", "demo");
      } finally {
        close();
      }
    }

    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner: createFakeCodexRunner({
        edit: async (cwd) => {
          writeFileSync(
            join(cwd, "docs/guide.md"),
            "# Guide\n\nchanged outside compiled project scope\n",
          );
        },
      }),
      reviewerRunner: createFakeCodexRunner(),
      repoPath: prepared.repoPath,
      baseBranch: prepared.baseBranch,
      projectRuntime: {
        compiledPolicy: prepared.compiledPolicy,
        reviewRuleResolution: prepared.reviewRuleResolution,
        project: prepared.project,
        ...(prepared.projectContextPacks !== undefined
          ? { projectContextPacks: prepared.projectContextPacks }
          : {}),
      },
    });

    const result = await runners.coder("h-compiled");

    expect(result.runStatus).toBe("failed-policy-violation");
    const run = latestRunForHitch(f.dbPath, "h-compiled");
    expect(run.status).toBe("failed-policy-violation");
    expect(run.provenance.source).toBe("project-runtime");
    expect(run.provenance.project?.projectId).toBe("demo");
    expect(reviewRuleSourceForRun(f.dbPath, run.runId)).toBe("project-profile");
  });

  it("fails closed for a project hitch when projectRuntime is missing", async () => {
    const f = setupFixture();
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        runMigrations(db);
        seedDrivableHitch(db, "h-missing-runtime", "demo");
      } finally {
        close();
      }
    }

    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner: createFakeCodexRunner({
        edit: async (cwd) => {
          writeFileSync(join(cwd, "docs/guide.md"), "# Guide\n\nraw fallback\n");
        },
      }),
      reviewerRunner: createFakeCodexRunner(),
      repoPath: f.repoPath,
      baseBranch: "main",
    });

    await expect(runners.coder("h-missing-runtime")).rejects.toThrow(
      /project-scoped.*compiled project policy.*raw repo policy fallback/i,
    );
    const { db, close } = openManagedDb({ dbPath: f.dbPath });
    try {
      expect(new HitchRepository(db).listAttempts("h-missing-runtime")).toEqual(
        [],
      );
    } finally {
      close();
    }
  });

  it("keeps raw repo policy behavior for non-project hitches", async () => {
    const f = setupFixture();
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        runMigrations(db);
        seedDrivableHitch(db, "h-raw", null);
      } finally {
        close();
      }
    }

    const runners = createOrchestratorRunners({
      dbPath: f.dbPath,
      harnessRoot: f.harnessRoot,
      createdBy: "test",
      coderRunner: createFakeCodexRunner({
        edit: async (cwd) => {
          writeFileSync(join(cwd, "docs/guide.md"), "# Guide\n\nraw allowed\n");
        },
      }),
      reviewerRunner: createFakeCodexRunner(),
      repoPath: f.repoPath,
      baseBranch: "main",
    });

    const result = await runners.coder("h-raw");

    expect(result.runStatus).toBe("needs_review");
    const run = latestRunForHitch(f.dbPath, "h-raw");
    expect(run.status).toBe("needs_review");
    expect(run.provenance.source).toBe("repo-policy");
    expect(run.provenance.project).toBeNull();
  });

  it("threads prepared project policy through MCP hitch.orchestrate", async () => {
    const f = setupFixture();
    process.env.HARNESS_CODEX_BIN = writeDocsCodexBin();
    {
      const { db, close } = openManagedDb({ dbPath: f.dbPath });
      try {
        runMigrations(db);
        seedDrivableHitch(db, "h-mcp", "demo");
      } finally {
        close();
      }
    }
    const config: McpConfig = {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedProjects: ["demo"],
      allowedOperations: ["hitch.orchestrate"],
      requireConfirmation: [],
    };
    const server = new HarnessMcpServer({
      harnessRoot: f.harnessRoot,
      config,
      clientName: "unit-test",
      transport: "stdio",
      sessionId: "mcp-orch-project-policy",
    });

    const response = await callTool(server, "harness.hitch.orchestrate", {
      hitchId: "h-mcp",
      idempotencyKey: "h-mcp-project-policy",
      maxSteps: 1,
    });

    expect(response.status).toBe("operation_started");
    const run = latestRunForHitch(f.dbPath, "h-mcp");
    expect(run.status).toBe("failed-policy-violation");
    expect(run.provenance.source).toBe("project-runtime");
    expect(reviewRuleSourceForRun(f.dbPath, run.runId)).toBe("project-profile");
  });

  it("threads prepared project policy through course orchestration", async () => {
    const f = setupFixture();
    const codexBin = writeDocsCodexBin();
    let courseId = "";
    const db = openDb(f.dbPath);
    try {
      runMigrations(db);
      const course = new CourseRepository(db).create({
        title: "Project course",
        projectId: "demo",
        repoId: "t",
        createdBy: "test",
        createdSource: "test",
      });
      courseId = course.courseId;
      const phase = new PhaseRepository(db).add({
        courseId,
        title: "Project phase",
        createdBy: "test",
        createdSource: "test",
      });
      seedDrivableHitch(db, "h-course", "demo");
      new PhaseRepository(db).linkHitch(phase.phaseId, "h-course");

      const result = await createProductionCourseOrchestrator({
        db,
        dbPath: f.dbPath,
        harnessRoot: f.harnessRoot,
        courseId,
        courseProjectId: "demo",
        createdBy: "test",
        codexBin,
      }).run({
        courseId,
        maxDrivenHitches: 1,
        maxStepsPerHitch: 1,
        createdBy: "test",
      });

      expect(result.drivenHitches).toEqual([
        expect.objectContaining({ hitchId: "h-course" }),
      ]);
    } finally {
      db.close();
    }

    const run = latestRunForHitch(f.dbPath, "h-course");
    expect(run.status).toBe("failed-policy-violation");
    expect(run.provenance.source).toBe("project-runtime");
    expect(reviewRuleSourceForRun(f.dbPath, run.runId)).toBe("project-profile");

    const runDir = join(f.harnessRoot, "runs", run.runId);
    expect(readFileSync(join(runDir, "resolved-policy.yaml"), "utf8")).toContain(
      "apps/user/**",
    );
  });
});
