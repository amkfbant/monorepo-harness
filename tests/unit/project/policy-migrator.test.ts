import { describe, it, expect } from "vitest";
import { migratePolicyToProfile } from "../../../src/project/policy-migrator.js";
import { RepoPolicySchema } from "../../../src/policy/schema.js";
import { ProjectProfileError } from "../../../src/project/errors.js";

function repoPolicy(overrides: Record<string, unknown> = {}) {
  return RepoPolicySchema.parse({
    repo_id: "mini-commerce",
    read: ["README.md", "docs/**"],
    domains: {
      "apps/catalog": {
        read: ["apps/catalog/**"],
        write: ["apps/catalog/**"],
        deny_write: ["apps/orders/**", "package.json"],
        commands: {
          allow: [{ id: "check", cmd: "test", args: ["-f", "x"] }],
        },
      },
      "apps/orders": {
        read: ["apps/orders/**"],
        write: ["apps/orders/**"],
        deny_write: ["apps/catalog/**"],
      },
    },
    ...overrides,
  });
}

describe("migratePolicyToProfile", () => {
  it("E5-5-1: converts a repo policy into a valid project profile", () => {
    const profile = migratePolicyToProfile(repoPolicy(), {
      projectId: "mini-commerce",
      policyTemplate: "strict-monorepo-v1",
    });
    expect(profile.project_id).toBe("mini-commerce");
    expect(profile.repo.id).toBe("mini-commerce");
    expect(profile.policy?.template).toBe("strict-monorepo-v1");
    expect(profile.domains).toHaveLength(2);
  });

  it("uses the domain key as the domain root", () => {
    const profile = migratePolicyToProfile(repoPolicy(), {
      projectId: "mini-commerce",
      policyTemplate: "strict-monorepo-v1",
    });
    const catalog = profile.domains.find((d) => d.id === "apps/catalog");
    expect(catalog?.root).toBe("apps/catalog");
  });

  it("E5-5-2: folds repo-level read into every domain read", () => {
    const profile = migratePolicyToProfile(repoPolicy(), {
      projectId: "mini-commerce",
      policyTemplate: "strict-monorepo-v1",
    });
    const catalog = profile.domains.find((d) => d.id === "apps/catalog");
    expect(catalog?.read).toContain("README.md");
    expect(catalog?.read).toContain("apps/catalog/**");
  });

  it("carries domain commands across", () => {
    const profile = migratePolicyToProfile(repoPolicy(), {
      projectId: "mini-commerce",
      policyTemplate: "strict-monorepo-v1",
    });
    const catalog = profile.domains.find((d) => d.id === "apps/catalog");
    expect(catalog?.commands?.allow).toHaveLength(1);
  });

  it("embeds repo.path when given", () => {
    const profile = migratePolicyToProfile(repoPolicy(), {
      projectId: "mini-commerce",
      policyTemplate: "strict-monorepo-v1",
      repoPath: "../mini-commerce",
    });
    expect(profile.repo.path).toBe("../mini-commerce");
  });

  it("preserves an empty write scope verbatim (does not fall back to a template default)", () => {
    const profile = migratePolicyToProfile(
      repoPolicy({
        read: [],
        domains: {
          "apps/locked": { read: [], write: [], deny_write: ["**"] },
        },
      }),
      { projectId: "x", policyTemplate: "strict-monorepo-v1" },
    );
    const locked = profile.domains.find((d) => d.id === "apps/locked");
    // an explicit `[]` must be present so the compiler keeps it non-writable.
    expect(locked?.write).toEqual([]);
  });

  it("rejects a policy whose globs are unsafe for a profile", () => {
    expect(() =>
      migratePolicyToProfile(
        repoPolicy({
          domains: {
            "apps/x": { read: [], write: ["../escape/**"], deny_write: [] },
          },
        }),
        { projectId: "x", policyTemplate: "strict-monorepo-v1" },
      ),
    ).toThrow(ProjectProfileError);
  });
});
