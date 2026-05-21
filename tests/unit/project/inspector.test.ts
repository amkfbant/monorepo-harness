import { describe, it, expect } from "vitest";
import { inspectProject } from "../../../src/project/inspector.js";
import { DomainRegistrySchema } from "../../../src/project/domain-registry.js";
import type { RepoSignals, DirSignal } from "../../../src/project/repo-signals.js";

function dir(path: string, o: Partial<DirSignal> = {}): DirSignal {
  return {
    path,
    depth: path.includes("/") ? 2 : 1,
    hasPackageJson: o.hasPackageJson ?? false,
    hasPyproject: o.hasPyproject ?? false,
    packageName: o.packageName ?? null,
    scripts: o.scripts ?? [],
  };
}

function signals(o: Partial<RepoSignals> & { directories: DirSignal[] }): RepoSignals {
  return {
    repoPath: "/repo",
    isGitRepo: o.isGitRepo ?? true,
    packageManager: o.packageManager ?? "pnpm",
    hasWorkspaces: o.hasWorkspaces ?? true,
    languages: o.languages ?? ["typescript", "javascript"],
    rootScripts: o.rootScripts ?? ["test"],
    directories: o.directories,
    truncated: o.truncated ?? false,
  };
}

const NODE_REGISTRY = DomainRegistrySchema.parse({
  version: 1,
  registry_id: "node-monorepo-default-v1",
  suggested_policy_template: "strict-monorepo-v1",
  patterns: [
    {
      id_template: "apps/{name}",
      root_glob: "apps/*",
      kind: "app",
      command_presets: ["node-basic-v1"],
      context_packs: ["monorepo-docs-v1"],
    },
    {
      id_template: "packages/{name}",
      root_glob: "packages/*",
      kind: "package",
      command_presets: ["node-package-basic-v1"],
    },
  ],
});

describe("inspectProject", () => {
  it("E5-3-2: proposes candidate domains from registry patterns", () => {
    const r = inspectProject(
      signals({
        directories: [
          dir("apps"),
          dir("apps/web", { hasPackageJson: true, packageName: "@x/web" }),
          dir("apps/admin", { hasPackageJson: true }),
          dir("packages"),
          dir("packages/ui", { hasPackageJson: true }),
        ],
      }),
      NODE_REGISTRY,
    );
    expect(r.candidates.map((c) => c.id)).toEqual([
      "apps/admin",
      "apps/web",
      "packages/ui",
    ]);
    const web = r.candidates.find((c) => c.id === "apps/web");
    expect(web?.kind).toBe("app");
    expect(web?.confidence).toBe("high");
    expect(web?.suggestedPolicyTemplate).toBe("strict-monorepo-v1");
    expect(web?.suggestedCommandPresets).toEqual(["node-basic-v1"]);
  });

  it("E5-3-3: output ordering is deterministic", () => {
    const dirs = [
      dir("apps/zed", { hasPackageJson: true }),
      dir("apps/alpha", { hasPackageJson: true }),
    ];
    const a = inspectProject(signals({ directories: dirs }), NODE_REGISTRY);
    const b = inspectProject(
      signals({ directories: [...dirs].reverse() }),
      NODE_REGISTRY,
    );
    expect(a.candidates.map((c) => c.id)).toEqual(b.candidates.map((c) => c.id));
    expect(a.candidates[0]?.id).toBe("apps/alpha");
  });

  it("marks a manifest-less domain as medium confidence", () => {
    const r = inspectProject(
      signals({ directories: [dir("apps/bare")] }),
      NODE_REGISTRY,
    );
    expect(r.candidates[0]?.confidence).toBe("medium");
  });

  it("skips a directory whose name yields an unsafe domain id", () => {
    const r = inspectProject(
      signals({ directories: [dir("apps/with space")] }),
      NODE_REGISTRY,
    );
    expect(r.candidates).toHaveLength(0);
  });

  it("the first matching registry pattern wins", () => {
    const reg = DomainRegistrySchema.parse({
      version: 1,
      registry_id: "dup-v1",
      patterns: [
        { id_template: "x", root_glob: "apps/web", kind: "app" },
        { id_template: "x", root_glob: "apps/*", kind: "package" },
      ],
    });
    const r = inspectProject(
      signals({ directories: [dir("apps/web", { hasPackageJson: true })] }),
      reg,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.kind).toBe("app");
  });

  it("E5-3-4: warns when the target is not a git repo", () => {
    const r = inspectProject(
      signals({ isGitRepo: false, directories: [] }),
      NODE_REGISTRY,
    );
    expect(r.warnings.some((w) => /not a git repository/.test(w))).toBe(true);
  });

  it("warns when no candidate matches", () => {
    const r = inspectProject(
      signals({ directories: [dir("src")] }),
      NODE_REGISTRY,
    );
    expect(r.warnings.some((w) => /no candidate domains/.test(w))).toBe(true);
  });

  it("warns when the directory scan was truncated", () => {
    const r = inspectProject(
      signals({
        truncated: true,
        directories: [dir("apps/web", { hasPackageJson: true })],
      }),
      NODE_REGISTRY,
    );
    expect(r.warnings.some((w) => /truncated/.test(w))).toBe(true);
  });
});
