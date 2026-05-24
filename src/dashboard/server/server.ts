import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { openManagedDb } from "../../db/managed-connection.js";
import { SCHEMA_VERSION } from "../../db/schema.js";

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

/** Default route table (Phase 12-1 = health only). */
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
