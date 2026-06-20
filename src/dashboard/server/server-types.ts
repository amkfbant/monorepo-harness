// dashboard server の公開型（leaf）。route/auth/listener が共有。
import type { IncomingMessage, ServerResponse } from "node:http";

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
  /**
   * Internal HTTP listener switch used by the operations server. Dashboard
   * creation sanitizes this to false and always serves read-only routes.
   */
  mutationEnabled?: boolean;
  /**
   * Internal CSRF token used by the operations server POST listener.
   */
  csrfToken?: string;
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
  method: "GET" | "POST";
  pattern: string;
  handler: RouteHandler;
}
