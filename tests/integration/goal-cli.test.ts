import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harnessPaths } from "../../src/config/paths.js";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

function runCli(root: string, args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: root },
    }).toString();
    return { out, code: 0 };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      code: err.status ?? 1,
    };
  }
}

function setup(): { root: string; scopePath: string; closePath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-goal-cli-"));
  mkdirSync(root, { recursive: true });
  const scopePath = join(root, "scope.yaml");
  const closePath = join(root, "close.yaml");
  writeFileSync(
    scopePath,
    [
      "targetFiles:",
      "  - src/goal/**",
      "allowedFindingCategories:",
      "  - correctness",
      "excludedCategories:",
      "  - future-feature",
      "targetSummary: goal convergence",
      "",
    ].join("\n"),
  );
  writeFileSync(
    closePath,
    [
      "- id: typecheck",
      "  kind: command",
      "  required: true",
      "  description: typecheck passed",
      "",
    ].join("\n"),
  );
  return { root, scopePath, closePath };
}

function json<T>(result: { out: string; code: number }): T {
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as T;
}

describe("goal CLI", () => {
  it("creates a goal, tracks attempts/findings/checks, and closes on convergence", () => {
    const { root, scopePath, closePath } = setup();
    const goal = json<{ goalId: string }>(
      runCli(root, [
        "goal",
        "start",
        "--title",
        "Goal convergence CLI",
        "--domain",
        "goal",
        "--scope-file",
        scopePath,
        "--close-file",
        closePath,
        "--json",
      ]),
    );

    const attempt = json<{ attemptId: string }>(
      runCli(root, [
        "goal",
        "attempt",
        "start",
        goal.goalId,
        "--type",
        "implement",
        "--json",
      ]),
    );
    expect(
      runCli(root, [
        "goal",
        "attempt",
        "complete",
        attempt.attemptId,
        "--status",
        "succeeded",
        "--run-id",
        "run-goal-cli",
      ]).code,
    ).toBe(0);

    const cycle = json<{ cycleId: string }>(
      runCli(root, [
        "goal",
        "review-cycle",
        "start",
        goal.goalId,
        "--mode",
        "initial",
        "--json",
      ]),
    );
    expect(
      runCli(root, [
        "goal",
        "review-cycle",
        "complete",
        cycle.cycleId,
        "--findings-seen",
        "1",
        "--findings-new",
        "1",
      ]).code,
    ).toBe(0);

    const finding = json<{
      finding: { findingId: string; scopeStatus: string; lifecycleStatus: string };
    }>(
      runCli(root, [
        "goal",
        "finding",
        "add",
        goal.goalId,
        "--severity",
        "P1",
        "--category",
        "correctness",
        "--summary",
        "Goal repository drops close-check evidence",
        "--file",
        "src/goal/repository.ts",
        "--json",
      ]),
    );
    expect(finding.finding.scopeStatus).toBe("in_scope");
    expect(
      runCli(root, [
        "goal",
        "finding",
        "fixed",
        finding.finding.findingId,
        "--note",
        "stored evidence",
      ]).code,
    ).toBe(0);
    expect(
      runCli(root, [
        "goal",
        "close-check",
        "record",
        goal.goalId,
        "--condition",
        "typecheck",
        "--status",
        "passed",
        "--message",
        "npm run typecheck passed",
      ]).code,
    ).toBe(0);

    const convergence = json<{ decision: string; decisionRecord: { decision: string } }>(
      runCli(root, ["goal", "check-convergence", goal.goalId, "--json"]),
    );
    expect(convergence.decision).toBe("close_ready");
    expect(convergence.decisionRecord.decision).toBe("close_ready");

    const closed = json<{ status: string }>(
      runCli(root, [
        "goal",
        "close",
        goal.goalId,
        "--summary",
        "all in-scope findings fixed",
        "--json",
      ]),
    );
    expect(closed.status).toBe("closed");
  });

  it("defers an out-of-scope finding to a backlog follow-up", () => {
    const { root, scopePath, closePath } = setup();
    const goal = json<{ goalId: string }>(
      runCli(root, [
        "goal",
        "start",
        "--title",
        "Goal convergence CLI",
        "--domain",
        "goal",
        "--scope-file",
        scopePath,
        "--close-file",
        closePath,
        "--json",
      ]),
    );
    const finding = json<{
      finding: { findingId: string; scopeStatus: string; lifecycleStatus: string };
    }>(
      runCli(root, [
        "goal",
        "finding",
        "add",
        goal.goalId,
        "--severity",
        "P2",
        "--category",
        "future-feature",
        "--summary",
        "Add dashboard goal controls",
        "--file",
        "src/dashboard/view.ts",
        "--json",
      ]),
    );
    expect(finding.finding.scopeStatus).toBe("out_of_scope");

    const deferred = json<{
      backlogItemId: string;
      finding: { lifecycleStatus: string; deferredBacklogItemId: string };
    }>(
      runCli(root, [
        "goal",
        "finding",
        "defer",
        finding.finding.findingId,
        "--backlog",
        "--reason",
        "future dashboard UI",
        "--json",
      ]),
    );
    expect(deferred.finding.lifecycleStatus).toBe("deferred");
    expect(deferred.backlogItemId).toMatch(/^item-\d{8}-001$/);

    const db = openDb(harnessPaths(root).dbPath);
    try {
      runMigrations(db);
      const row = db
        .prepare("SELECT item_id, status FROM backlog_items WHERE item_id = ?")
        .get(deferred.backlogItemId) as { item_id: string; status: string };
      expect(row).toEqual({ item_id: deferred.backlogItemId, status: "open" });
    } finally {
      db.close();
    }
  });

  it("exits nonzero when convergence needs classification", () => {
    const { root, scopePath, closePath } = setup();
    const goal = json<{ goalId: string }>(
      runCli(root, [
        "goal",
        "start",
        "--title",
        "Goal convergence CLI",
        "--domain",
        "goal",
        "--scope-file",
        scopePath,
        "--close-file",
        closePath,
        "--json",
      ]),
    );
    expect(
      runCli(root, [
        "goal",
        "finding",
        "add",
        goal.goalId,
        "--severity",
        "P2",
        "--category",
        "quality",
        "--summary",
        "Review finding lacks scope context",
      ]).code,
    ).toBe(0);
    expect(
      runCli(root, [
        "goal",
        "close-check",
        "record",
        goal.goalId,
        "--condition",
        "typecheck",
        "--status",
        "passed",
      ]).code,
    ).toBe(0);

    const result = runCli(root, ["goal", "check-convergence", goal.goalId, "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      decision: "needs_classification",
      recommendedNextAction: { kind: "classify_findings" },
    });
  });
});
