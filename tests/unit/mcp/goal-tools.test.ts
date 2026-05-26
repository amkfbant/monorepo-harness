import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { HarnessMcpServer } from "../../../src/mcp/server.js";
import {
  DEFAULT_MCP_CONFIG,
  type McpConfig,
} from "../../../src/mcp/security/config.js";

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-goal-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  db.close();
  return root;
}

function mutationConfig(allowedOperations: string[]): McpConfig {
  return {
    ...DEFAULT_MCP_CONFIG,
    defaultMode: "guarded-mutation",
    allowedProjects: ["demo"],
    allowedOperations,
  };
}

function server(root: string, config: McpConfig): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot: root,
    config,
    clientName: "unit-test",
    transport: "stdio",
    sessionId: "mcpsess_goal",
  });
}

async function callTool(
  s: HarnessMcpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const response = (await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as any;
  return response.result.structuredContent as Record<string, any>;
}

async function readResource(
  s: HarnessMcpServer,
  uri: string,
): Promise<Record<string, any>> {
  const response = (await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri },
  })) as any;
  return JSON.parse(response.result.contents[0].text) as Record<string, any>;
}

const GOAL_ALLOWED = [
  "goal.start",
  "goal.record_findings",
  "goal.mark_finding_fixed",
  "goal.record_close_check",
  "goal.check_convergence",
  "goal.defer_finding",
  "goal.close",
];

describe("MCP goal tools", () => {
  it("records findings, checks convergence, exposes resources, and closes close_ready goals", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(GOAL_ALLOWED));
    const started = await callTool(s, "harness.goal.start", {
      title: "Goal MCP",
      projectId: "demo",
      domain: "goal",
      scope: {
        targetFiles: ["src/goal/**"],
        allowedFindingCategories: ["correctness"],
      },
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-start",
    });
    expect(started.status).toBe("operation_started");
    const goalId = started.data.result.goalId as string;
    const startedOperation = await callTool(s, "harness.operation.get", {
      operationId: started.operationId,
    });
    expect(startedOperation.status).toBe("ok");

    const recorded = await callTool(s, "harness.goal.record_findings", {
      goalId,
      findings: [
        {
          severity: "P1",
          category: "correctness",
          summary: "Goal repository drops evidence",
          filePath: "src/goal/repository.ts",
        },
      ],
      idempotencyKey: "goal-findings",
    });
    expect(recorded.data.result.recorded[0].finding.scopeStatus).toBe(
      "in_scope",
    );
    const findingId = recorded.data.result.recorded[0].finding.findingId;

    expect(
      (await callTool(s, "harness.goal.mark_finding_fixed", {
        findingId,
        note: "stored evidence",
        idempotencyKey: "goal-fixed",
      })).status,
    ).toBe("operation_started");
    const secret = `sk-${"c".repeat(40)}`;
    const checked = await callTool(s, "harness.goal.record_close_check", {
      goalId,
      conditionId: "typecheck",
      status: "passed",
      evidence: { output: `typecheck passed with ${secret}` },
      message: "typecheck passed",
      idempotencyKey: "goal-check",
    });
    expect(checked.status).toBe("operation_started");
    expect(JSON.stringify(checked)).not.toContain(secret);
    const closeCheckOperation = await callTool(s, "harness.operation.get", {
      operationId: checked.operationId,
    });
    expect(closeCheckOperation.status).toBe("ok");
    expect(JSON.stringify(closeCheckOperation)).not.toContain(secret);
    const goalOperations = await callTool(s, "harness.operation.list", {
      targetType: "goal",
      limit: 10,
    });
    expect(goalOperations.status).toBe("ok");
    expect(
      goalOperations.data.operations.map((op: any) => op.operationId),
    ).toContain(checked.operationId);

    const convergence = await callTool(s, "harness.goal.check_convergence", {
      goalId,
      idempotencyKey: "goal-convergence",
    });
    expect(convergence.data.result.decision).toBe("close_ready");

    const resource = await readResource(s, `harness://goal/${goalId}`);
    expect(resource.status).toBe("ok");
    expect(resource.data.convergence.decision).toBe("close_ready");

    const closed = await callTool(s, "harness.goal.close", {
      goalId,
      summary: "done",
      idempotencyKey: "goal-close",
    });
    expect(closed.status).toBe("operation_started");
    expect(closed.data.result.status).toBe("closed");
  });

  it("requires backlog.create permission before creating deferred backlog follow-ups", async () => {
    const root = freshRoot();
    const s = server(
      root,
      mutationConfig(["goal.start", "goal.record_findings", "goal.defer_finding"]),
    );
    const started = await callTool(s, "harness.goal.start", {
      title: "Goal MCP defer",
      projectId: "demo",
      domain: "goal",
      scope: { targetFiles: ["src/goal/**"] },
      idempotencyKey: "goal-start-defer",
    });
    const goalId = started.data.result.goalId as string;
    const recorded = await callTool(s, "harness.goal.record_findings", {
      goalId,
      findings: [
        {
          severity: "P2",
          category: "future-feature",
          summary: "Add dashboard controls",
          filePath: "src/dashboard/view.ts",
        },
      ],
      idempotencyKey: "goal-out-scope",
    });
    const findingId = recorded.data.result.recorded[0].finding.findingId;

    const denied = await callTool(s, "harness.goal.defer_finding", {
      findingId,
      reason: "future UI",
      createBacklogItem: true,
      idempotencyKey: "goal-defer-denied",
    });
    expect(denied.status).toBe("permission_denied");
  });

  it("does not close close_ready goals without guarded close permission", async () => {
    const root = freshRoot();
    const s = server(
      root,
      mutationConfig(["goal.start", "goal.record_close_check"]),
    );
    const started = await callTool(s, "harness.goal.start", {
      title: "Goal MCP close permission",
      projectId: "demo",
      domain: "goal",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-close-denied-start",
    });
    const goalId = started.data.result.goalId as string;
    await callTool(s, "harness.goal.record_close_check", {
      goalId,
      conditionId: "typecheck",
      status: "passed",
      idempotencyKey: "goal-close-denied-check",
    });

    const denied = await callTool(s, "harness.goal.close", {
      goalId,
      summary: "done",
      idempotencyKey: "goal-close-denied",
    });
    expect(denied.status).toBe("permission_denied");
    expect(denied.data.reason).toBe("operation_not_allowlisted");
  });

  it("returns confirmation_required when closing a non-close_ready goal", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(["goal.start", "goal.close"]));
    const started = await callTool(s, "harness.goal.start", {
      title: "Goal MCP close confirmation",
      projectId: "demo",
      domain: "goal",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-close-confirm-start",
    });
    const goalId = started.data.result.goalId as string;

    const pending = await callTool(s, "harness.goal.close", {
      goalId,
      summary: "force after human review",
      idempotencyKey: "goal-close-confirm",
    });
    expect(pending.status).toBe("confirmation_required");
    expect(pending.confirmationId).toMatch(/^mcpconf-/);
    expect(pending.data.preview.data.convergence.decision).not.toBe(
      "close_ready",
    );
  });

  it("requires confirmation when force closing a close_ready goal", async () => {
    const root = freshRoot();
    const s = server(
      root,
      mutationConfig(["goal.start", "goal.record_close_check", "goal.close"]),
    );
    const started = await callTool(s, "harness.goal.start", {
      title: "Goal MCP close force",
      projectId: "demo",
      domain: "goal",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-close-force-start",
    });
    const goalId = started.data.result.goalId as string;
    await callTool(s, "harness.goal.record_close_check", {
      goalId,
      conditionId: "typecheck",
      status: "passed",
      idempotencyKey: "goal-close-force-check",
    });

    const pending = await callTool(s, "harness.goal.close", {
      goalId,
      summary: "done with force",
      force: true,
      idempotencyKey: "goal-close-force",
    });
    expect(pending.status).toBe("confirmation_required");
  });

  it("advertises goal tools, resource template, and convergence prompt", async () => {
    const s = server(freshRoot(), DEFAULT_MCP_CONFIG);
    const tools = (await s.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })) as any;
    const toolNames = tools.result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toContain("harness.goal.status");
    expect(toolNames).toContain("harness.goal.check_convergence");

    const resources = (await s.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/templates/list",
    })) as any;
    expect(JSON.stringify(resources)).toContain("harness://goal/{goalId}");

    const prompts = (await s.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "prompts/list",
    })) as any;
    expect(JSON.stringify(prompts)).toContain(
      "harness.prompt.drive_goal_convergence",
    );
    const prompt = (await s.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "prompts/get",
      params: {
        name: "harness.prompt.drive_goal_convergence",
        arguments: { goalId: "goal-test" },
      },
    })) as any;
    const promptText = prompt.result.messages[0].content.text as string;
    expect(promptText).toContain("escalate and stop on P0");
    expect(promptText).not.toContain("P0/P1");
  });
});
