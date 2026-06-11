import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { mergeMcpConfig } from "../../../src/onboard/mcp-config.js";

const baseDecline = { projectId: "demo", existingProjectIds: ["demo"], starter: null };

describe("mergeMcpConfig (#92)", () => {
  it("creates a fresh config (deny-all) when none exists and starter is declined", () => {
    const { yaml, report } = mergeMcpConfig(null, baseDecline);
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.defaultMode).toBe("dry-run");
    expect(cfg.allowedProjects).toEqual(["demo"]);
    expect(cfg.allowedOperations ?? []).toEqual([]);
    expect(cfg.clients ?? []).toEqual([]);
    expect(report.allowAllPreserved).toBe(false);
  });

  it("on starter opt-in writes BOTH a guarded-mutation client AND the operations (two-stage gate)", () => {
    const { yaml } = mergeMcpConfig(null, {
      projectId: "demo",
      existingProjectIds: ["demo"],
      starter: { clientName: "codex", operations: ["hitch.start", "run.start"] },
    });
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.defaultMode).toBe("dry-run"); // unknown clients stay un-elevated
    expect(cfg.clients).toEqual([
      { id: "codex", names: ["codex"], mode: "guarded-mutation" },
    ]);
    expect(cfg.allowedOperations).toEqual(["hitch.start", "run.start"]);
  });

  it("appends the project to a non-empty allowedProjects list, preserving other fields", () => {
    const existing = [
      "version: 1",
      "mcp:",
      "  defaultMode: dry-run",
      "  allowedProjects: [other]",
      "  deniedOperations: [db.restore]",
      "  clients:",
      "    - { id: codex, names: [codex], mode: guarded-mutation }",
      "",
    ].join("\n");
    const { yaml, report } = mergeMcpConfig(existing, {
      projectId: "demo",
      existingProjectIds: ["other", "demo"],
      starter: null,
    });
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.allowedProjects.sort()).toEqual(["demo", "other"]);
    expect(cfg.deniedOperations).toEqual(["db.restore"]); // preserved
    expect(cfg.clients).toHaveLength(1); // preserved
    expect(report.allowAllPreserved).toBe(false);
  });

  it("does NOT silently narrow an allow-all config; reports it and leaves the list empty unless explicitly enumerated", () => {
    const existing = ["version: 1", "mcp:", "  allowedProjects: []", ""].join("\n");
    const { yaml, report } = mergeMcpConfig(existing, {
      projectId: "demo",
      existingProjectIds: ["demo"],
      starter: null,
      allowAll: "keep",
    });
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.allowedProjects).toEqual([]); // still allow-all — not narrowed
    expect(report.allowAllPreserved).toBe(true);
  });

  it("treats a KEY-ABSENT allowedProjects as allow-all too (does not narrow)", () => {
    const existing = ["version: 1", "mcp:", "  defaultMode: dry-run", ""].join("\n");
    const { yaml, report } = mergeMcpConfig(existing, {
      projectId: "demo",
      existingProjectIds: ["demo"],
      starter: null,
      allowAll: "keep",
    });
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.allowedProjects).toEqual([]); // not narrowed to [demo]
    expect(report.allowAllPreserved).toBe(true);
  });

  it("promotes an existing same-name client to guarded-mutation on opt-in (no silent no-op, #81 trap)", () => {
    const existing = [
      "version: 1", "mcp:",
      "  allowedProjects: [demo]",
      "  clients:",
      "    - { id: codex, names: [codex], mode: read-only }",
      "",
    ].join("\n");
    const { yaml, report } = mergeMcpConfig(existing, {
      projectId: "demo", existingProjectIds: ["demo"],
      starter: { clientName: "codex", operations: ["hitch.start"] },
    });
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.clients).toEqual([{ id: "codex", names: ["codex"], mode: "guarded-mutation" }]);
    expect(cfg.allowedOperations).toEqual(["hitch.start"]);
    expect(report.mutationsEnabled).toBe(true);
  });

  it("when the operator chooses to enumerate, seeds the list from existing project ids + the new one", () => {
    const existing = ["version: 1", "mcp:", "  allowedProjects: []", ""].join("\n");
    const { yaml } = mergeMcpConfig(existing, {
      projectId: "demo",
      existingProjectIds: ["alpha", "beta", "demo"],
      starter: null,
      allowAll: "enumerate",
    });
    const cfg = parseYaml(yaml).mcp;
    expect(cfg.allowedProjects.sort()).toEqual(["alpha", "beta", "demo"]);
  });
});
