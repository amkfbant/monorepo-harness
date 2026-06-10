import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyGuarded } from "../../src/core/verify-guarded.js";
import type { ProjectProfile } from "../../src/project/schema.js";

function git(repo: string, args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "pipe" });
}

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "harness-vg-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "base.ts"), "export const x = 1;\n");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "base.md"), "# base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
}

const profile = {
  version: 1,
  project_id: "p",
  repo: { id: "p" },
  domains: [{ id: "src", root: "src", write: ["src/**"] }],
} as ProjectProfile;

describe("verifyGuarded (#69, integration)", () => {
  it("ok when the working tree is clean", () => {
    const repo = setupRepo();
    expect(verifyGuarded({ profile, repo }).ok).toBe(true);
  });

  it("fails closed on an uncommitted edit to a tracked guarded path", () => {
    const repo = setupRepo();
    writeFileSync(join(repo, "src", "base.ts"), "export const x = 2;\n");
    const r = verifyGuarded({ profile, repo });
    expect(r.ok).toBe(false);
    expect(r.violations).toContain("src/base.ts");
  });

  it("fails closed on a new untracked file in a guarded path", () => {
    const repo = setupRepo();
    writeFileSync(join(repo, "src", "new.ts"), "export const y = 1;\n");
    const r = verifyGuarded({ profile, repo });
    expect(r.ok).toBe(false);
    expect(r.violations).toContain("src/new.ts");
  });

  it("ignores uncommitted changes outside any guarded scope", () => {
    const repo = setupRepo();
    writeFileSync(join(repo, "docs", "base.md"), "# changed\n");
    expect(verifyGuarded({ profile, repo }).ok).toBe(true);
  });

  it("a guarded change committed through the harness flow is no longer flagged", () => {
    const repo = setupRepo();
    writeFileSync(join(repo, "src", "base.ts"), "export const x = 3;\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "fix: change"]);
    // Committed (clean tree) — the working-tree gate passes.
    expect(verifyGuarded({ profile, repo }).ok).toBe(true);
  });
});
