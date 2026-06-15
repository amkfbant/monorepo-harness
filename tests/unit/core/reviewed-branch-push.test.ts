import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGitPathList,
  assertPathsSubset,
  assertNoObjectGraphTampering,
  pushReviewedBranchForEscalation,
} from "../../../src/core/reviewed-branch-push.js";
import { computeReviewedFingerprint } from "../../../src/core/reviewed-fingerprint.js";

describe("parseGitPathList (git diff -z parsing)", () => {
  it("splits NUL-terminated paths and preserves leading/trailing whitespace", () => {
    // `git diff -z --name-only` emits NUL-terminated paths with a trailing NUL.
    expect(parseGitPathList("a\0 a\0b/c\0")).toEqual(["a", " a", "b/c"]);
  });

  it("returns an empty list for empty output", () => {
    expect(parseGitPathList("")).toEqual([]);
  });

  it("keeps a whitespace path distinct from a reviewed path (subset gate holds)", () => {
    // Reviewed set is exactly {"a"}; an existing change adds the distinct path
    // " a". With line-trimming this would collapse to "a" and slip past the
    // gate; with exact NUL parsing it must be rejected as unreviewed.
    const reviewed = ["a"];
    const changed = parseGitPathList("a\0 a\0");
    expect(() => assertPathsSubset(changed, reviewed, "branch diff")).toThrow(
      /unreviewed path/,
    );
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A throwaway git repo with one commit. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-objgraph-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@e.com"]);
  git(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, "f.txt"), "v0\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

const GIT = { timeoutMs: 30_000 };

describe("assertNoObjectGraphTampering (push-gate object-graph guard)", () => {
  it("passes on a clean repo", async () => {
    const dir = makeRepo();
    await expect(
      assertNoObjectGraphTampering({
        git: { cwd: dir, ...GIT },
        runId: "run-clean",
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a repo carrying a refs/replace/* ref", async () => {
    const dir = makeRepo();
    const real = git(dir, ["rev-parse", "HEAD"]).trim();
    // a sanitized sibling commit to replace the real one with
    git(dir, ["checkout", "-q", "--orphan", "san"]);
    writeFileSync(join(dir, "f.txt"), "sanitized\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "sanitized"]);
    const san = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["replace", real, san]);

    await expect(
      assertNoObjectGraphTampering({
        git: { cwd: dir, ...GIT },
        runId: "run-replace",
      }),
    ).rejects.toThrow(/replace ref.*object-graph tampering/s);
  });

  it("refuses a replace ref targeting a NON-head (ancestor) object", async () => {
    // The for-each-ref glob has no SHA filter, so a replace ref aimed at an
    // ancestor on base..HEAD is caught too — lock that blanket coverage.
    const dir = makeRepo();
    const root = git(dir, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(dir, "f.txt"), "v1\n");
    git(dir, ["commit", "-aqm", "c1"]); // HEAD is now c1; root is the ancestor
    // sanitized sibling (same tree, different message) via plumbing
    const tree = git(dir, ["rev-parse", "HEAD^{tree}"]).trim();
    const san = git(dir, ["commit-tree", tree, "-m", "san"]).trim();
    git(dir, ["replace", root, san]); // replace the ANCESTOR, not HEAD

    await expect(
      assertNoObjectGraphTampering({
        git: { cwd: dir, ...GIT },
        runId: "run-replace-ancestor",
      }),
    ).rejects.toThrow(/replace ref.*object-graph tampering/s);
  });

  it("refuses a repo carrying an info/grafts file", async () => {
    const dir = makeRepo();
    const real = git(dir, ["rev-parse", "HEAD"]).trim();
    const graftsPath = git(dir, [
      "rev-parse",
      "--git-path",
      "info/grafts",
    ]).trim();
    // graft the real commit to have no parent (any grafts content triggers)
    writeFileSync(join(dir, graftsPath), `${real}\n`);

    await expect(
      assertNoObjectGraphTampering({
        git: { cwd: dir, ...GIT },
        runId: "run-graft",
      }),
    ).rejects.toThrow(/graft.*object-graph tampering/s);
  });

  it("refuses a shallow repository", async () => {
    // upstream with 3 commits, then a depth-1 shallow clone
    const upstream = makeRepo();
    writeFileSync(join(upstream, "f.txt"), "v1\n");
    git(upstream, ["commit", "-aqm", "c1"]);
    writeFileSync(join(upstream, "f.txt"), "v2\n");
    git(upstream, ["commit", "-aqm", "c2"]);
    const cloneParent = mkdtempSync(join(tmpdir(), "harness-shallow-"));
    const clone = join(cloneParent, "clone");
    execFileSync("git", [
      "clone",
      "-q",
      "--depth",
      "1",
      `file://${upstream}`,
      clone,
    ]);

    await expect(
      assertNoObjectGraphTampering({
        git: { cwd: clone, ...GIT },
        runId: "run-shallow",
      }),
    ).rejects.toThrow(/shallow repository.*object-graph tampering/s);
  });
});

interface SalvageFixture {
  root: string;
  runId: string;
  worktree: string;
  bareRemote: string;
}

/**
 * A harness root with one `needs_review` / safetyStatus=`allowed` run ready
 * for the salvage push path (`pushReviewedBranchForEscalation`): a target repo
 * with a bare remote, a run worktree on the run branch with an uncommitted
 * reviewed change, and a meta.json carrying the reviewed fingerprint.
 */
async function setupSalvage(): Promise<SalvageFixture> {
  const root = mkdtempSync(join(tmpdir(), "harness-salvage-"));
  mkdirSync(join(root, "runs"), { recursive: true });
  mkdirSync(join(root, "workspaces"), { recursive: true });

  const target = mkdtempSync(join(tmpdir(), "harness-salvage-target-"));
  git(target, ["init", "-q", "-b", "main"]);
  git(target, ["config", "user.email", "t@e.com"]);
  git(target, ["config", "user.name", "T"]);
  mkdirSync(join(target, "apps/x"), { recursive: true });
  writeFileSync(join(target, "apps/x/f.ts"), "export const v = 0;\n");
  git(target, ["add", "."]);
  git(target, ["commit", "-qm", "init"]);

  const bareRemote =
    mkdtempSync(join(tmpdir(), "harness-salvage-bare-")) + ".git";
  execFileSync("git", ["init", "-q", "--bare", bareRemote]);
  git(target, ["remote", "add", "origin", bareRemote]);
  git(target, ["push", "-q", "-u", "origin", "main"]);

  const runId = "run-20260521-apps-x-salv1";
  const runBranch = `harness/${runId}/apps-x`;
  const worktree = join(root, "workspaces", runId, "repo");
  git(target, ["worktree", "add", "-q", "-b", runBranch, worktree, "main"]);
  // an uncommitted codex change in the worktree
  writeFileSync(join(worktree, "apps/x/f.ts"), "export const v = 1;\n");

  // the run's base SHA — the salvage path validates HEAD against this.
  const baseSha = git(worktree, ["rev-parse", "main"]).trim();

  const runDir = join(root, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const reviewedPaths = ["apps/x/f.ts"];
  const fingerprint = await computeReviewedFingerprint(worktree, reviewedPaths);
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        runId,
        domain: "apps/x",
        status: "needs_review",
        safetyStatus: "allowed",
        runBranch,
        baseSha,
        reviewer: "knkn",
        reviewedAt: "2026-05-21T00:00:00Z",
        reviewed: { paths: reviewedPaths, fingerprint },
        startedAt: "2026-05-21T00:00:00Z",
      },
      null,
      2,
    ),
  );
  writeFileSync(join(runDir, "events.jsonl"), "");
  return { root, runId, worktree, bareRemote };
}

describe("pushReviewedBranchForEscalation (salvage push guard)", () => {
  it("pushes a clean HEAD == base worktree (happy path)", async () => {
    const f = await setupSalvage();
    const r = await pushReviewedBranchForEscalation({
      runsDir: join(f.root, "runs"),
      workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
      runId: f.runId,
    });
    expect(r.committed).toBe(true);
    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).toMatch(/harness\/run-20260521-apps-x-salv1/);
  });

  it("P0: refuses an intermediate reviewed-path commit even when the final content matches the fingerprint", async () => {
    // Regression for the codex P0: an intermediate commit touches ONLY the
    // reviewed path with transient/secret content, then a later commit
    // restores the reviewed content so the working tree matches the recorded
    // fingerprint. The NET branch diff is only reviewed paths and the
    // fingerprint matches, so the fingerprint + branch-diff-subset gates BOTH
    // pass — yet the intermediate (secret) commit is still on the branch. The
    // HEAD == base guard must refuse so that history never reaches origin.
    const f = await setupSalvage();
    // intermediate commit on the reviewed path with transient/secret content
    writeFileSync(
      join(f.worktree, "apps/x/f.ts"),
      'export const TOKEN = "sk-secret-leak";\n',
    );
    git(f.worktree, ["add", "apps/x/f.ts"]);
    git(f.worktree, ["commit", "-qm", "transient secret (reviewed path)"]);
    // restore the reviewed content so the working tree matches the fingerprint
    writeFileSync(join(f.worktree, "apps/x/f.ts"), "export const v = 1;\n");
    git(f.worktree, ["add", "apps/x/f.ts"]);
    git(f.worktree, ["commit", "-qm", "restore reviewed content"]);
    // sanity: the working tree matches the recorded reviewed fingerprint
    const fp = await computeReviewedFingerprint(f.worktree, ["apps/x/f.ts"]);
    const meta = JSON.parse(
      readFileSync(join(f.root, "runs", f.runId, "meta.json"), "utf8"),
    );
    expect(fp).toBe(meta.reviewed.fingerprint);

    await expect(
      pushReviewedBranchForEscalation({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
      }),
    ).rejects.toThrow(
      /has commit history beyond base.*refusing to push unreviewed history/s,
    );

    // the intermediate (secret) commit never reached origin
    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).not.toMatch(/harness\/run-20260521-apps-x-salv1/);
  });

  it("idempotent retry: re-pushes the run's own single reviewed commit without minting a new one", async () => {
    // The MUST-PASS side of the history gate: this run already committed +
    // pushed its single reviewed commit (HEAD == base + 1 clean reviewed
    // commit), then a retry runs. The gate must tolerate it — `git add` stages
    // nothing, no second commit is created, and the same branch re-pushes (no
    // divergent SHA). This locks the no-over-refusal invariant.
    const f = await setupSalvage();
    // simulate the prior successful commit + push of the reviewed commit
    git(f.worktree, ["add", "apps/x/f.ts"]);
    git(f.worktree, ["commit", "-qm", "harness salvage: run-20260521-apps-x-salv1"]);
    const committedSha = git(f.worktree, ["rev-parse", "HEAD"]).trim();
    git(f.worktree, ["push", "-q", "-u", "origin", `harness/${f.runId}/apps-x`]);

    const r = await pushReviewedBranchForEscalation({
      runsDir: join(f.root, "runs"),
      workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
      runId: f.runId,
    });
    // nothing new was committed; the same commit is the branch head.
    expect(r.committed).toBe(false);
    expect(r.headSha).toBe(committedSha);
    const remoteHead = execFileSync(
      "git",
      ["-C", f.bareRemote, "rev-parse", `harness/${f.runId}/apps-x`],
      { encoding: "utf8" },
    ).trim();
    expect(remoteHead).toBe(committedSha);
  });

  it("refuses a one-commit-beyond-base worktree that still has reviewed content to stage", async () => {
    // History-gate ordering (codex P1) for the salvage path: exactly one clean
    // commit beyond base, but an untracked reviewed file remains. A bare
    // count==1 && clean-tracked check passes; `git add` would then stage the
    // untracked reviewed file and mint a SECOND commit onto the first. The
    // post-`git add` stage-nothing invariant must refuse instead.
    const f = await setupSalvage();
    writeFileSync(join(f.worktree, "apps/x/g.ts"), "export const g = 2;\n");
    const reviewedPaths = ["apps/x/f.ts", "apps/x/g.ts"];
    const fingerprint = await computeReviewedFingerprint(f.worktree, reviewedPaths);
    const metaPath = join(f.root, "runs", f.runId, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.reviewed = { paths: reviewedPaths, fingerprint };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    // commit ONLY the tracked reviewed change; leave g.ts untracked. The commit
    // message is the AUTHENTICATED harness salvage message so this exercises the
    // stage-nothing invariant (not the retry-commit message auth, which is
    // covered separately below).
    git(f.worktree, ["add", "apps/x/f.ts"]);
    git(f.worktree, [
      "commit",
      "-qm",
      "harness salvage: run-20260521-apps-x-salv1",
    ]);

    await expect(
      pushReviewedBranchForEscalation({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
      }),
    ).rejects.toThrow(/refusing to add a second commit onto pre-existing history/);

    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).not.toMatch(/harness\/run-20260521-apps-x-salv1/);
  });

  it("object-graph guard: refuses to push when the repo carries a replace ref", async () => {
    // End-to-end wiring: the salvage gate must invoke the object-graph guard so a
    // replace ref (which `git push` would ship the real object for) is rejected
    // before any push. GIT_NO_REPLACE_OBJECTS=1 neutralizes the read view, but the
    // push gate must still refuse outright (defense-in-depth).
    const f = await setupSalvage();
    const head = git(f.worktree, ["rev-parse", "HEAD"]).trim();
    // Install a refs/replace/<head> ref pointing at a sanitized sibling commit
    // (same tree, different message → different SHA), built with `commit-tree`
    // plumbing so the worktree HEAD/branch/index are untouched.
    const tree = git(f.worktree, ["rev-parse", "HEAD^{tree}"]).trim();
    const sanitized = git(f.worktree, [
      "commit-tree",
      tree,
      "-m",
      "sanitized",
    ]).trim();
    git(f.worktree, ["replace", head, sanitized]);

    await expect(
      pushReviewedBranchForEscalation({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
      }),
    ).rejects.toThrow(/replace ref.*object-graph tampering/s);

    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).not.toMatch(/harness\/run-20260521-apps-x-salv1/);
  });

  it("object-graph guard: refuses to push when the repo carries an info/grafts file (end-to-end)", async () => {
    // Graft branch wired through the real salvage push gate (not just the unit
    // test): a grafts file rewrites commit parents and can fool the rev-list
    // history gate, so it must be refused before the push.
    const f = await setupSalvage();
    const head = git(f.worktree, ["rev-parse", "HEAD"]).trim();
    const graftsPath = git(f.worktree, [
      "rev-parse",
      "--git-path",
      "info/grafts",
    ]).trim();
    writeFileSync(graftsPath, `${head}\n`);

    await expect(
      pushReviewedBranchForEscalation({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
      }),
    ).rejects.toThrow(/graft.*object-graph tampering/s);

    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).not.toMatch(/harness\/run-20260521-apps-x-salv1/);
  });

  it("commit-message hook injection: a prepare-commit-msg hook cannot taint the pushed commit message", async () => {
    // A target-repo `prepare-commit-msg` hook that appends a secret to the
    // deterministic `-m` message must NOT reach origin: the mint commits with
    // hooks disabled + verbatim, and the message is authenticated post-commit.
    const f = await setupSalvage();
    const hooksDir = join(
      git(f.worktree, ["rev-parse", "--git-path", "hooks"]).trim(),
    );
    mkdirSync(hooksDir, { recursive: true });
    const hook = join(hooksDir, "prepare-commit-msg");
    writeFileSync(hook, '#!/bin/sh\necho "SECRET=sk_hook_leak" >> "$1"\n');
    execFileSync("chmod", ["+x", hook]);

    const r = await pushReviewedBranchForEscalation({
      runsDir: join(f.root, "runs"),
      workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
      runId: f.runId,
    });
    expect(r.committed).toBe(true);
    // the pushed commit message is exactly the harness message — no hook leak
    const remoteMsg = execFileSync(
      "git",
      ["-C", f.bareRemote, "log", "-1", "--format=%B", `harness/${f.runId}/apps-x`],
      { encoding: "utf8" },
    ).trim();
    expect(remoteMsg).toBe("harness salvage: run-20260521-apps-x-salv1");
    expect(remoteMsg).not.toMatch(/SECRET/);
  });

  it("commit signing: a commit.gpgsign config cannot embed unauthenticated bytes in the pushed commit object", async () => {
    // A target-repo `commit.gpgsign=true` + `gpg.program` would embed a `gpgsig`
    // header (attacker-controlled bytes) into the pushed commit object, which the
    // %B message auth does not see. The mint must pass --no-gpg-sign.
    const f = await setupSalvage();
    const fakeGpg = join(f.root, "fakegpg.sh");
    writeFileSync(
      fakeGpg,
      '#!/bin/sh\ncat >/dev/null\necho "[GNUPG:] SIG_CREATED " >&2\n' +
        'printf -- "-----BEGIN PGP SIGNATURE-----\\n\\nSECRET_SIG_EXFIL\\n-----END PGP SIGNATURE-----\\n"\n',
    );
    execFileSync("chmod", ["+x", fakeGpg]);
    git(f.worktree, ["config", "gpg.program", fakeGpg]);
    git(f.worktree, ["config", "user.signingkey", "DEADBEEF"]);
    git(f.worktree, ["config", "commit.gpgsign", "true"]);

    const r = await pushReviewedBranchForEscalation({
      runsDir: join(f.root, "runs"),
      workspacesDir: join(f.root, "workspaces"),
      locksDir: join(f.root, "locks"),
      runId: f.runId,
    });
    expect(r.committed).toBe(true);
    // the pushed commit object carries NO gpgsig header / exfil bytes
    const obj = execFileSync(
      "git",
      ["-C", f.bareRemote, "cat-file", "-p", r.headSha],
      { encoding: "utf8" },
    );
    expect(obj).not.toMatch(/gpgsig/);
    expect(obj).not.toMatch(/SECRET_SIG_EXFIL/);
  });

  it("retry-commit auth: refuses a single clean commit beyond base whose message is not the harness message", async () => {
    // The idempotent-retry tolerance accepts exactly one clean commit beyond base
    // whose tree matches the reviewed fingerprint. Without authenticating its
    // MESSAGE, an out-of-band commit carrying a secret in its commit message (the
    // content matches the fingerprint) would be tolerated and pushed. The gate
    // must require the message to equal the deterministic harness salvage message.
    const f = await setupSalvage();
    // a single clean commit beyond base, reviewed content, but a non-harness
    // (secret-bearing) message
    git(f.worktree, ["add", "apps/x/f.ts"]);
    git(f.worktree, [
      "commit",
      "-qm",
      "exfil: AWS_SECRET=AKIAIOSFODNN7EXAMPLE",
    ]);

    await expect(
      pushReviewedBranchForEscalation({
        runsDir: join(f.root, "runs"),
        workspacesDir: join(f.root, "workspaces"),
        locksDir: join(f.root, "locks"),
        runId: f.runId,
      }),
    ).rejects.toThrow(/unauthenticated retry commit/);

    const remoteBranches = execFileSync(
      "git",
      ["-C", f.bareRemote, "branch", "--list"],
      { encoding: "utf8" },
    );
    expect(remoteBranches).not.toMatch(/harness\/run-20260521-apps-x-salv1/);
  });
});
