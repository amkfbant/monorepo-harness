import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { RunMeta } from "../logging/run-log.js";
import { gitCli } from "../git/git-cli.js";
import { acquireDomainLock } from "../workspace/domain-lock.js";
import { computeReviewedFingerprint } from "./reviewed-fingerprint.js";
import { openDb } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { RunRepository } from "../db/repositories/runs.js";
import { PullRequestRepository } from "../db/repositories/pull-requests.js";
import { exportRun } from "../db/export-files.js";

export class PrGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrGateError";
  }
}

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface PrPublishInputs {
  /** cwd for the publisher (the run worktree) */
  repoDir: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
}

export interface PrPublishResult {
  url: string;
  number: number;
}

/**
 * Publishes a pull request. Injected so the git side can be tested with a
 * local bare remote while the real GitHub call (`gh`) is swapped in only
 * at the CLI / demo boundary. A real publisher SHOULD be idempotent on
 * the head branch (return an existing PR rather than failing).
 */
export interface PrPublisher {
  publish(inputs: PrPublishInputs): Promise<PrPublishResult>;
}

export interface CreatePrOpts {
  runsDir: string;
  workspacesDir: string;
  /** domain lock dir — pr create takes the same lock as review / cleanup */
  locksDir: string;
  runId: string;
  base: string;
  draft: boolean;
  publisher: PrPublisher;
  /**
   * harness DB path. When given (Phase 7-10), the PR is recorded in
   * `pull_requests` as the canonical record — making `pr create`
   * idempotent — and a `db-first` run's PR fields are written through the
   * DB. Omitted → the legacy file-only path (meta.json) is used.
   */
  dbPath?: string;
  /** override the PR title; default derives from runId + domain */
  title?: string;
  gitTimeoutMs?: number;
  now?: Date;
}

export interface CreatePrResult {
  runId: string;
  prUrl: string;
  prNumber: number;
  head: string;
}

/**
 * Turn an APPROVED run into a draft pull request: commit ONLY the
 * reviewed paths from the run worktree onto the run branch, push it,
 * open the PR, and record prUrl / prNumber in meta.json.
 *
 * Runs under the run's domain lock so a concurrent cleanup cannot delete
 * the worktree / overwrite meta.json mid-flight.
 */
export async function createPullRequest(
  opts: CreatePrOpts,
): Promise<CreatePrResult> {
  if (!RUN_ID_RE.test(opts.runId)) {
    throw new PrGateError(`invalid runId: ${JSON.stringify(opts.runId)}`);
  }
  const runDir = join(opts.runsDir, opts.runId);
  const metaPath = join(runDir, "meta.json");
  if (!existsSync(metaPath)) {
    throw new PrGateError(`run ${opts.runId} not found`);
  }
  // unlocked probe read just to learn the domain for the lock.
  const probe = await readMeta(metaPath, opts.runId);
  // Open the DB before the lock so an open failure cannot leak a held
  // lock (mirrors cleanup). A DB-recorded `created` PR short-circuits the
  // whole flow — `pr create` is idempotent, never opening a second PR.
  const db = opts.dbPath !== undefined ? openDb(opts.dbPath) : undefined;
  let lock: Awaited<ReturnType<typeof acquireDomainLock>> | undefined;
  try {
    if (db !== undefined) {
      runMigrations(db);
      const existing = new PullRequestRepository(db).findByRun(opts.runId);
      if (
        existing !== null &&
        existing.status === "created" &&
        existing.url !== null &&
        existing.externalPrId !== null
      ) {
        return {
          runId: opts.runId,
          prUrl: existing.url,
          prNumber: Number(existing.externalPrId),
          head: existing.branch ?? "",
        };
      }
    }
    lock = await acquireDomainLock({
      locksDir: opts.locksDir,
      domain: typeof probe.domain === "string" ? probe.domain : "unknown",
      runId: `pr:${opts.runId}`,
      ...(typeof probe.repoId === "string" ? { repoId: probe.repoId } : {}),
    });
    return await createUnderLock(opts, runDir, metaPath, db);
  } finally {
    try {
      db?.close();
    } finally {
      if (lock !== undefined) await lock.release();
    }
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

async function createUnderLock(
  opts: CreatePrOpts,
  runDir: string,
  metaPath: string,
  db: Database.Database | undefined,
): Promise<CreatePrResult> {
  // authoritative read UNDER the lock — a concurrent cleanup can't have
  // changed status between the probe read and here.
  const meta = await readMeta(metaPath, opts.runId);
  if (meta.status !== "approved") {
    throw new PrGateError(
      `run ${opts.runId} has status "${meta.status}"; only approved runs can be turned into a PR`,
    );
  }
  if (typeof meta.prUrl === "string") {
    throw new PrGateError(
      `run ${opts.runId} already has a PR: ${meta.prUrl}`,
    );
  }
  if (typeof meta.runBranch !== "string" || meta.runBranch === "") {
    throw new PrGateError(`meta.json for ${opts.runId} has no runBranch`);
  }
  const head = meta.runBranch;

  const worktree = join(opts.workspacesDir, opts.runId, "repo");
  if (!existsSync(worktree)) {
    throw new PrGateError(
      `worktree for ${opts.runId} is gone (cleaned up); cannot create a PR`,
    );
  }
  const git = { cwd: worktree, timeoutMs: opts.gitTimeoutMs ?? 30_000 };

  // 1. The reviewed file set + content fingerprint come from meta.json
  //    (written at run time) — the authoritative record, not events.jsonl.
  const reviewed = meta.reviewed;
  if (
    !reviewed ||
    !Array.isArray(reviewed.paths) ||
    typeof reviewed.fingerprint !== "string"
  ) {
    throw new PrGateError(
      `run ${opts.runId} has no reviewed fingerprint in meta.json; cannot verify the worktree (re-run on a current harness)`,
    );
  }
  const reviewedPaths = reviewed.paths.filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
  if (reviewedPaths.length === 0) {
    throw new PrGateError(
      `run ${opts.runId} has no reviewed file changes; nothing to PR`,
    );
  }

  // 2. Content drift check: the worktree's reviewed files must still match
  //    what was approved. An edit to a reviewed path after approval must
  //    NOT slip silently into the PR.
  const currentFingerprint = await computeReviewedFingerprint(
    worktree,
    reviewedPaths,
  );
  if (currentFingerprint !== reviewed.fingerprint) {
    throw new PrGateError(
      `run ${opts.runId}: the worktree drifted since the run was reviewed — ` +
        `a reviewed file no longer matches the approved content. ` +
        `Refusing to create a PR; re-review the run.`,
    );
  }

  // 3. Stage ONLY the reviewed paths and commit onto the run branch.
  //    ignore_untracked files (dist/** etc.) are in the worktree but were
  //    NOT validated, so they stay out.
  await runGit(["add", "--", ...reviewedPaths], git);
  const staged = (
    await runGit(["diff", "--cached", "--name-only"], git)
  ).trim();
  if (staged !== "") {
    await runGit(["commit", "-m", `harness: ${opts.runId}`], git);
  }

  // 4. push the run branch to the target repo's origin.
  const push = await gitCli(["push", "-u", "origin", head], git);
  if (push.exitCode !== 0) {
    throw new PrGateError(
      `git push of ${head} failed: ${push.stderr.trim() || push.stdout.trim()}`,
    );
  }

  // 5. open the PR (publisher should be idempotent on the head branch).
  //    A `db-first` run is recorded through the DB; a legacy run keeps the
  //    meta.json path. The DB row's source_mode is the authority.
  const dbFirst =
    db !== undefined &&
    (
      db
        .prepare("SELECT source_mode FROM runs WHERE run_id = ?")
        .get(opts.runId) as { source_mode: string } | undefined
    )?.source_mode === "db-first";
  const title =
    opts.title ?? `harness ${opts.runId} (${meta.domain ?? "unknown"})`;
  const body = await buildPrBody(runDir, meta, opts.runId);
  const occurredAt = (opts.now ?? new Date()).toISOString();
  const repo = typeof meta.repoId === "string" ? meta.repoId : null;

  let published: PrPublishResult;
  try {
    published = await opts.publisher.publish({
      repoDir: worktree,
      base: opts.base,
      head,
      title,
      body,
      draft: opts.draft,
    });
  } catch (e) {
    // the external creation failed: record it so a retry can recover, and
    // surface the error. The DB stays the canonical record of the attempt.
    if (db !== undefined) {
      new PullRequestRepository(db).upsertPullRequest({
        runId: opts.runId,
        provider: "github",
        repo,
        branch: head,
        baseBranch: opts.base,
        title,
        url: null,
        externalPrId: null,
        status: "failed",
        operationId: null,
      });
    }
    throw e;
  }

  // 6. record the pull request. The DB is the canonical record (Phase
  //    7-10); a db-first run's PR fields go through the run row and are
  //    re-exported, a legacy run keeps the meta.json write.
  if (db !== undefined) {
    new PullRequestRepository(db).upsertPullRequest({
      runId: opts.runId,
      provider: "github",
      repo,
      branch: head,
      baseBranch: opts.base,
      title,
      url: published.url,
      externalPrId: String(published.number),
      status: "created",
      operationId: null,
    });
  }
  if (dbFirst && db !== undefined) {
    new RunRepository(db).recordPrCreated({
      runId: opts.runId,
      prUrl: published.url,
      prNumber: published.number,
      head,
      base: opts.base,
      occurredAt,
    });
    exportRun(db, opts.runId, { runsDir: opts.runsDir });
  } else {
    // legacy run — meta is re-read so we never clobber a field a
    // concurrent writer set; we hold the lock, so this read is current.
    const current = await readMeta(metaPath, opts.runId);
    await writeFile(
      metaPath,
      `${JSON.stringify({ ...current, prUrl: published.url, prNumber: published.number }, null, 2)}\n`,
      "utf8",
    );
    await appendFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({
        type: "pr_created",
        runId: opts.runId,
        prUrl: published.url,
        prNumber: published.number,
        head,
        base: opts.base,
        createdAt: occurredAt,
      })}\n`,
      "utf8",
    );
  }

  return {
    runId: opts.runId,
    prUrl: published.url,
    prNumber: published.number,
    head,
  };
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

/** Recover the operator's goal from the run's codex-prompt.md. */
async function recoverGoal(runDir: string): Promise<string> {
  try {
    const prompt = await readFile(join(runDir, "codex-prompt.md"), "utf8");
    const m = prompt.match(/^Goal:\s*\n([\s\S]*?)\n\nTarget domain:/m);
    if (m && m[1]) return m[1].trim();
  } catch {
    // best effort
  }
  return "(goal could not be recovered)";
}

async function buildPrBody(
  runDir: string,
  meta: RunMeta,
  runId: string,
): Promise<string> {
  const goal = await recoverGoal(runDir);
  const cmd = Array.isArray(meta.commandResults) ? meta.commandResults : [];
  const cmdOk = cmd.filter((c) => c.exitCode === 0 && !c.timedOut).length;
  return [
    "## Harness run",
    "",
    `- run: \`${runId}\``,
    `- domain: \`${meta.domain ?? "unknown"}\``,
    `- status: ${meta.status}`,
    `- safetyStatus: ${meta.safetyStatus ?? "?"}`,
    `- commands: ${cmdOk}/${cmd.length} ok`,
    `- reviewer: ${meta.reviewer ?? "(none)"}`,
    `- reviewedAt: ${meta.reviewedAt ?? "(none)"}`,
    `- secretSuspectCount: ${meta.secretSuspectCount ?? 0}`,
    `- ignoredUntrackedCount: ${meta.ignoredUntrackedCount ?? 0}`,
    "",
    "### Goal",
    "",
    goal,
    "",
    "### Notes",
    "",
    "Generated by `harness pr create`. Run artifacts (summary.md, " +
      "final-diff.patch, review-decision.yaml) live under " +
      `\`runs/${runId}/\` in the harness.`,
    "",
    "🤖 harness draft PR — review before merging.",
    "",
  ].join("\n");
}
