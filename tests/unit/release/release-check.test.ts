import { describe, it, expect } from "vitest";
import {
  buildReleaseCheck,
  renderReleaseCheckText,
  type ReleaseCheckInput,
} from "../../../src/release/release-check.js";
import {
  buildReleasePlan,
  type ReleasePlanInput,
} from "../../../src/release/release-plan.js";

function planWith(over: Partial<ReleasePlanInput> = {}) {
  return buildReleasePlan({
    since: "v0.5.0",
    to: "HEAD",
    currentVersion: "0.5.0",
    commits: [],
    schema: { fromVersion: 19, toVersion: 19, changed: false, newMigrations: [], destructive: false, noDowngrade: false },
    mcpTools: { added: [], removed: [] },
    cliCommands: { added: [], removed: [] },
    ...over,
  });
}

function input(over: Partial<ReleaseCheckInput> = {}): ReleaseCheckInput {
  return {
    plan: planWith(),
    packageVersion: "0.5.0",
    manifestVersion: "0.5.0",
    treeClean: true,
    specs: { mcp: "", db: "", cli: "" },
    ...over,
  };
}

function check(name: string, r: ReturnType<typeof buildReleaseCheck>) {
  return r.checks.find((c) => c.name === name)!;
}

describe("buildReleaseCheck", () => {
  it("passes when everything is clean", () => {
    const r = buildReleaseCheck(input());
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.pass)).toBe(true);
  });

  it("fails plan-clean on an undeclared breaking change", () => {
    const plan = planWith({ mcpTools: { added: [], removed: ["harness.old"] } });
    const r = buildReleaseCheck(input({ plan, specs: { mcp: "", db: "", cli: "" } }));
    expect(check("plan-clean", r).pass).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("fails plan-clean on an incomplete analysis (analysisWarnings)", () => {
    const plan = planWith({ warnings: ["src/cli/db.ts present at v0.5.0 but unreadable at HEAD"] });
    const r = buildReleaseCheck(input({ plan }));
    expect(check("plan-clean", r).pass).toBe(false);
  });

  it("fails version-consistency when package.json != manifest", () => {
    const r = buildReleaseCheck(input({ packageVersion: "0.5.0", manifestVersion: "0.4.0" }));
    expect(check("version-consistency", r).pass).toBe(false);
  });

  it("fails version-consistency when the manifest is missing", () => {
    const r = buildReleaseCheck(input({ manifestVersion: null }));
    expect(check("version-consistency", r).pass).toBe(false);
  });

  it("fails spec-sync when an added MCP tool is undocumented", () => {
    const plan = planWith({ mcpTools: { added: ["harness.new.tool"], removed: [] } });
    const r = buildReleaseCheck(input({ plan, specs: { mcp: "(no mention)", db: "", cli: "" } }));
    expect(check("spec-sync", r).pass).toBe(false);
    expect(check("spec-sync", r).detail).toMatch(/harness\.new\.tool/);
  });

  it("passes spec-sync when the added surface IS documented", () => {
    const plan = planWith({
      mcpTools: { added: ["harness.new.tool"], removed: [] },
      cliCommands: { added: ["widget"], removed: [] },
      schema: { fromVersion: 18, toVersion: 19, changed: true, newMigrations: [], destructive: false, noDowngrade: true },
    });
    const r = buildReleaseCheck(
      input({
        plan,
        specs: {
          mcp: "the harness.new.tool read tool",
          db: "schema v19 adds a column",
          cli: "harness widget does things",
        },
      }),
    );
    expect(check("spec-sync", r).pass).toBe(true);
  });

  it("fails spec-sync when a schema bump is undocumented in db.md", () => {
    const plan = planWith({
      schema: { fromVersion: 18, toVersion: 19, changed: true, newMigrations: [], destructive: false, noDowngrade: true },
    });
    const r = buildReleaseCheck(input({ plan, specs: { mcp: "", db: "schema v18 only", cli: "" } }));
    expect(check("spec-sync", r).pass).toBe(false);
    expect(check("spec-sync", r).detail).toMatch(/v19/);
  });

  it("does NOT treat a longer name as documenting an added MCP tool (boundary match)", () => {
    const plan = planWith({ mcpTools: { added: ["harness.b"], removed: [] } });
    // mcp.md only mentions `harness.b.extra` — must NOT count `harness.b` as documented
    const r = buildReleaseCheck(input({ plan, specs: { mcp: "see harness.b.extra here", db: "", cli: "" } }));
    expect(check("spec-sync", r).pass).toBe(false);
  });

  it("fails version-consistency when package.json version is unreadable (no false pass)", () => {
    const r = buildReleaseCheck(input({ packageVersion: null, manifestVersion: null }));
    expect(check("version-consistency", r).pass).toBe(false);
    expect(check("version-consistency", r).detail).toMatch(/unreadable/i);
  });

  it("fails clean-tree on uncommitted changes", () => {
    const r = buildReleaseCheck(input({ treeClean: false }));
    expect(check("clean-tree", r).pass).toBe(false);
  });

  it("renders a PASS/FAIL summary", () => {
    expect(renderReleaseCheckText(buildReleaseCheck(input()))).toMatch(/PASS/);
    expect(renderReleaseCheckText(buildReleaseCheck(input({ treeClean: false })))).toMatch(/FAIL/);
  });
});
