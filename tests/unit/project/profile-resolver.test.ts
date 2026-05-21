import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveProjectProfile,
  loadProjectById,
} from "../../../src/project/profile-resolver.js";
import { ProjectNotFoundError } from "../../../src/project/errors.js";

function profileYaml(repoPath: string | null): string {
  const lines = ["version: 1", "project_id: demo", "repo:", "  id: demo"];
  if (repoPath !== null) lines.push(`  path: ${repoPath}`);
  lines.push("domains:", "  - id: apps/web", "    root: apps/web", "");
  return lines.join("\n");
}

describe("resolveProjectProfile", () => {
  it("resolves a relative repo path against the profile file's directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-pr-"));
    const path = join(dir, "demo.yaml");
    writeFileSync(path, profileYaml("../target-repo"));
    const r = await resolveProjectProfile(path);
    expect(r.repoPath).toBe(resolve(dir, "../target-repo"));
    expect(r.profilePath).toBe(path);
  });

  it("uses an absolute repo path as-is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-pr-"));
    const path = join(dir, "demo.yaml");
    writeFileSync(path, profileYaml("/abs/target"));
    const r = await resolveProjectProfile(path);
    expect(r.repoPath).toBe("/abs/target");
  });

  it("lets a --repo override win over repo.path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-pr-"));
    const path = join(dir, "demo.yaml");
    writeFileSync(path, profileYaml("../target-repo"));
    const r = await resolveProjectProfile(path, {
      repoOverride: "/override/repo",
    });
    expect(r.repoPath).toBe("/override/repo");
  });

  it("yields repoPath=null when repo.path is absent and no override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-pr-"));
    const path = join(dir, "demo.yaml");
    writeFileSync(path, profileYaml(null));
    const r = await resolveProjectProfile(path);
    expect(r.repoPath).toBeNull();
  });
});

describe("loadProjectById", () => {
  it("resolves projects/<id>.yaml under the harness root", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-pr-root-"));
    mkdirSync(join(root, "projects"), { recursive: true });
    writeFileSync(
      join(root, "projects", "demo.yaml"),
      profileYaml("../target-repo"),
    );
    const r = await loadProjectById(root, "demo");
    expect(r.profile.project_id).toBe("demo");
  });

  it("throws ProjectNotFoundError when the profile is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-pr-root-"));
    await expect(loadProjectById(root, "missing")).rejects.toThrow(
      ProjectNotFoundError,
    );
  });

  it("rejects an unsafe project id before touching the filesystem", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-pr-root-"));
    await expect(loadProjectById(root, "../escape")).rejects.toThrow(
      /invalid repo id/,
    );
  });
});
