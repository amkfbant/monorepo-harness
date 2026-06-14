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
    expect(d.stat).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 1,
      deletedFiles: 0,
    });
    expect(d.patch).toMatch(/\+export const a = 2;/);
    expect(d.patch).not.toMatch(/apps\/user\/b\.ts/);
  });

  it("returns empty patch and empty lists when nothing changed", async () => {
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });
    expect(d.trackedChangedPaths).toEqual([]);
    expect(d.stagedChangedPaths).toEqual([]);
    expect(d.untrackedPaths).toEqual([]);
    expect(d.stat).toEqual({
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      deletedFiles: 0,
    });
    expect(d.patch).toBe("");
  });

  it("reports staged index changes separately from the working tree diff", async () => {
    writeFileSync(join(repo, "apps/user/a.ts"), "export const a = 2;\n");
    execFileSync("git", ["add", "apps/user/a.ts"], { cwd: repo });
    writeFileSync(join(repo, "apps/user/a.ts"), "export const a = 1;\n");

    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });

    expect(d.trackedChangedPaths).toEqual([]);
    expect(d.stagedChangedPaths).toEqual(["apps/user/a.ts"]);
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
    expect(d.stat).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 1,
      deletedFiles: 1,
    });
  });

  it("counts multi-line truncation and exact deleted-file totals", async () => {
    writeFileSync(join(repo, "apps/user/multi.ts"), "a\nb\nc\nd\n");
    execFileSync("git", ["add", "apps/user/multi.ts"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add multi"], { cwd: repo });

    writeFileSync(join(repo, "apps/user/multi.ts"), "a\n");
    rmSync(join(repo, "apps/user/a.ts"));
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });

    expect(d.stat).toEqual({
      filesChanged: 2,
      insertions: 0,
      deletions: 4,
      deletedFiles: 1,
    });
  });

  it("parses rename numstat output as a single changed file", async () => {
    execFileSync("git", ["mv", "apps/user/a.ts", "apps/user/renamed.ts"], {
      cwd: repo,
    });
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });

    expect(d.stat).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
      deletedFiles: 0,
    });
  });

  it("counts binary files as changed files without line additions or deletions", async () => {
    writeFileSync(join(repo, "apps/user/blob.bin"), Buffer.from([0, 1, 2]));
    execFileSync("git", ["add", "apps/user/blob.bin"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add binary"], { cwd: repo });

    writeFileSync(join(repo, "apps/user/blob.bin"), Buffer.from([0, 1, 2, 3]));
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });

    expect(d.stat).toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
      deletedFiles: 0,
    });
  });

  it("returns .gitignore'd files in untrackedPaths (harness applies its own filter)", async () => {
    writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(repo, "ignored.txt"), "secret\n");
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });
    expect(d.untrackedPaths).toContain("ignored.txt");
  });

  it("does NOT invoke a per-repo external diff driver during collection", async () => {
    // If --no-ext-diff is missing, this driver would run (and fail), so
    // collectDiff would throw. With the safety flag, the driver is ignored.
    execFileSync(
      "git",
      ["config", "diff.malicious.command", "sh -c 'exit 77'"],
      { cwd: repo },
    );
    writeFileSync(join(repo, ".gitattributes"), "*.ts diff=malicious\n");
    writeFileSync(join(repo, "apps/user/a.ts"), "export const a = 2;\n");
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });
    expect(d.trackedChangedPaths).toContain("apps/user/a.ts");
    expect(d.patch).toMatch(/\+export const a = 2;/);
  });
});
