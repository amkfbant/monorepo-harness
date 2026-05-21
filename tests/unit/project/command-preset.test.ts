import { describe, it, expect } from "vitest";
import {
  CommandPresetSchema,
  PresetCommandSchema,
  compilePresetCommand,
  type PresetCommand,
} from "../../../src/project/command-preset.js";

describe("CommandPresetSchema", () => {
  it("E5-2-4: parses a preset with plain and package_script commands", () => {
    const r = CommandPresetSchema.safeParse({
      version: 1,
      preset_id: "demo-v1",
      defaults: { timeout_ms: 1000, env_allowlist: ["PATH"] },
      commands: [
        { id: "ver", cmd: "node", args: ["--version"] },
        {
          id: "test",
          kind: "package_script",
          package_scope: "domain",
          script: "test",
          package_managers: { npm: { cmd: "npm", args: ["test"] } },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a package_script with no package managers", () => {
    const r = PresetCommandSchema.safeParse({
      id: "x",
      kind: "package_script",
      package_scope: "domain",
      script: "test",
      package_managers: {},
    });
    expect(r.success).toBe(false);
  });
});

describe("compilePresetCommand", () => {
  const plain: PresetCommand = {
    id: "pytest",
    cmd: "python3",
    args: ["-m", "pytest", "-q", "{domain_root}"],
  };

  it("E5-2-5: substitutes {domain_root} in a plain command", () => {
    const r = compilePresetCommand(plain, { domainRoot: "services/api" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command.args).toEqual([
      "-m",
      "pytest",
      "-q",
      "services/api",
    ]);
  });

  const pkgScript: PresetCommand = {
    id: "test",
    kind: "package_script",
    package_scope: "domain",
    script: "test",
    package_managers: {
      npm: { cmd: "npm", args: ["test", "--workspace", "{package_name}"] },
      pnpm: { cmd: "pnpm", args: ["--filter", "{package_name}", "test"] },
    },
  };

  it("E5-2-6: resolves a package_script for the npm package manager", () => {
    const r = compilePresetCommand(pkgScript, {
      domainRoot: "apps/web",
      packageManager: "npm",
      packageName: "@demo/web",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.command.cmd).toBe("npm");
      expect(r.command.args).toEqual(["test", "--workspace", "@demo/web"]);
    }
  });

  it("resolves a package_script for pnpm", () => {
    const r = compilePresetCommand(pkgScript, {
      domainRoot: "apps/web",
      packageManager: "pnpm",
      packageName: "@demo/web",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.command.args).toEqual(["--filter", "@demo/web", "test"]);
  });

  it("skips a package_script when the package manager is unknown", () => {
    const r = compilePresetCommand(pkgScript, { domainRoot: "apps/web" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/package manager unknown/);
  });

  it("skips a package_script when the package manager has no invocation", () => {
    const r = compilePresetCommand(pkgScript, {
      domainRoot: "apps/web",
      packageManager: "bun",
      packageName: "@demo/web",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no invocation/);
  });

  it("skips when {package_name} cannot be resolved", () => {
    const r = compilePresetCommand(pkgScript, {
      domainRoot: "apps/web",
      packageManager: "npm",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unresolved placeholder/);
  });

  it("rejects a misspelled placeholder rather than baking it into argv", () => {
    const typo: PresetCommand = {
      id: "typo",
      cmd: "echo",
      // `{domain-root}` (hyphen) is not a known token — must NOT pass through.
      args: ["{domain-root}", "{packageName}"],
    };
    const r = compilePresetCommand(typo, { domainRoot: "apps/web" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unresolved placeholder/);
  });
});
