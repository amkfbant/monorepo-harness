import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  hitchMetricsSummary,
  mcpConfirmationSummary,
} from "../../../src/db/repositories/convergence-aggregates.js";

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "harness-convergence-agg-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function insertHitchSession(
  db: Database.Database,
  input: {
    hitchId: string;
    status: string;
    projectId: string | null;
    repoId: string | null;
    domain: string | null;
    createdAt: string;
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
       ?, ?)`,
  ).run(
    input.hitchId,
    input.hitchId,
    input.status,
    input.projectId,
    input.repoId,
    input.domain,
    input.createdAt,
    input.createdAt,
  );
}

function insertReviewCycle(
  db: Database.Database,
  hitchId: string,
  cycleNumber: number,
): void {
  db.prepare(
    `INSERT INTO hitch_review_cycles (
       cycle_id, hitch_id, cycle_number, review_mode, created_at
     )
     VALUES (?, ?, ?, 'initial', '2026-06-10T00:00:00.000Z')`,
  ).run(`${hitchId}-cycle-${cycleNumber}`, hitchId, cycleNumber);
}

function insertAttempt(
  db: Database.Database,
  hitchId: string,
  iteration: number,
  attemptType: string,
): void {
  db.prepare(
    `INSERT INTO hitch_attempts (
       attempt_id, hitch_id, iteration, attempt_type, status, input_json,
       result_json, created_at
     )
     VALUES (?, ?, ?, ?, 'succeeded', '{}', '{}',
       '2026-06-10T00:00:00.000Z')`,
  ).run(`${hitchId}-attempt-${iteration}`, hitchId, iteration, attemptType);
}

function insertFinding(
  db: Database.Database,
  input: {
    findingId: string;
    hitchId: string;
    severity: string;
    scopeStatus: string;
    lifecycleStatus: string;
    reopenCount?: number;
  },
): void {
  db.prepare(
    `INSERT INTO hitch_findings (
       finding_id, hitch_id, stable_key, source, severity, category,
       scope_status, lifecycle_status, summary, first_seen_at, last_seen_at,
       reopen_count
     )
     VALUES (?, ?, ?, 'review', ?, 'correctness', ?, ?, ?,
       '2026-06-10T00:00:00.000Z', '2026-06-10T00:00:00.000Z', ?)`,
  ).run(
    input.findingId,
    input.hitchId,
    input.findingId,
    input.severity,
    input.scopeStatus,
    input.lifecycleStatus,
    input.findingId,
    input.reopenCount ?? 0,
  );
}

function insertMcpConfirmation(
  db: Database.Database,
  input: { confirmationId: string; status: string; createdAt: string },
): void {
  db.prepare(
    `INSERT INTO mcp_confirmation_requests (
       confirmation_id, client_name, actor, tool_name, operation_type,
       input_json, preview_json, permission_snapshot_json, status, created_at,
       expires_at
     )
     VALUES (?, 'test-client', 'test-actor', 'tool', 'mutation', '{}', '{}',
       '{}', ?, ?, '2026-07-01T00:00:00.000Z')`,
  ).run(input.confirmationId, input.status, input.createdAt);
}

describe("convergence aggregates", () => {
  it("reports null KPI rates for an empty DB", () => {
    const db = freshDb();
    try {
      expect(hitchMetricsSummary(db)).toEqual({
        totalSessions: 0,
        byStatus: {},
        avgReviewCycles: null,
        avgRerunAttempts: null,
        findingsBySeverity: {},
        findingResolutionRate: null,
        reopenRate: null,
      });
      expect(mcpConfirmationSummary(db)).toEqual({
        total: 0,
        byStatus: {},
        confirmationRate: null,
        expiredRate: null,
      });
    } finally {
      db.close();
    }
  });

  it("aggregates hitch convergence KPIs over scoped sessions", () => {
    const db = freshDb();
    try {
      insertHitchSession(db, {
        hitchId: "h1",
        status: "closed",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/web",
        createdAt: "2026-06-01T00:00:00.000Z",
      });
      insertHitchSession(db, {
        hitchId: "h2",
        status: "open",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/web",
        createdAt: "2026-06-02T00:00:00.000Z",
      });
      insertHitchSession(db, {
        hitchId: "h3",
        status: "escalated",
        projectId: "other",
        repoId: "repo-b",
        domain: "apps/api",
        createdAt: "2026-06-03T00:00:00.000Z",
      });
      insertHitchSession(db, {
        hitchId: "h4",
        status: "open",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/api",
        createdAt: "2026-05-01T00:00:00.000Z",
      });

      insertReviewCycle(db, "h1", 1);
      insertReviewCycle(db, "h1", 2);
      insertReviewCycle(db, "h2", 1);
      insertReviewCycle(db, "h3", 1);
      insertReviewCycle(db, "h3", 2);
      insertReviewCycle(db, "h3", 3);

      insertAttempt(db, "h1", 1, "implement");
      insertAttempt(db, "h1", 2, "rerun");
      insertAttempt(db, "h1", 3, "rerun");
      insertAttempt(db, "h2", 1, "rerun");
      insertAttempt(db, "h2", 2, "validate");
      insertAttempt(db, "h3", 1, "rerun");
      insertAttempt(db, "h3", 2, "rerun");
      insertAttempt(db, "h3", 3, "rerun");

      insertFinding(db, {
        findingId: "f1",
        hitchId: "h1",
        severity: "P1",
        scopeStatus: "in_scope",
        lifecycleStatus: "fixed",
      });
      insertFinding(db, {
        findingId: "f2",
        hitchId: "h1",
        severity: "P2",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
        reopenCount: 1,
      });
      insertFinding(db, {
        findingId: "f3",
        hitchId: "h1",
        severity: "P3",
        scopeStatus: "in_scope",
        lifecycleStatus: "deferred",
        reopenCount: 1,
      });
      insertFinding(db, {
        findingId: "f4",
        hitchId: "h1",
        severity: "P0",
        scopeStatus: "out_of_scope",
        lifecycleStatus: "out_of_scope",
        reopenCount: 5,
      });
      insertFinding(db, {
        findingId: "f5",
        hitchId: "h2",
        severity: "P1",
        scopeStatus: "in_scope",
        lifecycleStatus: "escalated",
      });
      insertFinding(db, {
        findingId: "f6",
        hitchId: "h2",
        severity: "info",
        scopeStatus: "in_scope",
        lifecycleStatus: "accepted_risk",
      });
      insertFinding(db, {
        findingId: "f7",
        hitchId: "h2",
        severity: "P2",
        scopeStatus: "duplicate",
        lifecycleStatus: "duplicate",
      });

      const summary = hitchMetricsSummary(db, {
        projectId: "demo",
        domain: "apps/web",
      });

      expect(summary.totalSessions).toBe(2);
      expect(summary.byStatus).toEqual({ closed: 1, open: 1 });
      expect(summary.avgReviewCycles).toBe(1.5);
      expect(summary.avgRerunAttempts).toBe(1.5);
      expect(summary.findingsBySeverity).toEqual({
        P1: 2,
        P2: 1,
        P3: 1,
        info: 1,
      });
      expect(summary.findingResolutionRate).toBe(1 / 3);
      expect(summary.reopenRate).toBe(2 / 5);
    } finally {
      db.close();
    }
  });

  it("applies project, domain, and session-created date filters", () => {
    const db = freshDb();
    try {
      insertHitchSession(db, {
        hitchId: "demo-web",
        status: "closed",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/web",
        createdAt: "2026-06-02T00:00:00.000Z",
      });
      insertHitchSession(db, {
        hitchId: "demo-api",
        status: "open",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/api",
        createdAt: "2026-06-03T00:00:00.000Z",
      });
      insertHitchSession(db, {
        hitchId: "other-web",
        status: "escalated",
        projectId: "other",
        repoId: "repo-a",
        domain: "apps/web",
        createdAt: "2026-06-04T00:00:00.000Z",
      });
      insertHitchSession(db, {
        hitchId: "old-demo-web",
        status: "open",
        projectId: "demo",
        repoId: "repo-a",
        domain: "apps/web",
        createdAt: "2026-05-01T00:00:00.000Z",
      });
      insertReviewCycle(db, "demo-web", 1);
      insertReviewCycle(db, "old-demo-web", 1);
      insertReviewCycle(db, "old-demo-web", 2);
      insertAttempt(db, "demo-web", 1, "rerun");
      insertAttempt(db, "demo-api", 1, "rerun");
      insertFinding(db, {
        findingId: "scoped",
        hitchId: "demo-web",
        severity: "P1",
        scopeStatus: "in_scope",
        lifecycleStatus: "fixed",
      });
      insertFinding(db, {
        findingId: "old",
        hitchId: "old-demo-web",
        severity: "P0",
        scopeStatus: "in_scope",
        lifecycleStatus: "open",
      });

      const summary = hitchMetricsSummary(db, {
        projectId: "demo",
        domain: "apps/web",
        since: "2026-06-01T00:00:00.000Z",
        until: "2026-06-30T00:00:00.000Z",
      });

      expect(summary.totalSessions).toBe(1);
      expect(summary.byStatus).toEqual({ closed: 1 });
      expect(summary.avgReviewCycles).toBe(1);
      expect(summary.avgRerunAttempts).toBe(1);
      expect(summary.findingsBySeverity).toEqual({ P1: 1 });
    } finally {
      db.close();
    }
  });

  it("aggregates MCP confirmation KPIs by created_at without project scope", () => {
    const db = freshDb();
    try {
      insertMcpConfirmation(db, {
        confirmationId: "pending-a",
        status: "pending",
        createdAt: "2026-06-10T00:00:00.000Z",
      });
      insertMcpConfirmation(db, {
        confirmationId: "confirmed-a",
        status: "confirmed",
        createdAt: "2026-06-10T00:00:00.000Z",
      });
      insertMcpConfirmation(db, {
        confirmationId: "confirmed-b",
        status: "confirmed",
        createdAt: "2026-06-11T00:00:00.000Z",
      });
      insertMcpConfirmation(db, {
        confirmationId: "consumed-a",
        status: "consumed",
        createdAt: "2026-06-11T00:00:00.000Z",
      });
      insertMcpConfirmation(db, {
        confirmationId: "rejected-a",
        status: "rejected",
        createdAt: "2026-06-12T00:00:00.000Z",
      });
      insertMcpConfirmation(db, {
        confirmationId: "expired-a",
        status: "expired",
        createdAt: "2026-06-12T00:00:00.000Z",
      });
      insertMcpConfirmation(db, {
        confirmationId: "expired-b",
        status: "expired",
        createdAt: "2026-06-13T00:00:00.000Z",
      });
      insertMcpConfirmation(db, {
        confirmationId: "old-consumed",
        status: "consumed",
        createdAt: "2026-05-01T00:00:00.000Z",
      });

      const summary = mcpConfirmationSummary(db, {
        since: "2026-06-01T00:00:00.000Z",
        until: "2026-06-30T00:00:00.000Z",
      });

      expect(summary.total).toBe(7);
      expect(summary.byStatus).toEqual({
        confirmed: 2,
        consumed: 1,
        expired: 2,
        pending: 1,
        rejected: 1,
      });
      expect(summary.confirmationRate).toBe(3 / 6);
      expect(summary.expiredRate).toBe(2 / 6);
    } finally {
      db.close();
    }
  });

  it("excludes pending confirmations from MCP rate denominators", () => {
    const db = freshDb();
    try {
      insertMcpConfirmation(db, {
        confirmationId: "pending-only",
        status: "pending",
        createdAt: "2026-06-10T00:00:00.000Z",
      });

      const summary = mcpConfirmationSummary(db);

      expect(summary.total).toBe(1);
      expect(summary.byStatus).toEqual({ pending: 1 });
      expect(summary.confirmationRate).toBeNull();
      expect(summary.expiredRate).toBeNull();
    } finally {
      db.close();
    }
  });
});
