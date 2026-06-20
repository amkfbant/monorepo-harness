// dashboard read API routes（前半: operations/assets/storage/archives/doctor/health/runs）。

import { dirname } from "node:path";

import { openManagedDb } from "../../db/managed-connection.js";
import { SCHEMA_VERSION } from "../../db/schema.js";
import { loadDashboardSnapshot, DashboardSnapshotError, type DashboardFilters } from "../snapshot.js";
import { readRunMetaFromDb, readRunEventsFromDb, listRunArtifactsFromDb } from "../../core/run-db-reader.js";
import { ReviewProposalRepository } from "../../db/repositories/review-proposals.js";
import { ReviewConsensusRepository } from "../../db/repositories/review-consensus.js";

import { listBlobStores, listExternalBlobs } from "../../db/blob-stores.js";
import { listArchives } from "../../db/archive-catalog.js";

import { listOperations, getOperation, listOperationEvents } from "../../db/repositories/operations.js";
import { listAssetExports, type AssetType } from "../../db/repositories/asset-exports.js";
import { getCurrentProjectProfile, listProjectProfileRevisions } from "../../db/repositories/project-profile-revisions.js";
import { getCurrentPolicyTemplate, listPolicyTemplates, type PolicyScopeType } from "../../db/repositories/policy-templates.js";
import { getCurrentKnowledgeRevision, listKnowledgeRevisions, knowledgeEntriesHasCategory } from "../../db/repositories/knowledge-entry-revisions.js";
import type { Route } from "./server-types.js";
import { validRunId, writeError, writeJson } from "./server-routing.js";

/**
 * Dashboard read-only HTTP server (Phase 12-1 skeleton).
 *
 * Single-file router; Node built-in http. Routes are matched by exact
 * path or `/api/runs/:runId/timeline`-style placeholders. Phase 12 only
 * accepts GET / HEAD; everything else is 405.
 *
 * Subsequent sub-phases (12-2 .. 12-7) extend the route list. The
 * skeleton intentionally keeps a single `routes` table — no framework,
 * no plugin system.
 */

export function dataRoutes(): Route[] {

  return [
    // Operation audit endpoints are read-only dashboard routes so operators can
    // inspect operations created by the separate operations POST listener.
    {
      method: "GET",
      pattern: "/api/operations",
      handler: ({ ctx, res, query }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const tt = query.get("targetType");
          const ti = query.get("targetId");
          const st = query.get("status");
          const limit = Number(query.get("limit") ?? "100");
          const rows = listOperations(handle.db, {
            ...(tt !== null ? { targetType: tt } : {}),
            ...(ti !== null ? { targetId: ti } : {}),
            ...(st !== null
              ? {
                  status: st as
                    | "pending"
                    | "running"
                    | "succeeded"
                    | "failed"
                    | "cancelled",
                }
              : {}),
            limit: Number.isFinite(limit) ? limit : 100,
          });
          writeJson(res, 200, { operations: rows });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/operations/:operationId",
      handler: ({ ctx, res, params }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const op = getOperation(handle.db, params.operationId!);
          if (op === null) {
            writeError(
              res,
              404,
              "not_found",
              `operation ${params.operationId} not found`,
            );
            return;
          }
          const events = listOperationEvents(handle.db, params.operationId!);
          writeJson(res, 200, { operation: op, events });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/assets/exports",
      handler: ({ ctx, res, query }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const t = query.get("assetType");
          const filter =
            t !== null
              ? { assetType: t as AssetType }
              : {};
          const rows = listAssetExports(handle.db, filter);
          writeJson(res, 200, { exports: rows });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/assets/projects",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const rows = handle.db
            .prepare(
              `SELECT p.project_id, p.repo_id,
                      p.current_profile_revision_id AS currentRevisionId,
                      r.version, r.created_at AS revisionCreatedAt
                 FROM projects p
                 LEFT JOIN project_profile_revisions r
                   ON r.revision_id = p.current_profile_revision_id
                ORDER BY p.project_id`,
            )
            .all();
          writeJson(res, 200, { projects: rows });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/assets/policies",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const templates = handle.db
            .prepare(
              `SELECT scope_type, scope_id, MAX(version) AS currentVersion,
                      COUNT(*) AS revisionCount
                 FROM policy_templates
                GROUP BY scope_type, scope_id
                ORDER BY scope_type, scope_id`,
            )
            .all();
          const snapshots = handle.db
            .prepare(
              `SELECT snapshot_id, run_id, project_id, repo_id, domain,
                      created_at
                 FROM effective_policy_snapshots
                ORDER BY created_at DESC, snapshot_id DESC
                LIMIT 100`,
            )
            .all();
          writeJson(res, 200, { templates, snapshots });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/assets/knowledge",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const rows = handle.db
            .prepare(
              // codebase-knowledge assets view. Operational knowledge
              // (category='operational', issue #57) is excluded here
              // (fail-closed); its own surfaces land in a follow-up. On a
              // pre-v19 schema all rows are codebase → drop the filter.
              `SELECT e.entry_id, e.project_id, e.repo_id, e.domain, e.kind,
                      e.path, e.current_revision_id AS currentRevisionId,
                      r.version, r.title, r.created_at AS revisionCreatedAt
                 FROM knowledge_entries e
                 LEFT JOIN knowledge_entry_revisions r
                   ON r.revision_id = e.current_revision_id
                ${knowledgeEntriesHasCategory(handle.db) ? "WHERE e.category = 'codebase'" : ""}
                ORDER BY e.kind, e.path, e.entry_id
                LIMIT 500`,
            )
            .all();
          writeJson(res, 200, { entries: rows });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/assets/projects/:projectId",
      handler: ({ ctx, res, params }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const cur = getCurrentProjectProfile(handle.db, params.projectId!);
          if (cur === null) {
            writeError(
              res,
              404,
              "not_found",
              `no current revision for project ${params.projectId}`,
            );
            return;
          }
          const history = listProjectProfileRevisions(
            handle.db,
            params.projectId!,
          );
          writeJson(res, 200, { current: cur, history });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/assets/policies/:scopeType/:scopeId",
      handler: ({ ctx, res, params }) => {
        const t = params.scopeType!;
        if (
          t !== "repo" &&
          t !== "project" &&
          t !== "domain" &&
          t !== "global"
        ) {
          writeError(
            res,
            400,
            "bad_request",
            "scopeType must be repo | project | domain | global",
          );
          return;
        }
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const cur = getCurrentPolicyTemplate(
            handle.db,
            t as PolicyScopeType,
            params.scopeId!,
          );
          if (cur === null) {
            writeError(
              res,
              404,
              "not_found",
              `no policy template for ${t}:${params.scopeId}`,
            );
            return;
          }
          const history = listPolicyTemplates(
            handle.db,
            t as PolicyScopeType,
            params.scopeId!,
          );
          writeJson(res, 200, { current: cur, history });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/assets/knowledge/:entryId",
      handler: ({ ctx, res, params }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          // codebase-only detail surface. Operational entries (issue #57) are
          // excluded so their body/history cannot be fetched here (mirrors the
          // category filter on the listing route). On a pre-v19 schema there is
          // no category column → every row is codebase.
          const isCodebase = knowledgeEntriesHasCategory(handle.db)
            ? ((
                handle.db
                  .prepare("SELECT category FROM knowledge_entries WHERE entry_id = ?")
                  .get(params.entryId!) as { category: string } | undefined
              )?.category === "codebase")
            : true;
          const cur = isCodebase
            ? getCurrentKnowledgeRevision(handle.db, params.entryId!)
            : null;
          if (cur === null) {
            writeError(
              res,
              404,
              "not_found",
              `no current revision for knowledge entry ${params.entryId}`,
            );
            return;
          }
          const history = listKnowledgeRevisions(handle.db, params.entryId!);
          writeJson(res, 200, { current: cur, history });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/storage/blobs",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const dbBlobs = handle.db
            .prepare(
              `SELECT COUNT(*) AS count,
                      COALESCE(SUM(bytes), 0) AS bytes,
                      COALESCE(SUM(stored_bytes), 0) AS storedBytes
                 FROM artifact_blobs`,
            )
            .get();
          writeJson(res, 200, {
            dbBlobs,
            stores: listBlobStores(handle.db),
            externalBlobs: listExternalBlobs(handle.db),
          });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/archives",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          writeJson(res, 200, { archives: listArchives(handle.db) });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/doctor/latest",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const run = handle.db
            .prepare(
              `SELECT doctor_run_id, started_at, completed_at, status,
                      summary_json
                 FROM doctor_runs
                ORDER BY started_at DESC
                LIMIT 1`,
            )
            .get() as { doctor_run_id: string } | undefined;
          if (run === undefined) {
            writeJson(res, 200, { run: null, findings: [] });
            return;
          }
          const findings = handle.db
            .prepare(
              `SELECT finding_id, check_id, severity, status, message,
                      repairable, details_json
                 FROM doctor_findings
                WHERE doctor_run_id = ?
                ORDER BY finding_id`,
            )
            .all(run.doctor_run_id);
          writeJson(res, 200, { run, findings });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/health",
      handler: ({ ctx, res }) => {
        let dbSchemaVersion: number | null = null;
        try {
          const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
          try {
            const r = handle.db
              .prepare("SELECT MAX(version) AS v FROM schema_migrations")
              .get() as { v: number | null } | undefined;
            dbSchemaVersion = r?.v ?? null;
          } finally {
            handle.close();
          }
        } catch {
          // surface as 'db-unavailable' but keep 200 — operator wants to
          // troubleshoot via health when the DB is missing.
        }
        writeJson(res, 200, {
          status: "ok",
          version: "phase12",
          dbSchemaVersion,
          schemaVersionExpected: SCHEMA_VERSION,
          generatedAt: new Date().toISOString(),
        });
      },
    },
    {
      method: "GET",
      pattern: "/api/runs",
      handler: ({ ctx, res, query }) => {
        // List recent runs via the snapshot's recentRuns slice. This
        // reuses the same projection the static dashboard already shows
        // so the UI shape stays consistent.
        const filters: DashboardFilters = {};
        const proj = query.get("project");
        const repo = query.get("repo");
        if (proj !== null) filters.projectId = proj;
        if (repo !== null) filters.repoId = repo;
        try {
          const snap = loadDashboardSnapshot({
            harnessRoot: dirname(dirname(ctx.config.dbPath)),
            filters,
            autoImport: false,
          });
          writeJson(res, 200, { runs: snap.recentRuns });
        } catch (e) {
          if (e instanceof DashboardSnapshotError) {
            writeError(res, 404, "not_found", e.message);
            return;
          }
          throw e;
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:runId",
      handler: ({ ctx, res, params }) => {
        const runId = params.runId!;
        if (!validRunId(runId)) {
          writeError(res, 400, "bad_request", "invalid runId shape");
          return;
        }
        const meta = readRunMetaFromDb(ctx.config.dbPath, runId);
        if (meta === null) {
          writeError(res, 404, "not_found", `run ${runId} not found`);
          return;
        }
        writeJson(res, 200, meta);
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:runId/timeline",
      handler: ({ ctx, res, params }) => {
        const runId = params.runId!;
        if (!validRunId(runId)) {
          writeError(res, 400, "bad_request", "invalid runId shape");
          return;
        }
        const events = readRunEventsFromDb(ctx.config.dbPath, runId);
        if (events === null) {
          writeError(res, 404, "not_found", `run ${runId} not found`);
          return;
        }
        writeJson(res, 200, { events });
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:runId/artifacts",
      handler: ({ ctx, res, params }) => {
        const runId = params.runId!;
        if (!validRunId(runId)) {
          writeError(res, 400, "bad_request", "invalid runId shape");
          return;
        }
        const list = listRunArtifactsFromDb(ctx.config.dbPath, runId);
        if (list === null) {
          writeError(res, 404, "not_found", `run ${runId} not found`);
          return;
        }
        writeJson(res, 200, { artifacts: list });
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:runId/review",
      handler: ({ ctx, res, params }) => {
        const runId = params.runId!;
        if (!validRunId(runId)) {
          writeError(res, 400, "bad_request", "invalid runId shape");
          return;
        }
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const proposals = new ReviewProposalRepository(handle.db).listForRun(
            runId,
          );
          const consensus = new ReviewConsensusRepository(handle.db).findActive(
            runId,
          );
          writeJson(res, 200, { runId, proposals, consensus });
        } finally {
          handle.close();
        }
      },
    },
  ];
}
