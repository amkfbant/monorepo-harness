import { createRequire } from "node:module";

/**
 * The harness's OWN package version, read from `package.json` at runtime so it
 * can never go stale (the previous hard-coded MCP `serverInfo.version` drifted to
 * `0.1.0` while the package was at 0.2.0). Resolved relative to this module, so
 * it works both in dev (`src/config/version.ts` → `../../package.json`) and in
 * the build (`dist/config/version.js` → `../../package.json`) — both land on the
 * repo-root package.json. Falls back to a sentinel if it cannot be read rather
 * than throwing, since a missing version must not crash the CLI / MCP server.
 */
export function harnessVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version !== ""
      ? pkg.version
      : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}
