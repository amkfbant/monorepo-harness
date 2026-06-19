import process from "node:process";
import { randomBytes } from "node:crypto";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { createOperationsServer } from "../operations/server.js";
import {
  listOperations,
  getOperation,
  listOperationEvents,
  type OperationStatus,
} from "../db/repositories/operations.js";
import {
  confirmMcpRequest,
  rejectMcpRequest,
} from "../mcp/confirmation-runner.js";
import {
  getMcpConfirmationRequest,
  redactMcpConfirmationRow,
} from "../mcp/security/confirmation.js";

/**
 * `harness operations`（audit ledger + mutation API serve）と `harness operation`
 * （MCP confirmation の confirm/reject）を run.ts から behavior-zero で抽出。
 *
 * 安全境界（CLAUDE.md 不可侵）: operation confirm/reject は dangerous operation の
 * out-of-band 人間確認パス。preview/--yes ゲート・exit code・redaction を一字一句維持する。
 * getHarnessRoot は action 実行時に opts 経由で遅延解決。
 */
export function registerOperationsCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const operationsCmd = program
    .command("operations")
    .description("operation audit ledger (Phase 13)");
  operationsCmd
    .command("serve")
    .description("start the authenticated operations mutation API")
    .option("--host <host>", "bind host (default 127.0.0.1)", "127.0.0.1")
    .option("--port <port>", "bind port (default 8788)", "8788")
    .option(
      "--token-env <name>",
      "env var name holding the bearer token (required)",
    )
    .option(
      "--csrf-token-env <name>",
      "env var name holding the CSRF token (default: generate and print once)",
    )
    .option("--cors-origin <origin>", "enable CORS for this origin")
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(opts.getHarnessRoot());
      const port = Number(raw.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write(
          `harness error: --port must be 0..65535 (got ${JSON.stringify(String(raw.port))})\n`,
        );
        process.exit(1);
      }
      if (raw.tokenEnv === undefined) {
        process.stderr.write(
          "harness error: operations serve requires --token-env <ENV_NAME>\n",
        );
        process.exit(1);
      }
      const token = process.env[String(raw.tokenEnv)];
      if (token === undefined || token === "") {
        process.stderr.write(
          `harness error: ${String(raw.tokenEnv)} is empty; operations serve requires a bearer token\n`,
        );
        process.exit(1);
      }
      let csrfToken: string;
      if (raw.csrfTokenEnv !== undefined) {
        const envName = String(raw.csrfTokenEnv);
        const fromEnv = process.env[envName];
        if (fromEnv === undefined || fromEnv === "") {
          process.stderr.write(
            `harness error: ${envName} is empty; operations serve requires a CSRF token\n`,
          );
          process.exit(1);
        }
        csrfToken = fromEnv;
      } else {
        csrfToken = randomBytes(24).toString("base64url");
        process.stdout.write(
          `operations CSRF token: ${csrfToken}\n` +
            "  pass it on POST requests as X-CSRF-Token.\n",
        );
      }
      const host = String(raw.host);
      if (host === "0.0.0.0") {
        process.stderr.write(
          "warning: binding operations serve to 0.0.0.0 exposes mutation APIs to the network.\n",
        );
      }
      const server = createOperationsServer({
        dbPath: paths.dbPath,
        host,
        port,
        token,
        csrfToken,
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
            `harness operations listening on http://${host}:${actualPort}\n`,
          );
          resolve();
        });
      });
    });
  operationsCmd
    .command("list")
    .description("list recent operations")
    .option("--target-type <t>", "filter by target type (run / backlog_item)")
    .option("--target-id <id>", "filter by target id")
    .option("--status <s>", "filter by status (pending|running|succeeded|failed|cancelled)")
    .option("--limit <n>", "max rows (default 50)", "50")
    .action((raw: Record<string, unknown>) => {
      const paths = harnessPaths(opts.getHarnessRoot());
      const dbHandle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
      try {
        const rows = listOperations(dbHandle.db, {
          ...(raw.targetType !== undefined
            ? { targetType: String(raw.targetType) }
            : {}),
          ...(raw.targetId !== undefined
            ? { targetId: String(raw.targetId) }
            : {}),
          ...(raw.status !== undefined
            ? { status: String(raw.status) as OperationStatus }
            : {}),
          limit: Number(raw.limit) || 50,
        });
        if (rows.length === 0) {
          process.stdout.write("(none)\n");
          return;
        }
        for (const r of rows) {
          process.stdout.write(
            `  ${r.operationId}\t${r.status}\t${r.operationType ?? "?"}\t${r.targetType ?? "?"}:${r.targetId ?? "?"}\tactor=${r.actor ?? "?"}\tcreated=${r.createdAt}\n`,
          );
        }
      } finally {
        dbHandle.close();
      }
    });
  operationsCmd
    .command("show")
    .description("show an operation row + events")
    .argument("<operationId>", "operation id")
    .action((operationId: string) => {
      const paths = harnessPaths(opts.getHarnessRoot());
      const dbHandle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
      try {
        const row = getOperation(dbHandle.db, operationId);
        if (row === null) {
          process.stderr.write(`harness error: operation ${operationId} not found\n`);
          process.exit(1);
        }
        process.stdout.write(JSON.stringify(row, null, 2) + "\n");
        const events = listOperationEvents(dbHandle.db, operationId);
        process.stdout.write("events:\n");
        for (const e of events) {
          process.stdout.write(
            `  ${e.seq}\t${e.eventType}\t${e.message ?? ""}\t${e.createdAt}\n`,
          );
        }
      } finally {
        dbHandle.close();
      }
    });

  const operationCmd = program
    .command("operation")
    .description("MCP confirmation actions for operation requests");
  operationCmd
    .command("confirm")
    .description("preview or confirm and execute a pending MCP confirmation request")
    .argument("<confirmationId>", "MCP confirmation id")
    .option("--by <actor>", "human confirmer identity", "cli")
    .option("--preview", "print the redacted confirmation preview without executing")
    .option("--yes", "execute after printing the confirmation preview")
    .action(async (confirmationId: string, raw: Record<string, unknown>) => {
      const row = getMcpConfirmationRequest(opts.getHarnessRoot(), confirmationId);
      if (row === null) {
        process.stderr.write(`harness error: confirmation ${confirmationId} not found\n`);
        process.exit(1);
      }
      const redacted = redactMcpConfirmationRow(row);
      process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
      if (raw.preview === true) return;
      if (raw.yes !== true) {
        process.stderr.write(
          "harness error: confirmation preview printed; rerun with --yes to execute\n",
        );
        process.exitCode = 1;
        return;
      }
      const result = await confirmMcpRequest({
        harnessRoot: opts.getHarnessRoot(),
        confirmationId,
        confirmedBy: String(raw.by ?? "cli"),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.status === "error" || result.status === "permission_denied") {
        process.exitCode = 1;
      }
    });
  operationCmd
    .command("reject")
    .description("reject a pending MCP confirmation request")
    .argument("<confirmationId>", "MCP confirmation id")
    .option("--by <actor>", "human confirmer identity", "cli")
    .action((confirmationId: string, raw: Record<string, unknown>) => {
      try {
        const row = rejectMcpRequest({
          harnessRoot: opts.getHarnessRoot(),
          confirmationId,
          confirmedBy: String(raw.by ?? "cli"),
        });
        process.stdout.write(`${JSON.stringify(redactMcpConfirmationRow(row), null, 2)}\n`);
      } catch (e) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
    });
}
