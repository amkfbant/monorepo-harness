import { describe, it, expect } from "vitest";
import {
  buildReleasePlan,
  parseConventionalCommit,
  applyBump,
  type ReleasePlanInput,
  type ParsedCommit,
  type SchemaCompat,
} from "../../../src/release/release-plan.js";

function commit(subject: string, body = ""): ParsedCommit {
  return parseConventionalCommit("abc1234", subject, body);
}

const noSchemaChange: SchemaCompat = {
  fromVersion: 19,
  toVersion: 19,
  changed: false,
  newMigrations: [],
  destructive: false,
  noDowngrade: false,
};

function input(over: Partial<ReleasePlanInput> = {}): ReleasePlanInput {
  return {
    since: "v0.5.0",
    to: "HEAD",
    currentVersion: "0.5.0",
    commits: [],
    schema: noSchemaChange,
    mcpTools: { added: [], removed: [] },
    cliCommands: { added: [], removed: [] },
    ...over,
  };
}

describe("parseConventionalCommit", () => {
  it("parses type / scope / subject", () => {
    const c = commit("feat(mcp): add a tool");
    expect(c).toMatchObject({ type: "feat", scope: "mcp", breaking: false });
    expect(c.subject).toBe("add a tool");
  });
  it("detects a `!` breaking marker", () => {
    expect(commit("feat!: drop X").breaking).toBe(true);
  });
  it("detects a BREAKING CHANGE footer", () => {
    expect(commit("refactor: x", "body\n\nBREAKING CHANGE: removed Y").breaking).toBe(true);
  });
  it("detects a BREAKING-CHANGE footer synonym", () => {
    expect(commit("refactor: x", "body\n\nBREAKING-CHANGE: removed Y").breaking).toBe(true);
  });
  it("returns type null for a non-conventional subject", () => {
    expect(commit("just a message").type).toBeNull();
  });
});

describe("applyBump", () => {
  it("bumps minor / patch / major and handles 0.x", () => {
    expect(applyBump("0.5.0", "minor")).toBe("0.6.0");
    expect(applyBump("0.5.0", "patch")).toBe("0.5.1");
    expect(applyBump("0.5.0", "major")).toBe("1.0.0");
    expect(applyBump("1.2.3", "none")).toBe("1.2.3");
  });
});

describe("buildReleasePlan — bump recommendation", () => {
  it("recommends minor for feat in 0.x", () => {
    const p = buildReleasePlan(input({ commits: [commit("feat: x"), commit("docs: y")] }));
    expect(p.recommendedBump).toBe("minor");
    expect(p.recommendedVersion).toBe("0.6.0");
    expect(p.commitsByType).toMatchObject({ feat: 1, docs: 1 });
  });
  it("recommends patch for fix-only", () => {
    const p = buildReleasePlan(input({ commits: [commit("fix: x")] }));
    expect(p.recommendedBump).toBe("patch");
    expect(p.recommendedVersion).toBe("0.5.1");
  });
  it("recommends none for docs/chore-only", () => {
    const p = buildReleasePlan(input({ commits: [commit("docs: x"), commit("chore: y")] }));
    expect(p.recommendedBump).toBe("none");
    expect(p.recommendedVersion).toBe("0.5.0");
  });
  it("a breaking commit in 0.x is a minor (not major)", () => {
    const p = buildReleasePlan(input({ commits: [commit("feat!: drop X")] }));
    expect(p.recommendedBump).toBe("minor");
    expect(p.breakingCommits).toHaveLength(1);
  });
  it("a breaking commit at >=1.x is a major", () => {
    const p = buildReleasePlan(
      input({ currentVersion: "1.4.0", commits: [commit("feat!: drop X")] }),
    );
    expect(p.recommendedBump).toBe("major");
    expect(p.recommendedVersion).toBe("2.0.0");
  });
});

describe("buildReleasePlan — compatibility detection", () => {
  it("flags removed MCP tools as an UNDECLARED breaking change (no marker)", () => {
    const p = buildReleasePlan(
      input({
        commits: [commit("feat: x")],
        mcpTools: { added: ["harness.new.tool"], removed: ["harness.old.tool"] },
      }),
    );
    expect(p.undeclaredBreaking.join(" ")).toMatch(/removed MCP tool.*harness\.old\.tool/);
    // 0.x: still minor, but the warning surfaces the undeclared break
    expect(p.recommendedBump).toBe("minor");
  });

  it("does NOT flag undeclared-breaking when a `feat!` marker is present", () => {
    const p = buildReleasePlan(
      input({
        commits: [commit("feat!: remove old tool")],
        mcpTools: { added: [], removed: ["harness.old.tool"] },
      }),
    );
    expect(p.undeclaredBreaking).toEqual([]);
  });

  it("does NOT flag undeclared-breaking when a BREAKING-CHANGE footer marker is present", () => {
    const p = buildReleasePlan(
      input({
        commits: [commit("feat: remove old tool", "BREAKING-CHANGE: removed old tool")],
        mcpTools: { added: [], removed: ["harness.old.tool"] },
      }),
    );
    expect(p.breakingCommits).toHaveLength(1);
    expect(p.undeclaredBreaking).toEqual([]);
  });

  it("surfaces the schema no-downgrade caveat as a compatibility note", () => {
    const schema: SchemaCompat = {
      fromVersion: 18,
      toVersion: 19,
      changed: true,
      newMigrations: [{ version: 19, name: "operational-knowledge-category-v19", additive: true }],
      destructive: false,
      noDowngrade: true,
    };
    const p = buildReleasePlan(input({ schema, commits: [commit("feat: x")] }));
    expect(p.compatibilityNotes.join(" ")).toMatch(/schema 18 → 19/);
    expect(p.compatibilityNotes.join(" ")).toMatch(/no downgrade/i);
    // additive migration → not an undeclared break
    expect(p.undeclaredBreaking).toEqual([]);
  });

  it("flags a non-additive (destructive) migration without a marker", () => {
    const schema: SchemaCompat = {
      fromVersion: 18,
      toVersion: 19,
      changed: true,
      newMigrations: [{ version: 19, name: "rebuild-x", additive: false }],
      destructive: true,
      noDowngrade: true,
    };
    const p = buildReleasePlan(input({ schema, commits: [commit("feat: x")] }));
    expect(p.undeclaredBreaking.join(" ")).toMatch(/non-additive DB migration.*rebuild-x/);
  });
});
