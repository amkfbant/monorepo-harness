// Phase 12-7 認証ゲート + security headers + artifact-id デコード。
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DashboardServerConfig } from "./server-types.js";

/**
 * Phase 12-7: Authorization gate.
 *
 *   - token unset + localhost (127.0.0.1 / ::1) → skip (operator UX).
 *   - token unset + non-local → 401 (server should not have started in
 *     that shape without an explicit warning; fail-closed regardless).
 *   - token set → require `Authorization: Bearer <token>` on every
 *     request.
 */
function isLocalHost(host: string): boolean {
  return (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "localhost" ||
    host === "::ffff:127.0.0.1"
  );
}

/**
 * Constant-time string compare. Returns false (not throws) when lengths
 * differ so callers can use a single boolean check.
 */
export function safeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function checkAuth(
  req: IncomingMessage,
  config: DashboardServerConfig,
): { ok: true } | { ok: false; status: number; code: string; message: string } {
  const tokenConfigured = config.token !== undefined && config.token !== "";
  // Operations mutation mode MUST have a bearer token, even on localhost.
  // Without one a local process could POST to /api/runs/:id/review and bypass
  // review governance.
  if (config.mutationEnabled === true && !tokenConfigured) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message:
        "operations serve requires a bearer token (--token-env). " +
        "Read-only dashboard serve still works without one.",
    };
  }
  // Read-only + local + no token → skip (existing operator UX).
  if (!tokenConfigured) {
    if (isLocalHost(config.host)) return { ok: true };
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message:
        "dashboard bound non-local but no bearer token configured (--token-env)",
    };
  }
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${config.token}`;
  if (!safeStringEqual(header, expected)) {
    return {
      ok: false,
      status: 401,
      code: "unauthorized",
      message: "missing or invalid Authorization: Bearer <token>",
    };
  }
  return { ok: true };
}

export function setSecurityHeaders(
  res: ServerResponse,
  config: DashboardServerConfig,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (config.corsOrigin !== undefined && config.corsOrigin !== "") {
    res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
    res.setHeader("Vary", "Origin");
  }
}
