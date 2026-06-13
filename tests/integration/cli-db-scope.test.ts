import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessPaths } from "../../src/config/paths.js";
import { openManagedDb } from "../../src/db/managed-connection.js";

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

function writeProjectRun(
  root: string,
  input: { runId: string; status: string },
): void {
  const runId = input.runId;
  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      runId,
      repoId: "demo",
      repoPath: "/tmp/demo",
      domain: "apps/web",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: `harness/${runId}`,
      status: input.status,
      startedAt: "2026-05-21T00:00:00Z",
      project: {
        projectId: "demo",
        profilePath: join(root, "projects", "demo.yaml"),
        profileVersion: 1,
        commandPresetIds: [],
        contextPackIds: [],
      },
    }),
  );
  writeFileSync(join(runDir, "events.jsonl"), `{"type":"run_started"}\n`);
}

/** A harness root with project "demo" and one approved run attributed to it. */
function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-scope-"));
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(
    join(root, "projects", "demo.yaml"),
    [
      "version: 1",
      "project_id: demo",
      "repo:",
      "  id: demo",
      "domains:",
      "  - id: apps/web",
      "    root: apps/web",
      "    kind: app",
      "",
    ].join("\n"),
  );
  writeProjectRun(root, {
    runId: "run-20260521-apps-web-aaa",
    status: "approved",
  });
  return root;
}

function moveLatestMetricsSnapshotTo(root: string, createdAt: string): void {
  const handle = openManagedDb({ dbPath: harnessPaths(root).dbPath });
  try {
    handle.db
      .prepare(
        `UPDATE metrics_snapshots
            SET created_at = ?
          WHERE snapshot_id = (
            SELECT snapshot_id FROM metrics_snapshots
             ORDER BY created_at DESC, snapshot_id DESC
             LIMIT 1
          )`,
      )
      .run(createdAt);
  } finally {
    handle.close();
  }
}

function writeBacklogYaml(
  root: string,
  input: {
    id: string;
    status: "open" | "doing" | "done" | "deferred";
    title: string;
    projectId?: string;
  },
): void {
  mkdirSync(join(root, "backlog", input.status), { recursive: true });
  writeFileSync(
    join(root, "backlog", input.status, `${input.id}.yaml`),
    [
      `id: ${input.id}`,
      `title: ${input.title}`,
      "domain: apps/web",
      "goal: g",
      `status: ${input.status}`,
      "priority: medium",
      "tags:",
      "  - legacy",
      ...(input.projectId !== undefined ? [`projectId: ${input.projectId}`] : []),
      "createdAt: 2026-05-21T00:00:00Z",
      "linkedRuns:",
      "  - run-20260521-apps-web-aaa",
      "",
    ].join("\n"),
  );
}

function metricsSnapshotCount(root: string): number {
  const handle = openManagedDb({ dbPath: harnessPaths(root).dbPath });
  try {
    return (
      handle.db
        .prepare("SELECT count(*) AS n FROM metrics_snapshots")
        .get() as { n: number }
    ).n;
  } finally {
    handle.close();
  }
}

describe("CLI project-scoped DB queries (Phase 6-6)", () => {
  it("metrics summary --project answers from the DB read model", () => {
    const root = setup();
    const { out, code } = runCli(root, [
      "metrics",
      "summary",
      "--project",
      "demo",
      "--json",
    ]);
    expect(code).toBe(0);
    const m = JSON.parse(out) as { totalRuns: number; approved: number };
    expect(m.totalRuns).toBe(1);
    expect(m.approved).toBe(1);
    expect(m).toHaveProperty("oneShotApprovalRate");
    expect(m).toHaveProperty("policyViolationRate");
    expect(m).toHaveProperty("secretSuspectRate");
    expect(m).toHaveProperty("lockContentionCount");
    expect(m).toHaveProperty("hitch");
    expect(m).toHaveProperty("mcpConfirmations");

    const text = runCli(root, ["metrics", "summary", "--project", "demo"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("hitch metrics:");
    expect(text.out).toContain("mcp confirmations:");
    // usage section surfaces the per-kind token breakdown (token-usage G2/G3)
    expect(text.out).toMatch(
      /by kind: coder=\d+ reviewer=\d+ evaluator=\d+/,
    );
  });

  it("metrics summary --project for an empty project reports zero", () => {
    const root = setup();
    const { out, code } = runCli(root, [
      "metrics",
      "summary",
      "--project",
      "nonesuch",
      "--json",
    ]);
    expect(code).toBe(0);
    const m = JSON.parse(out) as { totalRuns: number };
    expect(m.totalRuns).toBe(0);
  });

  it("inbox --repo-id answers from the DB read model", () => {
    const root = setup();
    const { out, code } = runCli(root, [
      "inbox",
      "--repo-id",
      "demo",
      "--json",
    ]);
    expect(code).toBe(0);
    const inbox = JSON.parse(out) as { needsReview: unknown[] };
    expect(Array.isArray(inbox.needsReview)).toBe(true);
  });

  it("metrics summary with no scope keeps the file-based path", () => {
    const root = setup();
    const { code } = runCli(root, ["metrics", "summary"]);
    expect(code).toBe(0);
  });

  it("metrics snapshot records a DB aggregate snapshot and prunes retention", () => {
    const root = setup();
    const json = runCli(root, [
      "metrics",
      "snapshot",
      "--project",
      "demo",
      "--retention-days",
      "90",
      "--json",
    ]);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as {
      snapshot: { snapshotId: string; projectId: string | null };
      pruned: number;
    };
    expect(parsed.snapshot.snapshotId).toMatch(/^msnap-[0-9a-f-]{36}$/);
    expect(parsed.snapshot.projectId).toBe("demo");
    expect(parsed.pruned).toBe(0);

    const text = runCli(root, [
      "metrics",
      "snapshot",
      "--project",
      "demo",
      "--retention-days",
      "90",
    ]);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^snapshot=msnap-[0-9a-f-]{36} pruned=\d+\n$/);
  });

  it("metrics snapshot keeps the just-recorded row with zero-day retention", () => {
    const root = setup();
    const json = runCli(root, [
      "metrics",
      "snapshot",
      "--project",
      "demo",
      "--retention-days",
      "0",
      "--json",
    ]);

    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as {
      snapshot: { snapshotId: string };
      pruned: number;
    };
    expect(parsed.snapshot.snapshotId).toMatch(/^msnap-[0-9a-f-]{36}$/);
    expect(parsed.pruned).toBe(0);
    expect(metricsSnapshotCount(root)).toBe(1);
  });

  it("metrics delta reports current live metrics against an older snapshot", () => {
    const root = setup();
    const snapshot = runCli(root, [
      "metrics",
      "snapshot",
      "--project",
      "demo",
      "--json",
    ]);
    expect(snapshot.code).toBe(0);
    moveLatestMetricsSnapshotTo(root, "2000-01-01T00:00:00.000Z");
    writeProjectRun(root, {
      runId: "run-20260521-apps-web-bbb",
      status: "needs_review",
    });

    const json = runCli(root, [
      "metrics",
      "delta",
      "--project",
      "demo",
      "--since",
      "1d",
      "--json",
    ]);

    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as {
      status: string;
      metrics: { totalRuns: { baseline: number; current: number; delta: number } };
    };
    expect(parsed.status).toBe("ok");
    expect(parsed.metrics.totalRuns).toEqual({
      baseline: 1,
      current: 2,
      delta: 1,
    });

    const text = runCli(root, [
      "metrics",
      "delta",
      "--project",
      "demo",
      "--since",
      "1d",
    ]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("total runs: 1 -> 2 (+1)");
  });

  it("metrics delta exits normally with a clear message when no baseline exists", () => {
    const root = setup();
    const result = runCli(root, [
      "metrics",
      "delta",
      "--project",
      "demo",
      "--since",
      "1d",
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("no metrics snapshot found");
  });

  it("backlog list --project --status threads the status filter (Phase 6 hardening)", () => {
    const root = setup();
    mkdirSync(join(root, "backlog", "open"), { recursive: true });
    writeFileSync(
      join(root, "backlog", "open", "item-20260521-001.yaml"),
      [
        "id: item-20260521-001",
        "title: t",
        "domain: apps/web",
        "goal: g",
        "status: open",
        "priority: medium",
        "tags: []",
        "projectId: demo",
        "createdAt: 2026-05-21T00:00:00Z",
        "linkedRuns: []",
        "",
      ].join("\n"),
    );
    const open = runCli(root, [
      "backlog",
      "list",
      "--project",
      "demo",
      "--status",
      "open",
      "--json",
    ]);
    expect(open.code).toBe(0);
    expect((JSON.parse(open.out) as { items: unknown[] }).items).toHaveLength(1);
    // a non-matching status must filter it out, not be ignored
    const done = runCli(root, [
      "backlog",
      "list",
      "--project",
      "demo",
      "--status",
      "done",
      "--json",
    ]);
    expect(done.code).toBe(0);
    expect((JSON.parse(done.out) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("backlog list/show read DB-only db-first items before exported YAML exists", () => {
    const root = setup();
    const added = runCli(root, [
      "backlog",
      "add",
      "--title",
      "db only",
      "--domain",
      "apps/web",
      "--goal",
      "fix the canonical read path",
      "--tags",
      "db,read",
    ]);
    expect(added.code).toBe(0);
    const itemId = added.out.match(/added (item-\d{8}-\d{3})/)?.[1];
    expect(itemId).toBeDefined();
    unlinkSync(join(root, "backlog", "open", `${itemId}.yaml`));

    const listed = runCli(root, ["backlog", "list", "--json"]);
    expect(listed.code).toBe(0);
    const payload = JSON.parse(listed.out) as {
      items: {
        itemId: string;
        title: string;
        goal: string;
        status: string;
        tags: string[];
        linkedRuns: string[];
        createdAt: string;
      }[];
    };
    expect(payload.items).toEqual([
      expect.objectContaining({
        itemId,
        title: "db only",
        goal: "fix the canonical read path",
        status: "open",
        tags: ["db", "read"],
        linkedRuns: [],
      }),
    ]);
    expect(payload.items[0].createdAt).toMatch(/^20/);

    const shown = runCli(root, ["backlog", "show", "--item-id", itemId!]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("Title: db only");
    expect(shown.out).toContain("Goal:\n  fix the canonical read path");
  });

  it("backlog done status is visible from DB even when export fails", () => {
    const root = setup();
    const added = runCli(root, [
      "backlog",
      "add",
      "--title",
      "finish me",
      "--domain",
      "apps/web",
      "--goal",
      "complete the item",
    ]);
    expect(added.code).toBe(0);
    const itemId = added.out.match(/added (item-\d{8}-\d{3})/)?.[1];
    expect(itemId).toBeDefined();
    rmSync(join(root, "backlog", "done"), { recursive: true, force: true });
    writeFileSync(join(root, "backlog", "done"), "not a directory\n");

    const done = runCli(root, ["backlog", "done", "--item-id", itemId!]);
    expect(done.code).toBe(0);
    expect(done.out).toContain(`${itemId} → done`);

    const listed = runCli(root, ["backlog", "list", "--status", "done", "--json"]);
    expect(listed.code).toBe(0);
    expect(
      (JSON.parse(listed.out) as { items: { itemId: string; status: string }[] })
        .items,
    ).toEqual([expect.objectContaining({ itemId, status: "done" })]);
    const shown = runCli(root, ["backlog", "show", "--item-id", itemId!]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("Status: done");
  });

  it("backlog list imports legacy file rows and still includes db-first rows", () => {
    const root = setup();
    writeBacklogYaml(root, {
      id: "item-20260521-001",
      status: "open",
      title: "legacy file",
      projectId: "demo",
    });
    const added = runCli(root, [
      "backlog",
      "add",
      "--title",
      "db item",
      "--domain",
      "apps/web",
      "--goal",
      "g",
    ]);
    expect(added.code).toBe(0);
    const dbItemId = added.out.match(/added (item-\d{8}-\d{3})/)?.[1];
    expect(dbItemId).toBeDefined();
    unlinkSync(join(root, "backlog", "open", `${dbItemId}.yaml`));

    const listed = runCli(root, ["backlog", "list", "--status", "open", "--json"]);
    expect(listed.code).toBe(0);
    const { items } = JSON.parse(listed.out) as {
      items: { itemId: string; title: string }[];
    };
    expect(items).toEqual([
      expect.objectContaining({ itemId: dbItemId, title: "db item" }),
      expect.objectContaining({
        itemId: "item-20260521-001",
        title: "legacy file",
      }),
    ]);
  });

  it("backlog list falls back to files when the harness DB is absent", () => {
    const root = setup();
    rmSync(join(root, ".harness"), { recursive: true, force: true });
    writeBacklogYaml(root, {
      id: "item-20260521-001",
      status: "open",
      title: "file fallback",
    });

    const listed = runCli(root, ["backlog", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect((JSON.parse(listed.out) as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        itemId: "item-20260521-001",
        title: "file fallback",
      }),
    ]);
    const shown = runCli(root, [
      "backlog",
      "show",
      "--item-id",
      "item-20260521-001",
    ]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("Title: file fallback");
  });

  it("metrics summary --project --since is accepted (date filter threaded)", () => {
    const root = setup();
    const { out, code } = runCli(root, [
      "metrics",
      "summary",
      "--project",
      "demo",
      "--since",
      "3650d",
      "--json",
    ]);
    expect(code).toBe(0);
    // a 10-year window includes the fixture run
    expect((JSON.parse(out) as { totalRuns: number }).totalRuns).toBe(1);
  });
});
