import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const runId = "run-20260521-apps-web-aaa";
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
      status: "approved",
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
  return root;
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
});
