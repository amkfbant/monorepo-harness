import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { exportDashboard } from "../../src/dashboard/export.js";
import { DashboardSnapshotError } from "../../src/dashboard/snapshot.js";
import { makeTmpDir } from "../helpers/tmp.js";

const CLI = join(process.cwd(), "src/cli/run.ts");

const PROFILE = [
  "version: 1",
  "project_id: demo",
  "repo:",
  "  id: demo",
  "domains:",
  "  - id: apps/web",
  "    root: apps/web",
  "    kind: app",
  "",
].join("\n");

function writeRun(root: string, runId: string, status: string): void {
  const dir = join(root, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      runId,
      repoId: "demo",
      repoPath: "/tmp/demo",
      domain: "apps/web",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: `harness/${runId}`,
      status,
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
  writeFileSync(join(dir, "events.jsonl"), `{"type":"run_started"}\n`);
}

function harnessRoot(): string {
  const root = makeTmpDir("harness-dash-");
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "projects", "demo.yaml"), PROFILE);
  writeRun(root, "run-20260521-apps-web-aaa", "approved");
  writeRun(root, "run-20260521-apps-web-bbb", "needs_review");
  return root;
}

function runCli(
  root: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): { out: string; code: number } {
  try {
    const out = execFileSync("node", ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, HARNESS_ROOT: root, ...extraEnv },
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

describe("exportDashboard", () => {
  it("writes a self-contained HTML dashboard from the DB read model", () => {
    const root = harnessRoot();
    const outPath = join(root, "docs", "dashboard", "index.html");
    const r = exportDashboard({ harnessRoot: root, outPath });
    expect(r.outPath).toBe(outPath);
    expect(r.bytes).toBeGreaterThan(0);
    const html = readFileSync(outPath, "utf8");
    expect(html).toMatch(/<!doctype html>/);
    expect(html).toMatch(/monorepo-harness dashboard/);
    expect(html).toMatch(/<h2>Overview<\/h2>/);
    expect(html).toMatch(/<h2>Projects<\/h2>/);
    expect(html).toMatch(/<h2>Inbox<\/h2>/);
    expect(html).toMatch(/run-20260521-apps-web-aaa/);
    expect(r.snapshot.importedRuns).toBe(2);
  });

  it("applies a project filter", () => {
    const root = harnessRoot();
    const r = exportDashboard({
      harnessRoot: root,
      outPath: join(root, "dash.html"),
      filters: { projectId: "nonesuch" },
    });
    expect(r.snapshot.overview.totalRuns).toBe(0);
    expect(r.snapshot.recentRuns).toHaveLength(0);
  });

  it("produces a page with no script tags (HTML escaping holds)", () => {
    const root = harnessRoot();
    const r = exportDashboard({
      harnessRoot: root,
      outPath: join(root, "dash.html"),
    });
    const html = readFileSync(join(root, "dash.html"), "utf8");
    expect(html).not.toMatch(/<script>/);
    expect(r.snapshot.consistencyStatus).toBe("ok");
  });

  it("errors when the DB is absent and auto-import is disabled", () => {
    const root = harnessRoot();
    expect(() =>
      exportDashboard({
        harnessRoot: root,
        outPath: join(root, "dash.html"),
        autoImport: false,
      }),
    ).toThrow(DashboardSnapshotError);
  });

  it("CLI: harness dashboard export writes the page", () => {
    const root = harnessRoot();
    let out = "";
    try {
      out = execFileSync(
        "node",
        ["--import", "tsx", CLI, "dashboard", "export"],
        { env: { ...process.env, HARNESS_ROOT: root } },
      ).toString();
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      out = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
    }
    expect(out).toMatch(/dashboard exported/);
    expect(out).toMatch(/consistency: ok/);
    expect(
      existsSync(join(root, "docs", "dashboard", "index.html")),
    ).toBe(true);
  });

  it("CLI: dashboard serve --enable-mutation fails before listen and points to operations serve", () => {
    const root = harnessRoot();
    const r = runCli(root, ["dashboard", "serve", "--enable-mutation"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/dashboard serve --enable-mutation has moved/);
    expect(r.out).toMatch(/harness operations serve/);
    expect(r.out).not.toMatch(/listening on/);
  });

  it("CLI: dashboard serve help marks --enable-mutation as deprecated", () => {
    const root = harnessRoot();
    const r = runCli(root, ["dashboard", "serve", "--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /--enable-mutation\s+deprecated: exits; use `harness operations\s+serve`/,
    );
    expect(r.out).not.toMatch(/enable POST mutation routes/);
  });

  it("CLI: operations serve fails before listen when bearer or CSRF env is missing", () => {
    const root = harnessRoot();
    const noToken = runCli(root, ["operations", "serve"]);
    expect(noToken.code).not.toBe(0);
    expect(noToken.out).toMatch(/requires --token-env/);
    expect(noToken.out).not.toMatch(/listening on/);

    const noCsrf = runCli(
      root,
      ["operations", "serve", "--token-env", "HARNESS_OP_TOKEN", "--csrf-token-env", "HARNESS_OP_CSRF"],
      { HARNESS_OP_TOKEN: "secret" },
    );
    expect(noCsrf.code).not.toBe(0);
    expect(noCsrf.out).toMatch(/HARNESS_OP_CSRF is empty/);
    expect(noCsrf.out).not.toMatch(/listening on/);
  });
});
