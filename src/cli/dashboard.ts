import process from "node:process";
import { join } from "node:path";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { exportDashboard } from "../dashboard/export.js";
import { createDashboardServer } from "../dashboard/server/server.js";
import { DashboardSnapshotError } from "../dashboard/snapshot.js";

/**
 * `harness dashboard`（export / serve）を run.ts から behavior-zero で抽出。
 *
 * 安全境界: dashboard serve は READ-ONLY。--enable-mutation は exit(1) で拒否し
 * POST mutation route を一切載せない（mutation は operations serve へ分離）。non-local
 * バインドの fail-closed 警告も維持。getHarnessRoot は action 実行時に opts 経由で遅延解決。
 */
export function registerDashboardCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const dashboardCmd = program
    .command("dashboard")
    .description("static, read-only HTML dashboard (DB-backed — Phase 6)");
  dashboardCmd
    .command("export")
    .description("write docs/dashboard/index.html from the DB read model")
    .option("--out <path>", "output path (default docs/dashboard/index.html)")
    .option("--project <id>", "scope the dashboard to one project")
    .option("--repo-id <id>", "scope the dashboard to one repo")
    .option("--no-auto-import", "do not refresh the DB from files first")
    .action((raw: Record<string, unknown>) => {
      const harnessRoot = opts.getHarnessRoot();
      const outPath =
        raw.out !== undefined
          ? String(raw.out)
          : join(harnessRoot, "docs", "dashboard", "index.html");
      const filters = {
        ...(raw.project !== undefined ? { projectId: String(raw.project) } : {}),
        ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
      };
      try {
        const r = exportDashboard({
          harnessRoot,
          outPath,
          filters,
          // commander maps --no-auto-import to raw.autoImport === false
          autoImport: raw.autoImport !== false,
        });
        const imported = raw.autoImport !== false ? " (auto-imported from files)" : "";
        process.stdout.write(
          `dashboard exported: ${r.outPath} (${r.bytes} bytes)${imported}\n` +
            `consistency: ${r.snapshot.consistencyStatus}\n`,
        );
      } catch (e) {
        if (e instanceof DashboardSnapshotError) {
          process.stderr.write(`harness error: ${e.message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });
  dashboardCmd
    .command("serve")
    .description("start a read-only HTTP dashboard (Phase 12)")
    .option("--host <host>", "bind host (default 127.0.0.1)", "127.0.0.1")
    .option("--port <port>", "bind port (default 8787)", "8787")
    .option(
      "--token-env <name>",
      "env var name holding the bearer token (Phase 12-7)",
    )
    .option(
      "--no-artifact-body",
      "disable GET /api/artifacts/:id/body (Phase 12-7)",
      false,
    )
    .option(
      "--max-inline-artifact-bytes <n>",
      "inline artifact body size cap (default 1048576)",
      "1048576",
    )
    .option("--cors-origin <origin>", "enable CORS for this origin")
    .option(
      "--enable-mutation",
      "deprecated: exits; use `harness operations serve`",
      false,
    )
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(opts.getHarnessRoot());
      const port = Number(raw.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write(
          `harness error: --port must be 0..65535 (got ${JSON.stringify(String(raw.port))})\n`,
        );
        process.exit(1);
      }
      if (raw.enableMutation === true) {
        process.stderr.write(
          "harness error: dashboard serve --enable-mutation has moved to " +
            "`harness operations serve`; dashboard serve is read-only and never " +
            "mounts POST mutation routes.\n",
        );
        process.exit(1);
      }
      const host = String(raw.host);
      const isLocal =
        host === "127.0.0.1" || host === "::1" || host === "localhost";
      if (!isLocal && raw.tokenEnv === undefined) {
        process.stderr.write(
          `warning: binding to non-local host ${host} without --token-env. ` +
            "All requests will be rejected with 401 (fail-closed). " +
            "Set --token-env <ENV_NAME> to enable auth.\n",
        );
      } else if (host === "0.0.0.0") {
        process.stderr.write(
          "warning: binding to 0.0.0.0 exposes the dashboard to the network.\n",
        );
      }
      const maxInline = Number(raw.maxInlineArtifactBytes);
      if (!Number.isInteger(maxInline) || maxInline < 0) {
        process.stderr.write(
          `harness error: --max-inline-artifact-bytes must be a non-negative integer\n`,
        );
        process.exit(1);
      }
      const token =
        raw.tokenEnv !== undefined ? process.env[String(raw.tokenEnv)] : undefined;
      const server = createDashboardServer({
        dbPath: paths.dbPath,
        host,
        port,
        ...(token !== undefined ? { token } : {}),
        artifactBodyDisabled: raw.artifactBody === false,
        maxInlineArtifactBytes: maxInline,
        ...(raw.corsOrigin !== undefined
          ? { corsOrigin: String(raw.corsOrigin) }
          : {}),
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = addr && typeof addr === "object" ? addr.port : port;
          process.stdout.write(
            `harness dashboard listening on http://${host}:${actualPort}\n`,
          );
          resolve();
        });
      });
    });
}
