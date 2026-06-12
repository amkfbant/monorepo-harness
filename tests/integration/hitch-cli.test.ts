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
  const root = mkdtempSync(join(tmpdir(), "harness-hitch-cli-"));
  mkdirSync(root, { recursive: true });
  const scopePath = join(root, "scope.yaml");
  const closePath = join(root, "close.yaml");
  writeFileSync(
    scopePath,
    [
      "targetFiles:",
      "  - src/hitch/**",
      "allowedFindingCategories:",
      "  - correctness",
      "excludedCategories:",
      "  - future-feature",
      "targetSummary: hitch convergence",
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

describe("hitch CLI", () => {
  it("creates a hitch, tracks attempts/findings/checks, and closes on convergence", () => {
    const { root, scopePath, closePath } = setup();
    const hitch = json<{ hitchId: string }>(
      runCli(root, [
        "hitch",
        "start",
        "--title",
        "Hitch convergence CLI",
        "--domain",
        "hitch",
        "--scope-file",
        scopePath,
        "--close-file",
        closePath,
        "--json",
      ]),
    );

    const attempt = json<{ attemptId: string }>(
      runCli(root, [
        "hitch",
        "attempt",
        "start",
        hitch.hitchId,
        "--type",
        "implement",
        "--json",
      ]),
    );
    expect(
      runCli(root, [
        "hitch",
        "attempt",
        "complete",
        attempt.attemptId,
        "--status",
        "succeeded",
        "--run-id",
        "run-hitch-cli",
      ]).code,
    ).toBe(0);

    const cycle = json<{ cycleId: string }>(
      runCli(root, [
        "hitch",
        "review-cycle",
        "start",
        hitch.hitchId,
        "--mode",
        "initial",
        "--json",
      ]),
    );
    expect(
      runCli(root, [
        "hitch",
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
        "hitch",
        "finding",
        "add",
        hitch.hitchId,
        "--severity",
        "P1",
        "--category",
        "correctness",
        "--summary",
        "Hitch repository drops close-check evidence",
        "--file",
        "src/hitch/repository.ts",
        "--json",
      ]),
    );
    expect(finding.finding.scopeStatus).toBe("in_scope");
    expect(
      runCli(root, [
        "hitch",
        "finding",
        "fixed",
        finding.finding.findingId,
        "--note",
        "stored evidence",
      ]).code,
    ).toBe(0);
    expect(
      runCli(root, [
        "hitch",
        "close-check",
        "record",
        hitch.hitchId,
        "--condition",
        "typecheck",
        "--status",
        "passed",
        "--message",
        "npm run typecheck passed",
      ]).code,
    ).toBe(0);

    const convergence = json<{ decision: string; decisionRecord: { decision: string } }>(
      runCli(root, ["hitch", "check-convergence", hitch.hitchId, "--json"]),
    );
    expect(convergence.decision).toBe("close_ready");
    expect(convergence.decisionRecord.decision).toBe("close_ready");

    const closed = json<{ status: string }>(
      runCli(root, [
        "hitch",
        "close",
        hitch.hitchId,
        "--summary",
        "all in-scope findings fixed",
        "--json",
      ]),
    );
    expect(closed.status).toBe("closed");
  });

  it("records reopen lifecycle events and exposes them in status JSON", () => {
    const { root, scopePath, closePath } = setup();
    const hitch = json<{ hitchId: string }>(
      runCli(root, [
        "hitch",
        "start",
        "--title",
        "Reopen audit",
        "--domain",
        "hitch",
        "--scope-file",
        scopePath,
        "--close-file",
        closePath,
        "--json",
      ]),
    );

    expect(
      runCli(root, [
        "hitch",
        "close",
        hitch.hitchId,
        "--summary",
        "done once",
        "--force",
      ]).code,
    ).toBe(0);
    expect(
      runCli(root, [
        "hitch",
        "reopen",
        hitch.hitchId,
        "--reason",
        "late finding",
      ]).code,
    ).toBe(0);
    expect(
      runCli(root, [
        "hitch",
        "close",
        hitch.hitchId,
        "--summary",
        "done twice",
        "--force",
        "--created-by",
        "closer",
      ]).code,
    ).toBe(0);
    expect(
      runCli(root, [
        "hitch",
        "reopen",
        hitch.hitchId,
        "--reason",
        "second late finding",
        "--created-by",
        "operator",
      ]).code,
    ).toBe(0);

    const status = json<{
      lifecycleEvents: {
        event: string;
        reason: string;
        createdBy: string;
      }[];
    }>(runCli(root, ["hitch", "status", hitch.hitchId, "--json"]));
    expect(status.lifecycleEvents).toMatchObject([
      { event: "closed", reason: "done once", createdBy: "cli" },
      { event: "reopened", reason: "late finding", createdBy: "cli" },
      { event: "closed", reason: "done twice", createdBy: "closer" },
      {
        event: "reopened",
        reason: "second late finding",
        createdBy: "operator",
      },
    ]);
  });

  it("defers an out-of-scope finding to a backlog follow-up", () => {
    const { root, scopePath, closePath } = setup();
    const hitch = json<{ hitchId: string }>(
      runCli(root, [
        "hitch",
        "start",
        "--title",
        "Hitch convergence CLI",
        "--domain",
        "hitch",
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
        "hitch",
        "finding",
        "add",
        hitch.hitchId,
        "--severity",
        "P2",
        "--category",
        "future-feature",
        "--summary",
        "Add dashboard hitch controls",
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
        "hitch",
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

  it("orchestrate --dry-run prints the next action without running codex", () => {
    const { root } = setup();
    expect(
      runCli(root, [
        "hitch",
        "start",
        "--title",
        "Dry",
        "--hitch-id",
        "g-dry",
        "--domain",
        "src",
        "--created-by",
        "cli",
      ]).code,
    ).toBe(0);
    const r = runCli(root, ["hitch", "orchestrate", "g-dry", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/decision=/);
    expect(r.out).toMatch(/next-action=/);
  });

  it("exits nonzero when convergence needs classification", () => {
    const { root, scopePath, closePath } = setup();
    const hitch = json<{ hitchId: string }>(
      runCli(root, [
        "hitch",
        "start",
        "--title",
        "Hitch convergence CLI",
        "--domain",
        "hitch",
        "--scope-file",
        scopePath,
        "--close-file",
        closePath,
        "--json",
      ]),
    );
    expect(
      runCli(root, [
        "hitch",
        "finding",
        "add",
        hitch.hitchId,
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
        "hitch",
        "close-check",
        "record",
        hitch.hitchId,
        "--condition",
        "typecheck",
        "--status",
        "passed",
      ]).code,
    ).toBe(0);

    const result = runCli(root, ["hitch", "check-convergence", hitch.hitchId, "--json"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      decision: "needs_classification",
      recommendedNextAction: { kind: "classify_findings" },
    });
  });
});
