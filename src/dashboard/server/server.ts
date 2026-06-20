import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import type {
  Route,
  RequestContext,
  DashboardServerConfig,
} from "./server-types.js";
import { matchRoute, writeError } from "./server-routing.js";
import {
  checkAuth,
  setSecurityHeaders,
  safeStringEqual,
} from "./server-auth.js";
import { dataRoutes } from "./server-routes-data.js";
import { reviewRoutes } from "./server-routes-review.js";

// Re-export the public surface so existing importers keep their paths:
// cli/dashboard (createDashboardServer), operations/server (buildListener,
// DashboardServerConfig), operations-api (Route, writeError, writeJson).
export { matchRoute, writeJson, writeError } from "./server-routing.js";
export type {
  Route,
  DashboardServerConfig,
  RouteHandler,
  RouteHandlerInput,
  RouteParams,
  ApiError,
  RequestContext,
} from "./server-types.js";

/**
 * Dashboard read-only HTTP server (Phase 12-1 skeleton).
 *
 * Single-file router; Node built-in http. Routes are matched by exact
 * path or `/api/runs/:runId/timeline`-style placeholders. Phase 12 only
 * accepts GET / HEAD; everything else is 405.
 *
 * Subsequent sub-phases (12-2 .. 12-7) extend the route list. The
 * skeleton intentionally keeps a single `routes` table — no framework,
 * no plugin system. The route table is split across server-routes-data.ts and
 * server-routes-review.ts (#125 A15); defaultRoutes() composes them in order.
 */

/** Default route table for the dashboard server. */
export function defaultRoutes(): Route[] {
  return [...dataRoutes(), ...reviewRoutes()];
}

/** Build the request listener. Exposed so tests can drive directly. */
export function buildListener(
  routes: Route[],
  config: DashboardServerConfig,
): (req: IncomingMessage, res: ServerResponse) => void {
  return async (req, res) => {
    try {
      setSecurityHeaders(res, config);
      const ctx: RequestContext = { config };
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const pathname = url.pathname;

      // Phase 12-7 auth gate before method check so /api/health does not
      // leak schema_version on unauthorized requests.
      const auth = checkAuth(req, config);
      if (!auth.ok) {
        writeError(res, auth.status, auth.code, auth.message);
        return;
      }

      // Dashboard defines GET/HEAD read routes. Operations serve enables POST
      // for mutation routes. Every other verb (PUT/PATCH/DELETE/...) is 405,
      // not 404 — keep the contract explicit rather than relying on a later
      // route miss.
      const isPost = req.method === "POST";

      if (
        req.method !== "GET" &&
        req.method !== "HEAD" &&
        !(isPost && config.mutationEnabled === true)
      ) {
        writeError(
          res,
          405,
          "method_not_allowed",
          `${config.mutationEnabled === true ? "operations" : "dashboard"} accepts GET / HEAD${
            config.mutationEnabled === true ? " / POST" : ""
          } only (got ${req.method ?? "?"})`,
        );
        return;
      }

      // CSRF for operations POST. Token check is the bearer auth gate above;
      // CSRF is an additional same-origin defense. csrfToken is required when
      // mutationEnabled, and compared in constant time.
      if (req.method === "POST" && config.mutationEnabled === true) {
        const expected = config.csrfToken;
        if (expected === undefined || expected === "") {
          writeError(
            res,
            500,
            "internal_error",
            "operations serve requires a csrf token (server misconfigured)",
          );
          return;
        }
        const got = req.headers["x-csrf-token"];
        if (typeof got !== "string" || !safeStringEqual(got, expected)) {
          writeError(
            res,
            403,
            "forbidden",
            "missing or invalid X-CSRF-Token header",
          );
          return;
        }
      }

      const match = matchRoute(routes, req.method ?? "GET", pathname);
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
  routes?: Route[],
): Server {
  const effective = routes ?? defaultRoutes();
  const {
    mutationEnabled: _mutationEnabled,
    csrfToken: _csrfToken,
    ...readOnlyConfig
  } = config;
  return createServer(
    buildListener(effective, {
      ...readOnlyConfig,
      mutationEnabled: false,
    }),
  );
}
