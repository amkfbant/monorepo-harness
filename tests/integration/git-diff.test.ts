import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "../../src/git/diff.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "harness-diff-"));
  const r = (a: string[]) =>
    execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  r(["init", "-q", "-b", "main"]);
  r(["config", "user.email", "t@e.com"]);
  r(["config", "user.name", "T"]);
  mkdirSync(join(repo, "apps/user"), { recursive: true });
  writeFileSync(join(repo, "apps/user/a.ts"), "export const a = 1;\n");
  r(["add", "."]);
  r(["commit", "-qm", "init"]);
});

describe("collectDiff", () => {
  it("returns changed file list and full patch for working tree changes", async () => {
    writeFileSync(join(repo, "apps/user/a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "apps/user/b.ts"), "export const b = 1;\n");
    const d = await collectDiff({ repoPath: repo, baseBranch: "main" });
    expect(d.changedPaths.sort()).toEqual([
      "apps/user/a.ts",
      "apps/user/b.ts",
    ]);
    expect(d.patch).toMatch(/\+export const a = 2;/);
    expect(d.patch).toMatch(/apps\/user\/b\.ts/);
  });

  it("returns empty patch when there are no changes", async () => {
    const d = await collectDiff({ repoPath: repo, baseBranch: "main" });
    expect(d.changedPaths).toEqual([]);
    expect(d.patch).toBe("");
  });
});
