import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectProfile } from "../../../src/project/profile-loader.js";
import { ProjectProfileError } from "../../../src/project/errors.js";

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-pl-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const VALID = [
  "version: 1",
  "project_id: demo",
  "repo:",
  "  id: demo",
  "  path: ../demo",
  "domains:",
  "  - id: apps/web",
  "    root: apps/web",
  "",
].join("\n");

describe("loadProjectProfile", () => {
  it("loads and validates a valid profile", async () => {
    const profile = await loadProjectProfile(tmpFile("demo.yaml", VALID));
    expect(profile.project_id).toBe("demo");
    expect(profile.domains).toHaveLength(1);
    expect(profile.domains[0]?.id).toBe("apps/web");
  });

  it("throws ProjectProfileError for a missing file", async () => {
    await expect(
      loadProjectProfile(join(tmpdir(), "does-not-exist-xyz.yaml")),
    ).rejects.toThrow(ProjectProfileError);
  });

  it("throws ProjectProfileError for malformed YAML", async () => {
    const path = tmpFile("bad.yaml", "version: 1\n  bad: : :\n");
    await expect(loadProjectProfile(path)).rejects.toThrow(
      ProjectProfileError,
    );
  });

  it("throws ProjectProfileError for a schema violation with a readable message", async () => {
    const path = tmpFile(
      "invalid.yaml",
      ["version: 1", "project_id: ../escape", "repo:", "  id: demo", "domains: []", ""].join(
        "\n",
      ),
    );
    await expect(loadProjectProfile(path)).rejects.toThrow(
      /failed validation/,
    );
  });
});
