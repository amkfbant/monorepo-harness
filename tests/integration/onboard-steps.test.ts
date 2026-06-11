import { afterEach, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildOnboardSteps } from "../../src/onboard/step-impls.js";
import { scriptedPrompts } from "../../src/onboard/prompts.js";
import type { OnboardCtx } from "../../src/onboard/steps.js";

const tmps: string[] = [];
afterEach(() => { for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true }); });

function miniRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "onb-repo-")); tmps.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  // root package.json triggers node-monorepo-default-v1 registry (apps/* pattern)
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root", workspaces: ["apps/*"] }));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(join(repo, "apps", "web", "package.json"), JSON.stringify({ name: "@demo/web" }));
  writeFileSync(join(repo, "apps", "web", "index.ts"), "export const x = 1;\n");
  return repo;
}

function ctxFor(answers: string[]): OnboardCtx {
  const root = mkdtempSync(join(tmpdir(), "onb-root-")); tmps.push(root);
  mkdirSync(join(root, ".harness"), { recursive: true });
  // copy real template catalogs so runProjectInit can resolve policy templates
  cpSync(join(process.cwd(), "templates"), join(root, "templates"), { recursive: true });
  return {
    harnessRoot: root, repoPath: miniRepo(), projectId: "demo",
    prompts: scriptedPrompts(answers), log: [],
  };
}

describe("onboard steps (integration)", () => {
  it("profile+policy step writes the profile, repo policy, and global.yaml", async () => {
    const ctx = ctxFor(["y"]); // confirm write
    const profileStep = buildOnboardSteps().find((s) => s.id === "profile")!;
    const res = await profileStep.run(ctx);
    expect(res.ok).toBe(true);
    expect(existsSync(join(ctx.harnessRoot, "projects", "demo.yaml"))).toBe(true);
    expect(existsSync(join(ctx.harnessRoot, "policies", "global.yaml"))).toBe(true);
    expect(profileStep.probe(ctx)).toBe("done");
  });

  it("mcp step merges the project and, on starter opt-in, writes a guarded-mutation client", async () => {
    // answers: enable-starter=y, client-name=codex, goal.start=y, run.start=n
    const ctx = ctxFor(["y", "codex", "y", "n"]);
    mkdirSync(join(ctx.harnessRoot, "projects"), { recursive: true });
    writeFileSync(join(ctx.harnessRoot, "projects", "demo.yaml"),
      "version: 1\nproject_id: demo\nrepo:\n  id: demo\ndomains:\n  - { id: web, root: apps/web }\n");
    const mcpStep = buildOnboardSteps().find((s) => s.id === "mcp")!;
    const res = await mcpStep.run(ctx);
    expect(res.ok).toBe(true);
    const cfg = parseYaml(readFileSync(join(ctx.harnessRoot, ".harness", "mcp.yaml"), "utf8")).mcp;
    expect(cfg.allowedProjects).toContain("demo");
    expect(cfg.clients).toEqual([{ id: "codex", names: ["codex"], mode: "guarded-mutation" }]);
    expect(cfg.allowedOperations).toEqual(["goal.start"]); // run.start declined
  });

  it("check step returns ok=false (stops the wizard) when the profile is uncompilable", async () => {
    const ctx = ctxFor([]);
    mkdirSync(join(ctx.harnessRoot, "projects"), { recursive: true });
    // reference a non-existent policy template to cause a compile error → status "error"
    writeFileSync(join(ctx.harnessRoot, "projects", "demo.yaml"),
      "version: 1\nproject_id: demo\nrepo:\n  id: demo\n  path: " + ctx.repoPath +
      "\npolicy:\n  template: nonexistent-template-v99\ndomains:\n  - { id: web, root: apps/web }\n");
    const checkStep = buildOnboardSteps().find((s) => s.id === "check")!;
    const res = await checkStep.run(ctx);
    expect(res.ok).toBe(false);
    expect(res.remediation).toMatch(/fix the profile/i);
  });
});
