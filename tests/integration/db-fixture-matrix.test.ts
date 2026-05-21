import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { runFullImport } from "../../src/db/import-files.js";
import { checkConsistency } from "../../src/db/consistency.js";
import { RunRepository } from "../../src/db/repositories/runs.js";
import { loadDashboardSnapshot } from "../../src/dashboard/snapshot.js";
import { exportDashboard } from "../../src/dashboard/export.js";

/**
 * Phase 6-9 — multi-project DB fixture matrix.
 *
 * One harness root holds the cases that stress the DB read model:
 *  - two projects sharing the domain id `apps/catalog`; one project's
 *    `project_id` deliberately differs from its `repo.id` (so a
 *    project/repo filter conflation bug is caught)
 *  - a generated repo policy + provenance sidecar
 *  - per-run knowledge candidates
 *  - a legacy `--repo-id` run (project_id = NULL)
 *  - a malformed run (import_errors)
 *  - a profile / generated policy that drifts after import (consistency)
 */

function writeProject(root: string, id: string, repoId: string): void {
  writeFileSync(
    join(root, "projects", `${id}.yaml`),
    [
      "version: 1",
      `project_id: ${id}`,
      "repo:",
      `  id: ${repoId}`,
      "domains:",
      "  - id: apps/catalog",
      "    root: apps/catalog",
      "    kind: app",
      "",
    ].join("\n"),
  );
}

function writeRun(
  root: string,
  runId: string,
  opts: {
    repoId: string;
    projectId?: string;
    status?: string;
    candidate?: boolean;
  },
): void {
  const dir = join(root, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId,
      repoId: opts.repoId,
      repoPath: "/tmp/x",
      domain: "apps/catalog",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: `harness/${runId}`,
      status: opts.status ?? "needs_review",
      startedAt: "2026-05-21T00:00:00Z",
      ...(opts.projectId !== undefined
        ? {
            project: {
              projectId: opts.projectId,
              profilePath: join(root, "projects", `${opts.projectId}.yaml`),
              profileVersion: 1,
              commandPresetIds: [],
              contextPackIds: [],
            },
          }
        : {}),
    }),
  );
  writeFileSync(join(dir, "events.jsonl"), `{"type":"run_started"}\n`);
  if (opts.candidate === true) {
    writeFileSync(
      join(dir, "knowledge-candidates.yaml"),
      [
        "candidates:",
        "  - kind: policy_violation",
        "    domain: apps/catalog",
        "    title: a finding",
        "    content: something happened",
        "    status: candidate",
        "",
      ].join("\n"),
    );
  }
}

function writeGeneratedPolicy(root: string, repoId: string): void {
  const reposDir = join(root, "policies", "repos");
  mkdirSync(reposDir, { recursive: true });
  writeFileSync(join(reposDir, `${repoId}.yaml`), `repo_id: ${repoId}\n`);
  writeFileSync(
    join(reposDir, `${repoId}.generated.json`),
    JSON.stringify({
      schemaVersion: 1,
      projectId: "mini-commerce",
      repoId,
      profilePath: "projects/mini-commerce.yaml",
      profileVersion: 1,
      policyTemplate: null,
      commandPresets: [],
      contextPackPresets: [],
      domainRegistry: null,
      generatedAt: "2026-05-22T00:00:00.000Z",
    }),
  );
}

/** A harness root populated with the full fixture matrix. */
function matrixRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-matrix-"));
  mkdirSync(join(root, "projects"), { recursive: true });
  // two projects, both with domain apps/catalog. web-app's project_id
  // differs from its repo.id (web-shop) on purpose.
  writeProject(root, "mini-commerce", "mini-commerce");
  writeProject(root, "web-app", "web-shop");
  writeGeneratedPolicy(root, "mini-commerce");
  // a project run per project, each with a knowledge candidate
  writeRun(root, "run-20260521-apps-catalog-mc1", {
    repoId: "mini-commerce",
    projectId: "mini-commerce",
    status: "approved",
    candidate: true,
  });
  writeRun(root, "run-20260521-apps-catalog-wa1", {
    repoId: "web-shop",
    projectId: "web-app",
    status: "needs_review",
    candidate: true,
  });
  // a legacy --repo-id run: no project block
  writeRun(root, "run-20260521-apps-catalog-lg1", {
    repoId: "legacy-repo",
    status: "needs_review",
  });
  // a malformed run
  const badDir = join(root, "runs", "run-20260521-apps-catalog-bad");
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, "meta.json"), "{ not json");
  return root;
}

function importedDb(root: string): ReturnType<typeof openDb> {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  runFullImport(db, { harnessRoot: root });
  return db;
}

describe("Phase 6-9 — multi-project DB fixture matrix", () => {
  it("imports projects / runs / generated policy and records the malformed run", () => {
    const root = matrixRoot();
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    runMigrations(db);
    const report = runFullImport(db, { harnessRoot: root });
    expect(report.projects).toBe(2);
    expect(report.runs).toBe(3); // the malformed run is not counted
    expect(report.policies).toBe(1);
    expect(report.errors).toBe(1);
    db.close();
  });

  it("separates the same domain across projects and keeps project/repo distinct", () => {
    const root = matrixRoot();
    const db = importedDb(root);
    const repo = new RunRepository(db);
    expect(
      repo
        .listRuns({ projectId: "mini-commerce", domain: "apps/catalog" })
        .map((r) => r.runId),
    ).toEqual(["run-20260521-apps-catalog-mc1"]);
    expect(
      repo
        .listRuns({ projectId: "web-app", domain: "apps/catalog" })
        .map((r) => r.runId),
    ).toEqual(["run-20260521-apps-catalog-wa1"]);
    // web-app's project_id is NOT a repo id — a repo filter on it must
    // return nothing (catches project/repo filter conflation).
    expect(repo.listRuns({ repoId: "web-app" })).toHaveLength(0);
    expect(
      repo.listRuns({ repoId: "web-shop" }).map((r) => r.runId),
    ).toEqual(["run-20260521-apps-catalog-wa1"]);
    // two distinct `domains` rows for the same domain_id
    const domains = db
      .prepare(
        "SELECT project_id FROM domains WHERE domain_id = 'apps/catalog' ORDER BY project_id",
      )
      .all() as { project_id: string }[];
    expect(domains.map((d) => d.project_id)).toEqual([
      "mini-commerce",
      "web-app",
    ]);
    db.close();
  });

  it("includes the legacy run by repo filter, excludes it by project filter", () => {
    const root = matrixRoot();
    const db = importedDb(root);
    const repo = new RunRepository(db);
    expect(
      repo.listRuns({ repoId: "legacy-repo" }).map((r) => r.runId),
    ).toEqual(["run-20260521-apps-catalog-lg1"]);
    expect(repo.listRuns({ projectId: "mini-commerce" })).toHaveLength(1);
    db.close();
  });

  it("consistency detects a profile and a generated policy that drift", () => {
    const root = matrixRoot();
    const db = importedDb(root);
    writeFileSync(
      join(root, "projects", "web-app.yaml"),
      "version: 1\nproject_id: web-app\nrepo:\n  id: web-shop\n" +
        "domains:\n  - id: apps/catalog\n    root: apps/catalog\n" +
        "    kind: app\ndescription: drifted\n",
    );
    writeFileSync(
      join(root, "policies", "repos", "mini-commerce.yaml"),
      "repo_id: mini-commerce\ndrifted: true\n",
    );
    const report = checkConsistency({ db, harnessRoot: root });
    expect(report.status).toBe("warn");
    expect(
      report.items.some((i) => i.kind === "project" && i.status === "drift"),
    ).toBe(true);
    expect(
      report.items.some((i) => i.kind === "policy" && i.status === "drift"),
    ).toBe(true);
    db.close();
  });

  it("builds a DashboardSnapshot with per-project domain / run / policy", () => {
    const root = matrixRoot();
    const snap = loadDashboardSnapshot({ harnessRoot: root });
    expect(snap.importedRuns).toBe(3);
    const byId = new Map(snap.projects.map((p) => [p.projectId, p]));
    expect(byId.get("mini-commerce")?.domainCount).toBe(1);
    expect(byId.get("mini-commerce")?.runCount).toBe(1);
    expect(byId.get("mini-commerce")?.hasGeneratedPolicy).toBe(true);
    expect(byId.get("web-app")?.hasGeneratedPolicy).toBe(false);
    expect(snap.warnings.some((w) => /import/.test(w.message))).toBe(true);
  });

  it("scopes knowledge / inbox aggregates per project", () => {
    const root = matrixRoot();
    const all = loadDashboardSnapshot({ harnessRoot: root });
    expect(all.knowledge.candidateTotal).toBe(2);
    expect(all.inbox.knowledgeCandidateRuns).toBe(2);
    const mc = loadDashboardSnapshot({
      harnessRoot: root,
      filters: { projectId: "mini-commerce" },
    });
    expect(mc.knowledge.candidateTotal).toBe(1);
    expect(mc.inbox.knowledgeCandidateRuns).toBe(1);
    expect(mc.overview.totalRuns).toBe(1);
  });

  it("exports a dashboard for the whole matrix and for one project", () => {
    const root = matrixRoot();
    const all = exportDashboard({
      harnessRoot: root,
      outPath: join(root, "all.html"),
    });
    expect(all.snapshot.overview.totalRuns).toBe(3);
    const scoped = exportDashboard({
      harnessRoot: root,
      outPath: join(root, "mc.html"),
      filters: { projectId: "mini-commerce" },
    });
    expect(scoped.snapshot.overview.totalRuns).toBe(1);
    expect(scoped.snapshot.projects.map((p) => p.projectId)).toEqual([
      "mini-commerce",
    ]);
  });
});
