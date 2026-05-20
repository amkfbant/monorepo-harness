import { describe, it, expect, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff, resolveBaseSha } from "../../src/git/diff.js";

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

async function baseSha(): Promise<string> {
  return await resolveBaseSha({ repoPath: repo, baseBranch: "main" });
}

describe("resolveBaseSha", () => {
  it("returns the SHA of the given ref", async () => {
    const sha = await baseSha();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("collectDiff", () => {
  it("separates tracked changes from untracked files", async () => {
    writeFileSync(join(repo, "apps/user/a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "apps/user/b.ts"), "export const b = 1;\n");
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });
    expect(d.trackedChangedPaths).toEqual(["apps/user/a.ts"]);
    expect(d.untrackedPaths).toEqual(["apps/user/b.ts"]);
    expect(d.patch).toMatch(/\+export const a = 2;/);
    expect(d.patch).not.toMatch(/apps\/user\/b\.ts/);
  });

  it("returns empty patch and empty lists when nothing changed", async () => {
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });
    expect(d.trackedChangedPaths).toEqual([]);
    expect(d.untrackedPaths).toEqual([]);
    expect(d.patch).toBe("");
  });

  it("does not pollute the index with intent-to-add markers", async () => {
    writeFileSync(join(repo, "apps/user/b.ts"), "export const b = 1;\n");
    await collectDiff({ repoPath: repo, baseSha: await baseSha() });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repo,
    })
      .toString()
      .trim();
    expect(staged).toBe("");
  });

  it("captures deletes as tracked changes", async () => {
    rmSync(join(repo, "apps/user/a.ts"));
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });
    expect(d.trackedChangedPaths).toEqual(["apps/user/a.ts"]);
    expect(d.untrackedPaths).toEqual([]);
  });

  it("returns .gitignore'd files in untrackedPaths (harness applies its own filter)", async () => {
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repo, "ignored.txt"), "secret\n");
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });
    expect(d.untrackedPaths).toContain("ignored.txt");
  });
});
