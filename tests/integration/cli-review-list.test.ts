import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setup(
  runs: Array<{ runId: string; meta: Record<string, unknown> }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "harness-list-cli-"));
  mkdirSync(join(root, "runs"), { recursive: true });
  for (const r of runs) {
    const d = join(root, "runs", r.runId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "meta.json"), JSON.stringify(r.meta, null, 2));
  }
  return root;
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function run(args: string[], harnessRoot: string): RunResult {
  // spawnSync captures stdout AND stderr regardless of exit code.
  const r = spawnSync("node", ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, HARNESS_ROOT: harnessRoot },
    encoding: "utf8",
  });
  return {
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    status: r.status ?? 1,
  };
}

function meta(
  runId: string,
  over: Record<string, unknown> = {},
): { runId: string; meta: Record<string, unknown> } {
  return {
    runId,
    meta: {
      runId,
      domain: "apps/catalog",
      status: "needs_review",
      safetyStatus: "allowed",
      startedAt: "2026-05-21T10:00:00Z",
      ...over,
    },
  };
}

describe("harness review list", () => {
  it("prints 'no runs' when none exist", () => {
    const root = setup([]);
    const { stdout, status } = run(["review", "list"], root);
    expect(status).toBe(0);
    expect(stdout).toMatch(/no runs/);
  });

  it("default queue shows needs_review + changes_requested, hides approved/cleaned", () => {
    const root = setup([
      meta("run-20260521-apps-catalog-nr", { status: "needs_review" }),
      meta("run-20260521-apps-orders-cr", {
        status: "changes_requested",
        domain: "apps/orders",
      }),
      meta("run-20260521-apps-catalog-ap", { status: "approved" }),
      meta("run-20260521-apps-catalog-cl", { status: "cleaned" }),
    ]);
    const { stdout, status } = run(["review", "list"], root);
    expect(status).toBe(0);
    expect(stdout).toMatch(/run-20260521-apps-catalog-nr/);
    expect(stdout).toMatch(/run-20260521-apps-orders-cr/);
    expect(stdout).not.toMatch(/run-20260521-apps-catalog-ap/);
    expect(stdout).not.toMatch(/run-20260521-apps-catalog-cl/);
  });

  it("--all includes every status", () => {
    const root = setup([
      meta("run-20260521-x-nr", { status: "needs_review" }),
      meta("run-20260521-x-cl", { status: "cleaned" }),
    ]);
    const { stdout } = run(["review", "list", "--all"], root);
    expect(stdout).toMatch(/run-20260521-x-nr/);
    expect(stdout).toMatch(/run-20260521-x-cl/);
  });

  it("--status filters to a single status", () => {
    const root = setup([
      meta("run-20260521-x-nr", { status: "needs_review" }),
      meta("run-20260521-x-fpv", { status: "failed-policy-violation" }),
    ]);
    const { stdout } = run(
      ["review", "list", "--status", "failed-policy-violation"],
      root,
    );
    expect(stdout).toMatch(/run-20260521-x-fpv/);
    expect(stdout).not.toMatch(/run-20260521-x-nr/);
  });

  it("--domain filters to a single domain", () => {
    const root = setup([
      meta("run-20260521-cat", { domain: "apps/catalog" }),
      meta("run-20260521-ord", { domain: "apps/orders" }),
    ]);
    const { stdout } = run(
      ["review", "list", "--domain", "apps/orders"],
      root,
    );
    expect(stdout).toMatch(/run-20260521-ord/);
    expect(stdout).not.toMatch(/run-20260521-cat/);
  });

  it("--limit caps the rows", () => {
    const runs = [];
    for (let i = 0; i < 4; i++) {
      runs.push(
        meta(`run-20260521-x-${i}`, {
          startedAt: `2026-05-21T1${i}:00:00Z`,
        }),
      );
    }
    const root = setup(runs);
    const { stdout } = run(["review", "list", "--limit", "2"], root);
    const rows = stdout
      .trim()
      .split("\n")
      .filter((l) => l.includes("run-20260521"));
    expect(rows).toHaveLength(2);
  });

  it("--json emits parseable validRuns / invalidRuns", () => {
    const root = setup([
      meta("run-20260521-ok", { status: "needs_review" }),
    ]);
    mkdirSync(join(root, "runs", "run-20260521-bad"), { recursive: true });
    writeFileSync(
      join(root, "runs", "run-20260521-bad", "meta.json"),
      "{ broken",
    );
    const { stdout, status } = run(["review", "list", "--json"], root);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.validRuns.map((r: { runId: string }) => r.runId)).toEqual([
      "run-20260521-ok",
    ]);
    expect(parsed.invalidRuns.map((r: { runId: string }) => r.runId)).toEqual([
      "run-20260521-bad",
    ]);
  });

  it("does not crash on a broken run dir; warns on stderr", () => {
    const root = setup([meta("run-20260521-ok")]);
    mkdirSync(join(root, "runs", "run-20260521-broken"), { recursive: true });
    writeFileSync(
      join(root, "runs", "run-20260521-broken", "meta.json"),
      "{ not json at all",
    );
    const { stdout, stderr, status } = run(["review", "list"], root);
    expect(status).toBe(0);
    expect(stdout).toMatch(/run-20260521-ok/);
    expect(stdout).not.toMatch(/run-20260521-broken/);
    expect(stderr).toMatch(/unreadable run dir/);
  });

  it("rejects a non-integer --limit with exit 1", () => {
    const root = setup([meta("run-20260521-ok")]);
    const { status, stderr } = run(
      ["review", "list", "--limit", "abc"],
      root,
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/--limit must be/);
  });

  it("rejects an unknown --status value with exit 1 (not a silent empty list)", () => {
    const root = setup([meta("run-20260521-ok")]);
    const { status, stderr } = run(
      ["review", "list", "--status", "needs_reveiw"],
      root,
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/unknown --status/);
  });

  it("prints the spec columns", () => {
    const root = setup([
      meta("run-20260521-apps-catalog-aaa", {
        reviewer: "knkn",
        parentRunId: "run-20260521-parent",
        commandResults: [
          {
            command: "npm test",
            exitCode: 0,
            durationMs: 1,
            timedOut: false,
          },
        ],
      }),
    ]);
    const { stdout } = run(["review", "list"], root);
    expect(stdout).toMatch(
      /runId.*domain.*status.*safety.*reviewer.*parent.*commands.*secrets.*ignored.*startedAt/,
    );
    expect(stdout).toMatch(/knkn/);
    expect(stdout).toMatch(/1\/1/);
  });
});
