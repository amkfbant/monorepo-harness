import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { HarnessMcpServer } from "../../../src/mcp/server.js";
import {
  DEFAULT_MCP_CONFIG,
  type McpConfig,
} from "../../../src/mcp/security/config.js";
import { scopedIdForIdempotencyKey } from "../../../src/mcp/tools/scoped-idempotency.js";

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

function withDb(root: string, fn: (db: ReturnType<typeof openDb>) => void): void {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function mockedConvergence(hitchId: string, decision: string): Record<string, unknown> {
  return {
    hitchId,
    decision,
    reason: "mocked convergence",
    metrics: {
      openInScopeP0: 0,
      openInScopeP1: decision === "close_ready" ? 0 : 1,
      openInScopeP2: 0,
      openUnknownScope: 0,
      openOutOfScope: 0,
      totalNewFindings: 0,
      newFindingsThisCycle: 0,
      reviewCyclesUsed: 0,
      iterationsUsed: 0,
      rerunsUsed: 0,
      closeConditionsPassed: decision === "close_ready" ? 1 : 0,
      closeConditionsFailed: 0,
      closeConditionsPending: decision === "close_ready" ? 0 : 1,
      maxReopenCount: 0,
    },
    recommendedNextAction: {
      kind: decision === "close_ready" ? "close_hitch" : "fix_findings",
      message: "mocked action",
    },
  };
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
  "hitch.start",
  "hitch.record_findings",
  "hitch.mark_finding_fixed",
  "hitch.record_close_check",
  "hitch.check_convergence",
  "hitch.defer_finding",
  "hitch.close",
];

describe("MCP goal tools", () => {
  it("records findings, checks convergence, exposes resources, and closes close_ready goals", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(GOAL_ALLOWED));
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP",
      projectId: "demo",
      domain: "goal",
      scope: {
        targetFiles: ["src/hitch/**"],
        allowedFindingCategories: ["correctness"],
      },
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-start",
    });
    expect(started.status).toBe("operation_started");
    const hitchId = started.data.result.hitchId as string;
    const startedOperation = await callTool(s, "harness.operation.get", {
      operationId: started.operationId,
    });
    expect(startedOperation.status).toBe("ok");
    expect(startedOperation.data.operation.metadata.hitchId).toBe(hitchId);
    expect(startedOperation.data.operation.metadata.hitch_id).toBe(hitchId);

    // a coding pass has already run; convergence reflects post-run behavior.
    withDb(root, (db) => {
      new HitchRepository(db).createAttempt({
        hitchId,
        attemptType: "implement",
      });
    });

    const recorded = await callTool(s, "harness.hitch.record_findings", {
      hitchId,
      findings: [
        {
          severity: "P1",
          category: "correctness",
          summary: "Goal repository drops evidence",
          filePath: "src/hitch/repository.ts",
        },
      ],
      idempotencyKey: "goal-findings",
    });
    expect(recorded.data.result.recorded[0].finding.scopeStatus).toBe(
      "in_scope",
    );
    const findingId = recorded.data.result.recorded[0].finding.findingId;

    const fixed = await callTool(s, "harness.hitch.mark_finding_fixed", {
      findingId,
      note: "stored evidence",
      idempotencyKey: "goal-fixed",
    });
    expect(fixed.status).toBe("operation_started");
    expect(fixed.data.result.finding.lifecycleStatus).toBe("fixed");
    expect(fixed.data.result.decisionRecord.decision).toBe("continue");
    const secret = `sk-${"c".repeat(40)}`;
    const checked = await callTool(s, "harness.hitch.record_close_check", {
      hitchId,
      conditionId: "typecheck",
      status: "passed",
      evidence: { output: `typecheck passed with ${secret}` },
      message: "typecheck passed",
      idempotencyKey: "goal-check",
    });
    expect(checked.status).toBe("operation_started");
    expect(checked.data.result.check.status).toBe("passed");
    expect(checked.data.result.convergence.decision).toBe("close_ready");
    expect(checked.data.result.decisionRecord.decision).toBe("close_ready");
    expect(checked.data.result.hitchStatus.status).toBe("close_ready");
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

    const convergence = await callTool(s, "harness.hitch.check_convergence", {
      hitchId,
      idempotencyKey: "goal-convergence",
    });
    expect(convergence.data.result.decision).toBe("close_ready");

    const resource = await readResource(s, `harness://hitch/${hitchId}`);
    expect(resource.status).toBe("ok");
    expect(resource.data.convergence.decision).toBe("close_ready");

    const closed = await callTool(s, "harness.hitch.close", {
      hitchId,
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
      mutationConfig(["hitch.start", "hitch.record_findings", "hitch.defer_finding"]),
    );
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP defer",
      projectId: "demo",
      domain: "goal",
      scope: { targetFiles: ["src/hitch/**"] },
      idempotencyKey: "goal-start-defer",
    });
    const hitchId = started.data.result.hitchId as string;
    const recorded = await callTool(s, "harness.hitch.record_findings", {
      hitchId,
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

    const denied = await callTool(s, "harness.hitch.defer_finding", {
      findingId,
      reason: "future UI",
      createBacklogItem: true,
      idempotencyKey: "goal-defer-denied",
    });
    expect(denied.status).toBe("permission_denied");
  });

  it("rejects duplicate-scoped finding records without canonical duplicate targets", async () => {
    const root = freshRoot();
    const s = server(
      root,
      mutationConfig(["hitch.start", "hitch.record_findings"]),
    );
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP duplicate finding",
      projectId: "demo",
      domain: "goal",
      idempotencyKey: "goal-start-duplicate-finding",
    });
    const hitchId = started.data.result.hitchId as string;

    const recorded = await callTool(s, "harness.hitch.record_findings", {
      hitchId,
      findings: [
        {
          severity: "P1",
          category: "correctness",
          summary: "Duplicate without canonical",
          scopeStatus: "duplicate",
        },
      ],
      idempotencyKey: "goal-record-duplicate-finding",
    });
    expect(recorded.status).toBe("error");
    expect(recorded.summary).toContain("duplicate finding requires duplicateOf");
  });

  it("records convergence decisions after classify and defer mutations", async () => {
    const root = freshRoot();
    const s = server(
      root,
      mutationConfig([
        "hitch.start",
        "hitch.record_findings",
        "hitch.classify_finding",
        "hitch.defer_finding",
      ]),
    );
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP post mutation audit",
      projectId: "demo",
      domain: "goal",
      scope: { targetFiles: ["src/hitch/**"] },
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-start-post-mutation-audit",
    });
    const hitchId = started.data.result.hitchId as string;
    const unknown = await callTool(s, "harness.hitch.record_findings", {
      hitchId,
      findings: [
        {
          severity: "P1",
          category: "correctness",
          summary: "Unknown finding",
          scopeStatus: "unknown",
        },
      ],
      idempotencyKey: "goal-record-unknown-audit",
    });
    const unknownFindingId = unknown.data.result.recorded[0].finding.findingId;

    const classified = await callTool(s, "harness.hitch.classify_finding", {
      findingId: unknownFindingId,
      scopeStatus: "in_scope",
      reason: "blocks the goal",
      idempotencyKey: "goal-classify-audit",
    });
    expect(classified.status).toBe("operation_started");
    expect(classified.data.result.convergence.decision).toBe("needs_fix");
    expect(classified.data.result.decisionRecord.decision).toBe("needs_fix");

    const outOfScope = await callTool(s, "harness.hitch.record_findings", {
      hitchId,
      findings: [
        {
          severity: "P2",
          category: "future-feature",
          summary: "Future dashboard controls",
          filePath: "src/dashboard/view.ts",
        },
      ],
      idempotencyKey: "goal-record-oos-audit",
    });
    const outOfScopeFindingId =
      outOfScope.data.result.recorded[0].finding.findingId;

    const deferred = await callTool(s, "harness.hitch.defer_finding", {
      findingId: outOfScopeFindingId,
      reason: "future feature",
      createBacklogItem: false,
      idempotencyKey: "goal-defer-audit",
    });
    expect(deferred.status).toBe("operation_started");
    expect(deferred.data.result.finding.lifecycleStatus).toBe("deferred");
    expect(deferred.data.result.decisionRecord).toBeTruthy();
  });

  it("counts MCP-recorded findings as review cycles for divergence budgets", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(["hitch.start", "hitch.record_findings"]));
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP divergence",
      projectId: "demo",
      domain: "goal",
      scope: {
        targetFiles: ["src/hitch/**"],
        allowedFindingCategories: ["correctness"],
      },
      maxTotalNewFindings: 1,
      idempotencyKey: "goal-start-mcp-divergence",
    });
    const hitchId = started.data.result.hitchId as string;

    const recorded = await callTool(s, "harness.hitch.record_findings", {
      hitchId,
      findings: [
        {
          severity: "P2",
          category: "correctness",
          summary: "First MCP finding",
          filePath: "src/hitch/repository.ts",
        },
        {
          severity: "P2",
          category: "correctness",
          summary: "Second MCP finding",
          filePath: "src/hitch/convergence.ts",
        },
      ],
      idempotencyKey: "goal-record-mcp-divergence",
    });

    expect(recorded.status).toBe("operation_started");
    expect(recorded.data.result.cycle.findingsNew).toBe(2);
    expect(recorded.data.result.cycle.findingsSeen).toBe(2);
    expect(recorded.data.result.convergence.decision).toBe("diverging");
    expect(recorded.data.result.convergence.metrics.totalNewFindings).toBe(2);
    expect(recorded.data.result.convergence.metrics.reviewCyclesUsed).toBe(1);
  });

  it("check_convergence honors updateStatus:false (no status sync), matching the CLI", async () => {
    const root = freshRoot();
    withDb(root, (db) => {
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "goal-no-sync",
        title: "NoSync",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      repo.recordCloseCheck({
        hitchId: "goal-no-sync",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
    });
    const s = server(root, mutationConfig(["hitch.check_convergence"]));

    const res = await callTool(s, "harness.hitch.check_convergence", {
      hitchId: "goal-no-sync",
      idempotencyKey: "goal-no-sync",
      updateStatus: false,
    });
    // decision is still computed and recorded, but status sync is suppressed.
    expect(res.data.result.decision).toBe("close_ready");
    expect(res.data.result.hitchStatus).toBeNull();
    withDb(root, (db) => {
      expect(new HitchRepository(db).requireSession("goal-no-sync").status).not.toBe(
        "close_ready",
      );
    });
  });

  it("check_convergence syncs durable stop and close_ready statuses", async () => {
    const root = freshRoot();
    withDb(root, (db) => {
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "goal-sync-diverging",
        title: "Diverging",
        projectId: "demo",
        maxTotalNewFindings: 0,
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      const cycle = repo.startReviewCycle({
        hitchId: "goal-sync-diverging",
        reviewMode: "initial",
      });
      repo.completeReviewCycle({ cycleId: cycle.cycleId, findingsNew: 1 });

      repo.createSession({
        hitchId: "goal-sync-budget",
        title: "Budget",
        projectId: "demo",
        maxIterations: 0,
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });

      repo.createSession({
        hitchId: "goal-sync-close",
        title: "Close",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "mcp",
      });
      repo.recordCloseCheck({
        hitchId: "goal-sync-close",
        conditionId: "typecheck",
        status: "passed",
        checkedBy: "test",
      });
    });
    const s = server(root, mutationConfig(["hitch.check_convergence"]));

    const diverging = await callTool(s, "harness.hitch.check_convergence", {
      hitchId: "goal-sync-diverging",
      idempotencyKey: "goal-sync-diverging",
    });
    expect(diverging.data.result.decision).toBe("diverging");
    expect(diverging.data.result.hitchStatus.status).toBe("diverging");

    const budget = await callTool(s, "harness.hitch.check_convergence", {
      hitchId: "goal-sync-budget",
      idempotencyKey: "goal-sync-budget",
    });
    expect(budget.data.result.decision).toBe("budget_exhausted");
    expect(budget.data.result.hitchStatus.status).toBe("budget_exhausted");

    const closeReady = await callTool(s, "harness.hitch.check_convergence", {
      hitchId: "goal-sync-close",
      idempotencyKey: "goal-sync-close",
    });
    expect(closeReady.data.result.decision).toBe("close_ready");
    expect(closeReady.data.result.hitchStatus.status).toBe("close_ready");

    withDb(root, (db) => {
      const repo = new HitchRepository(db);
      expect(repo.requireSession("goal-sync-diverging").status).toBe("diverging");
      expect(repo.requireSession("goal-sync-budget").status).toBe(
        "budget_exhausted",
      );
      expect(repo.requireSession("goal-sync-close").status).toBe("close_ready");
    });
  });

  it("redacts and caps raw findings in read tools and resources", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(["hitch.start"]));
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP raw findings",
      projectId: "demo",
      domain: "goal",
      idempotencyKey: "goal-start-raw-findings",
    });
    const hitchId = started.data.result.hitchId as string;
    const secret = `sk-${"d".repeat(40)}`;
    withDb(root, (db) => {
      new HitchRepository(db).upsertFinding({
        hitchId,
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: `review leaked ${secret}`,
        detail: `details leaked ${secret}`,
        suggestedFix: "x".repeat(1500),
      });
    });

    const status = await callTool(s, "harness.hitch.status", { hitchId });
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(status.data.findings).toHaveLength(1);
    expect(status.data.findings[0].summary).toBe("[redacted]");
    expect(status.data.findings[0].detail).toBe("[redacted]");
    expect(status.data.findings[0].suggestedFix).toHaveLength(1014);
    expect(status.data.findings[0].suggestedFix).toMatch(/\.\.\.\[truncated\]$/);
    expect(status.data.findingsTruncated).toBe(false);

    const findings = await callTool(s, "harness.hitch.findings", { hitchId });
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(findings.data.findings[0].summary).toBe("[redacted]");

    const resource = await readResource(s, `harness://hitch/${hitchId}`);
    expect(JSON.stringify(resource)).not.toContain(secret);
    expect(resource.data.findings[0].detail).toBe("[redacted]");
  });

  it("does not close close_ready goals without guarded close permission", async () => {
    const root = freshRoot();
    const s = server(
      root,
      mutationConfig(["hitch.start", "hitch.record_close_check"]),
    );
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP close permission",
      projectId: "demo",
      domain: "goal",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-close-denied-start",
    });
    const hitchId = started.data.result.hitchId as string;
    await callTool(s, "harness.hitch.record_close_check", {
      hitchId,
      conditionId: "typecheck",
      status: "passed",
      idempotencyKey: "goal-close-denied-check",
    });

    const denied = await callTool(s, "harness.hitch.close", {
      hitchId,
      summary: "done",
      idempotencyKey: "goal-close-denied",
    });
    expect(denied.status).toBe("permission_denied");
    expect(denied.data.reason).toBe("operation_not_allowlisted");
  });

  it("rechecks convergence inside an unconfirmed close_ready close", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(["hitch.start", "hitch.close"]));
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP stale close",
      projectId: "demo",
      domain: "goal",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-close-stale-start",
    });
    const hitchId = started.data.result.hitchId as string;
    const evaluate = vi
      .spyOn(ConvergenceService.prototype, "evaluate")
      .mockImplementationOnce(() => mockedConvergence(hitchId, "close_ready") as any)
      .mockImplementationOnce(() => mockedConvergence(hitchId, "needs_fix") as any);
    try {
      const denied = await callTool(s, "harness.hitch.close", {
        hitchId,
        summary: "done",
        idempotencyKey: "goal-close-stale",
      });
      expect(denied.status).toBe("error");
      expect(denied.summary).toContain("hitch is no longer close_ready");
      withDb(root, (db) => {
        expect(new HitchRepository(db).requireSession(hitchId).status).toBe("open");
      });
    } finally {
      evaluate.mockRestore();
    }
  });

  it("returns confirmation_required when closing a non-close_ready goal", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(["hitch.start", "hitch.close"]));
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP close confirmation",
      projectId: "demo",
      domain: "goal",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-close-confirm-start",
    });
    const hitchId = started.data.result.hitchId as string;

    const pending = await callTool(s, "harness.hitch.close", {
      hitchId,
      summary: "force after human review",
      idempotencyKey: "goal-close-confirm",
    });
    expect(pending.status).toBe("confirmation_required");
    expect(pending.confirmationId).toMatch(/^mcpconf-/);
    expect(pending.data.preview.data.convergence.decision).not.toBe(
      "close_ready",
    );
  });

  it("does not treat empty close conditions as close_ready by default", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(["hitch.start", "hitch.close"]));
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP empty close conditions",
      projectId: "demo",
      domain: "goal",
      idempotencyKey: "goal-empty-close-start",
    });
    const hitchId = started.data.result.hitchId as string;
    // a coding pass has already run; convergence reflects post-run behavior.
    withDb(root, (db) => {
      new HitchRepository(db).createAttempt({
        hitchId,
        attemptType: "implement",
      });
    });

    const pending = await callTool(s, "harness.hitch.close", {
      hitchId,
      summary: "should require confirmation",
      idempotencyKey: "goal-empty-close",
    });
    expect(pending.status).toBe("confirmation_required");
    expect(pending.data.preview.data.convergence.decision).toBe("continue");
    expect(pending.data.preview.data.convergence.metrics.closeConditionsPending).toBe(1);
  });

  it("requires confirmation when force closing a close_ready goal", async () => {
    const root = freshRoot();
    const s = server(
      root,
      mutationConfig(["hitch.start", "hitch.record_close_check", "hitch.close"]),
    );
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP close force",
      projectId: "demo",
      domain: "goal",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-close-force-start",
    });
    const hitchId = started.data.result.hitchId as string;
    await callTool(s, "harness.hitch.record_close_check", {
      hitchId,
      conditionId: "typecheck",
      status: "passed",
      idempotencyKey: "goal-close-force-check",
    });

    const pending = await callTool(s, "harness.hitch.close", {
      hitchId,
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
    expect(toolNames).toContain("harness.hitch.status");
    expect(toolNames).toContain("harness.hitch.check_convergence");

    const resources = (await s.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/templates/list",
    })) as any;
    expect(JSON.stringify(resources)).toContain("harness://hitch/{hitchId}");

    const prompts = (await s.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "prompts/list",
    })) as any;
    expect(JSON.stringify(prompts)).toContain(
      "harness.prompt.drive_hitch_convergence",
    );
    const prompt = (await s.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "prompts/get",
      params: {
        name: "harness.prompt.drive_hitch_convergence",
        arguments: { hitchId: "goal-test" },
      },
    })) as any;
    const promptText = prompt.result.messages[0].content.text as string;
    expect(promptText).toContain("escalate and stop on P0");
    expect(promptText).not.toContain("P0/P1");
  });

  it("rejects linking review operations to a goal in another domain", async () => {
    const root = freshRoot();
    const s = server(
      root,
      mutationConfig(["hitch.start", "review.process"]),
    );
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP domain link",
      projectId: "demo",
      repoId: "demo-repo",
      domain: "goal",
      idempotencyKey: "goal-domain-link-start",
    });
    const hitchId = started.data.result.hitchId as string;
    withDb(root, (db) => {
      db.prepare(
        `INSERT INTO runs
           (run_id, repo_id, project_id, repo_path, domain, workflow,
            base_branch, run_branch, status, safety_status, started_at,
            source_meta_sha256, updated_at, meta_json, source_mode)
         VALUES
           ('run-other-domain', 'demo-repo', 'demo', '/tmp/demo', 'other',
            'domain-coding', 'main', 'harness/run-other-domain',
            'needs_review', 'allowed', '2026-05-26T00:00:00Z', 'sha',
            '2026-05-26T00:00:00Z', '{}', 'db-first')`,
      ).run();
    });

    const result = await callTool(s, "harness.review.process", {
      runId: "run-other-domain",
      hitchId,
      decision: "approved",
      idempotencyKey: "goal-domain-link-review",
    });

    expect(result.status).toBe("error");
    expect(result.summary).toContain("hitch domain does not match run domain");
  });

  it("rejects linking a project goal to an unprojected run", async () => {
    const root = freshRoot();
    const s = server(
      root,
      mutationConfig(["hitch.start", "review.process"]),
    );
    const started = await callTool(s, "harness.hitch.start", {
      title: "Goal MCP project link",
      projectId: "demo",
      repoId: "demo-repo",
      domain: "goal",
      idempotencyKey: "goal-project-link-start",
    });
    const hitchId = started.data.result.hitchId as string;
    withDb(root, (db) => {
      db.prepare(
        `INSERT INTO runs
           (run_id, repo_id, project_id, repo_path, domain, workflow,
            base_branch, run_branch, status, safety_status, started_at,
            source_meta_sha256, updated_at, meta_json, source_mode)
         VALUES
           ('run-unprojected', 'demo-repo', NULL, '/tmp/demo', 'goal',
            'domain-coding', 'main', 'harness/run-unprojected',
            'needs_review', 'allowed', '2026-05-26T00:00:00Z', 'sha',
            '2026-05-26T00:00:00Z', '{}', 'db-first')`,
      ).run();
    });

    const result = await callTool(s, "harness.review.process", {
      runId: "run-unprojected",
      hitchId,
      decision: "approved",
      idempotencyKey: "goal-project-link-review",
    });

    expect(result.status).toBe("error");
    expect(result.summary).toContain("hitch project does not match run project");
  });
});

function seedProject(
  db: ReturnType<typeof openDb>,
  projectId: string,
  repoId: string,
): void {
  db.prepare(
    `INSERT INTO projects (project_id, repo_id, created_at, updated_at)
     VALUES (?, ?, '2026-06-11T00:00:00Z', '2026-06-11T00:00:00Z')`,
  ).run(projectId, repoId);
}

function hitchProjectId(root: string, hitchId: string): string | null {
  let pid: string | null = null;
  withDb(root, (db) => {
    pid = (
      db
        .prepare("SELECT project_id FROM hitch_sessions WHERE hitch_id = ?")
        .get(hitchId) as { project_id: string | null }
    ).project_id;
  });
  return pid;
}

describe("hitch.start repoId → projectId derivation (#81)", () => {
  it("derives an unambiguous projectId from repoId and persists it", async () => {
    const root = freshRoot();
    withDb(root, (db) => seedProject(db, "demo", "demo-repo"));
    const s = server(root, mutationConfig(["hitch.start"]));
    const started = await callTool(s, "harness.hitch.start", {
      title: "repoId only",
      repoId: "demo-repo", // no projectId — must be derived
      domain: "goal",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-derive-ok",
    });
    expect(started.status).toBe("operation_started");
    const hitchId = started.data.result.hitchId as string;
    expect(hitchProjectId(root, hitchId)).toBe("demo");
  });

  it("does NOT derive an ambiguous repoId (two projects) — denies with the actionable message", async () => {
    const root = freshRoot();
    withDb(root, (db) => {
      seedProject(db, "demo", "shared-repo");
      seedProject(db, "demo2", "shared-repo");
    });
    const s = server(root, {
      ...mutationConfig(["hitch.start"]),
      allowedProjects: ["demo", "demo2"],
    });
    const denied = await callTool(s, "harness.hitch.start", {
      title: "ambiguous repo",
      repoId: "shared-repo",
      domain: "goal",
      idempotencyKey: "goal-derive-ambiguous",
    });
    expect(denied.status).toBe("permission_denied");
    expect(denied.summary).toMatch(/projectId is required/i);
    expect(denied.data.reason).toBe("project_not_allowed");
  });

  it("denies when repoId resolves to a single project that is NOT in allowedProjects (re-validated, fail-closed)", async () => {
    const root = freshRoot();
    withDb(root, (db) => seedProject(db, "demo3", "lonely-repo"));
    // client is scoped to "demo" only; the derived "demo3" must still be denied
    const s = server(root, {
      ...mutationConfig(["hitch.start"]),
      allowedProjects: ["demo"],
    });
    const denied = await callTool(s, "harness.hitch.start", {
      title: "derived-but-not-allowed",
      repoId: "lonely-repo",
      domain: "goal",
      idempotencyKey: "goal-derive-not-allowed",
    });
    expect(denied.status).toBe("permission_denied");
    expect(denied.data.reason).toBe("project_not_allowed");
    // derived projectId is present (not unset) → not-allowed variant
    expect(denied.summary).toContain("project_not_allowed");
    expect(denied.data.projectId).toBe("demo3");
  });

  it("does not require derivation when allowedProjects is empty (repoId-only is allowed)", async () => {
    const root = freshRoot();
    const s = server(root, {
      ...mutationConfig(["hitch.start"]),
      allowedProjects: [],
    });
    const started = await callTool(s, "harness.hitch.start", {
      title: "unscoped client",
      repoId: "demo-repo",
      domain: "goal",
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      idempotencyKey: "goal-derive-unscoped",
    });
    expect(started.status).toBe("operation_started");
  });
});

describe("hitch.start idempotency scope isolation (#114)", () => {
  it("does not replay the same idempotencyKey across different project-restricted clients", async () => {
    const root = freshRoot();
    const idempotencyKey = "shared-hitch-key-across-projects";
    const demoServer = server(root, {
      ...mutationConfig(["hitch.start"]),
      allowedProjects: ["demo"],
    });
    const otherServer = server(root, {
      ...mutationConfig(["hitch.start"]),
      allowedProjects: ["other"],
    });

    const demoResult = await callTool(demoServer, "harness.hitch.start", {
      title: "Demo Project Hitch",
      projectId: "demo",
      domain: "goal",
      idempotencyKey,
    });
    expect(demoResult.status).toBe("operation_started");
    expect(demoResult.data.replayed).toBe(false);
    const demoHitchId = demoResult.data.result.hitchId as string;

    const otherResult = await callTool(otherServer, "harness.hitch.start", {
      title: "Other Project Hitch",
      projectId: "other",
      domain: "goal",
      idempotencyKey,
    });
    expect(otherResult.status).toBe("operation_started");
    expect(otherResult.data.replayed).toBe(false);
    const otherHitchId = otherResult.data.result.hitchId as string;

    expect(otherHitchId).not.toBe(demoHitchId);
    expect(hitchProjectId(root, demoHitchId)).toBe("demo");
    expect(hitchProjectId(root, otherHitchId)).toBe("other");
  });

  it("replays the same idempotencyKey within the same project", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(["hitch.start"]));
    const idempotencyKey = "same-project-hitch-replay";

    const first = await callTool(s, "harness.hitch.start", {
      title: "First Hitch",
      projectId: "demo",
      domain: "goal",
      idempotencyKey,
    });
    expect(first.status).toBe("operation_started");
    expect(first.data.replayed).toBe(false);
    const firstHitchId = first.data.result.hitchId as string;

    const replay = await callTool(s, "harness.hitch.start", {
      title: "Second Hitch Should Replay",
      projectId: "demo",
      domain: "goal",
      idempotencyKey,
    });
    expect(replay.status).toBe("operation_started");
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.result.hitchId).toBe(firstHitchId);

    withDb(root, (db) => {
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM hitch_sessions")
        .get() as { count: number };
      expect(count.count).toBe(1);
    });
  });

  it("replays repoId-only hitches inside the same null project scope", async () => {
    const root = freshRoot();
    const s = server(root, {
      ...mutationConfig(["hitch.start"]),
      allowedProjects: [],
    });
    const idempotencyKey = "null-vs-empty-project-scope";

    const nullProject = await callTool(s, "harness.hitch.start", {
      title: "Null Project Hitch",
      repoId: "repo-without-project",
      domain: "goal",
      idempotencyKey,
    });
    expect(nullProject.status).toBe("operation_started");
    expect(nullProject.data.replayed).toBe(false);
    const nullProjectHitchId = nullProject.data.result.hitchId as string;

    const replay = await callTool(s, "harness.hitch.start", {
      title: "Null Project Hitch Replay",
      repoId: "another-repo-without-project",
      domain: "goal",
      idempotencyKey,
    });
    expect(replay.status).toBe("operation_started");
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.result.hitchId).toBe(nullProjectHitchId);
    expect(hitchProjectId(root, nullProjectHitchId)).toBeNull();
  });

  it("keeps null project scope distinct from an empty-string project scope", () => {
    const idempotencyKey = "null-vs-empty-project-scope";
    expect(scopedIdForIdempotencyKey("hitch", null, idempotencyKey)).not.toBe(
      scopedIdForIdempotencyKey("hitch", "", idempotencyKey),
    );
  });
});
