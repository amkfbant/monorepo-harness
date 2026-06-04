import { readFile, writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { RunMeta } from "../logging/run-log.js";
import { gitCli } from "../git/git-cli.js";
import { warnLegacyFileLocks } from "../workspace/legacy-file-lock-warning.js";
import { computeReviewedFingerprint } from "./reviewed-fingerprint.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";
import { RunRepository } from "../db/repositories/runs.js";
import { PullRequestRepository } from "../db/repositories/pull-requests.js";
import { exportRun, warnIfExportFailed } from "../db/export-files.js";
import { SourceModeError } from "../db/errors.js";

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

/** Phase 3-2: merge method for an auto-merge. */
export type PrMergeMethod = "squash" | "merge" | "rebase";

export interface PrMergeInputs {
  /** cwd for the merger (the run worktree). */
  repoDir: string;
  prNumber: number;
  method: PrMergeMethod;
  /**
   * Phase 3 safety: pin the merge to this head commit. When set, the merge
   * must target exactly this SHA (the reviewed / CI-checked commit) and is
   * refused if the PR head moved. When omitted, the merger pins to the head
   * it observes just before merging.
   */
  expectedHeadSha?: string;
}

export interface PrMergeResult {
  merged: boolean;
  /** True when the PR was already merged before this call (idempotent no-op). */
  alreadyMerged: boolean;
}

/**
 * Merges a pull request. Injected like {@link PrPublisher} so the auto-merge
 * wiring can be tested with a fake. A real merger MUST be idempotent: detect
 * an already-merged PR and not attempt a second merge.
 */
export interface PrMerger {
  merge(inputs: PrMergeInputs): Promise<PrMergeResult>;
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
  /**
   * Phase 3: the commit SHA that was committed + pushed for this PR — i.e. the
   * exact reviewed commit (the worktree was fingerprint-verified against the
   * approved content before this commit). Auto-merge pins the merge to THIS
   * SHA, never to the PR's later-observed head. Undefined on the idempotent
   * "PR already exists" paths where the commit was made by a prior run.
   */
  headSha?: string;
}

/**
 * Turn an APPROVED run into a draft pull request: commit ONLY the
 * reviewed paths from the run worktree onto the run branch, push it,
 * open the PR, and record prUrl / prNumber in meta.json.
 *
 * Phase 10-1: the file domain lock has been retired. Idempotency comes
 * from the DB-recorded `pull_requests.status='created'` short-circuit at
 * the top of `createPullRequest`. The post-review TODO below (Phase 10-2)
 * tightens the race window between two concurrent `pr create` invocations
 * for the same run, by reserving the `pull_requests` row before any
 * external git/gh side effect.
 */
export async function createPullRequest(
  opts: CreatePrOpts,
): Promise<CreatePrResult> {
  if (!RUN_ID_RE.test(opts.runId)) {
    throw new PrGateError(`invalid runId: ${JSON.stringify(opts.runId)}`);
  }
  const runDir = join(opts.runsDir, opts.runId);
  const metaPath = join(runDir, "meta.json");
  // Phase 9 post-close P0 fix: managed open holds the DB-wide shared
  // maintenance lock for the lifetime of this command. Phase 10-1: the
  // file domain lock is retired; `pr create` is idempotent (DB-recorded
  // `created` PRs short-circuit) and the state guard prevents racing
  // against a still-running domain (status != 'created' check).
  warnLegacyFileLocks(opts.locksDir);
  const dbHandle =
    opts.dbPath !== undefined
      ? openManagedDb({ dbPath: opts.dbPath })
      : undefined;
  const db = dbHandle?.db;
  try {
    if (db !== undefined) {
      runMigrations(db);
      // Phase 9-11: refuse to operate on a DB with legacy-file runtime rows.
      assertNoLegacyRuntimeRows(db);
    }
    // Validate the run row source_mode before doing anything destructive.
    const dbRow =
      db !== undefined
        ? (db
            .prepare(
              "SELECT source_mode FROM runs WHERE run_id = ?",
            )
            .get(opts.runId) as { source_mode: string } | undefined)
        : undefined;
    // Phase 10-6: runtime pr create operates only on db-first runs.
    // legacy-file is dead branch (assertNoLegacyRuntimeRows gates above).
    if (dbRow !== undefined && dbRow.source_mode !== "db-first") {
      throw new SourceModeError(
        opts.runId,
        dbRow.source_mode,
        "db-first",
      );
    }
    // legacy / not-in-DB runs still need meta.json on disk.
    if (dbRow === undefined && !existsSync(metaPath)) {
      throw new PrGateError(`run ${opts.runId} not found`);
    }
    if (db !== undefined) {
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
    return await createUnderLock(opts, runDir, metaPath, db);
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

async function createUnderLock(
  opts: CreatePrOpts,
  runDir: string,
  metaPath: string,
  db: Database.Database | undefined,
): Promise<CreatePrResult> {
  // the run's canonical state: a `db-first` run is the `runs` row, a
  // legacy run is meta.json. The exported meta.json of a db-first run can
  // be stale, so it must NOT gate the PR.
  const dbRow =
    db !== undefined
      ? (db
          .prepare(
            "SELECT source_mode, status, run_branch, meta_json FROM runs WHERE run_id = ?",
          )
          .get(opts.runId) as
          | {
              source_mode: string;
              status: string;
              run_branch: string | null;
              meta_json: string | null;
            }
          | undefined)
      : undefined;
  // an unrecognised source_mode is corruption — surface it rather than
  // silently treating the row as legacy.
  if (
    dbRow !== undefined &&
    dbRow.source_mode !== "db-first" &&
    dbRow.source_mode !== "legacy-file"
  ) {
    throw new SourceModeError(
      opts.runId,
      dbRow.source_mode,
      "db-first | legacy-file",
    );
  }
  const dbFirst = dbRow?.source_mode === "db-first";

  // re-check the canonical PR record UNDER the lock — a concurrent
  // `pr create` may have opened the PR since the pre-lock check.
  if (db !== undefined) {
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

  let meta: RunMeta;
  let status: string;
  let head: string;
  if (dbFirst && dbRow !== undefined) {
    if (dbRow.meta_json === null) {
      throw new PrGateError(
        `run ${opts.runId} is db-first but its row has no meta_json`,
      );
    }
    meta = JSON.parse(dbRow.meta_json) as RunMeta;
    status = dbRow.status;
    head = dbRow.run_branch ?? "";
  } else {
    meta = await readMeta(metaPath, opts.runId);
    status = typeof meta.status === "string" ? meta.status : "";
    head = typeof meta.runBranch === "string" ? meta.runBranch : "";
  }
  if (status !== "approved") {
    throw new PrGateError(
      `run ${opts.runId} has status "${status}"; only approved runs can be turned into a PR`,
    );
  }
  // a db-first run's PR fact is its `pull_requests` row (re-checked
  // above); a legacy run's is meta.prUrl — catch a pre-Phase-7 PR here.
  if (!dbFirst && typeof meta.prUrl === "string") {
    throw new PrGateError(
      `run ${opts.runId} already has a PR: ${meta.prUrl}`,
    );
  }
  if (head === "") {
    throw new PrGateError(`run ${opts.runId} has no runBranch`);
  }

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
  // The pushed tip is the reviewed commit (the worktree was fingerprint-checked
  // above). Capture it so auto-merge can pin the merge to THIS exact commit.
  const reviewedHeadSha = (await runGit(["rev-parse", "HEAD"], git)).trim();

  // 5. open the PR (publisher should be idempotent on the head branch).
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
  //    7-10). For a db-first run the `runs` update and the `pull_requests`
  //    row are committed in ONE transaction, so the PR record can never be
  //    `created` while the run row is left unrecorded.
  if (db !== undefined && dbFirst) {
    const conn = db;
    conn.transaction(() => {
      new RunRepository(conn).recordPrCreated({
        runId: opts.runId,
        prUrl: published.url,
        prNumber: published.number,
        head,
        base: opts.base,
        occurredAt,
      });
      new PullRequestRepository(conn).upsertPullRequest({
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
    })();
    warnIfExportFailed(exportRun(db, opts.runId, { runsDir: opts.runsDir }));
  } else {
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
    headSha: reviewedHeadSha,
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
      "final-diff.patch, review-decision.yaml) are stored in the harness " +
      `DB and can be materialized under \`runs/${runId}/\` ` +
      "(`harness db export-files`).",
    "",
    "🤖 harness draft PR — review before merging.",
    "",
  ].join("\n");
}
