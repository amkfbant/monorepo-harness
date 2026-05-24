import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { dirname } from "node:path";
import { openManagedDb } from "../../db/managed-connection.js";
import { SCHEMA_VERSION } from "../../db/schema.js";
import {
  loadDashboardSnapshot,
  DashboardSnapshotError,
  type DashboardFilters,
} from "../snapshot.js";
import {
  readRunMetaFromDb,
  readRunEventsFromDb,
  listRunArtifactsFromDb,
} from "../../core/run-db-reader.js";
import { ReviewProposalRepository } from "../../db/repositories/review-proposals.js";
import { ReviewConsensusRepository } from "../../db/repositories/review-consensus.js";
import { ReviewerRepository } from "../../db/repositories/reviewers.js";
import { readArtifactBlob } from "../../db/artifact-blobs.js";
import { listActiveDomainLocks } from "../../workspace/db-domain-lock.js";
import { checkConsistency } from "../../db/consistency.js";
import { dbStats } from "../../db/maintenance.js";

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

export interface DashboardServerConfig {
  dbPath: string;
  host: string;
  port: number;
  /** Optional bearer token (Phase 12-7). */
  token?: string;
  /** When true (Phase 12-7), block GET /api/artifacts/:id/body. */
  artifactBodyDisabled?: boolean;
  /** Maximum bytes to inline for an artifact body (Phase 12-4). */
  maxInlineArtifactBytes?: number;
  /** Optional CORS origin (Phase 12-7). */
  corsOrigin?: string;
}

export interface RequestContext {
  config: DashboardServerConfig;
}

export interface RouteParams {
  [key: string]: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RouteHandlerInput {
  req: IncomingMessage;
  res: ServerResponse;
  ctx: RequestContext;
  params: RouteParams;
  /** Parsed URL query. */
  query: URLSearchParams;
}

export type RouteHandler = (input: RouteHandlerInput) => Promise<void> | void;

export interface Route {
  method: "GET";
  pattern: string;
  handler: RouteHandler;
}

const ROUTE_PARAM_RE = /:([A-Za-z_][A-Za-z0-9_]*)/g;

function compilePattern(
  pattern: string,
): { regex: RegExp; params: string[] } {
  const params: string[] = [];
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const re = escaped.replace(ROUTE_PARAM_RE, (_, name: string) => {
    params.push(name);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${re}$`), params };
}

/** Match a path against a list of routes. Returns route + params or null. */
export function matchRoute(
  routes: Route[],
  pathname: string,
): { route: Route; params: RouteParams } | null {
  for (const route of routes) {
    const { regex, params: paramNames } = compilePattern(route.pattern);
    const m = regex.exec(pathname);
    if (m === null) continue;
    const params: RouteParams = {};
    paramNames.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? "");
    });
    return { route, params };
  }
  return null;
}

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Length", Buffer.byteLength(json).toString());
  res.end(json);
}

export function writeError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const err: ApiError = { code, message, ...(details !== undefined ? { details } : {}) };
  writeJson(res, status, { error: err });
}

/** Default route table for the dashboard server. */
export function defaultRoutes(): Route[] {
  return [
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
        const meta = readRunMetaFromDb(ctx.config.dbPath, params.runId!);
        if (meta === null) {
          writeError(res, 404, "not_found", `run ${params.runId} not found`);
          return;
        }
        writeJson(res, 200, meta);
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:runId/timeline",
      handler: ({ ctx, res, params }) => {
        const events = readRunEventsFromDb(ctx.config.dbPath, params.runId!);
        if (events === null) {
          writeError(res, 404, "not_found", `run ${params.runId} not found`);
          return;
        }
        writeJson(res, 200, { events });
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:runId/artifacts",
      handler: ({ ctx, res, params }) => {
        const list = listRunArtifactsFromDb(ctx.config.dbPath, params.runId!);
        if (list === null) {
          writeError(res, 404, "not_found", `run ${params.runId} not found`);
          return;
        }
        writeJson(res, 200, { artifacts: list });
      },
    },
    {
      method: "GET",
      pattern: "/api/runs/:runId/review",
      handler: ({ ctx, res, params }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const proposals = new ReviewProposalRepository(handle.db).listForRun(
            params.runId!,
          );
          const consensus = new ReviewConsensusRepository(handle.db).findActive(
            params.runId!,
          );
          writeJson(res, 200, { runId: params.runId, proposals, consensus });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/review/proposals",
      handler: ({ ctx, res, query }) => {
        const runId = query.get("runId");
        if (runId === null) {
          writeError(res, 400, "bad_request", "runId query is required");
          return;
        }
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const proposals = new ReviewProposalRepository(handle.db).listForRun(
            runId,
            { includeArchived: query.get("includeArchived") === "1" },
          );
          writeJson(res, 200, { runId, proposals });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/review/consensus",
      handler: ({ ctx, res, query }) => {
        const runId = query.get("runId");
        if (runId === null) {
          writeError(res, 400, "bad_request", "runId query is required");
          return;
        }
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const active = new ReviewConsensusRepository(handle.db).findActive(
            runId,
          );
          writeJson(res, 200, { runId, consensus: active });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/artifacts/:artifactId",
      handler: ({ ctx, res, params }) => {
        // Phase 12-4 — artifactId must be a positive integer (path
        // traversal defense via type narrowing).
        const id = Number(params.artifactId);
        if (!Number.isInteger(id) || id <= 0) {
          writeError(
            res,
            400,
            "bad_request",
            "artifactId must be a positive integer",
          );
          return;
        }
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const row = handle.db
            .prepare(
              `SELECT artifact_id, run_id, relative_path, content_type,
                      byte_size, sha256, blob_sha256, storage,
                      secret_suspect, original_bytes, original_sha256,
                      body_status
                 FROM artifacts
                WHERE artifact_id = ?`,
            )
            .get(id) as Record<string, unknown> | undefined;
          if (row === undefined) {
            writeError(res, 404, "not_found", `artifact ${id} not found`);
            return;
          }
          writeJson(res, 200, row);
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/artifacts/:artifactId/body",
      handler: ({ ctx, res, params }) => {
        const id = Number(params.artifactId);
        if (!Number.isInteger(id) || id <= 0) {
          writeError(
            res,
            400,
            "bad_request",
            "artifactId must be a positive integer",
          );
          return;
        }
        if (ctx.config.artifactBodyDisabled === true) {
          writeError(
            res,
            403,
            "forbidden",
            "artifact body serving is disabled (--no-artifact-body)",
          );
          return;
        }
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const row = handle.db
            .prepare(
              `SELECT blob_sha256, byte_size, content_type, secret_suspect,
                      relative_path
                 FROM artifacts WHERE artifact_id = ?`,
            )
            .get(id) as
            | {
                blob_sha256: string | null;
                byte_size: number | null;
                content_type: string | null;
                secret_suspect: number | null;
                relative_path: string;
              }
            | undefined;
          if (row === undefined || row.blob_sha256 === null) {
            writeError(
              res,
              404,
              "not_found",
              `artifact ${id} has no DB-stored body`,
            );
            return;
          }
          const max =
            ctx.config.maxInlineArtifactBytes ?? 1024 * 1024;
          const tooLarge =
            row.byte_size !== null && row.byte_size > max;
          const buf = readArtifactBlob(handle.db, row.blob_sha256);
          if (buf === null) {
            writeError(
              res,
              404,
              "not_found",
              `artifact blob ${row.blob_sha256} missing`,
            );
            return;
          }
          res.statusCode = 200;
          res.setHeader(
            "Content-Type",
            row.content_type ?? "application/octet-stream",
          );
          res.setHeader("X-Content-Type-Options", "nosniff");
          if (row.secret_suspect === 1) {
            res.setHeader("X-Harness-Secret-Suspect", "1");
          }
          if (tooLarge) {
            // download-style: encourage client to save rather than render
            const filename = row.relative_path.split("/").pop() ?? "artifact";
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
            );
          }
          res.setHeader("Content-Length", buf.length.toString());
          res.end(buf);
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/review/reviewers",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const reviewers = new ReviewerRepository(handle.db).list();
          writeJson(res, 200, { reviewers });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/db/status",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const ver = handle.db
            .prepare("SELECT MAX(version) AS v FROM schema_migrations")
            .get() as { v: number | null };
          const runs = handle.db
            .prepare("SELECT count(*) AS n FROM runs")
            .get() as { n: number };
          writeJson(res, 200, {
            dbPath: ctx.config.dbPath,
            schemaVersion: ver.v,
            schemaVersionExpected: SCHEMA_VERSION,
            runs: runs.n,
            generatedAt: new Date().toISOString(),
          });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/db/stats",
      handler: ({ ctx, res }) => {
        try {
          const stats = dbStats(ctx.config.dbPath);
          writeJson(res, 200, stats);
        } catch (e) {
          writeError(
            res,
            500,
            "internal_error",
            (e as Error).message ?? "dbStats failed",
          );
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/db/consistency",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const report = checkConsistency({
            db: handle.db,
            harnessRoot: dirname(dirname(ctx.config.dbPath)),
          });
          writeJson(res, 200, report);
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/locks",
      handler: ({ ctx, res }) => {
        const handle = openManagedDb({ dbPath: ctx.config.dbPath, readonly: true });
        try {
          const locks = listActiveDomainLocks(handle.db);
          writeJson(res, 200, { locks });
        } finally {
          handle.close();
        }
      },
    },
    {
      method: "GET",
      pattern: "/api/snapshot",
      handler: ({ ctx, res, query }) => {
        // Phase 12-2: DashboardSnapshot live from the DB. The server
        // never auto-imports (autoImport: false enforces read-only).
        // Phase 12 minimum filters: project / repo are the only fields
        // supported by DashboardFilters at this point. domain / status /
        // since / until query params are accepted but silently ignored
        // (forward-compatible for Phase 14+ wiring).
        const filters: DashboardFilters = {};
        const proj = query.get("project");
        const repo = query.get("repo");
        if (proj !== null) filters.projectId = proj;
        if (repo !== null) filters.repoId = repo;

        try {
          const snapshot = loadDashboardSnapshot({
            harnessRoot: dirname(dirname(ctx.config.dbPath)),
            filters,
            autoImport: false,
          });
          writeJson(res, 200, snapshot);
        } catch (e) {
          if (e instanceof DashboardSnapshotError) {
            writeError(res, 404, "not_found", e.message);
            return;
          }
          throw e;
        }
      },
    },
  ];
}

/** Build the request listener. Exposed so tests can drive directly. */
export function buildListener(
  routes: Route[],
  config: DashboardServerConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    try {
      const ctx: RequestContext = { config };
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const pathname = url.pathname;

      if (req.method !== "GET" && req.method !== "HEAD") {
        writeError(
          res,
          405,
          "method_not_allowed",
          `Phase 12 dashboard accepts GET / HEAD only (got ${req.method ?? "?"})`,
        );
        return;
      }

      const match = matchRoute(routes, pathname);
      if (match === null) {
        writeError(res, 404, "not_found", `no route for ${pathname}`);
        return;
      }
      await match.route.handler({
        req,
        res,
        ctx,
        params: match.params,
        query: url.searchParams,
      });
    } catch (e) {
      try {
        writeError(
          res,
          500,
          "internal_error",
          (e as Error).message ?? "unknown error",
        );
      } catch {
        // res already closed — best-effort
      }
    }
  };
}

export function createDashboardServer(
  config: DashboardServerConfig,
  routes: Route[] = defaultRoutes(),
): Server {
  return createServer(buildListener(routes, config));
}
