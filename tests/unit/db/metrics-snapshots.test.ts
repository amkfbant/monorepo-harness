import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  buildMetricsDelta,
  listMetricsSnapshots,
  listMetricsTrend,
  pruneMetricsSnapshots,
  recordAndPruneMetricsSnapshot,
  recordMetricsSnapshot,
  type MetricsSnapshotPayloadV1,
} from "../../../src/db/repositories/metrics-snapshots.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-metrics-snap-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function insertRun(
  db: Database.Database,
  input: {
    runId: string;
    projectId: string | null;
    repoId: string;
    domain: string;
    status: string;
    startedAt?: string;
    totalTokens?: number;
  },
): void {
  const startedAt = input.startedAt ?? "2026-06-01T00:00:00.000Z";
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, project_id, domain, workflow,
       base_branch, status, started_at, updated_at)
     VALUES (?, ?, ?, ?, 'domain-coding', 'main', ?,
       ?, ?)`,
  ).run(
    input.runId,
    input.repoId,
    input.projectId,
    input.domain,
    input.status,
    startedAt,
    startedAt,
  );
  if (input.totalTokens !== undefined) {
    db.prepare(
      `INSERT INTO run_usage
         (run_id, input_tokens, output_tokens, total_tokens, usage_source,
          created_at)
       VALUES (?, 0, 0, ?, 'exact', ?)`,
    ).run(input.runId, input.totalTokens, startedAt);
  }
}

function insertUsage(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO run_usage
       (run_id, input_tokens, output_tokens, total_tokens, usage_source,
        created_at)
     VALUES (?, 100, 25, 125, 'exact', '2026-06-01T00:00:00.000Z')`,
  ).run(runId);
}

function insertHitchSession(
  db: Database.Database,
  input: {
    hitchId: string;
    projectId: string | null;
    repoId: string | null;
    domain: string | null;
    status: string;
  },
): void {
  db.prepare(
    `INSERT INTO hitch_sessions (
       hitch_id, title, status, project_id, repo_id, domain, scope_json,
       close_conditions_json, policy_json, max_iterations, max_review_cycles,
       max_reruns, max_total_new_findings, created_by, created_source,
       created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, '{}', '[]', '{}', 3, 3, 2, 12, 'test', 'cli',
       '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
  ).run(
    input.hitchId,
    input.hitchId,
    input.status,
    input.projectId,
    input.repoId,
    input.domain,
  );
}

function insertMcpConfirmation(db: Database.Database): void {
  db.prepare(
    `INSERT INTO mcp_confirmation_requests (
       confirmation_id, client_name, actor, tool_name, operation_type,
       input_json, preview_json, permission_snapshot_json, status, created_at,
       expires_at
     )
     VALUES ('mcpconf-snap', 'test-client', 'test-actor', 'tool', 'mutation',
       '{}', '{}', '{}', 'confirmed', '2026-06-01T00:00:00.000Z',
       '2026-07-01T00:00:00.000Z')`,
  ).run();
}

function payloadOf(row: { payloadJson: string }): MetricsSnapshotPayloadV1 {
  return JSON.parse(row.payloadJson) as MetricsSnapshotPayloadV1;
}

describe("metrics snapshots repository", () => {
  it("records and prunes in one repository transaction", () => {
    const db = freshDb();
    try {
      db.prepare(
        `INSERT INTO metrics_snapshots
           (snapshot_id, created_at, payload_json)
         VALUES (?, ?, '{}')`,
      ).run("msnap-old", "2026-03-14T23:59:59.999Z");

      const result = recordAndPruneMetricsSnapshot(db, {
        filter: {},
        retentionDays: 90,
        now: "2026-06-13T00:00:00.000Z",
      });

      expect(result.snapshot.createdAt).toBe("2026-06-13T00:00:00.000Z");
      expect(result.prunedCount).toBe(1);
      expect(
        listMetricsSnapshots(db, { filter: {} }).map((s) => s.snapshotId),
      ).toEqual([result.snapshot.snapshotId]);
    } finally {
      db.close();
    }
  });

  it("rolls back recordAndPrune when pruning input is invalid", () => {
    const db = freshDb();
    try {
      expect(() =>
        recordAndPruneMetricsSnapshot(db, {
          filter: {},
          retentionDays: -1,
          now: "2026-06-13T00:00:00.000Z",
        }),
      ).toThrow(/retentionDays must be a non-negative integer/);
      expect(listMetricsSnapshots(db, { filter: {} })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("records a scoped aggregate payload and returns the stored snapshot", () => {
    const db = freshDb();
    try {
      insertRun(db, {
        runId: "run-demo",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/web",
        status: "approved",
      });
      insertRun(db, {
        runId: "run-other",
        projectId: "other",
        repoId: "repo-b",
        domain: "apps/api",
        status: "needs_review",
      });
      insertUsage(db, "run-demo");
      insertHitchSession(db, {
        hitchId: "hitch-demo",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/web",
        status: "closed",
      });
      insertHitchSession(db, {
        hitchId: "hitch-other",
        projectId: "other",
        repoId: "repo-b",
        domain: "apps/api",
        status: "open",
      });
      insertMcpConfirmation(db);

      const snapshot = recordMetricsSnapshot(db, {
        filter: { projectId: "demo", repoId: "repo-a", domain: "apps/web" },
        now: "2026-06-13T00:00:00.000Z",
      });

      expect(snapshot.snapshotId).toMatch(/^msnap-[0-9a-f-]{36}$/);
      expect(snapshot.createdAt).toBe("2026-06-13T00:00:00.000Z");
      expect(snapshot.projectId).toBe("demo");
      expect(snapshot.repoId).toBe("repo-a");
      expect(snapshot.domain).toBe("apps/web");
      expect(snapshot.payloadSchema).toBe(1);
      expect(payloadOf(snapshot)).toMatchObject({
        schema: 1,
        capturedAt: "2026-06-13T00:00:00.000Z",
        filter: { projectId: "demo", repoId: "repo-a", domain: "apps/web" },
        metricsSummary: { totalRuns: 1, approved: 1 },
        tokenUsageSummary: {
          runsWithUsage: 1,
          totalInputTokens: 100,
          totalOutputTokens: 25,
          totalTokens: 125,
        },
        hitchMetricsSummary: {
          totalSessions: 1,
          byStatus: { closed: 1 },
        },
        mcpConfirmationSummary: {
          total: 1,
          byStatus: { confirmed: 1 },
        },
      });
    } finally {
      db.close();
    }
  });

  it("prunes only snapshots older than the retention boundary", () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        `INSERT INTO metrics_snapshots
           (snapshot_id, created_at, payload_json)
         VALUES (?, ?, '{}')`,
      );
      insert.run("msnap-old", "2026-03-14T23:59:59.999Z");
      insert.run("msnap-boundary", "2026-03-15T00:00:00.000Z");
      insert.run("msnap-new", "2026-06-13T00:00:00.000Z");

      const pruned = pruneMetricsSnapshots(db, {
        retentionDays: 90,
        now: "2026-06-13T00:00:00.000Z",
      });

      expect(pruned).toBe(1);
      expect(
        listMetricsSnapshots(db, { filter: {} }).map((s) => s.snapshotId),
      ).toEqual(["msnap-new", "msnap-boundary"]);
    } finally {
      db.close();
    }
  });

  it("lists newest snapshots first with scope, since, and limit filters", () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        `INSERT INTO metrics_snapshots
           (snapshot_id, created_at, project_id, repo_id, domain, payload_json)
         VALUES (?, ?, ?, ?, ?, '{}')`,
      );
      insert.run(
        "msnap-demo-old",
        "2026-06-01T00:00:00.000Z",
        "demo",
        "repo-a",
        "apps/web",
      );
      insert.run(
        "msnap-demo-new",
        "2026-06-03T00:00:00.000Z",
        "demo",
        "repo-a",
        "apps/web",
      );
      insert.run(
        "msnap-demo-api",
        "2026-06-04T00:00:00.000Z",
        "demo",
        "repo-a",
        "apps/api",
      );
      insert.run(
        "msnap-other",
        "2026-06-05T00:00:00.000Z",
        "other",
        "repo-b",
        "apps/web",
      );

      const rows = listMetricsSnapshots(db, {
        filter: { projectId: "demo", repoId: "repo-a", domain: "apps/web" },
        since: "2026-06-02T00:00:00.000Z",
        limit: 1,
      });

      expect(rows.map((s) => s.snapshotId)).toEqual(["msnap-demo-new"]);
    } finally {
      db.close();
    }
  });

  it("lists and trends only snapshots with the exact requested scope", () => {
    const db = freshDb();
    try {
      const global = recordMetricsSnapshot(db, {
        filter: {},
        now: "2026-06-01T00:00:00.000Z",
      });
      const project = recordMetricsSnapshot(db, {
        filter: { projectId: "demo" },
        now: "2026-06-02T00:00:00.000Z",
      });
      const projectDomain = recordMetricsSnapshot(db, {
        filter: { projectId: "demo", domain: "apps/api" },
        now: "2026-06-03T00:00:00.000Z",
      });

      expect(
        listMetricsSnapshots(db, { filter: {} }).map((s) => s.snapshotId),
      ).toEqual([global.snapshotId]);
      expect(
        listMetricsSnapshots(db, { filter: { projectId: "demo" } }).map(
          (s) => s.snapshotId,
        ),
      ).toEqual([project.snapshotId]);
      expect(
        listMetricsSnapshots(db, {
          filter: { projectId: "demo", domain: "apps/api" },
        }).map((s) => s.snapshotId),
      ).toEqual([projectDomain.snapshotId]);

      expect(
        listMetricsTrend(db, { filter: {}, limit: 10 }).map((p) => p.createdAt),
      ).toEqual([global.createdAt]);
      expect(
        listMetricsTrend(db, {
          filter: { projectId: "demo" },
          limit: 10,
        }).map((p) => p.createdAt),
      ).toEqual([project.createdAt]);
      expect(
        listMetricsTrend(db, {
          filter: { projectId: "demo", domain: "apps/api" },
          limit: 10,
        }).map((p) => p.createdAt),
      ).toEqual([projectDomain.createdAt]);
    } finally {
      db.close();
    }
  });

  it("computes a delta from the newest valid snapshot at or before the baseline time", () => {
    const db = freshDb();
    try {
      insertRun(db, {
        runId: "run-baseline-approved",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/web",
        status: "approved",
        totalTokens: 100,
      });
      recordMetricsSnapshot(db, {
        filter: { projectId: "demo", repoId: "repo-a", domain: "apps/web" },
        now: "2026-06-01T00:00:00.000Z",
      });
      insertRun(db, {
        runId: "run-current-review",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/web",
        status: "needs_review",
        totalTokens: 50,
      });
      insertHitchSession(db, {
        hitchId: "hitch-demo",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/web",
        status: "open",
      });

      const delta = buildMetricsDelta(db, {
        filter: { projectId: "demo", repoId: "repo-a", domain: "apps/web" },
        baselineAt: "2026-06-08T00:00:00.000Z",
        now: "2026-06-13T00:00:00.000Z",
      });

      expect(delta.status).toBe("ok");
      if (delta.status !== "ok") return;
      expect(delta.baseline.snapshotId).toMatch(/^msnap-/);
      expect(delta.baseline.createdAt).toBe("2026-06-01T00:00:00.000Z");
      expect(delta.metrics.totalRuns).toEqual({
        baseline: 1,
        current: 2,
        delta: 1,
      });
      expect(delta.metrics.approvedRate).toEqual({
        baseline: 1,
        current: 1,
        delta: 0,
      });
      expect(delta.hitch.totalSessions).toEqual({
        baseline: 0,
        current: 1,
        delta: 1,
      });
      expect(delta.usage.totalTokens).toEqual({
        baseline: 100,
        current: 150,
        delta: 50,
      });
      expect(delta.skippedSnapshots).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("selects delta baselines only from the exact requested scope", () => {
    const db = freshDb();
    try {
      const global = recordMetricsSnapshot(db, {
        filter: {},
        now: "2026-06-01T00:00:00.000Z",
      });
      const project = recordMetricsSnapshot(db, {
        filter: { projectId: "demo" },
        now: "2026-06-02T00:00:00.000Z",
      });
      const projectDomain = recordMetricsSnapshot(db, {
        filter: { projectId: "demo", domain: "apps/api" },
        now: "2026-06-03T00:00:00.000Z",
      });

      const globalDelta = buildMetricsDelta(db, {
        filter: {},
        baselineAt: "2026-06-08T00:00:00.000Z",
        now: "2026-06-13T00:00:00.000Z",
      });
      const projectDelta = buildMetricsDelta(db, {
        filter: { projectId: "demo" },
        baselineAt: "2026-06-08T00:00:00.000Z",
        now: "2026-06-13T00:00:00.000Z",
      });
      const projectDomainDelta = buildMetricsDelta(db, {
        filter: { projectId: "demo", domain: "apps/api" },
        baselineAt: "2026-06-08T00:00:00.000Z",
        now: "2026-06-13T00:00:00.000Z",
      });

      expect(globalDelta.status).toBe("ok");
      expect(projectDelta.status).toBe("ok");
      expect(projectDomainDelta.status).toBe("ok");
      if (
        globalDelta.status !== "ok" ||
        projectDelta.status !== "ok" ||
        projectDomainDelta.status !== "ok"
      ) {
        return;
      }
      expect(globalDelta.baseline.snapshotId).toBe(global.snapshotId);
      expect(projectDelta.baseline.snapshotId).toBe(project.snapshotId);
      expect(projectDomainDelta.baseline.snapshotId).toBe(
        projectDomain.snapshotId,
      );
    } finally {
      db.close();
    }
  });

  it("returns a normal missing-baseline result when no snapshot exists before the baseline time", () => {
    const db = freshDb();
    try {
      recordMetricsSnapshot(db, {
        filter: { projectId: "demo" },
        now: "2026-06-10T00:00:00.000Z",
      });

      const delta = buildMetricsDelta(db, {
        filter: { projectId: "demo" },
        baselineAt: "2026-06-08T00:00:00.000Z",
        now: "2026-06-13T00:00:00.000Z",
      });

      expect(delta).toMatchObject({
        status: "missing-baseline",
        baselineAt: "2026-06-08T00:00:00.000Z",
        skippedSnapshots: [],
      });
    } finally {
      db.close();
    }
  });

  it("skips unsupported payload schemas and uses the next older valid snapshot", () => {
    const db = freshDb();
    try {
      insertRun(db, {
        runId: "run-baseline",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/web",
        status: "approved",
      });
      const valid = recordMetricsSnapshot(db, {
        filter: { projectId: "demo" },
        now: "2026-06-01T00:00:00.000Z",
      });
      db.prepare(
        `INSERT INTO metrics_snapshots
           (snapshot_id, created_at, project_id, payload_json, payload_schema)
         VALUES (
           'msnap-future-schema', '2026-06-07T00:00:00.000Z', 'demo',
           '{"schema":99}', 99
         )`,
      ).run();

      const delta = buildMetricsDelta(db, {
        filter: { projectId: "demo" },
        baselineAt: "2026-06-08T00:00:00.000Z",
        now: "2026-06-13T00:00:00.000Z",
      });

      expect(delta.status).toBe("ok");
      if (delta.status !== "ok") return;
      expect(delta.baseline.snapshotId).toBe(valid.snapshotId);
      expect(delta.skippedSnapshots).toEqual([
        {
          snapshotId: "msnap-future-schema",
          createdAt: "2026-06-07T00:00:00.000Z",
          reason: "unsupported payload_schema 99",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("fills metrics trends up to the requested valid point count after invalid schemas are skipped", () => {
    const db = freshDb();
    try {
      for (let i = 0; i < 30; i += 1) {
        insertRun(db, {
          runId: `run-trend-${i}`,
          projectId: "demo",
          repoId: "repo-a",
          domain: "apps/web",
          status: "approved",
        });
        recordMetricsSnapshot(db, {
          filter: { projectId: "demo" },
          now: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        });
      }
      db.prepare(
        `INSERT INTO metrics_snapshots
           (snapshot_id, created_at, project_id, payload_json, payload_schema)
         VALUES (?, ?, 'demo', '{"schema":99}', 99)`,
      ).run("msnap-invalid-newest", "2026-07-01T00:00:00.000Z");

      const trend = listMetricsTrend(db, {
        filter: { projectId: "demo" },
        limit: 30,
      });

      expect(trend).toHaveLength(30);
      expect(trend[0]?.createdAt).toBe("2026-06-01T00:00:00.000Z");
      expect(trend.at(-1)?.createdAt).toBe("2026-06-30T00:00:00.000Z");
    } finally {
      db.close();
    }
  });

  it("returns an empty metrics trend when every fetched snapshot is invalid", () => {
    const db = freshDb();
    try {
      const insert = db.prepare(
        `INSERT INTO metrics_snapshots
           (snapshot_id, created_at, project_id, payload_json, payload_schema)
         VALUES (?, ?, 'demo', '{"schema":99}', 99)`,
      );
      for (let i = 0; i < 35; i += 1) {
        insert.run(
          `msnap-invalid-${i}`,
          `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
        );
      }

      expect(
        listMetricsTrend(db, { filter: { projectId: "demo" }, limit: 30 }),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
