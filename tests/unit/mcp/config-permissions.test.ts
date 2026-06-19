import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadMcpConfig, McpConfigError } from "../../../src/mcp/security/config.js";
import {
  decideMcpPermission,
  resolveMcpClientPermission,
} from "../../../src/mcp/security/permissions.js";

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
    // phase.ratify records human spec approval (accountable owner signs); it must
    // require out-of-band confirmation by default so an allowlisted agent cannot
    // silently self-ratify a phase spec (parity with hitch.close/hitch.cancel).
    expect(config.requireConfirmation).toContain("phase.ratify");
    expect(config.deniedOperations).toContain("db.vacuum");
  });

  it("ignores removed confirmation policy keys while preserving ttlSeconds", () => {
    const root = tempHarnessRoot();
    const configPath = join(root, ".harness", "mcp.yaml");
    writeFileSync(
      configPath,
      [
        "version: 1",
        "mcp:",
        "  confirmation:",
        "    ttlSeconds: 123",
        "    requireOutOfBand: false",
        "    allowAgentConfirm: true",
        "",
      ].join("\n"),
    );

    const config = loadMcpConfig({ harnessRoot: root, configPath });
    expect(config.confirmation).toEqual({ ttlSeconds: 123 });
    expect("requireOutOfBand" in config.confirmation).toBe(false);
    expect("allowAgentConfirm" in config.confirmation).toBe(false);
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

  it("gates dangerous and confirmation-required operations by client mode before confirmation", () => {
    const config = {
      ...loadMcpConfig({ harnessRoot: tempHarnessRoot() }),
      requireConfirmation: ["backlog.create"],
    };
    const cases = [
      {
        clientMode: "read-only" as const,
        kind: "dangerous" as const,
        toolName: "harness.pr.create",
        expected: {
          allowed: false,
          mode: "mutation",
          reason: "dangerous_disabled_for_client",
        },
      },
      {
        clientMode: "dry-run" as const,
        kind: "dangerous" as const,
        toolName: "harness.pr.create",
        expected: {
          allowed: false,
          mode: "mutation",
          reason: "dangerous_disabled_for_client",
        },
      },
      {
        clientMode: "guarded-mutation" as const,
        kind: "dangerous" as const,
        toolName: "harness.pr.create",
        expected: {
          allowed: true,
          mode: "confirmation-required",
          reason: "confirmation_required",
          requiredConfirmation: true,
        },
      },
      {
        clientMode: "read-only" as const,
        kind: "mutation" as const,
        toolName: "harness.backlog.create",
        expected: {
          allowed: false,
          mode: "mutation",
          reason: "dangerous_disabled_for_client",
        },
      },
      {
        clientMode: "dry-run" as const,
        kind: "mutation" as const,
        toolName: "harness.backlog.create",
        expected: {
          allowed: false,
          mode: "mutation",
          reason: "dangerous_disabled_for_client",
        },
      },
      {
        clientMode: "guarded-mutation" as const,
        kind: "mutation" as const,
        toolName: "harness.backlog.create",
        expected: {
          allowed: true,
          mode: "confirmation-required",
          reason: "confirmation_required",
          requiredConfirmation: true,
        },
      },
    ];

    for (const c of cases) {
      expect(
        decideMcpPermission(config, {
          toolName: c.toolName,
          kind: c.kind,
          clientMode: c.clientMode,
        }),
      ).toMatchObject(c.expected);
    }
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

  it("resolves effective permission for a named client", () => {
    const root = tempHarnessRoot();
    const configPath = join(root, ".harness", "mcp.yaml");
    writeFileSync(
      configPath,
      [
        "version: 1",
        "mcp:",
        "  defaultMode: read-only",
        "  clients:",
        "    - id: claude-local",
        "      names:",
        "        - claude",
        "      mode: guarded-mutation",
        "  allowedOperations:",
        "    - run.start",
        "  requireConfirmation:",
        "    - pr.create",
        "",
      ].join("\n"),
    );

    const config = loadMcpConfig({ harnessRoot: root, configPath });
    expect(resolveMcpClientPermission(config, "claude")).toEqual({
      clientName: "claude",
      clientId: "claude-local",
      mode: "guarded-mutation",
      allowedOperations: ["run.start"],
      requireConfirmation: ["pr.create"],
    });
    expect(resolveMcpClientPermission(config, "unknown")).toMatchObject({
      clientName: "unknown",
      clientId: null,
      mode: "read-only",
    });
  });

  it("prints effective permission for mcp config --client-name", () => {
    const root = tempHarnessRoot();
    const configPath = join(root, ".harness", "mcp.yaml");
    writeFileSync(
      configPath,
      [
        "version: 1",
        "mcp:",
        "  defaultMode: read-only",
        "  clients:",
        "    - id: claude-local",
        "      names: [claude]",
        "      mode: guarded-mutation",
        "  allowedOperations:",
        "    - run.start",
        "  requireConfirmation:",
        "    - pr.create",
        "",
      ].join("\n"),
    );

    const result = runCli(root, ["mcp", "config", "--client-name", "claude"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      clientName: "claude",
      clientId: "claude-local",
      mode: "guarded-mutation",
      allowedOperations: ["run.start"],
      requireConfirmation: ["pr.create"],
    });
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
