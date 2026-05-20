import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  loadGlobalPolicy,
  loadRepoPolicy,
} from "../../../src/policy/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIX = (n: string) => join(__dirname, "../../fixtures/policies", n);

describe("loadGlobalPolicy", () => {
  it("loads a valid YAML", async () => {
    const p = await loadGlobalPolicy(FIX("global.ok.yaml"));
    expect(p.always_deny_write).toContain(".git/**");
  });
});

describe("loadRepoPolicy", () => {
  it("loads a valid repo policy", async () => {
    const p = await loadRepoPolicy(FIX("repo.ok.yaml"));
    expect(p.repo_id).toBe("sample-monorepo");
  });

  it("throws on invalid YAML (missing repo_id)", async () => {
    await expect(loadRepoPolicy(FIX("repo.bad.yaml"))).rejects.toThrow(
      /repo_id/,
    );
  });
});
