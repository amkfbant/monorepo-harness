import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOnboard } from "../../src/cli/onboard.js";
import { scriptedPrompts } from "../../src/onboard/prompts.js";

const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true }); });

function repoRoot(): { repo: string; root: string } {
  const repo = mkdtempSync(join(tmpdir(), "onb-cli-repo-")); tmps.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  // a node monorepo so domain inspection selects apps/* (matches the steps test)
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "r", workspaces: ["apps/*"] }));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "package.json"), JSON.stringify({ name: "web" }));
  writeFileSync(join(repo, "apps", "web", "i.ts"), "export const x=1;\n");
  const root = mkdtempSync(join(tmpdir(), "onb-cli-root-")); tmps.push(root);
  mkdirSync(join(root, ".harness"), { recursive: true });
  // copy template catalogs so runProjectInit can find domain registries
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), { recursive: true });
  return { repo, root };
}

describe("runOnboard", () => {
  it("drives the steps to completion with injected prompts (write profile=y, no mutations=n)", async () => {
    const { repo, root } = repoRoot();
    const result = await runOnboard({
      harnessRoot: root, repoPath: repo, projectId: "demo",
      isTTY: true, prompts: scriptedPrompts(["y", "n"]), // confirm write, decline mutations
    });
    expect(result.completed).toBe(true);
    expect(existsSync(join(root, "projects", "demo.yaml"))).toBe(true);
    expect(existsSync(join(root, ".harness", "mcp.yaml"))).toBe(true);
  });

  it("fails closed (no prompting) when not a TTY", async () => {
    const { repo, root } = repoRoot();
    await expect(
      runOnboard({ harnessRoot: root, repoPath: repo, projectId: "demo", isTTY: false, prompts: scriptedPrompts([]) }),
    ).rejects.toThrow(/not a TTY|interactive|non-interactive/i);
  });
});
