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
  // hermetic: the collectDiff fixtures have no remote — skip the best-effort fetch
  return await resolveBaseSha({
    repoPath: repo,
    baseBranch: "main",
    fetchRemote: false,
  });
}

function git(cwd: string, a: string[]): string {
  return execFileSync("git", a, { cwd, encoding: "utf8" });
}

describe("resolveBaseSha", () => {
  it("returns the SHA of the given ref (local, no fetch)", async () => {
    const sha = await baseSha();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("prefers origin/<base> over a STALE local <base> (#154)", async () => {
    // a bare remote + a clone; advance origin/main beyond the clone's local main
    const bare = mkdtempSync(join(tmpdir(), "harness-base-bare-")) + ".git";
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    const staleLocal = git(repo, ["rev-parse", "main"]).trim();

    // a second clone advances origin/main (simulating merges landing remotely)
    const other = mkdtempSync(join(tmpdir(), "harness-base-other-"));
    git(other, ["clone", "-q", bare, "."]);
    git(other, ["config", "user.email", "t@e.com"]);
    git(other, ["config", "user.name", "T"]);
    writeFileSync(join(other, "advanced.ts"), "export const x = 1;\n");
    git(other, ["add", "."]);
    git(other, ["commit", "-qm", "advance origin/main"]);
    git(other, ["push", "-q", "origin", "main"]);
    const remoteTip = git(other, ["rev-parse", "main"]).trim();

    // resolveBaseSha (fetch=default) must return the REMOTE tip, not stale local
    const resolved = await resolveBaseSha({ repoPath: repo, baseBranch: "main" });
    expect(resolved).toBe(remoteTip);
    expect(resolved).not.toBe(staleLocal);
  });

  it("on fetch failure, prefers the LOCAL branch over a STALE origin/<base> ref (codex P1)", async () => {
    // origin/main exists locally (from the push), then origin becomes unreachable
    // and local main advances. resolveBaseSha must NOT prefer the now-stale
    // origin/main remote-tracking ref — it should resolve the fresh local main.
    const bare = mkdtempSync(join(tmpdir(), "harness-base-stale-")) + ".git";
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    const staleOrigin = git(repo, ["rev-parse", "refs/remotes/origin/main"]).trim();
    // break the remote so the best-effort fetch fails
    git(repo, ["remote", "set-url", "origin", "/nonexistent/repo.git"]);
    // local main advances beyond the stale origin/main
    writeFileSync(join(repo, "local-advance.ts"), "export const a = 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "local advance"]);
    const localTip = git(repo, ["rev-parse", "main"]).trim();
    expect(localTip).not.toBe(staleOrigin);

    const resolved = await resolveBaseSha({ repoPath: repo, baseBranch: "main" });
    expect(resolved).toBe(localTip);
    expect(resolved).not.toBe(staleOrigin);
  });

  it("swallows a best-effort fetch failure when there is no remote at all", async () => {
    // no `origin` remote configured; fetchRemote defaults true → the fetch fails
    // and must be ignored, resolving the local main.
    const localMain = git(repo, ["rev-parse", "main"]).trim();
    const resolved = await resolveBaseSha({ repoPath: repo, baseBranch: "main" });
    expect(resolved).toBe(localMain);
  });

  it("passes a raw 40-hex SHA through (no fetch, no remote candidate)", async () => {
    const sha = git(repo, ["rev-parse", "main"]).trim();
    const resolved = await resolveBaseSha({ repoPath: repo, baseBranch: sha });
    expect(resolved).toBe(sha);
  });

  it("rejects a rev-expression / refspec base name (no silent resolution)", async () => {
    await expect(
      resolveBaseSha({ repoPath: repo, baseBranch: "main~1" }),
    ).rejects.toThrow(/invalid base branch "main~1"/);
    await expect(
      resolveBaseSha({ repoPath: repo, baseBranch: "--output=/tmp/x" }),
    ).rejects.toThrow(/invalid base branch/);
  });

  it("rejects pseudo-refs (HEAD / @ / FETCH_HEAD) as a base branch", async () => {
    // HEAD would otherwise resolve via refs/remotes/origin/HEAD (default-branch
    // symref); @/FETCH_HEAD/ORIG_HEAD resolve transient state — none is a branch.
    for (const name of ["HEAD", "@", "FETCH_HEAD", "ORIG_HEAD"]) {
      await expect(
        resolveBaseSha({ repoPath: repo, baseBranch: name }),
      ).rejects.toThrow(/invalid base branch/);
    }
  });

  it("resolves a LOCAL-only base branch via the local candidate when origin lacks it (#195a)", async () => {
    const bare = mkdtempSync(join(tmpdir(), "harness-base-bare2-")) + ".git";
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);
    // a local-only branch never pushed to origin
    git(repo, ["checkout", "-q", "-b", "feat/local-only"]);
    writeFileSync(join(repo, "local.ts"), "export const l = 1;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "local-only work"]);
    const localTip = git(repo, ["rev-parse", "feat/local-only"]).trim();
    git(repo, ["checkout", "-q", "main"]);

    const resolved = await resolveBaseSha({
      repoPath: repo,
      baseBranch: "feat/local-only",
    });
    expect(resolved).toBe(localTip);
  });

  it("fails fast (no silent fallback) when the base branch resolves nowhere (#195)", async () => {
    const bare = mkdtempSync(join(tmpdir(), "harness-base-bare3-")) + ".git";
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "-q", "-u", "origin", "main"]);

    await expect(
      resolveBaseSha({ repoPath: repo, baseBranch: "does-not-exist" }),
    ).rejects.toThrow(/cannot resolve base branch "does-not-exist"/);
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
    expect(d.stat).toEqual({
      filesChanged: 1,
      insertions: 1,
      deletions: 1,
      deletedFiles: 0,
    });
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

  it("surfaces a rename as delete + add (--no-renames), not a collapsed single file", async () => {
    // SECURITY: rename detection would collapse a rename to the destination
    // path only, hiding the SOURCE deletion. `--no-renames` makes collectDiff
    // report both sides, so a coder cannot delete an out-of-scope file by
    // renaming it into scope without the source deletion surfacing to policy.
    execFileSync("git", ["mv", "apps/user/a.ts", "apps/user/renamed.ts"], {
      cwd: repo,
    });
    const d = await collectDiff({ repoPath: repo, baseSha: await baseSha() });

    // a.ts (1 line) deleted + renamed.ts (1 line) added — two distinct paths.
    expect(d.trackedChangedPaths.sort()).toEqual([
      "apps/user/a.ts",
      "apps/user/renamed.ts",
    ]);
    expect(d.stat).toEqual({
      filesChanged: 2,
      insertions: 1,
      deletions: 1,
      deletedFiles: 1,
    });
  });

  it("surfaces an out-of-scope rename source so policy can catch the deletion", async () => {
    // The threat: rename an OUT-OF-SCOPE tracked file into an in-scope path.
    // With --no-renames the out-of-scope source appears as a tracked deletion,
    // so write-scope validation (which consumes trackedChangedPaths) sees it.
    mkdirSync(join(repo, "outside"), { recursive: true });
    writeFileSync(join(repo, "outside/secret.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "add out-of-scope file"], {
      cwd: repo,
    });
    const base = await baseSha();
    execFileSync("git", ["mv", "outside/secret.ts", "apps/user/pulled-in.ts"], {
      cwd: repo,
    });
    const d = await collectDiff({ repoPath: repo, baseSha: base });
    expect(d.trackedChangedPaths).toContain("outside/secret.ts");
    expect(d.trackedChangedPaths).toContain("apps/user/pulled-in.ts");
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
