import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapHitchErrorExit } from "../../src/cli/hitch.js";
import { harnessPaths } from "../../src/config/paths.js";
import { openDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import {
  acquireDomainLock,
  DomainLockBusyError,
  type DomainLockHandle,
} from "../../src/workspace/db-domain-lock.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

function runCli(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, ...env, HARNESS_ROOT: root },
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

function setupProjectFixture(): { root: string; repoPath: string; scopePath: string } {
  const root = mkdtempSync(join(tmpdir(), "harness-hitch-cli-project-"));
  mkdirSync(root, { recursive: true });
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), {
    recursive: true,
  });
  mkdirSync(join(root, "projects"), { recursive: true });

  const repoPath = mkdtempSync(join(tmpdir(), "harness-hitch-cli-repo-"));
  mkdirSync(join(repoPath, "apps/web/src"), { recursive: true });
  writeFileSync(
    join(repoPath, "apps/web/package.json"),
    JSON.stringify({ name: "@demo/web" }),
  );
  writeFileSync(join(repoPath, "apps/web/src/page.ts"), "export const page = 1;\n");
  execFileSync("git", ["init", "-b", "main", repoPath]);
  execFileSync("git", ["-C", repoPath, "add", "-A"]);
  execFileSync("git", [
    "-C",
    repoPath,
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=t",
    "commit",
    "-m",
    "init",
  ]);

  writeFileSync(
    join(root, "projects", "demo.yaml"),
    [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: demo",
      `  path: ${repoPath}`,
      "  base_branch: main",
      "policy:",
      "  template: strict-monorepo-v1",
      "domains:",
      "  - id: apps/web",
      "    root: apps/web",
      "    kind: app",
      "",
    ].join("\n"),
  );

  const scopePath = join(root, "scope-apps-web.yaml");
  writeFileSync(
    scopePath,
    [
      "targetFiles:",
      "  - apps/web/**",
      "allowedFindingCategories:",
      "  - correctness",
      "targetSummary: apps web",
      "",
    ].join("\n"),
  );

  return { root, repoPath, scopePath };
}

function json<T>(result: { out: string; code: number }): T {
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as T;
}

function holdAppsWebDomainLock(root: string): {
  db: ReturnType<typeof openDb>;
  lock: DomainLockHandle;
} {
  const db = openDb(harnessPaths(root).dbPath);
  runMigrations(db);
  const lock = acquireDomainLock(db, {
    domainKey: "demo::apps/web",
    repoId: "demo",
    domain: "apps/web",
    runId: "holder-run",
    pid: process.pid,
    hostname: "test-host",
  });
  return { db, lock };
}

function releaseHeldLock(held: { db: ReturnType<typeof openDb>; lock: DomainLockHandle }): void {
  try {
    held.lock.release({ reason: "test cleanup", releasedBy: "test" });
  } finally {
    held.db.close();
  }
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

  it("adopt-pr records the adopted PR as an audit-only lifecycle event", () => {
    const { root, scopePath, closePath } = setup();
    const hitch = json<{ hitchId: string }>(
      runCli(root, [
        "hitch",
        "start",
        "--title",
        "Adopt PR audit",
        "--domain",
        "hitch",
        "--scope-file",
        scopePath,
        "--close-file",
        closePath,
        "--json",
      ]),
    );

    const adopted = json<{ status: string }>(
      runCli(root, [
        "hitch",
        "adopt-pr",
        hitch.hitchId,
        "https://github.com/acme/app/pull/42",
        "--reason",
        "operator takeover",
        "--json",
      ]),
    );
    expect(adopted.status).toBe("open");
    const status = json<{
      lifecycleEvents: Array<{
        event: string;
        reason: string;
        detail: Record<string, unknown> | null;
      }>;
    }>(runCli(root, ["hitch", "status", hitch.hitchId, "--json"]));
    expect(status.lifecycleEvents).toMatchObject([
      {
        event: "pr_adopted",
        reason: "operator takeover",
        detail: {
          adoptedPr: {
            url: "https://github.com/acme/app/pull/42",
            number: 42,
          },
          supersededPr: null,
          runId: null,
        },
      },
    ]);
  });

  it("update requires a config file and records updated lifecycle events", () => {
    const { root, scopePath, closePath } = setup();
    const hitch = json<{ hitchId: string }>(
      runCli(root, [
        "hitch",
        "start",
        "--title",
        "Update audit",
        "--domain",
        "hitch",
        "--scope-file",
        scopePath,
        "--close-file",
        closePath,
        "--json",
      ]),
    );

    const none = runCli(root, [
      "hitch",
      "update",
      hitch.hitchId,
      "--reason",
      "nothing selected",
    ]);
    expect(none.code).not.toBe(0);
    expect(none.out).toMatch(/at least one/);

    const nextClose = join(root, "close-next.yaml");
    writeFileSync(
      nextClose,
      [
        "- id: typecheck",
        "  kind: command",
        "  required: true",
        "  description: typecheck passed",
        "- id: manual-ok",
        "  kind: manual",
        "  required: true",
        "",
      ].join("\n"),
    );
    const updated = json<{ closeConditions: Array<{ id: string }> }>(
      runCli(root, [
        "hitch",
        "update",
        hitch.hitchId,
        "--close-file",
        nextClose,
        "--reason",
        "add manual signoff",
        "--json",
      ]),
    );
    expect(updated.closeConditions.map((c) => c.id)).toEqual([
      "typecheck",
      "manual-ok",
    ]);
    const status = json<{
      lifecycleEvents: Array<{ event: string; reason: string }>;
    }>(runCli(root, ["hitch", "status", hitch.hitchId, "--json"]));
    expect(status.lifecycleEvents).toMatchObject([
      { event: "updated", reason: "add manual signoff" },
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

  it("classifies an in-scope finding out of scope while deferring it", () => {
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
        "correctness",
        "--summary",
        "Process advisory needs follow-up",
        "--json",
      ]),
    );
    expect(finding.finding.scopeStatus).toBe("in_scope");
    expect(
      runCli(root, [
        "hitch",
        "finding",
        "defer",
        finding.finding.findingId,
        "--reason",
        "still in scope",
      ]).code,
    ).not.toBe(0);

    const deferred = json<{
      backlogItemId: string | null;
      finding: {
        scopeStatus: string;
        lifecycleStatus: string;
        classificationReason: string;
      };
    }>(
      runCli(root, [
        "hitch",
        "finding",
        "defer",
        finding.finding.findingId,
        "--classify-out-of-scope",
        "--reason",
        "operator confirmed process-only advisory",
        "--json",
      ]),
    );
    expect(deferred.backlogItemId).toBeNull();
    expect(deferred.finding.scopeStatus).toBe("out_of_scope");
    expect(deferred.finding.lifecycleStatus).toBe("deferred");
    expect(deferred.finding.classificationReason).toBe(
      "operator confirmed process-only advisory",
    );
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

  it("maps hitch orchestrate domain-lock contention to deferred exit 1", () => {
    const { root, repoPath, scopePath } = setupProjectFixture();
    const hitch = json<{ hitchId: string }>(
      runCli(root, [
        "hitch",
        "start",
        "--title",
        "Lock busy",
        "--project",
        "demo",
        "--domain",
        "apps/web",
        "--scope-file",
        scopePath,
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
        "P1",
        "--category",
        "correctness",
        "--summary",
        "Fix the page",
        "--file",
        "apps/web/src/page.ts",
        "--scope",
        "in-scope",
      ]).code,
    ).toBe(0);
    const before = json<{ session: { status: string } }>(
      runCli(root, ["hitch", "status", hitch.hitchId, "--json"]),
    );

    const held = holdAppsWebDomainLock(root);
    try {
      const result = runCli(
        root,
        ["hitch", "orchestrate", hitch.hitchId, "--repo", repoPath, "--max-steps", "1"],
        { HARNESS_CODEX_BIN: join(root, "missing-codex") },
      );
      expect(result.code).toBe(1);
      expect(result.out).toContain("harness error:");
      expect(result.out).toContain("hitch deferred/lock_busy");
      expect(result.out).toContain("DomainLockBusyError");
    } finally {
      releaseHeldLock(held);
    }

    const after = json<{ session: { status: string } }>(
      runCli(root, ["hitch", "status", hitch.hitchId, "--json"]),
    );
    expect(after.session.status).toBe(before.session.status);
    expect(after.session.status).toBe("open");
  });

  it("maps classify --then-rerun domain-lock contention to deferred exit 1", () => {
    const { root, repoPath, scopePath } = setupProjectFixture();
    const hitch = json<{ hitchId: string }>(
      runCli(root, [
        "hitch",
        "start",
        "--title",
        "Classify lock busy",
        "--project",
        "demo",
        "--domain",
        "apps/web",
        "--scope-file",
        scopePath,
        "--json",
      ]),
    );
    const finding = json<{ finding: { findingId: string } }>(
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
        "Classify me",
        "--file",
        "apps/web/src/page.ts",
        "--scope",
        "unknown",
        "--json",
      ]),
    );

    const held = holdAppsWebDomainLock(root);
    try {
      const result = runCli(
        root,
        [
          "hitch",
          "finding",
          "classify",
          finding.finding.findingId,
          "--scope",
          "in-scope",
          "--reason",
          "belongs to this hitch",
          "--then-rerun",
          "--repo",
          repoPath,
          "--max-steps",
          "1",
        ],
        { HARNESS_CODEX_BIN: join(root, "missing-codex") },
      );
      expect(result.code).toBe(1);
      expect(result.out).toContain("harness error:");
      expect(result.out).toContain("hitch deferred/lock_busy");
      expect(result.out).toContain("DomainLockBusyError");
    } finally {
      releaseHeldLock(held);
    }

    const status = json<{ session: { status: string } }>(
      runCli(root, ["hitch", "status", hitch.hitchId, "--json"]),
    );
    expect(status.session.status).toBe("open");
  });

  it("maps wrapped transient lease causes through the hitch exit mapping", () => {
    const busy = new DomainLockBusyError("demo::apps/web", {
      runId: "holder-run",
      pid: 123,
      hostname: "host",
      expiresAt: "2026-06-14T00:00:00.000Z",
    });
    const mapped = mapHitchErrorExit(new Error("outer", { cause: busy }));
    expect(mapped).toEqual({
      code: 1,
      message:
        "hitch deferred/lock_busy (DomainLockBusyError): " + busy.message,
    });
  });

  it("maps non-hitch domain-lock contention escaping to the top-level handler as exit 1", () => {
    const { root } = setupProjectFixture();
    const held = holdAppsWebDomainLock(root);
    try {
      const result = runCli(
        root,
        [
          "run",
          "--project",
          "demo",
          "--domain",
          "apps/web",
          "--goal",
          "noop",
        ],
        { HARNESS_CODEX_BIN: join(root, "missing-codex") },
      );
      expect(result.code).toBe(1);
      expect(result.out).toContain("harness error:");
      expect(result.out).toContain("retryable domain lease contention");
      expect(result.out).toContain("DomainLockBusyError");
    } finally {
      releaseHeldLock(held);
    }
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

  it("lists findings with open/severity/scope/limit filters and errors on an unknown hitch", () => {
    const { root, scopePath, closePath } = setup();
    const hitch = json<{ hitchId: string }>(
      runCli(root, [
        "hitch", "start", "--title", "list findings", "--domain", "hitch",
        "--scope-file", scopePath, "--close-file", closePath, "--json",
      ]),
    );
    const add = (severity: string, summary: string) =>
      json<{ finding: { findingId: string } }>(
        runCli(root, [
          "hitch", "finding", "add", hitch.hitchId, "--severity", severity,
          "--category", "correctness", "--summary", summary, "--json",
        ]),
      ).finding.findingId;
    const p1 = add("P1", "a P1 bug");
    const p2 = add("P2", "a P2 nit");
    const p3 = add("P2", "an out-of-scope note");
    // p2 → fixed (should drop out of --open); p3 → out_of_scope (for --scope)
    expect(runCli(root, ["hitch", "finding", "fixed", p2]).code).toBe(0);
    expect(
      runCli(root, [
        "hitch", "finding", "classify", p3, "--scope", "out-of-scope",
        "--reason", "not this hitch",
      ]).code,
    ).toBe(0);

    // all findings, with full HitchFinding rows in JSON
    const all = json<{
      findings: {
        findingId: string;
        severity: string;
        lifecycleStatus: string;
        scopeStatus: string;
        category: string;
        summary: string;
        firstSeenAt: string;
      }[];
    }>(runCli(root, ["hitch", "finding", "list", hitch.hitchId, "--json"]));
    expect(all.findings.map((f) => f.findingId).sort()).toEqual([p1, p2, p3].sort());
    const first = all.findings.find((f) => f.findingId === p1)!;
    expect(first).toMatchObject({
      severity: "P1",
      lifecycleStatus: "open",
      scopeStatus: "in_scope",
      category: "correctness",
      summary: "a P1 bug",
    });
    expect(typeof first.firstSeenAt).toBe("string");

    // --open excludes the fixed p2 and the out-of-scope p3 keeps its lifecycle
    const open = json<{ findings: { findingId: string }[] }>(
      runCli(root, ["hitch", "finding", "list", hitch.hitchId, "--open", "--json"]),
    );
    expect(open.findings.map((f) => f.findingId)).not.toContain(p2);

    // --severity filter
    const onlyP1 = json<{ findings: { findingId: string }[] }>(
      runCli(root, ["hitch", "finding", "list", hitch.hitchId, "--severity", "P1", "--json"]),
    );
    expect(onlyP1.findings.map((f) => f.findingId)).toEqual([p1]);

    // --scope filter
    const oos = json<{ findings: { findingId: string }[] }>(
      runCli(root, ["hitch", "finding", "list", hitch.hitchId, "--scope", "out-of-scope", "--json"]),
    );
    expect(oos.findings.map((f) => f.findingId)).toEqual([p3]);

    // --limit caps the rows
    const limited = json<{ findings: unknown[] }>(
      runCli(root, ["hitch", "finding", "list", hitch.hitchId, "--limit", "1", "--json"]),
    );
    expect(limited.findings).toHaveLength(1);

    // text output carries the 6 tab-separated columns
    const text = runCli(root, ["hitch", "finding", "list", hitch.hitchId]);
    expect(text.code).toBe(0);
    const p1Line = text.out.split("\n").find((l) => l.startsWith(p1))!;
    expect(p1Line.split("\t")).toEqual([
      p1, "P1", "open", "in_scope", "correctness", "a P1 bug",
    ]);

    // unknown hitch id fails (requireSession), not a silent empty list
    expect(runCli(root, ["hitch", "finding", "list", "hitch-does-not-exist"]).code).not.toBe(0);

    // a real hitch with no findings lists empty without error
    const empty = json<{ hitchId: string }>(
      runCli(root, [
        "hitch", "start", "--title", "empty", "--domain", "hitch",
        "--scope-file", scopePath, "--close-file", closePath, "--json",
      ]),
    );
    const none = json<{ findings: unknown[] }>(
      runCli(root, ["hitch", "finding", "list", empty.hitchId, "--json"]),
    );
    expect(none.findings).toEqual([]);
  });

  it("surfaces per-hitch token usage in `hitch status --json` (G3 wiring)", () => {
    const { root, scopePath, closePath } = setup();
    const hitch = json<{ hitchId: string }>(
      runCli(root, [
        "hitch", "start", "--title", "tok", "--domain", "apps/web",
        "--scope-file", scopePath, "--close-file", closePath, "--json",
      ]),
    );
    // Seed a run linked to the hitch via an attempt, plus its run_usage rows.
    const db = openDb(harnessPaths(root).dbPath);
    try {
      runMigrations(db);
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, updated_at)
         VALUES ('run-tok', 't', 'apps/web', 'domain-coding', 'main',
           'needs_review', '2026-06-13T00:00:00Z')`,
      ).run();
      db.prepare(
        `INSERT INTO hitch_attempts
           (attempt_id, hitch_id, iteration, attempt_type, status, run_id,
            created_at)
         VALUES ('att-tok', ?, 1, 'implement', 'succeeded', 'run-tok',
           '2026-06-13T00:00:00Z')`,
      ).run(hitch.hitchId);
      for (const [kind, total] of [
        ["coder", 40],
        ["reviewer", 6],
      ] as const) {
        db.prepare(
          `INSERT INTO run_usage
             (run_id, kind, seq, input_tokens, output_tokens, total_tokens,
              usage_source, created_at)
           VALUES ('run-tok', ?, 0, ?, ?, ?, 'exact', '2026-06-13T00:00:00Z')`,
        ).run(kind, total - 1, 1, total);
      }
    } finally {
      db.close();
    }
    const status = json<{
      tokenUsage: {
        totalTokens: number;
        runsWithUsage: number;
        byKind: Record<string, { totalTokens: number }>;
      };
    }>(runCli(root, ["hitch", "status", hitch.hitchId, "--json"]));
    expect(status.tokenUsage.totalTokens).toBe(46);
    expect(status.tokenUsage.runsWithUsage).toBe(1);
    expect(status.tokenUsage.byKind.coder.totalTokens).toBe(40);
    expect(status.tokenUsage.byKind.reviewer.totalTokens).toBe(6);
    // text output also carries the token line
    const text = runCli(root, ["hitch", "status", hitch.hitchId]);
    expect(text.out).toContain("tokens total=46");
  });
});
