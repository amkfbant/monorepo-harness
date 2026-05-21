import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { runFullImport } from "../../../src/db/import-files.js";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "harness-imp-"));
}

function db(root: string) {
  const d = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(d);
  return d;
}

const PROFILE = [
  "version: 1",
  "project_id: demo",
  "repo:",
  "  id: demo",
  "policy:",
  "  template: strict-monorepo-v1",
  "domains:",
  "  - id: apps/web",
  "    root: apps/web",
  "    kind: app",
  "",
].join("\n");

function writeRun(
  root: string,
  runId: string,
  meta: Record<string, unknown> = {},
): void {
  const dir = join(root, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId,
      repoId: "demo",
      repoPath: "/tmp/demo",
      domain: "apps/web",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: `harness/${runId}`,
      status: "needs_review",
      startedAt: "2026-05-21T00:00:00Z",
      ...meta,
    }),
  );
  writeFileSync(
    join(dir, "events.jsonl"),
    `{"type":"run_started","runId":"${runId}"}\n{"type":"run_completed"}\n`,
  );
  writeFileSync(
    join(dir, "review-decision.yaml"),
    [
      `runId: ${runId}`,
      "domain: apps/web",
      "decision: pending",
      "required_changes: []",
      "reviewer: null",
      "",
    ].join("\n"),
  );
}

/** A harness root with one project, one run, one backlog item. */
function normalRoot(): string {
  const root = freshRoot();
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "projects", "demo.yaml"), PROFILE);
  writeRun(root, "run-20260521-apps-web-aaa");
  mkdirSync(join(root, "backlog", "open"), { recursive: true });
  writeFileSync(
    join(root, "backlog", "open", "item-20260521-001.yaml"),
    [
      "id: item-20260521-001",
      "title: do a thing",
      "domain: apps/web",
      "goal: ship it",
      "status: open",
      "priority: medium",
      "tags: []",
      "createdAt: 2026-05-21T00:00:00Z",
      "linkedRuns: []",
      "",
    ].join("\n"),
  );
  return root;
}

describe("runFullImport", () => {
  it("imports an empty tree with no errors", () => {
    const root = freshRoot();
    const d = db(root);
    const r = runFullImport(d, { harnessRoot: root });
    d.close();
    expect(r.projects).toBe(0);
    expect(r.runs).toBe(0);
    expect(r.errors).toBe(0);
  });

  it("imports projects / runs / backlog from a normal tree", () => {
    const root = normalRoot();
    const d = db(root);
    const r = runFullImport(d, { harnessRoot: root });
    expect(r.projects).toBe(1);
    expect(r.runs).toBe(1);
    expect(r.backlogItems).toBe(1);
    expect(r.errors).toBe(0);
    const runRow = d
      .prepare("SELECT repo_id, status FROM runs WHERE run_id = ?")
      .get("run-20260521-apps-web-aaa") as { repo_id: string; status: string };
    expect(runRow.repo_id).toBe("demo");
    const events = (
      d
        .prepare("SELECT count(*) AS n FROM run_events WHERE run_id = ?")
        .get("run-20260521-apps-web-aaa") as { n: number }
    ).n;
    expect(events).toBe(2);
    const domains = (
      d.prepare("SELECT count(*) AS n FROM domains").get() as { n: number }
    ).n;
    expect(domains).toBe(1);
    d.close();
  });

  it("is idempotent — a second import skips the unchanged run", () => {
    const root = normalRoot();
    const d = db(root);
    runFullImport(d, { harnessRoot: root });
    const r2 = runFullImport(d, { harnessRoot: root });
    expect(r2.runs).toBe(0);
    expect(r2.runsSkipped).toBe(1);
    const runCount = (
      d.prepare("SELECT count(*) AS n FROM runs").get() as { n: number }
    ).n;
    expect(runCount).toBe(1);
    d.close();
  });

  it("re-imports a run after its meta.json changes", () => {
    const root = normalRoot();
    const d = db(root);
    runFullImport(d, { harnessRoot: root });
    writeRun(root, "run-20260521-apps-web-aaa", { status: "approved" });
    const r2 = runFullImport(d, { harnessRoot: root });
    expect(r2.runs).toBe(1);
    expect(r2.runsSkipped).toBe(0);
    const status = (
      d
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get("run-20260521-apps-web-aaa") as { status: string }
    ).status;
    expect(status).toBe("approved");
    d.close();
  });

  it("records a malformed meta.json in import_errors and keeps other runs", () => {
    const root = normalRoot();
    const badDir = join(root, "runs", "run-20260521-apps-web-bad");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(join(badDir, "meta.json"), "{ not json");
    const d = db(root);
    const r = runFullImport(d, { harnessRoot: root });
    expect(r.runs).toBe(1); // the good run still imported
    expect(r.errors).toBe(1);
    const err = d
      .prepare("SELECT kind FROM import_errors")
      .get() as { kind: string };
    expect(err.kind).toBe("run");
    d.close();
  });

  it("re-import of an unchanged tree leaves identical timestamps", () => {
    const root = normalRoot();
    const d = db(root);
    runFullImport(d, { harnessRoot: root });
    const before = d
      .prepare("SELECT updated_at FROM projects WHERE project_id = 'demo'")
      .get() as { updated_at: string };
    const itemBefore = d
      .prepare("SELECT updated_at FROM backlog_items LIMIT 1")
      .get() as { updated_at: string };
    runFullImport(d, { harnessRoot: root });
    const after = d
      .prepare("SELECT updated_at FROM projects WHERE project_id = 'demo'")
      .get() as { updated_at: string };
    const itemAfter = d
      .prepare("SELECT updated_at FROM backlog_items LIMIT 1")
      .get() as { updated_at: string };
    expect(after.updated_at).toBe(before.updated_at);
    expect(itemAfter.updated_at).toBe(itemBefore.updated_at);
    d.close();
  });

  it("re-imports a run when review-decision.yaml changes but meta does not", () => {
    const root = normalRoot();
    const d = db(root);
    runFullImport(d, { harnessRoot: root });
    // rewrite ONLY the review decision — meta.json is untouched
    writeFileSync(
      join(
        root,
        "runs",
        "run-20260521-apps-web-aaa",
        "review-decision.yaml",
      ),
      [
        "runId: run-20260521-apps-web-aaa",
        "domain: apps/web",
        "decision: approved",
        "required_changes: []",
        "reviewer: alice",
        "",
      ].join("\n"),
    );
    const r2 = runFullImport(d, { harnessRoot: root });
    expect(r2.runs).toBe(1);
    expect(r2.runsSkipped).toBe(0);
    const decision = (
      d
        .prepare("SELECT decision FROM review_decisions WHERE run_id = ?")
        .get("run-20260521-apps-web-aaa") as { decision: string }
    ).decision;
    expect(decision).toBe("approved");
    d.close();
  });

  it("removes a domain dropped from the profile on re-import", () => {
    const root = freshRoot();
    mkdirSync(join(root, "projects"), { recursive: true });
    const twoDomains = [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: demo",
      "domains:",
      "  - id: apps/web",
      "    root: apps/web",
      "    kind: app",
      "  - id: apps/api",
      "    root: apps/api",
      "    kind: app",
      "",
    ].join("\n");
    writeFileSync(join(root, "projects", "demo.yaml"), twoDomains);
    const d = db(root);
    runFullImport(d, { harnessRoot: root });
    expect(
      (d.prepare("SELECT count(*) AS n FROM domains").get() as { n: number })
        .n,
    ).toBe(2);
    writeFileSync(join(root, "projects", "demo.yaml"), PROFILE); // 1 domain
    runFullImport(d, { harnessRoot: root });
    expect(
      (d.prepare("SELECT count(*) AS n FROM domains").get() as { n: number })
        .n,
    ).toBe(1);
    d.close();
  });

  it("records a malformed review-decision.yaml in import_errors", () => {
    const root = normalRoot();
    writeFileSync(
      join(
        root,
        "runs",
        "run-20260521-apps-web-aaa",
        "review-decision.yaml",
      ),
      ":\n  bad: [unclosed",
    );
    const d = db(root);
    const r = runFullImport(d, { harnessRoot: root });
    expect(r.errors).toBeGreaterThanOrEqual(1);
    const kinds = (
      d.prepare("SELECT source_path FROM import_errors").all() as {
        source_path: string;
      }[]
    ).map((x) => x.source_path);
    expect(kinds.some((p) => p.endsWith("review-decision.yaml"))).toBe(true);
    d.close();
  });

  it("derives a backlog item's repo_id from its project (Phase 6-6)", () => {
    const root = normalRoot();
    // a second backlog item attributed to project "demo"
    writeFileSync(
      join(root, "backlog", "open", "item-20260521-002.yaml"),
      [
        "id: item-20260521-002",
        "title: project-attributed",
        "domain: apps/web",
        "goal: g",
        "status: open",
        "priority: medium",
        "tags: []",
        "projectId: demo",
        "createdAt: 2026-05-21T00:00:00Z",
        "linkedRuns: []",
        "",
      ].join("\n"),
    );
    const d = db(root);
    runFullImport(d, { harnessRoot: root });
    const row = d
      .prepare(
        "SELECT project_id, repo_id FROM backlog_items WHERE item_id = ?",
      )
      .get("item-20260521-002") as {
      project_id: string;
      repo_id: string | null;
    };
    expect(row.project_id).toBe("demo");
    expect(row.repo_id).toBe("demo"); // derived from projects.repo_id
    d.close();
  });

  it("keeps a malformed review-decision.yaml error across a no-change re-import", () => {
    const root = normalRoot();
    // the run's review decision is malformed
    writeFileSync(
      join(root, "runs", "run-20260521-apps-web-aaa", "review-decision.yaml"),
      ":\n  bad: [unclosed",
    );
    const d = db(root);
    const r1 = runFullImport(d, { harnessRoot: root });
    expect(r1.errors).toBeGreaterThanOrEqual(1);
    // re-import with nothing changed: the run is skipped by fingerprint,
    // but its malformed-file error must NOT vanish.
    const r2 = runFullImport(d, { harnessRoot: root });
    expect(r2.runsSkipped).toBe(1);
    expect(r2.errors).toBeGreaterThanOrEqual(1);
    const rows = (
      d.prepare("SELECT count(*) AS n FROM import_errors").get() as {
        n: number;
      }
    ).n;
    expect(rows).toBeGreaterThanOrEqual(1);
    d.close();
  });

  it("clears the error once the malformed file is fixed", () => {
    const root = normalRoot();
    const declPath = join(
      root,
      "runs",
      "run-20260521-apps-web-aaa",
      "review-decision.yaml",
    );
    writeFileSync(declPath, ":\n  bad: [unclosed");
    const d = db(root);
    expect(runFullImport(d, { harnessRoot: root }).errors).toBeGreaterThanOrEqual(
      1,
    );
    // fix the file — the fingerprint changes, the run re-imports cleanly
    writeFileSync(
      declPath,
      "runId: run-20260521-apps-web-aaa\ndomain: apps/web\ndecision: pending\nrequired_changes: []\n",
    );
    const r = runFullImport(d, { harnessRoot: root });
    expect(r.errors).toBe(0);
    d.close();
  });

  it("prunes an import error whose source file was deleted", () => {
    const root = normalRoot();
    const declPath = join(
      root,
      "runs",
      "run-20260521-apps-web-aaa",
      "review-decision.yaml",
    );
    writeFileSync(declPath, ":\n  bad: [unclosed");
    const d = db(root);
    expect(runFullImport(d, { harnessRoot: root }).errors).toBeGreaterThanOrEqual(
      1,
    );
    rmSync(declPath);
    const r = runFullImport(d, { harnessRoot: root });
    expect(r.errors).toBe(0); // the orphan error row was pruned
    d.close();
  });

  it("--reset empties tables before importing", () => {
    const root = normalRoot();
    const d = db(root);
    runFullImport(d, { harnessRoot: root });
    // a second run dir appears, then a reset import
    writeRun(root, "run-20260521-apps-web-bbb");
    const r = runFullImport(d, { harnessRoot: root, reset: true });
    expect(r.runs).toBe(2);
    expect(r.runsSkipped).toBe(0); // reset cleared the prior rows
    d.close();
  });
});
