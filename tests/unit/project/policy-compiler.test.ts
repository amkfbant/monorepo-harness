import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { ProjectProfileSchema } from "../../../src/project/schema.js";
import {
  loadCompileInputs,
  compileProjectPolicy,
} from "../../../src/project/policy-compiler.js";
import type { RepoSignals } from "../../../src/project/repo-signals.js";
import { RepoPolicySchema } from "../../../src/policy/schema.js";
import { resolvePolicy } from "../../../src/policy/resolver.js";

const TEMPLATES = join(process.cwd(), "templates");
const GENERATED_AT = "2026-05-22T00:00:00.000Z";

function profile(overrides: Record<string, unknown> = {}) {
  return ProjectProfileSchema.parse({
    version: 1,
    project_id: "demo",
    repo: { id: "demo", path: "../demo", package_manager: "npm" },
    policy: { template: "strict-monorepo-v1" },
    commands: { presets: ["node-basic-v1"] },
    domains: [
      { id: "apps/web", root: "apps/web", kind: "app" },
      { id: "packages/ui", root: "packages/ui", kind: "package" },
    ],
    ...overrides,
  });
}

function signals(): RepoSignals {
  return {
    repoPath: "/demo",
    isGitRepo: true,
    packageManager: "npm",
    hasWorkspaces: true,
    languages: ["javascript"],
    rootScripts: [],
    truncated: false,
    directories: [
      {
        path: "apps/web",
        depth: 2,
        hasPackageJson: true,
        hasPyproject: false,
        packageName: "@demo/web",
        scripts: ["test"],
      },
      {
        path: "packages/ui",
        depth: 2,
        hasPackageJson: true,
        hasPyproject: false,
        packageName: "@demo/ui",
        scripts: ["test"],
      },
    ],
  };
}

async function compile(p = profile(), repoSignals = signals()) {
  const inputs = await loadCompileInputs(p, "projects/demo.yaml", {
    templatesDir: TEMPLATES,
    repoSignals,
    generatedAt: GENERATED_AT,
  });
  return compileProjectPolicy(inputs);
}

describe("compileProjectPolicy", () => {
  it("E5-4-2: produces a RepoPolicy that parses against RepoPolicySchema", async () => {
    const r = await compile();
    expect(RepoPolicySchema.safeParse(r.repoPolicy).success).toBe(true);
  });

  it("E5-4-3: resolvePolicy succeeds for every compiled domain", async () => {
    const r = await compile();
    for (const domain of Object.keys(r.repoPolicy.domains)) {
      expect(() =>
        resolvePolicy(r.globalPolicy, r.repoPolicy, domain),
      ).not.toThrow();
    }
  });

  it("derives write scope from the template when the domain omits it", async () => {
    const r = await compile();
    expect(r.repoPolicy.domains["apps/web"]?.write).toEqual(["apps/web/**"]);
  });

  it("an explicit domain write scope overrides the template default", async () => {
    const r = await compile(
      profile({
        domains: [
          {
            id: "apps/web",
            root: "apps/web",
            kind: "app",
            write: ["apps/web/src/**"],
          },
          { id: "packages/ui", root: "packages/ui", kind: "package" },
        ],
      }),
    );
    expect(r.repoPolicy.domains["apps/web"]?.write).toEqual([
      "apps/web/src/**",
    ]);
  });

  it("E5-4-4: deny_write isolates a domain from sibling domain roots", async () => {
    const r = await compile();
    expect(r.repoPolicy.domains["apps/web"]?.deny_write).toContain(
      "packages/ui/**",
    );
    expect(r.repoPolicy.domains["apps/web"]?.deny_write).toContain(
      "package.json",
    );
  });

  it("the global policy carries the template root_deny + ignore_untracked", async () => {
    const r = await compile();
    expect(r.globalPolicy.always_deny_write).toContain("package.json");
    expect(r.globalPolicy.ignore_untracked).toContain("**/node_modules/**");
  });

  it("the strict-monorepo-v1 template ignores common Python build/cache artifacts", async () => {
    const r = await compile();
    for (const p of [
      "**/.venv/**",
      "**/.mypy_cache/**",
      "**/.pytest_cache/**",
      "**/.ruff_cache/**",
      "**/__pycache__/**",
    ]) {
      expect(r.globalPolicy.ignore_untracked).toContain(p);
    }
  });

  it("merges profile.policy.ignore_untracked with the template ignore_untracked", async () => {
    const r = await compile(
      profile({
        policy: {
          template: "strict-monorepo-v1",
          ignore_untracked: ["**/.tox/**", "**/build/**"],
        },
      }),
    );
    // template-provided entries survive
    expect(r.globalPolicy.ignore_untracked).toContain("**/node_modules/**");
    // profile-provided entries are merged in
    expect(r.globalPolicy.ignore_untracked).toContain("**/.tox/**");
    expect(r.globalPolicy.ignore_untracked).toContain("**/build/**");
  });

  it("compiles a package_script command when the package manager is known", async () => {
    const r = await compile();
    const allow = r.repoPolicy.domains["apps/web"]?.commands?.allow ?? [];
    // node-basic-v1: node-version (plain) + npm-test-if-script-exists.
    const ids = allow.map((c) => (typeof c === "string" ? c : c.id));
    expect(ids).toContain("npm-test-if-script-exists");
  });

  it("E5-4-5: warns instead of emitting a package_script with an unknown manager", async () => {
    const noPm = { ...signals(), packageManager: "none" as const };
    const r = await compile(
      profile({ repo: { id: "demo", path: "../demo" } }),
      noPm,
    );
    expect(
      r.warnings.some((w) => /package manager unknown/.test(w.message)),
    ).toBe(true);
  });

  it("E5-4-6: output is deterministic", async () => {
    const a = await compile();
    const b = await compile();
    expect(JSON.stringify(a.repoPolicy)).toBe(JSON.stringify(b.repoPolicy));
    expect(JSON.stringify(a.globalPolicy)).toBe(JSON.stringify(b.globalPolicy));
  });

  it("records provenance with the template and preset ids", async () => {
    const r = await compile();
    expect(r.provenance.policyTemplate?.id).toBe("strict-monorepo-v1");
    expect(r.provenance.commandPresets.map((p) => p.id)).toContain(
      "node-basic-v1",
    );
    expect(r.provenance.generatedAt).toBe(GENERATED_AT);
  });

  it("rejects a profile with no policy.template", async () => {
    const p = profile({ policy: undefined });
    await expect(
      loadCompileInputs(p, "projects/demo.yaml", {
        templatesDir: TEMPLATES,
        generatedAt: GENERATED_AT,
      }),
    ).rejects.toThrow(/policy\.template/);
  });

  it("dedupes a structured 'cmd-N' id colliding with a legacy string command", async () => {
    const p = profile({
      commands: undefined,
      domains: [
        {
          id: "apps/web",
          root: "apps/web",
          kind: "app",
          commands: {
            allow: ["echo hi", { id: "cmd-0", cmd: "node", args: [] }],
          },
        },
      ],
    });
    const r = await compile(p);
    // string "echo hi" resolves to id cmd-0, colliding with the structured
    // cmd-0; the later entry is dropped so resolvePolicy will not throw.
    expect(() =>
      resolvePolicy(r.globalPolicy, r.repoPolicy, "apps/web"),
    ).not.toThrow();
    expect(
      r.warnings.some((w) => /duplicate command id "cmd-0"/.test(w.message)),
    ).toBe(true);
  });

  it("normalizes a '.' domain root to a repo-root-anchored glob", async () => {
    const p = profile({
      commands: undefined,
      domains: [
        { id: "root-domain", root: ".", kind: "app" },
        { id: "apps/web", root: "apps/web", kind: "app" },
      ],
    });
    const r = await compile(p, signals());
    expect(r.repoPolicy.domains["root-domain"]?.write).toEqual(["**"]);
  });

  it("skips a package_script command when the domain does not declare the script", async () => {
    const noTest: RepoSignals = {
      ...signals(),
      directories: signals().directories.map((d) => ({ ...d, scripts: [] })),
    };
    const r = await compile(profile(), noTest);
    const allow = r.repoPolicy.domains["apps/web"]?.commands?.allow ?? [];
    const ids = allow.map((c) => (typeof c === "string" ? c : c.id));
    expect(ids).not.toContain("npm-test-if-script-exists");
    expect(
      r.warnings.some((w) => /not declared/.test(w.message)),
    ).toBe(true);
  });
});
