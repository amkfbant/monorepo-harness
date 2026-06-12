import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadDashboardSnapshot,
  DashboardSnapshotError,
} from "../../../src/dashboard/snapshot.js";
import { harnessPaths } from "../../../src/config/paths.js";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { SCHEMA_VERSION } from "../../../src/db/schema.js";
import type { MetricsSnapshotPayloadV1 } from "../../../src/db/repositories/metrics-snapshots.js";

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

function insertHitchSession(root: string): void {
  const { dbPath } = harnessPaths(root);
  const handle = openManagedDb({ dbPath });
  try {
    handle.db
      .prepare(
        `INSERT INTO hitch_sessions (
           hitch_id, title, status, project_id, repo_id, domain, scope_json,
           close_conditions_json, policy_json, max_iterations, max_review_cycles,
           max_reruns, max_total_new_findings, created_by, created_source,
           created_at, updated_at
         )
         VALUES (
           'hitch-demo', 'demo hitch', 'open', 'demo', 'demo', 'apps/web',
           '{}', '[]', '{}', 3, 3, 2, 12, 'test', 'cli',
           '2026-06-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z'
         )`,
      )
      .run();
    handle.db
      .prepare(
        `INSERT INTO hitch_findings (
           finding_id, hitch_id, stable_key, source, severity, category,
           scope_status, lifecycle_status, summary, first_seen_at, last_seen_at,
           reopen_count
         )
         VALUES (
           'finding-demo', 'hitch-demo', 'finding-demo', 'review', 'P1',
           'correctness', 'in_scope', 'fixed', 'fixed finding',
           '2026-06-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z', 0
         )`,
      )
      .run();
  } finally {
    handle.close();
  }
}

function insertMcpConfirmation(root: string): void {
  const { dbPath } = harnessPaths(root);
  const handle = openManagedDb({ dbPath });
  try {
    handle.db
      .prepare(
        `INSERT INTO mcp_confirmation_requests (
           confirmation_id, client_name, actor, tool_name, operation_type,
           input_json, preview_json, permission_snapshot_json, status,
           created_at, expires_at
         )
         VALUES (
           'confirm-demo', 'client', 'actor', 'harness.pr.create',
           'pr.create', '{}', '{}', '{}', 'confirmed',
           '2026-06-10T00:00:00.000Z', '2026-06-11T00:00:00.000Z'
         )`,
      )
      .run();
  } finally {
    handle.close();
  }
}

function insertPendingMcpConfirmation(
  root: string,
  confirmationId: string,
  expiresAt: string,
): void {
  const { dbPath } = harnessPaths(root);
  const handle = openManagedDb({ dbPath });
  try {
    handle.db
      .prepare(
        `INSERT INTO mcp_confirmation_requests (
           confirmation_id, client_name, actor, tool_name, operation_type,
           input_json, preview_json, permission_snapshot_json, status,
           created_at, expires_at
         )
         VALUES (
           ?, 'client', 'actor', 'harness.pr.create',
           'pr.create', '{}', '{}', '{}', 'pending',
           '2026-01-01T00:00:00.000Z', ?
         )`,
      )
      .run(confirmationId, expiresAt);
  } finally {
    handle.close();
  }
}

function insertMetricsSnapshot(
  root: string,
  input: {
    index: number;
    createdAt: string;
    projectId?: string;
    totalRuns: number;
    approvedRate: number | null;
    totalTokens: number;
  },
): void {
  const { dbPath } = harnessPaths(root);
  const handle = openManagedDb({ dbPath });
  try {
    const payload: MetricsSnapshotPayloadV1 = {
      schema: 1,
      capturedAt: input.createdAt,
      filter:
        input.projectId === undefined ? {} : { projectId: input.projectId },
      metricsSummary: {
        totalRuns: input.totalRuns,
        byStatus: {},
        approved: 0,
        needsReview: 0,
        failed: 0,
        approvedRate: input.approvedRate,
        oneShotApprovalRate: null,
        policyViolationRate: null,
        secretSuspectRate: null,
      },
      hitchMetricsSummary: {
        totalSessions: 0,
        byStatus: {},
        avgReviewCycles: null,
        avgRerunAttempts: null,
        findingsBySeverity: {},
        findingResolutionRate: null,
        reopenRate: null,
      },
      tokenUsageSummary: {
        runsWithUsage: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: input.totalTokens,
        bySource: {},
      },
      mcpConfirmationSummary: {
        total: 0,
        byStatus: {},
        confirmationRate: null,
        expiredRate: null,
      },
    };
    handle.db
      .prepare(
        `INSERT INTO metrics_snapshots
           (snapshot_id, created_at, project_id, payload_json, payload_schema)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .run(
        `msnap-trend-${String(input.index).padStart(2, "0")}`,
        input.createdAt,
        input.projectId ?? null,
        JSON.stringify(payload),
      );
  } finally {
    handle.close();
  }
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
    expect(snap.dbSchemaVersion).toBe(SCHEMA_VERSION);
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

  it("includes hitch metrics and MCP confirmation summaries", () => {
    const root = normalRoot();
    loadDashboardSnapshot({ harnessRoot: root });
    insertHitchSession(root);
    insertMcpConfirmation(root);

    const snap = loadDashboardSnapshot({
      harnessRoot: root,
      autoImport: false,
      filters: { projectId: "demo" },
    });

    expect(snap.hitchMetrics).toMatchObject({
      totalSessions: 1,
      byStatus: { open: 1 },
      findingsBySeverity: { P1: 1 },
      findingResolutionRate: 1,
    });
    expect(snap.mcpConfirmations).toMatchObject({
      total: 1,
      byStatus: { confirmed: 1 },
      confirmationRate: 1,
    });
  });

  it("uses the snapshot timestamp for pending MCP confirmation expiry", () => {
    const root = normalRoot();
    loadDashboardSnapshot({ harnessRoot: root });
    insertPendingMcpConfirmation(
      root,
      "confirm-past",
      "2025-12-31T23:59:59.000Z",
    );
    insertPendingMcpConfirmation(
      root,
      "confirm-future",
      "2026-01-02T00:00:00.000Z",
    );

    const snap = loadDashboardSnapshot({
      harnessRoot: root,
      autoImport: false,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(snap.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(snap.mcpConfirmations).toMatchObject({
      total: 2,
      byStatus: { expired: 1, pending: 1 },
      confirmationRate: 0,
      expiredRate: 1,
    });
  });

  it("includes a 30-point metrics trend from recent snapshots", () => {
    const root = normalRoot();
    loadDashboardSnapshot({ harnessRoot: root });
    for (let i = 0; i < 31; i += 1) {
      insertMetricsSnapshot(root, {
        index: i,
        createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        projectId: "demo",
        totalRuns: i,
        approvedRate: i / 100,
        totalTokens: i * 10,
      });
    }

    const snap = loadDashboardSnapshot({
      harnessRoot: root,
      autoImport: false,
      filters: { projectId: "demo" },
    });

    expect(snap.metricsTrend).toHaveLength(30);
    expect(snap.metricsTrend[0]).toEqual({
      createdAt: "2026-01-02T00:00:00.000Z",
      totalRuns: 1,
      approvedRate: 0.01,
      totalTokens: 10,
    });
    expect(snap.metricsTrend.at(-1)).toEqual({
      createdAt: "2026-01-31T00:00:00.000Z",
      totalRuns: 30,
      approvedRate: 0.3,
      totalTokens: 300,
    });
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
