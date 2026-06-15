import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type Database from "better-sqlite3";
import type { RunMeta } from "../logging/run-log.js";
import { gitCli } from "../git/git-cli.js";
import { warnLegacyFileLocks } from "../workspace/legacy-file-lock-warning.js";
import { computeReviewedFingerprint } from "./reviewed-fingerprint.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";
import { SourceModeError } from "../db/errors.js";
import { PrGateError } from "./pr-gate-error.js";

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PushReviewedBranchOpts {
  runsDir: string;
  workspacesDir: string;
  locksDir: string;
  runId: string;
  dbPath?: string;
  gitTimeoutMs?: number;
}

export interface PushReviewedBranchResult {
  runId: string;
  branch: string;
  headSha: string;
  committed: boolean;
}

export async function pushReviewedBranchForEscalation(
  opts: PushReviewedBranchOpts,
): Promise<PushReviewedBranchResult> {
  if (!RUN_ID_RE.test(opts.runId)) {
    throw new PrGateError(`invalid runId: ${JSON.stringify(opts.runId)}`);
  }
  warnLegacyFileLocks(opts.locksDir);
  const runDir = join(opts.runsDir, opts.runId);
  const metaPath = join(runDir, "meta.json");
  const dbHandle =
    opts.dbPath !== undefined && existsSync(opts.dbPath)
      ? openManagedDb({ dbPath: opts.dbPath })
      : undefined;
  const db = dbHandle?.db;
  try {
    if (db !== undefined) {
      runMigrations(db);
      assertNoLegacyRuntimeRows(db);
    }
    const ctx = await loadReviewedBranchContext({
      db,
      runId: opts.runId,
      metaPath,
      expectedStatus: "needs_review",
      expectedSafetyStatus: "allowed",
    });
    return await commitAndPushReviewedBranch({
      runId: opts.runId,
      workspacesDir: opts.workspacesDir,
      branch: ctx.branch,
      baseRef: ctx.baseRef,
      meta: ctx.meta,
      ...(opts.gitTimeoutMs !== undefined
        ? { gitTimeoutMs: opts.gitTimeoutMs }
        : {}),
      commitMessage: `harness salvage: ${opts.runId}`,
    });
  } finally {
    dbHandle?.close();
  }
}

async function readMeta(metaPath: string, runId: string): Promise<RunMeta> {
  try {
    return JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
  } catch (e) {
    throw new PrGateError(
      `meta.json for ${runId} is unreadable: ${(e as Error).message}`,
    );
  }
}

async function loadReviewedBranchContext(input: {
  db: Database.Database | undefined;
  runId: string;
  metaPath: string;
  expectedStatus: "needs_review";
  expectedSafetyStatus: "allowed";
}): Promise<{ meta: RunMeta; branch: string; baseRef: string }> {
  const dbRow =
    input.db !== undefined
      ? (input.db
          .prepare(
            `SELECT source_mode, status, safety_status, base_sha, run_branch,
                    meta_json
               FROM runs WHERE run_id = ?`,
          )
          .get(input.runId) as
          | {
              source_mode: string;
              status: string;
              safety_status: string | null;
              base_sha: string | null;
              run_branch: string | null;
              meta_json: string | null;
            }
          | undefined)
      : undefined;
  if (dbRow !== undefined && dbRow.source_mode !== "db-first") {
    throw new SourceModeError(input.runId, dbRow.source_mode, "db-first");
  }

  let meta: RunMeta;
  let status: string;
  let safetyStatus: string | undefined;
  let branch: string;
  let baseRef: string;
  if (dbRow !== undefined) {
    if (dbRow.meta_json === null) {
      throw new PrGateError(
        `run ${input.runId} is db-first but its row has no meta_json`,
      );
    }
    meta = JSON.parse(dbRow.meta_json) as RunMeta;
    status = dbRow.status;
    safetyStatus = dbRow.safety_status ?? undefined;
    branch = dbRow.run_branch ?? "";
    baseRef = dbRow.base_sha ?? meta.baseSha;
  } else {
    meta = await readMeta(input.metaPath, input.runId);
    status = typeof meta.status === "string" ? meta.status : "";
    safetyStatus = meta.safetyStatus;
    branch = typeof meta.runBranch === "string" ? meta.runBranch : "";
    baseRef = meta.baseSha;
  }

  if (status !== input.expectedStatus) {
    throw new PrGateError(
      `run ${input.runId} has status "${status}"; expected ${input.expectedStatus}`,
    );
  }
  if (safetyStatus !== input.expectedSafetyStatus) {
    throw new PrGateError(
      `run ${input.runId} has safetyStatus "${safetyStatus ?? "(none)"}"; ` +
        `expected ${input.expectedSafetyStatus}`,
    );
  }
  if (branch === "") {
    throw new PrGateError(`run ${input.runId} has no runBranch`);
  }
  if (typeof baseRef !== "string" || baseRef === "") {
    throw new PrGateError(`run ${input.runId} has no baseSha`);
  }
  return { meta, branch, baseRef };
}

export function reviewedPathsFromMeta(meta: RunMeta, runId: string): string[] {
  const reviewed = meta.reviewed;
  if (
    !reviewed ||
    !Array.isArray(reviewed.paths) ||
    typeof reviewed.fingerprint !== "string"
  ) {
    throw new PrGateError(
      `run ${runId} has no reviewed fingerprint in meta.json; cannot verify ` +
        `the worktree (re-run on a current harness)`,
    );
  }
  const reviewedPaths = reviewed.paths.filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  if (reviewedPaths.length === 0) {
    throw new PrGateError(`run ${runId} has no reviewed file changes`);
  }
  return reviewedPaths;
}

export async function assertReviewedFingerprintMatches(input: {
  worktree: string;
  meta: RunMeta;
  runId: string;
  reviewedPaths: string[];
  refusal?: string;
}): Promise<void> {
  const reviewed = input.meta.reviewed as { fingerprint: string };
  const currentFingerprint = await computeReviewedFingerprint(
    input.worktree,
    input.reviewedPaths,
  );
  if (currentFingerprint !== reviewed.fingerprint) {
    throw new PrGateError(
      `run ${input.runId}: the worktree drifted since the run was reviewed — ` +
        `a reviewed file no longer matches the approved content. ` +
        `Refusing to ${input.refusal ?? "push"}; re-review the run.`,
    );
  }
}

async function commitAndPushReviewedBranch(input: {
  runId: string;
  workspacesDir: string;
  branch: string;
  baseRef: string;
  meta: RunMeta;
  gitTimeoutMs?: number;
  commitMessage: string;
}): Promise<PushReviewedBranchResult> {
  const worktree = join(input.workspacesDir, input.runId, "repo");
  if (!existsSync(worktree)) {
    throw new PrGateError(
      `worktree for ${input.runId} is gone (cleaned up); cannot push branch`,
    );
  }
  const git = { cwd: worktree, timeoutMs: input.gitTimeoutMs ?? 30_000 };
  const reviewedPaths = reviewedPathsFromMeta(input.meta, input.runId);
  await assertReviewedFingerprintMatches({
    worktree,
    meta: input.meta,
    runId: input.runId,
    reviewedPaths,
  });

  // The diff gates below validate HEAD, but `git push ... input.branch` pushes
  // the named branch ref. If the worktree HEAD is not the reviewed branch (e.g.
  // an operator checked out another branch in the worktree), HEAD and
  // input.branch can diverge and unreviewed commits already on input.branch
  // would bypass the gate. Pin HEAD == input.branch up front, fail-closed.
  const currentBranch = (
    await runGit(["rev-parse", "--abbrev-ref", "HEAD"], git)
  ).trim();
  if (currentBranch !== input.branch) {
    throw new PrGateError(
      `worktree for ${input.runId} is on '${currentBranch}', not the reviewed ` +
        `branch '${input.branch}'; refusing to push`,
    );
  }

  // Fail-closed: refuse to push if the repo's object graph is tampered (replace
  // refs / grafts / shallow). The history gates below are object-graph based, so
  // this must run first. `git push` ships the REAL objects regardless.
  await assertNoObjectGraphTampering({ git, runId: input.runId });

  // Fail-closed: refuse any unreviewed commit history beyond base (an
  // intermediate commit touching only reviewed paths whose final content matches
  // the fingerprint would otherwise pass the net branch-diff gate below and push
  // its history). Tolerates this run's own single reviewed commit re-pushed
  // idempotently after a failed publish/push (its message is authenticated below).
  const headAtBase = await assertNoUnreviewedHistory({
    git,
    runId: input.runId,
    baseRef: input.baseRef,
  });

  await runGit(["add", "--", ...reviewedPaths], git);
  const stagedPaths = parseGitPathList(
    await runGit(["diff", "--no-renames", "--cached", "-z", "--name-only"], git),
  );
  assertPathsSubset(stagedPaths, reviewedPaths, "staged diff");
  // When HEAD already carries this run's reviewed commit (idempotent retry),
  // `git add` must stage NOTHING — the reviewed content is already that commit.
  // If it staged new content (e.g. an untracked reviewed file the prior commit
  // didn't include), committing it would push a SECOND commit on top of the
  // existing (potentially unreviewed-message) one. Refuse instead.
  if (!headAtBase && stagedPaths.length > 0) {
    throw new PrGateError(
      `worktree for ${input.runId} carries a commit beyond base plus ` +
        `additional reviewed content to stage; refusing to add a second commit ` +
        `onto pre-existing history`,
    );
  }
  let committed = false;
  if (stagedPaths.length > 0) {
    // Mint with hooks disabled + verbatim so neither a target-repo
    // `prepare-commit-msg` hook nor git's message cleanup can mutate the
    // deterministic message (authenticated post-commit below).
    await runGit(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--cleanup=verbatim",
        "-m",
        input.commitMessage,
      ],
      git,
    );
    committed = true;
  }

  await assertSingleReviewedCommit({
    git,
    runId: input.runId,
    baseRef: input.baseRef,
  });
  // Authenticate HEAD's commit message (covers both the freshly minted commit and
  // a tolerated single retry commit) — fail-closed if it is not the exact harness
  // message (e.g. a hook-appended secret or an out-of-band commit message).
  await assertHeadCommitMessageAuthentic({
    git,
    runId: input.runId,
    expectedCommitMessage: input.commitMessage,
  });
  const branchPaths = parseGitPathList(
    await runGit(["diff", "--no-renames", "-z", "--name-only", input.baseRef, "HEAD"], git),
  );
  assertPathsSubset(branchPaths, reviewedPaths, "branch diff");

  const push = await gitCli(["push", "-u", "origin", input.branch], git);
  if (push.exitCode !== 0) {
    throw new PrGateError(
      `git push of ${input.branch} failed: ${push.stderr.trim() || push.stdout.trim()}`,
    );
  }
  const headSha = (await runGit(["rev-parse", "HEAD"], git)).trim();
  return { runId: input.runId, branch: input.branch, headSha, committed };
}

export function parseGitPathList(stdout: string): string[] {
  // Parse `git diff -z` output: paths are NUL-terminated, so split on NUL and
  // do NOT trim. A path with leading/trailing whitespace (e.g. " a") must be
  // preserved exactly — trimming line-oriented output could rewrite " a" to
  // "a" and let an unreviewed file slip past the reviewed-paths subset gate.
  return stdout.split("\0").filter((p) => p !== "");
}

export function assertPathsSubset(
  paths: string[],
  allowedPaths: string[],
  label: string,
): void {
  const allowed = new Set(allowedPaths);
  const unreviewed = paths.filter((p) => !allowed.has(p));
  if (unreviewed.length > 0) {
    throw new PrGateError(
      `${label} contains unreviewed path(s): ${unreviewed.join(", ")}`,
    );
  }
}

// Fail-closed: refuse to push if the repo's object graph is tampered via
// `refs/replace/*`, an `info/grafts` file, or shallowness. `GIT_NO_REPLACE_OBJECTS=1`
// (forced centrally in gitCli) already neutralizes replace refs for every harness
// READ, but the push gates must additionally refuse such tampering OUTRIGHT: a
// replace ref or graft makes `git diff` / `git rev-list` validate a sanitized
// object view while `git push` still transmits the REAL (unreviewed/secret)
// objects; a shallow repo hides ancestry so the history-count gate can be fooled.
// This is defense-in-depth — the coder's `--sandbox workspace-write` likely blocks
// writes to the shared commondir where these live, but the deterministic git
// validation must not RELY on the sandbox.
//
// `objects/info/alternates` and the commit-graph are deliberately NOT gated: an
// alternate object store is content-addressed lookup and the commit-graph is a
// consistency-verified cache, so neither can make a given SHA read as a sanitized
// object while `git push` ships a different real one — only replace/grafts/shallow
// create that read-view-vs-pushed-bytes divergence. The check is point-in-time
// (re-introducing tampering AFTER this call but before the push is out of scope:
// the run is already terminal-reviewed and single-threaded here, and an attacker
// with concurrent commondir write could `git push` directly anyway).
export async function assertNoObjectGraphTampering(input: {
  git: { cwd: string; timeoutMs: number };
  runId: string;
}): Promise<void> {
  const replaceRefs = (
    await runGit(
      ["for-each-ref", "--format=%(refname)", "refs/replace/"],
      input.git,
    )
  ).trim();
  if (replaceRefs !== "") {
    throw new PrGateError(
      `worktree for ${input.runId} carries replace ref(s) ` +
        `(${replaceRefs.split("\n").join(", ")}); refusing to push ` +
        `(object-graph tampering)`,
    );
  }
  // `git rev-parse --git-path info/grafts` resolves to the (shared commondir)
  // grafts path, relative to the worktree when linked. Any grafts content rewrites
  // commit parents, so refuse if the file exists at all.
  const graftsPath = (
    await runGit(["rev-parse", "--git-path", "info/grafts"], input.git)
  ).trim();
  if (graftsPath !== "" && existsSync(resolve(input.git.cwd, graftsPath))) {
    throw new PrGateError(
      `worktree for ${input.runId} carries a commit-graft file ` +
        `(${graftsPath}); refusing to push (object-graph tampering)`,
    );
  }
  const isShallow = (
    await runGit(["rev-parse", "--is-shallow-repository"], input.git)
  ).trim();
  if (isShallow === "true") {
    throw new PrGateError(
      `worktree for ${input.runId} is a shallow repository; refusing to push ` +
        `(object-graph tampering)`,
    );
  }
}

// Fail-closed: the reviewed worktree must carry NO unreviewed commit HISTORY
// beyond the run base. The net branch-diff gate the callers run only checks the
// FINAL changed-path set (`git diff <base> HEAD`), so an intermediate commit
// that touches only reviewed paths — with transient/secret content later
// restored to the reviewed fingerprint — would pass the path subset and still
// push its unreviewed history to origin. The run flow normalizes every reviewed
// worktree to HEAD == base (`git reset --mixed`), so the ONLY legitimate
// non-base HEAD here is this run's OWN single reviewed commit re-pushed
// idempotently after a failed publish/push: EXACTLY one commit beyond base AND a
// clean tracked worktree (working tree == that commit, so the caller's
// `git add` finds nothing new and merely re-pushes the same commit). Anything
// else — multiple commits, or a single commit whose content the working tree no
// longer matches (a restored intermediate secret commit) — is rejected. We do
// NOT reset/re-commit here: that would mint a new commit SHA and diverge from an
// already-pushed branch, breaking the idempotent retry.
//
// Returns whether HEAD is AT base. The caller MUST use it: when HEAD is already a
// (retry) commit beyond base, the reviewed content must ALREADY be exactly that
// commit, so the caller's `git add` must stage NOTHING — otherwise it would mint a
// SECOND commit on top of the (unreviewed-message / pre-existing) first one. A
// clean TRACKED worktree here does not preclude an untracked reviewed file that
// `git add` would still stage, so the count/clean check alone is not sufficient;
// the caller enforces the stage-nothing invariant after `git add`.
export async function assertNoUnreviewedHistory(input: {
  git: { cwd: string; timeoutMs: number };
  runId: string;
  baseRef: string;
}): Promise<boolean> {
  const head = (await runGit(["rev-parse", "HEAD"], input.git)).trim();
  // baseRef may be a SHA (meta.baseSha) or a symbolic ref (opts.base, e.g.
  // "main"); resolve to a commit so the compare is over identity, not text.
  const base = (await runGit(["rev-parse", input.baseRef], input.git)).trim();
  if (head === base) return true;
  const commitCount = (
    await runGit(["rev-list", "--count", `${base}..HEAD`], input.git)
  ).trim();
  const trackedDirty = (
    await runGit(["diff", "--no-renames", "--name-only", "HEAD"], input.git)
  ).trim();
  // A single clean commit beyond base is the tolerated idempotent retry. Its
  // commit MESSAGE is authenticated separately, post-commit, by
  // assertHeadCommitMessageAuthentic (which covers both this tolerated retry and a
  // freshly minted commit) — so an out-of-band commit whose tree matches the
  // reviewed fingerprint but whose message carries a secret is still rejected.
  if (commitCount === "1" && trackedDirty === "") return false;
  throw new PrGateError(
    `worktree for ${input.runId} has commit history beyond base ` +
      `(HEAD ${head} != base ${base}, ${commitCount} commit(s)); refusing to ` +
      `push unreviewed history`,
  );
}

// Fail-closed: after the caller stages + (optionally) commits the reviewed paths,
// the branch must carry EXACTLY one commit beyond base — the single fresh reviewed
// commit. More than one means unreviewed history (a pre-existing commit plus the
// one just added) would push to origin.
export async function assertSingleReviewedCommit(input: {
  git: { cwd: string; timeoutMs: number };
  runId: string;
  baseRef: string;
}): Promise<void> {
  const base = (await runGit(["rev-parse", input.baseRef], input.git)).trim();
  const commitCount = (
    await runGit(["rev-list", "--count", `${base}..HEAD`], input.git)
  ).trim();
  if (Number(commitCount) > 1) {
    throw new PrGateError(
      `worktree for ${input.runId} would push ${commitCount} commits beyond ` +
        `base; refusing to push unreviewed history`,
    );
  }
}

// Fail-closed: authenticate that HEAD's commit MESSAGE is exactly the deterministic
// harness message. Harness commits are minted with hooks disabled + `--cleanup=verbatim`
// so the stored message equals the `-m` argument verbatim. This single post-commit check
// covers BOTH a freshly minted commit (the HEAD==base mint path the history gate does not
// otherwise message-check — e.g. a target-repo `prepare-commit-msg` hook appending a
// secret to the message, which `--no-verify` does NOT suppress) AND the tolerated single
// retry commit (an out-of-band commit whose tree matches the reviewed fingerprint but
// whose MESSAGE carries unreviewed content). Trailing newlines are stripped on both sides
// (git's mandatory final LF); verbatim means no other cleanup, so the compare is exact.
export async function assertHeadCommitMessageAuthentic(input: {
  git: { cwd: string; timeoutMs: number };
  runId: string;
  expectedCommitMessage: string;
}): Promise<void> {
  const headMessage = (
    await runGit(["log", "-1", "--format=%B", "HEAD"], input.git)
  ).replace(/\n+$/, "");
  if (headMessage !== input.expectedCommitMessage.replace(/\n+$/, "")) {
    throw new PrGateError(
      `worktree for ${input.runId} has a HEAD commit whose message does not ` +
        `match the deterministic harness commit message; refusing to push ` +
        `(unauthenticated retry commit)`,
    );
  }
}

async function runGit(
  args: readonly string[],
  git: { cwd: string; timeoutMs: number },
): Promise<string> {
  const r = await gitCli(args, git);
  if (r.timedOut) {
    throw new PrGateError(`git ${args.slice(0, 2).join(" ")} timed out`);
  }
  if (r.exitCode !== 0) {
    throw new PrGateError(
      `git ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
  return r.stdout;
}
