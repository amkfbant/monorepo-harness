import { createServer, type Server } from "node:http";
import {
  buildListener,
  type DashboardServerConfig,
} from "../dashboard/server/server.js";
import { mutationRoutes } from "./operations-api.js";

export type OperationsServerConfig = Omit<
  DashboardServerConfig,
  "mutationEnabled"
>;

export function createOperationsServer(config: OperationsServerConfig): Server {
  if (config.token === undefined || config.token === "") {
    throw new Error("operations serve requires a bearer token (set via --token-env)");
  }
  if (config.csrfToken === undefined || config.csrfToken === "") {
    throw new Error(
      "operations serve requires a csrf token (set via --csrf-token-env or allow startup generation)",
    );
  }
  return createServer(
    buildListener(mutationRoutes(), {
      ...config,
      mutationEnabled: true,
    }),
  );
}
