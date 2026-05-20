import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(process.cwd(), "src/cli/run.ts");

function setup(runs: Array<{ runId: string; meta: Record<string, unknown> }>): string {
  const root = mkdtempSync(join(tmpdir(), "harness-list-cli-"));
  mkdirSync(join(root, "runs"), { recursive: true });
  for (const r of runs) {
    const d = join(root, "runs", r.runId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "meta.json"), JSON.stringify(r.meta, null, 2));
  }
  return root;
}

function run(
  args: string[],
  harnessRoot: string,
): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: harnessRoot },
    }).toString();
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`,
      status: err.status ?? 1,
    };
  }
}

describe("harness review list", () => {
  it("prints 'no runs' when none exist", () => {
    const root = setup([]);
    const { stdout, status } = run(["review", "list"], root);
    expect(status).toBe(0);
    expect(stdout).toMatch(/no runs/);
  });

  it("by default shows only needs_review", () => {
    const root = setup([
      {
        runId: "run-20260520-apps-catalog-aaa",
        meta: {
          runId: "run-20260520-apps-catalog-aaa",
          domain: "apps/catalog",
          status: "needs_review",
          safetyStatus: "allowed",
          changedFilesCount: 2,
          secretSuspectCount: 0,
          ignoredUntrackedCount: 0,
          startedAt: "2026-05-20T10:00:00Z",
        },
      },
      {
        runId: "run-20260520-apps-orders-bbb",
        meta: {
          runId: "run-20260520-apps-orders-bbb",
          domain: "apps/orders",
          status: "approved",
          safetyStatus: "allowed",
          changedFilesCount: 3,
          secretSuspectCount: 0,
          ignoredUntrackedCount: 0,
          startedAt: "2026-05-20T11:00:00Z",
        },
      },
    ]);
    const { stdout, status } = run(["review", "list"], root);
    expect(status).toBe(0);
    expect(stdout).toMatch(/run-20260520-apps-catalog-aaa/);
    expect(stdout).not.toMatch(/run-20260520-apps-orders-bbb/);
  });

  it("--all includes every status", () => {
    const root = setup([
      {
        runId: "run-20260520-x-a",
        meta: {
          runId: "run-20260520-x-a",
          domain: "x",
          status: "needs_review",
          startedAt: "2026-05-20T10:00:00Z",
        },
      },
      {
        runId: "run-20260520-x-b",
        meta: {
          runId: "run-20260520-x-b",
          domain: "x",
          status: "cleaned",
          startedAt: "2026-05-20T11:00:00Z",
        },
      },
    ]);
    const { stdout, status } = run(["review", "list", "--all"], root);
    expect(status).toBe(0);
    expect(stdout).toMatch(/run-20260520-x-a/);
    expect(stdout).toMatch(/run-20260520-x-b/);
  });

  it("prints columns: runId / domain / status / safety / changed / secrets / ignored / startedAt", () => {
    const root = setup([
      {
        runId: "run-20260520-apps-catalog-aaa",
        meta: {
          runId: "run-20260520-apps-catalog-aaa",
          domain: "apps/catalog",
          status: "needs_review",
          safetyStatus: "allowed",
          changedFilesCount: 2,
          secretSuspectCount: 1,
          ignoredUntrackedCount: 3,
          startedAt: "2026-05-20T10:00:00Z",
        },
      },
    ]);
    const { stdout } = run(["review", "list"], root);
    expect(stdout).toMatch(/runId.*domain.*status.*safety.*changed.*secrets.*ignored.*startedAt/);
    expect(stdout).toMatch(/apps\/catalog/);
  });
});
