import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { runFullImport } from "../../../src/db/import-files.js";
import { checkConsistency } from "../../../src/db/consistency.js";

const PROFILE = [
  "version: 1",
  "project_id: demo",
  "repo:",
  "  id: demo",
  "domains:",
  "  - id: apps/web",
  "    root: apps/web",
  "    kind: app",
  "",
].join("\n");

function writeRun(root: string, runId: string, status = "needs_review"): void {
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
      status,
      startedAt: "2026-05-21T00:00:00Z",
    }),
  );
  writeFileSync(join(dir, "events.jsonl"), `{"type":"run_started"}\n`);
}

/** Harness root with one project and one run, already imported. */
function importedRoot(): { root: string; db: ReturnType<typeof openDb> } {
  const root = mkdtempSync(join(tmpdir(), "harness-cons-"));
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "projects", "demo.yaml"), PROFILE);
  writeRun(root, "run-20260521-apps-web-aaa");
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  runFullImport(db, { harnessRoot: root });
  return { root, db };
}

describe("checkConsistency", () => {
  it("reports ok immediately after an import", () => {
    const { root, db } = importedRoot();
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(r.status).toBe("ok");
    expect(r.items.every((i) => i.status === "ok")).toBe(true);
  });

  it("detects run drift when a run file changes after import", () => {
    const { root, db } = importedRoot();
    writeRun(root, "run-20260521-apps-web-aaa", "approved"); // meta changed
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(r.status).toBe("warn");
    expect(
      r.items.some((i) => i.kind === "run" && i.status === "drift"),
    ).toBe(true);
  });

  it("detects a missing run dir as missing-file", () => {
    const { root, db } = importedRoot();
    rmSync(join(root, "runs", "run-20260521-apps-web-aaa"), {
      recursive: true,
      force: true,
    });
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some((i) => i.kind === "run" && i.status === "missing-file"),
    ).toBe(true);
  });

  it("detects an un-imported run dir as missing-db", () => {
    const { root, db } = importedRoot();
    writeRun(root, "run-20260521-apps-web-bbb");
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some(
        (i) =>
          i.kind === "run" &&
          i.id === "run-20260521-apps-web-bbb" &&
          i.status === "missing-db",
      ),
    ).toBe(true);
  });

  it("does not false-warn when the filename differs from project_id", () => {
    const root = mkdtempSync(join(tmpdir(), "harness-cons-"));
    mkdirSync(join(root, "projects"), { recursive: true });
    // filename stem "weird-name" ≠ project_id "demo"
    writeFileSync(join(root, "projects", "weird-name.yaml"), PROFILE);
    const db = openDb(join(root, ".harness", "harness.sqlite"));
    runMigrations(db);
    runFullImport(db, { harnessRoot: root });
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(r.status).toBe("ok");
  });

  it("detects a generated policy sidecar missing from the DB", () => {
    const { root, db } = importedRoot();
    // a generated-policy sidecar appears on disk but is never imported
    mkdirSync(join(root, "policies", "repos"), { recursive: true });
    writeFileSync(join(root, "policies", "repos", "demo.yaml"), "repo_id: demo\n");
    writeFileSync(
      join(root, "policies", "repos", "demo.generated.json"),
      JSON.stringify({
        schemaVersion: 1,
        projectId: "demo",
        repoId: "demo",
        profilePath: "projects/demo.yaml",
        profileVersion: 1,
        policyTemplate: null,
        commandPresets: [],
        contextPackPresets: [],
        domainRegistry: null,
        generatedAt: "2026-05-22T00:00:00.000Z",
      }),
    );
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some((i) => i.kind === "policy" && i.status === "missing-db"),
    ).toBe(true);
  });

  it("detects a backlog item on disk but not in the DB (missing-db)", () => {
    const { root, db } = importedRoot();
    // a backlog item appears on disk after the import
    mkdirSync(join(root, "backlog", "open"), { recursive: true });
    writeFileSync(
      join(root, "backlog", "open", "item-20260521-001.yaml"),
      [
        "id: item-20260521-001",
        "title: t",
        "domain: apps/web",
        "goal: g",
        "status: open",
        "priority: medium",
        "tags: []",
        "createdAt: 2026-05-21T00:00:00Z",
        "linkedRuns: []",
        "",
      ].join("\n"),
    );
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some(
        (i) => i.kind === "backlog" && i.status === "missing-db",
      ),
    ).toBe(true);
  });

  it("detects project profile drift", () => {
    const { root, db } = importedRoot();
    writeFileSync(
      join(root, "projects", "demo.yaml"),
      `${PROFILE}\ndescription: changed\n`,
    );
    const r = checkConsistency({ db, harnessRoot: root });
    db.close();
    expect(
      r.items.some((i) => i.kind === "project" && i.status === "drift"),
    ).toBe(true);
  });
});
