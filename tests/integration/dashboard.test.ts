import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDashboardHtml,
  exportDashboard,
} from "../../src/core/dashboard.js";

let seq = 0;

interface Root {
  runsDir: string;
  workspacesDir: string;
  indexDbPath: string;
  knowledgeDir: string;
  outPath: string;
}

function harnessRoot(): Root {
  const root = mkdtempSync(join(tmpdir(), "harness-dash-"));
  const r = {
    runsDir: join(root, "runs"),
    workspacesDir: join(root, "workspaces"),
    indexDbPath: join(root, ".harness", "index.sqlite"),
    knowledgeDir: join(root, "docs", "knowledge"),
    outPath: join(root, "docs", "dashboard", "index.html"),
  };
  mkdirSync(r.runsDir, { recursive: true });
  mkdirSync(r.workspacesDir, { recursive: true });
  return r;
}

function writeRun(
  r: Root,
  o: { status: string; domain?: string; runId?: string },
): string {
  const runId =
    o.runId ?? `run-20260521-apps-user-da${String(seq++).padStart(2, "0")}`;
  mkdirSync(join(r.runsDir, runId), { recursive: true });
  writeFileSync(
    join(r.runsDir, runId, "meta.json"),
    JSON.stringify({
      runId,
      domain: o.domain ?? "apps/user",
      status: o.status,
      safetyStatus: "allowed",
      startedAt: "2026-05-21T00:00:00Z",
    }),
  );
  writeFileSync(
    join(r.runsDir, runId, "knowledge-candidates.yaml"),
    "candidates: []\n",
  );
  return runId;
}

describe("dashboard", () => {
  it("E4-8: generates a self-contained static HTML page", async () => {
    const r = harnessRoot();
    writeRun(r, { status: "needs_review" });
    const html = await buildDashboardHtml(r);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toMatch(/<\/html>/);
    // self-contained: no external assets, no script
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/src=|href="http/);
    expect(html).toMatch(/monorepo-harness dashboard/);
  });

  it("E4-8: links each run to its run dir", async () => {
    const r = harnessRoot();
    const runId = writeRun(r, { status: "needs_review" });
    const html = await buildDashboardHtml(r);
    expect(html).toMatch(
      new RegExp(`<a href="\\.\\./\\.\\./runs/${runId}/">`),
    );
  });

  it("E4-8: includes inbox / recent runs / knowledge / metrics sections", async () => {
    const r = harnessRoot();
    writeRun(r, { status: "failed-policy-violation" });
    const html = await buildDashboardHtml(r);
    expect(html).toMatch(/<h2>Metrics<\/h2>/);
    expect(html).toMatch(/<h2>Inbox<\/h2>/);
    expect(html).toMatch(/<h2>Recent runs<\/h2>/);
    expect(html).toMatch(/<h2>Knowledge<\/h2>/);
    expect(html).toMatch(/Failed \(1\)/);
  });

  it("escapes interpolated run data", async () => {
    const r = harnessRoot();
    // a domain with HTML metacharacters must be escaped, not injected
    writeRun(r, { status: "needs_review", domain: "apps/<script>x" });
    const html = await buildDashboardHtml(r);
    expect(html).not.toMatch(/<script>x/);
    expect(html).toMatch(/apps\/&lt;script&gt;x/);
  });

  it("E4-8: exportDashboard writes the file", async () => {
    const r = harnessRoot();
    writeRun(r, { status: "approved" });
    const res = await exportDashboard(r);
    expect(res.outPath).toBe(r.outPath);
    expect(existsSync(r.outPath)).toBe(true);
    expect(readFileSync(r.outPath, "utf8")).toMatch(/<!doctype html>/);
  });

  it("run links adapt to a custom --out location", async () => {
    const r = harnessRoot();
    const runId = writeRun(r, { status: "needs_review" });
    // export one level shallower than the default docs/dashboard/
    const shallowOut = join(r.runsDir, "..", "reports", "dash.html");
    await exportDashboard({ ...r, outPath: shallowOut });
    const html = readFileSync(shallowOut, "utf8");
    // from <root>/reports/ to <root>/runs/ is "../runs", not "../../runs"
    expect(html).toMatch(new RegExp(`href="\\.\\./runs/${runId}/"`));
    expect(html).not.toMatch(/\.\.\/\.\.\/runs/);
  });

  it("renders cleanly with no runs", async () => {
    const r = harnessRoot();
    const html = await buildDashboardHtml(r);
    expect(html).toMatch(/no runs/);
  });
});
