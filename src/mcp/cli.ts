import process from "node:process";
import type { Command } from "commander";
import { harnessPaths } from "../config/paths.js";
import { loadMcpConfig } from "./security/config.js";
import { HarnessMcpServer } from "./server.js";
import { serveMcpStdio } from "./transports/stdio.js";
import { listMcpTools } from "./registry/tool-registry.js";
import {
  MCP_RESOURCE_TEMPLATES,
  MCP_STATIC_RESOURCES,
} from "./registry/resource-registry.js";
import { MCP_PROMPTS } from "./registry/prompt-registry.js";
import {
  listMcpInvocations,
  listMcpSessions,
} from "./audit/mcp-audit.js";
import { listMcpConfirmationRequests } from "./security/confirmation.js";
import { resolveMcpClientPermission } from "./security/permissions.js";

export interface RegisterMcpCommandOptions {
  getHarnessRoot: () => string;
}

function configPathFrom(raw: Record<string, unknown>): string | undefined {
  return raw.config === undefined ? undefined : String(raw.config);
}

function clientNameFrom(raw: Record<string, unknown>): string | undefined {
  return raw.clientName === undefined ? undefined : String(raw.clientName);
}

export function registerMcpCommands(
  program: Command,
  opts: RegisterMcpCommandOptions,
): void {
  const mcp = program
    .command("mcp")
    .description("Model Context Protocol server for coding agents");

  mcp
    .command("serve")
    .description("serve the harness MCP server")
    .option("--transport <transport>", "stdio | http (default stdio)", "stdio")
    .option("--client-name <name>", "fallback MCP client name")
    .option("--config <path>", "path to .harness/mcp.yaml")
    .action(async (raw: Record<string, unknown>) => {
      const transport = String(raw.transport ?? "stdio");
      if (transport !== "stdio") {
        process.stderr.write(
          "harness error: MCP Streamable HTTP transport is deferred; use --transport stdio\n",
        );
        process.exit(1);
      }
      const harnessRoot = opts.getHarnessRoot();
      const config = loadMcpConfig({
        harnessRoot,
        ...(configPathFrom(raw) !== undefined
          ? { configPath: configPathFrom(raw) as string }
          : {}),
      });
      const server = new HarnessMcpServer({
        harnessRoot,
        config,
        transport: "stdio",
        ...(clientNameFrom(raw) !== undefined
          ? { clientName: clientNameFrom(raw) as string }
          : {}),
      });
      await serveMcpStdio({ server });
    });

  mcp
    .command("tools")
    .description("list MCP tools without starting a client session")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      const tools = listMcpTools();
      if (Boolean(raw.json)) {
        process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
        return;
      }
      for (const tool of tools) {
        process.stdout.write(`${tool.name}\t${tool.description}\n`);
      }
    });

  mcp
    .command("resources")
    .description("list MCP resources/templates")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      const payload = {
        resources: MCP_STATIC_RESOURCES,
        resourceTemplates: MCP_RESOURCE_TEMPLATES,
      };
      if (Boolean(raw.json)) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      for (const r of MCP_STATIC_RESOURCES) {
        process.stdout.write(`${r.uri}\t${r.description}\n`);
      }
      for (const r of MCP_RESOURCE_TEMPLATES) {
        process.stdout.write(`${r.uriTemplate}\t${r.description}\n`);
      }
    });

  mcp
    .command("prompts")
    .description("list MCP prompts")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      const prompts = MCP_PROMPTS.map((p) => ({
        name: p.name,
        title: p.title,
        description: p.description,
        arguments: p.arguments,
      }));
      if (Boolean(raw.json)) {
        process.stdout.write(`${JSON.stringify({ prompts }, null, 2)}\n`);
        return;
      }
      for (const p of prompts) {
        process.stdout.write(`${p.name}\t${p.description}\n`);
      }
    });

  mcp
    .command("config")
    .description("show effective MCP config")
    .option("--config <path>", "path to .harness/mcp.yaml")
    .option("--client-name <name>", "show effective permission for MCP client name")
    .action((raw: Record<string, unknown>) => {
      const paths = harnessPaths(opts.getHarnessRoot());
      const config = loadMcpConfig({
        harnessRoot: paths.root,
        ...(configPathFrom(raw) !== undefined
          ? { configPath: configPathFrom(raw) as string }
          : {}),
      });
      const clientName = clientNameFrom(raw);
      const payload =
        clientName === undefined
          ? config
          : resolveMcpClientPermission(config, clientName);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    });

  mcp
    .command("sessions")
    .description("list audited MCP sessions")
    .option("--limit <n>", "max rows (default 20)", "20")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      const rows = listMcpSessions(opts.getHarnessRoot(), Number(raw.limit) || 20);
      if (Boolean(raw.json)) {
        process.stdout.write(`${JSON.stringify({ sessions: rows }, null, 2)}\n`);
        return;
      }
      for (const r of rows) {
        process.stdout.write(
          `${String(r.session_id)}\t${String(r.client_name)}\t${String(r.started_at)}\t${String(r.ended_at ?? "")}\n`,
        );
      }
    });

  mcp
    .command("invocations")
    .description("list audited MCP tool invocations")
    .option("--session-id <id>", "filter by MCP session id")
    .option("--limit <n>", "max rows (default 20)", "20")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      const rows = listMcpInvocations(opts.getHarnessRoot(), {
        ...(raw.sessionId !== undefined ? { sessionId: String(raw.sessionId) } : {}),
        limit: Number(raw.limit) || 20,
      });
      if (Boolean(raw.json)) {
        process.stdout.write(`${JSON.stringify({ invocations: rows }, null, 2)}\n`);
        return;
      }
      for (const r of rows) {
        process.stdout.write(
          `${String(r.invocation_id)}\t${String(r.tool_name)}\t${String(r.result_status)}\t${String(r.started_at)}\n`,
        );
      }
    });

  mcp
    .command("confirmations")
    .description("list MCP confirmation requests")
    .option("--status <status>", "pending|confirmed|rejected|expired|consumed")
    .option("--limit <n>", "max rows (default 20)", "20")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      const rows = listMcpConfirmationRequests(opts.getHarnessRoot(), {
        ...(raw.status !== undefined ? { status: String(raw.status) as any } : {}),
        limit: Number(raw.limit) || 20,
      });
      if (Boolean(raw.json)) {
        process.stdout.write(`${JSON.stringify({ confirmations: rows }, null, 2)}\n`);
        return;
      }
      for (const r of rows) {
        process.stdout.write(
          `${r.confirmationId}\t${r.status}\t${r.toolName}\t${r.targetType ?? "?"}:${r.targetId ?? "?"}\texpires=${r.expiresAt}\n`,
        );
      }
    });
}
