import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDashboardSnapshot,
  DashboardSnapshotError,
} from "../../../src/dashboard/snapshot.js";

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
      project: {
        projectId: "demo",
        profilePath: join(root, "projects", "demo.yaml"),
        profileVersion: 1,
        commandPresetIds: [],
        contextPackIds: [],
      },
    }),
  );
  writeFileSync(join(dir, "events.jsonl"), `{"type":"run_started"}\n`);
}

function normalRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-snap-"));
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "projects", "demo.yaml"), PROFILE);
  writeRun(root, "run-20260521-apps-web-aaa", "approved");
  writeRun(root, "run-20260521-apps-web-bbb", "needs_review");
  return root;
}

describe("loadDashboardSnapshot", () => {
  it("builds a snapshot from files when the DB is absent (auto-import)", () => {
    const root = normalRoot();
    const snap = loadDashboardSnapshot({ harnessRoot: root });
    expect(snap.importedRuns).toBe(2);
    expect(snap.overview.totalRuns).toBe(2);
    expect(snap.recentRuns).toHaveLength(2);
    expect(snap.projects).toHaveLength(1);
    expect(snap.projects[0]?.projectId).toBe("demo");
    expect(snap.projects[0]?.runCount).toBe(2);
    expect(snap.projects[0]?.domainCount).toBe(1);
    expect(snap.consistencyStatus).toBe("ok");
    expect(snap.dbSchemaVersion).toBe(1);
  });

  it("throws when the DB is absent and auto-import is disabled", () => {
    const root = normalRoot();
    expect(() =>
      loadDashboardSnapshot({ harnessRoot: root, autoImport: false }),
    ).toThrow(DashboardSnapshotError);
  });

  it("applies a project filter to the snapshot aggregates", () => {
    const root = normalRoot();
    const snap = loadDashboardSnapshot({
      harnessRoot: root,
      filters: { projectId: "nonesuch" },
    });
    expect(snap.overview.totalRuns).toBe(0);
    expect(snap.recentRuns).toHaveLength(0);
    // the project list is scoped the same way — no matching project
    expect(snap.projects).toHaveLength(0);
    // importedRuns is the unfiltered total
    expect(snap.importedRuns).toBe(2);
  });

  it("scopes the project list to a matching project filter", () => {
    const root = normalRoot();
    const snap = loadDashboardSnapshot({
      harnessRoot: root,
      filters: { projectId: "demo" },
    });
    expect(snap.projects.map((p) => p.projectId)).toEqual(["demo"]);
  });

  it("surfaces a consistency warning when files drift after import", () => {
    const root = normalRoot();
    // import once
    loadDashboardSnapshot({ harnessRoot: root });
    // mutate a run, then read WITHOUT re-importing
    writeRun(root, "run-20260521-apps-web-aaa", "rejected");
    const snap = loadDashboardSnapshot({
      harnessRoot: root,
      autoImport: false,
    });
    expect(snap.consistencyStatus).toBe("warn");
    expect(snap.warnings.some((w) => /drifted/.test(w.message))).toBe(true);
  });
});
