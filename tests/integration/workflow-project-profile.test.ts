import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  RunFinalizedError,
  runDomainCoding,
} from "../../src/core/workflow-runner.js";
import { DEFAULT_REVIEW_RULE } from "../../src/core/review-rule.js";
import { createFakeCodexRunner } from "../../src/codex/fake-codex-runner.js";
import { prepareProjectRun } from "../../src/project/run-project.js";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { recordProjectProfileRevision } from "../../src/db/repositories/project-profile-revisions.js";

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-pp-repo-"));
  const g = (a: string[]) =>
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@e.com"]);
  g(["config", "user.name", "T"]);
  mkdirSync(join(repo, "apps/user/src"), { recursive: true });
  writeFileSync(join(repo, "apps/user/src/profile.ts"), "export const x = 0;\n");
  writeFileSync(join(repo, "README.md"), "# project context doc\n");
  writeFileSync(join(repo, "package-lock.json"), "{}");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }));
  g(["add", "."]);
  g(["commit", "-qm", "init"]);
  return repo;
}

function setupHarness(repoPath: string): string {
  const root = mkdtempSync(join(tmpdir(), "harness-pp-root-"));
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(
    join(root, "projects", "demo.yaml"),
    [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: t",
      `  path: ${repoPath}`,
      "  package_manager: npm",
      "policy:",
      "  template: strict-monorepo-v1",
      "context_packs:",
      "  docs:",
      "    globs: [README.md]",
      "domains:",
      "  - id: apps/user",
      "    root: apps/user",
      "    kind: app",
      "    context_packs: [docs]",
      "",
    ].join("\n"),
  );
  return root;
}

function seedDbProjectProfile(harness: string, yaml: string): number {
  const db = openDb(join(harness, ".harness", "harness.sqlite"));
  try {
    runMigrations(db);
    const r = recordProjectProfileRevision(db, {
      projectId: "demo",
      bodyYaml: yaml,
      parsed: parseYaml(yaml),
      actor: "test",
      reason: "phase17 db-first profile fixture",
      now: new Date("2026-05-25T00:00:00Z"),
    });
    return r.revision.revisionId;
  } finally {
    db.close();
  }
}

describe("run --project (fake codex)", () => {
  let repoPath: string;
  let harness: string;
  beforeEach(() => {
    repoPath = setupRepo();
    harness = setupHarness(repoPath);
  });

  it("E5-7-1: compiles the profile and runs the domain to needs_review", async () => {
    const prepared = await prepareProjectRun({
      harnessRoot: harness,
      projectId: "demo",
      domain: "apps/user",
    });
    const runner = createFakeCodexRunner({
      edit: async (cwd) => {
        writeFileSync(
          join(cwd, "apps/user/src/profile.ts"),
          "export const x = 1;\n",
        );
      },
      stdout: "done\n",
      stderr: "",
    });
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: prepared.repoId,
      domain: "apps/user",
      goal: "bump x",
      baseBranch: "main",
      codexRunner: runner,
      compiledPolicy: prepared.compiledPolicy,
      reviewRuleResolution: prepared.reviewRuleResolution,
      project: prepared.project,
      ...(prepared.projectContextPacks !== undefined
        ? {
            projectContextPacks: {
              promptText: prepared.projectContextPacks.promptText,
              manifestYaml: prepared.projectContextPacks.manifestYaml,
            },
          }
        : {}),
    });
    expect(r.status).toBe("needs_review");

    const runDir = join(harness, "runs", r.runId);
    // E5-7-2: run meta records the project provenance.
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    expect(meta.project.projectId).toBe("demo");
    expect(meta.project.policyTemplateId).toBe("strict-monorepo-v1");

    // E5-7-3: the context pack is injected and a manifest artifact written.
    expect(existsSync(join(runDir, "context-pack-manifest.yaml"))).toBe(true);
    const prompt = readFileSync(join(runDir, "codex-prompt.md"), "utf8");
    expect(prompt).toMatch(/Explicit project context packs/);
    expect(prompt).toMatch(/project context doc/);
  });

  it("freezes a project-profile review rule snapshot for a project run", async () => {
    writeFileSync(
      join(harness, "projects", "demo.yaml"),
      [
        "version: 1",
        "project_id: demo",
        "repo:",
        "  id: t",
        `  path: ${repoPath}`,
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
        "",
      ].join("\n"),
    );
    const prepared = await prepareProjectRun({
      harnessRoot: harness,
      projectId: "demo",
      domain: "apps/user",
    });
    expect(prepared.reviewRuleResolution.source).toBe("project-profile");
    const r = await runDomainCoding({
      harnessRoot: harness,
      repoPath,
      repoId: prepared.repoId,
      domain: "apps/user",
      goal: "no-op",
      baseBranch: "main",
      codexRunner: createFakeCodexRunner(),
      compiledPolicy: prepared.compiledPolicy,
      reviewRuleResolution: prepared.reviewRuleResolution,
      project: prepared.project,
    });

    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const row = db
        .prepare(
          `SELECT rr.source AS source, s.rule_json AS ruleJson
             FROM run_review_rule_snapshots s
             JOIN review_rules rr ON rr.rule_id = s.rule_id
            WHERE s.run_id = ?`,
        )
        .get(r.runId) as { source: string; ruleJson: string } | undefined;
      expect(row?.source).toBe("project-profile");
      expect(JSON.parse(row?.ruleJson ?? "{}")).toMatchObject({
        mode: "consensus",
        requirements: [{ group: "humans", minApprovals: 1 }],
      });
    } finally {
      db.close();
    }
  });

  it("hard-fails a project-profile run when review rule snapshotting fails", async () => {
    const prepared = await prepareProjectRun({
      harnessRoot: harness,
      projectId: "demo",
      domain: "apps/user",
    });
    const circularRule = { ...DEFAULT_REVIEW_RULE } as Record<string, unknown>;
    circularRule.self = circularRule;

    let error: unknown;
    try {
      await runDomainCoding({
        harnessRoot: harness,
        repoPath,
        repoId: prepared.repoId,
        domain: "apps/user",
        goal: "snapshot should fail",
        baseBranch: "main",
        codexRunner: createFakeCodexRunner(),
        compiledPolicy: prepared.compiledPolicy,
        reviewRuleResolution: {
          rule: circularRule as never,
          source: "project-profile",
          ruleSha256: "invalid",
        },
        project: prepared.project,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(RunFinalizedError);
    const runId = (error as RunFinalizedError).runId;
    const db = openDb(join(harness, ".harness", "harness.sqlite"));
    try {
      const row = db
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(runId) as { status: string } | undefined;
      expect(row?.status).toBe("failed-internal-error");
    } finally {
      db.close();
    }
  });

  it("E5-7-4: rejects an unknown domain", async () => {
    await expect(
      prepareProjectRun({
        harnessRoot: harness,
        projectId: "demo",
        domain: "apps/ghost",
      }),
    ).rejects.toThrow(/not defined/);
  });

  it("E5-7-6: surfaces the profile's repo.base_branch", async () => {
    writeFileSync(
      join(harness, "projects", "demo.yaml"),
      [
        "version: 1",
        "project_id: demo",
        "repo:",
        "  id: t",
        `  path: ${repoPath}`,
        "  base_branch: release",
        "policy:",
        "  template: strict-monorepo-v1",
        "domains:",
        "  - id: apps/user",
        "    root: apps/user",
        "    kind: app",
        "",
      ].join("\n"),
    );
    const prepared = await prepareProjectRun({
      harnessRoot: harness,
      projectId: "demo",
      domain: "apps/user",
    });
    expect(prepared.baseBranch).toBe("release");
  });

  it("Phase 17-1: prefers DB current profile revision over compatibility YAML", async () => {
    const yaml = [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: t",
      `  path: ${repoPath}`,
      "  base_branch: db-main",
      "  package_manager: npm",
      "policy:",
      "  template: strict-monorepo-v1",
      "domains:",
      "  - id: apps/user",
      "    root: apps/user",
      "    kind: app",
      "",
    ].join("\n");
    const revisionId = seedDbProjectProfile(harness, yaml);
    unlinkSync(join(harness, "projects", "demo.yaml"));

    const prepared = await prepareProjectRun({
      harnessRoot: harness,
      projectId: "demo",
      domain: "apps/user",
    });

    expect(prepared.baseBranch).toBe("db-main");
    expect(prepared.project.profileSource).toBe("db");
    expect(prepared.project.profileRevisionId).toBe(revisionId);
    expect(prepared.resolvedPolicy.domain).toBe("apps/user");
  });
});
