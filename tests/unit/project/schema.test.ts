import { describe, it, expect } from "vitest";
import { ProjectProfileSchema } from "../../../src/project/schema.js";

function validProfile(): unknown {
  return {
    version: 1,
    project_id: "demo",
    description: "a demo project",
    repo: { id: "demo", path: "../demo", base_branch: "main" },
    domains: [
      { id: "apps/web", root: "apps/web", kind: "app" },
      { id: "packages/ui", root: "packages/ui", kind: "package" },
    ],
  };
}

describe("ProjectProfileSchema", () => {
  it("E5-1-1: parses a valid profile", () => {
    const r = ProjectProfileSchema.safeParse(validProfile());
    expect(r.success).toBe(true);
  });

  it("accepts inline context packs and command presets", () => {
    const p = validProfile() as Record<string, unknown>;
    p.context_packs = {
      "default-docs": { globs: ["README.md", "docs/**/*.md"], max_bytes: 1024 },
    };
    p.commands = { presets: ["node-basic-v1"] };
    (p.domains as Array<Record<string, unknown>>)[0]!.context_packs = [
      "default-docs",
    ];
    expect(ProjectProfileSchema.safeParse(p).success).toBe(true);
  });

  it("accepts a project profile mcp section", () => {
    const p = validProfile() as Record<string, unknown>;
    p.mcp = {
      defaultMode: "read-only",
      allowedProjects: ["demo"],
    };
    expect(ProjectProfileSchema.safeParse(p).success).toBe(true);
  });

  it("accepts an optional profile review section", () => {
    const p = validProfile() as Record<string, unknown>;
    p.review = {
      mode: "consensus",
      requirements: [
        {
          group: "humans",
          min_approvals: 1,
          blocking_decisions: ["changes_requested", "rejected"],
          reviewer_ids: ["alice"],
          lens_axes: ["correctness"],
          max_reviewers: 1,
        },
      ],
      overrides: { allowed_reviewers: ["lead"], require_reason: true },
      stale_proposal: { reject_superseded: true, max_age_hours: 24 },
    };
    expect(ProjectProfileSchema.safeParse(p).success).toBe(true);
  });

  it("rejects unknown keys in the profile review section", () => {
    const p = validProfile() as Record<string, unknown>;
    p.review = { mode: "latest-proposal", count: 2 };
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects invalid review quorum shape", () => {
    const p = validProfile() as Record<string, unknown>;
    p.review = {
      mode: "consensus",
      requirements: [
        {
          group: "humans",
          min_approvals: 1,
          blocking_decisions: ["changes_requested"],
          quorum: { min_participants: 0 },
        },
      ],
    };
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects an unknown top-level key (strict)", () => {
    const p = validProfile() as Record<string, unknown>;
    p.extra = true;
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects version other than 1", () => {
    const p = validProfile() as Record<string, unknown>;
    p.version = 2;
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("E5-1-2: rejects an unsafe project_id", () => {
    for (const bad of ["../foo", "foo/bar", "..", "", "foo\\bar"]) {
      const p = validProfile() as Record<string, unknown>;
      p.project_id = bad;
      expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
    }
  });

  it("rejects an unsafe repo.id", () => {
    const p = validProfile() as Record<string, unknown>;
    (p.repo as Record<string, unknown>).id = "../escape";
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("E5-1-3: rejects an unsafe domain id", () => {
    for (const bad of [
      "/apps/web",
      "apps/../web",
      "apps//web",
      "apps/web/",
      "apps\\web",
      "",
    ]) {
      const p = validProfile() as Record<string, unknown>;
      (p.domains as Array<Record<string, unknown>>)[0]!.id = bad;
      expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
    }
  });

  it("allows a slash in domain id (backward compat)", () => {
    const p = validProfile() as Record<string, unknown>;
    (p.domains as Array<Record<string, unknown>>)[0]!.id = "apps/user/api";
    (p.domains as Array<Record<string, unknown>>)[0]!.root = "apps/user/api";
    expect(ProjectProfileSchema.safeParse(p).success).toBe(true);
  });

  it("E5-1-4: rejects an unsafe domain root", () => {
    for (const bad of ["../../etc", "/abs/path", "apps/../x"]) {
      const p = validProfile() as Record<string, unknown>;
      (p.domains as Array<Record<string, unknown>>)[0]!.root = bad;
      expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
    }
  });

  it("E5-1-5: rejects an unsafe glob in domain scopes", () => {
    const p = validProfile() as Record<string, unknown>;
    (p.domains as Array<Record<string, unknown>>)[0]!.write = ["../escape/**"];
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects an unsafe glob in a context pack", () => {
    const p = validProfile() as Record<string, unknown>;
    p.context_packs = { x: { globs: ["/etc/passwd"] } };
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects duplicate domain ids", () => {
    const p = validProfile() as Record<string, unknown>;
    p.domains = [
      { id: "apps/web", root: "apps/web" },
      { id: "apps/web", root: "apps/web2" },
    ];
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects duplicate domain roots", () => {
    const p = validProfile() as Record<string, unknown>;
    p.domains = [
      { id: "apps/web", root: "apps/web" },
      { id: "apps/web2", root: "apps/web" },
    ];
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects an empty domains array", () => {
    const p = validProfile() as Record<string, unknown>;
    p.domains = [];
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("allows repo.path to contain '..' (it is a filesystem path)", () => {
    const r = ProjectProfileSchema.safeParse(validProfile());
    expect(r.success).toBe(true);
  });

  it("rejects a NUL byte in repo.path", () => {
    const p = validProfile() as Record<string, unknown>;
    (p.repo as Record<string, unknown>).path = "foo\0bar";
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects a glob whose brace expansion escapes the repo", () => {
    const p = validProfile() as Record<string, unknown>;
    (p.domains as Array<Record<string, unknown>>)[0]!.read = ["{..,docs}/**"];
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("accepts a safe brace-expanded glob", () => {
    const p = validProfile() as Record<string, unknown>;
    (p.domains as Array<Record<string, unknown>>)[0]!.read = [
      "{docs,packages}/**",
    ];
    expect(ProjectProfileSchema.safeParse(p).success).toBe(true);
  });

  it("rejects a '.' segment in a domain root (canonical alias)", () => {
    const p = validProfile() as Record<string, unknown>;
    (p.domains as Array<Record<string, unknown>>)[0]!.root = "apps/./web";
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });

  it("rejects a '.' segment in a glob", () => {
    const p = validProfile() as Record<string, unknown>;
    (p.domains as Array<Record<string, unknown>>)[0]!.write = ["apps/./web/**"];
    expect(ProjectProfileSchema.safeParse(p).success).toBe(false);
  });
});
