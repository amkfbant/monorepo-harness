import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadMcpConfig, McpConfigError } from "../../../src/mcp/security/config.js";
import { decideMcpPermission } from "../../../src/mcp/security/permissions.js";

function tempHarnessRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-config-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  return root;
}

function runCli(root: string, args: string[]) {
  return spawnSync("node", ["--import", "tsx", join(process.cwd(), "src/cli/run.ts"), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HARNESS_ROOT: root },
    encoding: "utf8",
  });
}

describe("MCP config and permission engine", () => {
  it("uses safe defaults when no config exists", () => {
    const config = loadMcpConfig({ harnessRoot: tempHarnessRoot() });
    expect(config.defaultMode).toBe("dry-run");
    expect(config.audit.recordDryRuns).toBe(true);
    expect(config.requireConfirmation).toContain("pr.create");
    expect(config.deniedOperations).toContain("db.vacuum");
  });

  it("denies mutation by default but permits dry-run", () => {
    const config = loadMcpConfig({ harnessRoot: tempHarnessRoot() });
    expect(
      decideMcpPermission(config, {
        toolName: "harness.run.start",
        kind: "mutation",
        clientMode: "dry-run",
        projectId: "demo",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "mutation_disabled_for_client",
    });
    expect(
      decideMcpPermission(config, {
        toolName: "harness.run.dry_run",
        kind: "dry-run",
        clientMode: "dry-run",
        projectId: "demo",
      }),
    ).toMatchObject({ allowed: true, mode: "dry-run" });
  });

  it("treats allowedOperations as a guarded-mutation allowlist, not a read/dry-run allowlist", () => {
    const config = {
      ...loadMcpConfig({ harnessRoot: tempHarnessRoot() }),
      allowedOperations: ["backlog.create"],
    };
    expect(
      decideMcpPermission(config, {
        toolName: "harness.project.list",
        kind: "read",
        clientMode: "dry-run",
      }),
    ).toMatchObject({ allowed: true, reason: "read_allowed" });
    expect(
      decideMcpPermission(config, {
        toolName: "harness.run.dry_run",
        kind: "dry-run",
        clientMode: "dry-run",
      }),
    ).toMatchObject({ allowed: true, reason: "dry_run_allowed" });
    expect(
      decideMcpPermission(config, {
        toolName: "harness.run.start",
        kind: "mutation",
        clientMode: "guarded-mutation",
      }),
    ).toMatchObject({ allowed: false, reason: "operation_not_allowlisted" });
  });

  it("applies denied > confirmation > allowlist precedence", () => {
    const root = tempHarnessRoot();
    const configPath = join(root, ".harness", "mcp.yaml");
    writeFileSync(
      configPath,
      [
        "version: 1",
        "mcp:",
        "  defaultMode: guarded-mutation",
        "  allowedOperations:",
        "    - db.vacuum",
        "    - run.start",
        "  requireConfirmation:",
        "    - run.start",
        "  deniedOperations:",
        "    - db.vacuum",
        "",
      ].join("\n"),
    );
    const config = loadMcpConfig({ harnessRoot: root, configPath });
    expect(
      decideMcpPermission(config, {
        toolName: "harness.db.vacuum",
        kind: "dangerous",
        clientMode: "guarded-mutation",
      }),
    ).toMatchObject({ allowed: false, reason: "operation_denied" });
    expect(
      decideMcpPermission(config, {
        toolName: "harness.run.start",
        kind: "mutation",
        clientMode: "guarded-mutation",
      }),
    ).toMatchObject({
      allowed: true,
      mode: "confirmation-required",
      requiredConfirmation: true,
    });
  });

  it("enforces project allowlist", () => {
    const root = tempHarnessRoot();
    const configPath = join(root, ".harness", "mcp.yaml");
    writeFileSync(
      configPath,
      [
        "version: 1",
        "mcp:",
        "  allowedProjects:",
        "    - allowed",
        "",
      ].join("\n"),
    );
    const config = loadMcpConfig({ harnessRoot: root, configPath });
    expect(
      decideMcpPermission(config, {
        toolName: "harness.project.get",
        kind: "read",
        clientMode: "dry-run",
        projectId: "blocked",
      }),
    ).toMatchObject({ allowed: false, reason: "project_not_allowed" });
  });

  it("uses project profile mcp config when no explicit or global config exists", () => {
    const root = tempHarnessRoot();
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
        "mcp:",
        "  defaultMode: read-only",
        "  allowedProjects:",
        "    - demo",
        "  audit:",
        "    recordReadTools: true",
        "",
      ].join("\n"),
    );

    const config = loadMcpConfig({ harnessRoot: root });
    expect(config.defaultMode).toBe("read-only");
    expect(config.allowedProjects).toEqual(["demo"]);
    expect(config.audit.recordReadTools).toBe(true);
  });

  it("prefers explicit config over project profile mcp config", () => {
    const root = tempHarnessRoot();
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
        "mcp:",
        "  defaultMode: read-only",
        "  allowedProjects:",
        "    - profile-only",
        "",
      ].join("\n"),
    );
    const explicit = join(root, "mcp-explicit.yaml");
    writeFileSync(
      explicit,
      [
        "version: 1",
        "mcp:",
        "  defaultMode: guarded-mutation",
        "  allowedProjects:",
        "    - explicit",
        "",
      ].join("\n"),
    );

    const config = loadMcpConfig({ harnessRoot: root, configPath: explicit });
    expect(config.defaultMode).toBe("guarded-mutation");
    expect(config.allowedProjects).toEqual(["explicit"]);
  });

  it("fails closed when an explicit config path is missing", () => {
    const root = tempHarnessRoot();
    expect(() =>
      loadMcpConfig({
        harnessRoot: root,
        configPath: join(root, "missing-mcp.yaml"),
      }),
    ).toThrow(McpConfigError);

    const config = runCli(root, ["mcp", "config", "--config", "missing-mcp.yaml"]);
    expect(config.status).not.toBe(0);
    expect(config.stderr).toContain("MCP config not found");

    const serve = runCli(root, ["mcp", "serve", "--config", "missing-mcp.yaml"]);
    expect(serve.status).not.toBe(0);
    expect(serve.stderr).toContain("MCP config not found");
  });
});
