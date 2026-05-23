import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { minimatch } from "minimatch";
import { stringify as yamlStringify } from "yaml";
import { harnessPaths } from "../config/paths.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import {
  validateChangedPaths,
  type Violation,
} from "../policy/path-policy-validator.js";
import type {
  ResolvedPolicy,
  GlobalPolicy,
  RepoPolicy,
} from "../policy/schema.js";
import type Database from "better-sqlite3";
import {
  type RunLog,
  type RunMeta,
  type RunStatus,
  type SafetyStatus,
} from "../logging/run-log.js";
import { openDb } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { createDbRunLog } from "../db/run-log-db.js";
import { ingestRunArtifacts } from "../db/run-artifacts.js";
import {
  RunRepository,
  type ChangedFileInput,
} from "../db/repositories/runs.js";
import { RerunGateError } from "./rerun.js";
import { writeArtifact } from "../logging/artifacts.js";
import { generateRunId } from "./run-id.js";
import { runAllowedCommands } from "./command-runner.js";
import { acquireDomainLock } from "../workspace/domain-lock.js";
import {
  acquireDomainLock as acquireDbDomainLock,
  heartbeatIntervalMs,
  type DomainLockHandle as DbDomainLockHandle,
} from "../workspace/db-domain-lock.js";
import { hostname } from "node:os";
import { runBranchName } from "../workspace/branch-name.js";
import { createWorktree } from "../workspace/git-worktree.js";
import { collectDiff, resolveBaseSha } from "../git/diff.js";
import {
  buildCodexPrompt,
  CODER_PROMPT_TEMPLATE,
} from "../codex/prompt-builder.js";
import { computeReviewedFingerprint } from "./reviewed-fingerprint.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { buildSummary } from "../reporter/summary.js";
import { buildKnowledgeCandidates } from "../reporter/knowledge-candidates.js";
import { buildReviewRequest } from "../reporter/review-request.js";
import { buildReviewDecision } from "../reporter/review-decision.js";
import {
  buildUntrackedPatch,
  buildUntrackedDeniedReport,
  buildUntrackedSecretsReport,
} from "../reporter/untracked-patch.js";

/**
 * Surface a failed artifact-body ingest (Phase 8-2). The run still
 * succeeded — its bodies are file-backed — but the DB-canonical copy is
 * missing until `harness db migrate-artifacts` is run, so it is a loud
 * warning rather than a silently swallowed failure.
 */
function warnArtifactIngestFailed(runId: string, e: unknown): void {
  process.stderr.write(
    `warning: run ${runId}: artifact body ingestion into the DB failed: ` +
      `${(e as Error).message} — run \`harness db migrate-artifacts\` to recover\n`,
  );
}

export interface RunDomainCodingOpts {
  harnessRoot: string;
  repoPath: string;
  repoId: string;
  domain: string;
  goal: string;
  baseBranch: string;
  /** retained for forward compat with a future cleanup tool; ignored by the workflow */
  keepWorktree?: boolean;
  codexRunner: CodexExecRunner;
  now?: Date;
  /**
   * Set when this run is a rerun spawned from a previous changes_requested
   * run. Recorded in meta.json so reviewers can follow the chain.
   */
  parentRunId?: string;
  /** rerun chain root (see RunMeta.rootRunId). Set together with parentRunId. */
  rootRunId?: string;
  /** rerun attempt count from rootRunId (see RunMeta.rerunAttempt). */
  rerunAttempt?: number;
  /**
   * Promoted-knowledge context to inject into the codex prompt (Phase 3-4).
   * `text` is appended to the prompt; `path` is recorded in meta/events.
   */
  knowledgeContext?: { path: string; text: string };
  /**
   * Pre-compiled policy (Phase 5-7 `--project`). When set, the workflow
   * uses it instead of loading `policies/global.yaml` + the repo policy
   * file — a project profile compiles to exactly this {global, repo} pair.
   */
  compiledPolicy?: { global: GlobalPolicy; repo: RepoPolicy };
  /** project profile provenance, recorded in meta.json (Phase 5-7). */
  project?: RunMeta["project"];
  /**
   * Explicit project context packs (Phase 5-7). `promptText` is appended
   * to the codex prompt as reference material; `manifestYaml` is saved as
   * the `context-pack-manifest.yaml` artifact.
   */
  projectContextPacks?: { promptText: string; manifestYaml: string };
}

/**
 * Thrown by runDomainCoding when an unexpected exception finalized the run
 * as `failed-internal-error`. The run dir DOES exist and meta.status is
 * already written — this error just carries the runId so an orchestrator
 * (e.g. `harness workflow reviewed-run`) can record the failed attempt
 * instead of aborting. `message` is the underlying error's message.
 */
export class RunFinalizedError extends Error {
  readonly runId: string;
  readonly status: RunStatus;
  constructor(runId: string, status: RunStatus, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "RunFinalizedError";
    this.runId = runId;
    this.status = status;
  }
}

export interface RunDomainCodingResult {
  runId: string;
  status: RunStatus;
  safetyStatus: SafetyStatus;
  ignoredUntrackedCount: number;
  secretSuspectCount: number;
  commandResults: Array<{
    command: string;
    exitCode: number;
    durationMs: number;
    timedOut: boolean;
  }>;
}

const MATCH_OPTS = { dot: true, nocomment: true } as const;

async function readTail(path: string, maxBytes = 8 * 1024): Promise<string> {
  try {
    const buf = await readFile(path);
    if (buf.length <= maxBytes) return buf.toString("utf8");
    return buf.subarray(buf.length - maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Codex sometimes echoes the diff it just applied into stderr (via the
 * `git apply` subprocess), which then floods review-request.md and
 * summary.md. Truncate at the first `diff --git` block so reviewers see
 * the real error message instead of a re-quoted patch.
 */
export function filterPatchEcho(stderr: string): string {
  if (stderr === "") return "";
  const m = stderr.match(/(^|\n)diff --git /);
  if (!m) return stderr;
  const head = stderr.slice(0, m.index! + (m[1] ?? "").length).trimEnd();
  return `${head}\n[stderr omitted: patch-like output detected after this point]`;
}

async function readStderrTail(
  path: string,
  maxBytes = 8 * 1024,
): Promise<string> {
  return filterPatchEcho(await readTail(path, maxBytes));
}

function partitionUntracked(
  paths: readonly string[],
  ignoreGlobs: readonly string[],
): { kept: string[]; ignored: string[] } {
  if (ignoreGlobs.length === 0) return { kept: [...paths], ignored: [] };
  const kept: string[] = [];
  const ignored: string[] = [];
  for (const p of paths) {
    if (ignoreGlobs.some((g) => minimatch(p, g, MATCH_OPTS))) {
      ignored.push(p);
    } else {
      kept.push(p);
    }
  }
  return { kept, ignored };
}

interface DiffOutcome {
  ok: boolean;
  error?: string;
  trackedChangedPaths: string[];
  untrackedAll: string[];
  patch: string;
}

interface DiffAndValidate {
  diff: DiffOutcome;
  untrackedKept: string[];
  untrackedIgnored: string[];
  violations: Violation[];
  safetyStatus: SafetyStatus;
}

async function diffAndValidate(opts: {
  worktreePath: string;
  baseSha: string;
  gitTimeoutMs: number;
  policy: ResolvedPolicy;
}): Promise<DiffAndValidate> {
  const diff = await attemptDiff(
    opts.worktreePath,
    opts.baseSha,
    opts.gitTimeoutMs,
  );
  const { kept: untrackedKept, ignored: untrackedIgnored } = partitionUntracked(
    diff.untrackedAll,
    opts.policy.ignoreUntracked,
  );
  let violations: Violation[] = [];
  let safetyStatus: SafetyStatus;
  if (!diff.ok) {
    safetyStatus = "skipped";
  } else {
    const allChangedPaths = [...diff.trackedChangedPaths, ...untrackedKept];
    const validation = validateChangedPaths(opts.policy, allChangedPaths);
    violations = validation.violations;
    safetyStatus = validation.status === "allowed" ? "allowed" : "denied";
  }
  return { diff, untrackedKept, untrackedIgnored, violations, safetyStatus };
}

async function attemptDiff(
  worktreePath: string,
  baseSha: string,
  gitTimeoutMs: number,
): Promise<DiffOutcome> {
  try {
    const d = await collectDiff({
      repoPath: worktreePath,
      baseSha,
      timeoutMs: gitTimeoutMs,
    });
    return {
      ok: true,
      trackedChangedPaths: d.trackedChangedPaths,
      untrackedAll: d.untrackedPaths,
      patch: d.patch,
    };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      trackedChangedPaths: [],
      untrackedAll: [],
      patch: "",
    };
  }
}

export async function runDomainCoding(
  opts: RunDomainCodingOpts,
): Promise<RunDomainCodingResult> {
  const paths = harnessPaths(opts.harnessRoot);
  // a `--project` run supplies a pre-compiled {global, repo}; otherwise
  // load the policy YAML files for the given repo id.
  const { global, repo } = opts.compiledPolicy ?? {
    global: await loadGlobalPolicy(paths.globalPolicyPath),
    repo: await loadRepoPolicy(paths.repoPolicyPath(opts.repoId)),
  };
  const policy: ResolvedPolicy = resolvePolicy(global, repo, opts.domain);
  const gitTimeoutMs = policy.limits.gitTimeoutMs;

  const runId = generateRunId({
    domain: opts.domain,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const branch = runBranchName(runId, opts.domain);
  const startedAt = (opts.now ?? new Date()).toISOString();

  const lock = await acquireDomainLock({
    locksDir: paths.locksDir,
    domain: opts.domain,
    runId,
    repoId: opts.repoId,
  });

  // Phase 7: the run is DB-first. Open the harness DB (read-write) and
  // ensure the schema is current before any run state is written; the
  // run log writes the DB and exports `meta.json` / `events.jsonl`.
  let db: Database.Database | undefined;
  // Phase 9-5: dual-lock — alongside the file lock above, hold a
  // DB-backed lease (with heartbeat) so a stolen lease can be detected
  // and the file lock can be retired in Phase 10.
  let dbLock: DbDomainLockHandle | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const domainKey = `${opts.repoId}::${opts.domain}`;
  try {
    db = openDb(paths.dbPath);
    runMigrations(db);

    // acquire the DB lease. The file lock above already serializes
    // contenders, so this is mostly book-keeping during Phase 9; in
    // Phase 10 the file lock goes away and the DB lease becomes primary.
    dbLock = acquireDbDomainLock(db, {
      domainKey,
      repoId: opts.repoId,
      domain: opts.domain,
      runId,
      pid: process.pid,
      hostname: hostname(),
    });
    heartbeatTimer = setInterval(() => {
      try {
        dbLock?.heartbeat();
      } catch (e) {
        // a lost lease will surface as a fencing-guard rejection on the
        // next write (Phase 9-6); surface a warning here too.
        process.stderr.write(
          `warning: domain lease heartbeat failed for ${runId}: ` +
            `${(e as Error).message}\n`,
        );
      }
    }, heartbeatIntervalMs());
    // do not keep the event loop alive solely for the heartbeat tick.
    heartbeatTimer.unref?.();

    // Phase 7-6: a rerun produces exactly one child. The duplicate check
    // runs UNDER the domain lock — two reruns of the same parent share a
    // domain, so the lock serializes them and check-then-create is atomic.
    if (opts.parentRunId !== undefined) {
      const existingChild = db
        .prepare("SELECT run_id FROM runs WHERE parent_run_id = ? LIMIT 1")
        .get(opts.parentRunId) as { run_id: string } | undefined;
      if (existingChild !== undefined) {
        throw new RerunGateError(
          `parent run ${opts.parentRunId} already has a rerun child ` +
            `(${existingChild.run_id}); refusing to create a second one`,
        );
      }
    }

    const baseSha = await resolveBaseSha({
      repoPath: opts.repoPath,
      baseBranch: opts.baseBranch,
      timeoutMs: gitTimeoutMs,
    });

    const log = createDbRunLog({
      db,
      runsDir: paths.runsDir,
      runId,
      meta: {
        runId,
        repoId: opts.repoId,
        repoPath: opts.repoPath,
        domain: opts.domain,
        workflow: "domain-coding",
        baseBranch: opts.baseBranch,
        baseSha,
        runBranch: branch,
        status: "running",
        ...(opts.parentRunId !== undefined
          ? { parentRunId: opts.parentRunId }
          : {}),
        ...(opts.rootRunId !== undefined
          ? { rootRunId: opts.rootRunId }
          : {}),
        ...(opts.rerunAttempt !== undefined
          ? { rerunAttempt: opts.rerunAttempt }
          : {}),
        ...(opts.knowledgeContext !== undefined
          ? {
              knowledgeContext: {
                enabled: true,
                contextFile: opts.knowledgeContext.path,
              },
            }
          : {}),
        ...(opts.project !== undefined ? { project: opts.project } : {}),
        promptTemplate: {
          name: CODER_PROMPT_TEMPLATE.name,
          version: CODER_PROMPT_TEMPLATE.version,
        },
        startedAt,
      },
    });

    // Phase 9-6: stamp the run row with the lease fencing token so
    // run-execution writes can verify the active lease via EXISTS.
    db.prepare(
      `UPDATE runs SET lease_lock_id = ?, lease_token = ?,
         lease_domain_key = ?
       WHERE run_id = ?`,
    ).run(dbLock.lockId, dbLock.fencingToken, domainKey, runId);

    // Any failure after createDbRunLog leaves status='running' in the DB.
    // Wrap the rest of the workflow so unexpected throws still finalize the
    // run as failed-internal-error instead of silently rotting the status.
    try {
      return await runDomainCodingInner({
        opts,
        policy,
        paths,
        runId,
        branch,
        baseSha,
        gitTimeoutMs,
        log,
        db,
      });
    } catch (e) {
      await log
        .emit({ type: "run_failed", error: (e as Error).message })
        .catch(() => {});
      // ingest the artifact manifest + bodies BEFORE the failure finalize,
      // so the finalize export records whatever artifacts the partial run
      // produced in `exported_files` — same ordering as the happy path
      // (Phase 8 — external review P1-2).
      try {
        ingestRunArtifacts(db, log.runDir, runId);
      } catch (e) {
        warnArtifactIngestFailed(runId, e);
      }
      await log
        .finalize({
          status: "failed-internal-error",
          safetyStatus: "skipped",
          ignoredUntrackedCount: 0,
          secretSuspectCount: 0,
          commandResults: [],
          changedFilesCount: 0,
          finishedAt: new Date().toISOString(),
        })
        .catch(() => {});
      // Rethrow as a typed error carrying the (now finalized) runId so an
      // orchestrator can record the failed attempt. `harness run` still
      // surfaces it as an exception (message preserved) → exit 2.
      throw new RunFinalizedError(runId, "failed-internal-error", e);
    }
  } finally {
    // teardown order (mirrors §A2 of the Phase 9 design):
    //   1. stop heartbeat
    //   2. release DB lease (uses the still-open db connection)
    //   3. close DB
    //   4. release file lock
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (dbLock !== undefined) {
      try {
        dbLock.release({ reason: "normal", releasedBy: `pid:${process.pid}` });
      } catch {
        // DB may be in a bad state; the lease will eventually expire.
      }
    }
    try {
      db?.close();
    } finally {
      await lock.release();
    }
  }
}

interface InnerOpts {
  opts: RunDomainCodingOpts;
  policy: ResolvedPolicy;
  paths: ReturnType<typeof harnessPaths>;
  runId: string;
  branch: string;
  baseSha: string;
  gitTimeoutMs: number;
  log: RunLog;
  db: Database.Database;
}

async function runDomainCodingInner(
  inner: InnerOpts,
): Promise<RunDomainCodingResult> {
  const { opts, policy, paths, runId, branch, baseSha, gitTimeoutMs, log, db } =
    inner;
    await log.emit({ type: "run_started", runId, baseSha });
    await writeArtifact(
      join(log.runDir, "resolved-policy.yaml"),
      yamlStringify(policy),
    );

    const wt = await createWorktree({
      repoPath: opts.repoPath,
      worktreesDir: paths.workspacesDir,
      runId,
      branch,
      base: baseSha,
      timeoutMs: gitTimeoutMs,
    });
    await log.emit({ type: "worktree_created", path: wt.path });

    const prompt = buildCodexPrompt({
      goal: opts.goal,
      policy,
      ...(opts.knowledgeContext !== undefined
        ? { knowledgeContext: opts.knowledgeContext.text }
        : {}),
      ...(opts.projectContextPacks !== undefined
        ? { projectContextPacks: opts.projectContextPacks.promptText }
        : {}),
    });
    await writeArtifact(join(log.runDir, "codex-prompt.md"), prompt);
    if (opts.knowledgeContext !== undefined) {
      await log.emit({
        type: "knowledge_context_loaded",
        contextFile: opts.knowledgeContext.path,
      });
    }
    if (opts.projectContextPacks !== undefined) {
      await writeArtifact(
        join(log.runDir, "context-pack-manifest.yaml"),
        opts.projectContextPacks.manifestYaml,
      );
    }

    await log.emit({ type: "codex_exec_started" });
    const codexStdoutPath = join(log.runDir, "codex-output.log");
    const codexStderrPath = join(log.runDir, "codex-error.log");
    const codex = await opts.codexRunner.run({
      worktreePath: wt.path,
      prompt,
      logPaths: { stdout: codexStdoutPath, stderr: codexStderrPath },
    });
    await log.emit({
      type: "codex_exec_completed",
      exitCode: codex.exitCode,
      timedOut: codex.timedOut,
    });
    await log.setStatus("generated");

    // Pass 1: post-codex diff + validation. This determines whether commands
    // are safe to invoke (we don't want to run npm test in a worktree that
    // already violates write scope).
    let dv = await diffAndValidate({
      worktreePath: wt.path,
      baseSha,
      gitTimeoutMs,
      policy,
    });
    if (!dv.diff.ok) {
      await log.emit({
        type: "diff_collection_failed",
        error: dv.diff.error,
        stage: "post-codex",
      });
    } else {
      await log.emit({
        type: "policy_validation_completed",
        status: dv.safetyStatus === "allowed" ? "allowed" : "denied",
        stage: "post-codex",
      });
    }

    // Pass 2: run allowed commands and RE-COLLECT diff + RE-VALIDATE. A
    // command (formatter, build script) can modify the worktree in ways
    // path policy would reject; artifacts must reflect the post-command
    // worktree, not the pre-command snapshot.
    let commandResults: Array<{
      command: string;
      exitCode: number;
      durationMs: number;
      timedOut: boolean;
    }> = [];
    let commandsRan = false;
    let commandsPassed = true;
    if (
      dv.diff.ok &&
      dv.safetyStatus === "allowed" &&
      !codex.timedOut &&
      codex.exitCode === 0 &&
      policy.allowedCommands.length > 0
    ) {
      await log.setStatus("verified");
      await log.emit({
        type: "commands_started",
        count: policy.allowedCommands.length,
      });
      const cmdRun = await runAllowedCommands({
        worktreePath: wt.path,
        commands: policy.allowedCommands,
        logDir: join(log.runDir, "commands"),
        timeoutMs: policy.commandDefaults.timeoutMs,
        ...(policy.commandDefaults.envAllowlist !== undefined
          ? { envAllowlist: policy.commandDefaults.envAllowlist }
          : {}),
      });
      commandResults = cmdRun.results.map((r) => ({
        command: r.command,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
      }));
      commandsRan = true;
      commandsPassed = cmdRun.allPassed;
      await log.emit({
        type: "commands_completed",
        results: commandResults,
        allPassed: cmdRun.allPassed,
      });

      // Re-collect diff + re-validate against the post-command worktree.
      dv = await diffAndValidate({
        worktreePath: wt.path,
        baseSha,
        gitTimeoutMs,
        policy,
      });
      if (!dv.diff.ok) {
        await log.emit({
          type: "diff_collection_failed",
          error: dv.diff.error,
          stage: "post-command",
        });
      } else {
        await log.emit({
          type: "policy_validation_completed",
          status: dv.safetyStatus === "allowed" ? "allowed" : "denied",
          stage: "post-command",
        });
      }
    }

    const { diff, untrackedKept, untrackedIgnored } = dv;
    const safetyStatus = dv.safetyStatus;
    const violations = dv.violations;
    const violatedPaths = new Set<string>(violations.map((v) => v.path));
    await log.setSafetyStatus(safetyStatus);

    // Split untracked into (allowed, denied). Only allowed content is
    // inlined into untracked-files.patch. Denied paths get a metadata-only
    // report so reviewers can see *what* was there without harness
    // persisting the bytes.
    const untrackedAllowed: string[] = [];
    const untrackedDenied: string[] = [];
    for (const p of untrackedKept) {
      if (violatedPaths.has(p)) untrackedDenied.push(p);
      else untrackedAllowed.push(p);
    }

    await writeArtifact(join(log.runDir, "final-diff.patch"), diff.patch);
    let secretSuspects: { path: string; reasons: string[] }[] = [];
    if (untrackedAllowed.length > 0) {
      await writeArtifact(
        join(log.runDir, "untracked-files.txt"),
        `${untrackedAllowed.join("\n")}\n`,
      );
      const result = await buildUntrackedPatch(wt.path, untrackedAllowed);
      await writeArtifact(
        join(log.runDir, "untracked-files.patch"),
        result.patch,
      );
      secretSuspects = result.secretSuspects;
      if (secretSuspects.length > 0) {
        await writeArtifact(
          join(log.runDir, "untracked-secrets.txt"),
          buildUntrackedSecretsReport(secretSuspects),
        );
        await log.emit({
          type: "secret_suspects_redacted",
          count: secretSuspects.length,
          paths: secretSuspects.map((s) => s.path),
        });
      }
    }
    if (untrackedDenied.length > 0) {
      const deniedReport = await buildUntrackedDeniedReport(
        wt.path,
        untrackedDenied,
      );
      await writeArtifact(
        join(log.runDir, "untracked-denied.txt"),
        deniedReport,
      );
    }
    // Reviewed file set + content fingerprint over the final (post-command
    // if commands ran) worktree. `harness pr create` re-checks this to
    // refuse a PR if a reviewed file drifted after approval.
    let reviewed: { paths: string[]; fingerprint: string } | undefined;
    if (diff.ok) {
      await log.emit({
        type: "diff_collected",
        tracked: diff.trackedChangedPaths,
        untrackedAllowed,
        untrackedDenied,
        ignored: untrackedIgnored,
        // reflects which worktree state these lists describe: when commands
        // ran, the diff was re-collected against the post-command worktree.
        stage: commandsRan ? "post-command" : "post-codex",
      });
      const reviewedPaths = [
        ...diff.trackedChangedPaths,
        ...untrackedAllowed,
      ];
      reviewed = {
        paths: reviewedPaths,
        fingerprint: await computeReviewedFingerprint(
          wt.path,
          reviewedPaths,
        ),
      };
    }

    // Phase 7-4: persist the diff-verification result to the DB. Phase 6
    // left run_changed_files / policy_violations empty (the importer
    // cannot derive them from files); a DB-first run writes them here
    // from the in-memory validation result.
    const runRepo = new RunRepository(db);
    runRepo.upsertViolations(
      runId,
      violations.map((v) => ({ path: v.path, rule: v.reason })),
    );
    if (diff.ok) {
      const diffSource = commandsRan ? "post-command" : "post-codex";
      const changedFiles: ChangedFileInput[] = [
        ...diff.trackedChangedPaths.map((p) => ({
          path: p,
          status: "tracked",
          allowed: !violatedPaths.has(p),
          source: diffSource,
        })),
        ...untrackedAllowed.map((p) => ({
          path: p,
          status: "untracked",
          allowed: true,
          source: diffSource,
        })),
        ...untrackedDenied.map((p) => ({
          path: p,
          status: "untracked",
          allowed: false,
          source: diffSource,
        })),
        ...untrackedIgnored.map((p) => ({
          path: p,
          status: "ignored",
          allowed: true,
          source: diffSource,
        })),
      ];
      runRepo.upsertChangedFiles(runId, changedFiles);
    }

    // Status priority (evaluated against POST-command worktree if commands ran):
    //   diff failure > codex timeout > codex non-zero > policy violation
    //   > command failure > needs_review
    // safetyStatus is reported independently so callers can detect e.g.
    // "timeout AND scope violation" cases.
    let status: RunStatus;
    if (!diff.ok) {
      status = "failed-diff-collection";
    } else if (codex.timedOut) {
      status = "failed-codex-timeout";
    } else if (codex.exitCode !== 0) {
      status = "failed-codex";
    } else if (safetyStatus === "denied") {
      // a denied state here may be (a) codex itself, or (b) a command that
      // wrote outside scope post-validation. Either way → policy violation.
      status = "failed-policy-violation";
    } else if (commandsRan && !commandsPassed) {
      status = "failed-command";
    } else {
      status = "needs_review";
    }

    const codexStdoutTail = await readTail(codexStdoutPath);
    const codexStderrTail = await readStderrTail(codexStderrPath);
    const finalDiffPath = join(log.runDir, "final-diff.patch");
    const summaryPath = join(log.runDir, "summary.md");
    const knowledgeCandidatesPath = join(
      log.runDir,
      "knowledge-candidates.yaml",
    );
    const reviewDecisionPath = join(log.runDir, "review-decision.yaml");
    const untrackedPatchPath =
      untrackedAllowed.length > 0
        ? join(log.runDir, "untracked-files.patch")
        : undefined;

    const secretSuspectPaths = secretSuspects.map((s) => s.path);
    const summary = buildSummary({
      runId,
      domain: opts.domain,
      goal: opts.goal,
      status,
      safetyStatus,
      changedPaths: diff.trackedChangedPaths,
      untrackedPaths: untrackedKept,
      ignoredUntrackedPaths: untrackedIgnored,
      secretSuspectPaths,
      violations,
      codexExitCode: codex.exitCode,
      codexTimedOut: codex.timedOut,
      codexStdoutTail,
      codexStderrTail,
      ...(diff.error ? { diffCollectionError: diff.error } : {}),
    });
    await writeArtifact(summaryPath, summary);

    const knowledge = buildKnowledgeCandidates({
      runId,
      domain: opts.domain,
      status,
      violations,
      secretSuspectCount: secretSuspects.length,
      ignoredUntrackedCount: untrackedIgnored.length,
      changedFilesCount:
        diff.trackedChangedPaths.length + untrackedKept.length,
      codexExitCode: codex.exitCode,
      codexTimedOut: codex.timedOut,
    });
    await writeArtifact(knowledgeCandidatesPath, knowledge);

    await writeArtifact(
      reviewDecisionPath,
      buildReviewDecision({ runId, domain: opts.domain }),
    );
    await writeArtifact(
      join(log.runDir, "review-request.md"),
      buildReviewRequest({
        runId,
        domain: opts.domain,
        goal: opts.goal,
        status,
        safetyStatus,
        baseSha,
        runBranch: branch,
        worktreePath: wt.path,
        changedPaths: diff.trackedChangedPaths,
        untrackedPaths: untrackedKept,
        ignoredUntrackedPaths: untrackedIgnored,
        secretSuspectPaths,
        violations,
        codexExitCode: codex.exitCode,
        codexTimedOut: codex.timedOut,
        codexStdoutTail,
        codexStderrTail,
        ...(diff.error ? { diffCollectionError: diff.error } : {}),
        finalDiffPath,
        ...(untrackedPatchPath ? { untrackedPatchPath } : {}),
        summaryPath,
        knowledgeCandidatesPath,
        reviewDecisionPath,
      }),
    );

    // Worktree intentionally kept regardless of status — review and cleanup
    // are deferred to a follow-up tool that consumes review-decision.yaml.

    const ignoredUntrackedCount = untrackedIgnored.length;
    const secretSuspectCount = secretSuspects.length;
    const changedFilesCount =
      diff.trackedChangedPaths.length + untrackedAllowed.length;
    // Phase 8-2: ingest the artifact manifest + bodies into the DB now
    // that every artifact body has been written. This runs BEFORE
    // `finalize` so the finalize export sees the `storage='db'` rows and
    // records the artifact bodies in `exported_files` — otherwise
    // `check-consistency` could not detect drift on summary.md /
    // final-diff.patch etc. (Phase 8 — external review P1-2).
    // A failure does NOT flip a completed run to failed-internal-error —
    // the run succeeded — but it IS surfaced as a warning.
    try {
      ingestRunArtifacts(db, log.runDir, runId);
    } catch (e) {
      warnArtifactIngestFailed(runId, e);
    }
    await log.finalize({
      status,
      safetyStatus,
      ignoredUntrackedCount,
      secretSuspectCount,
      commandResults,
      changedFilesCount,
      ...(reviewed ? { reviewed } : {}),
      finishedAt: new Date().toISOString(),
    });
    await log.emit({
      type: "run_completed",
      status,
      safetyStatus,
      ignoredUntrackedCount,
      secretSuspectCount,
      commandResultsCount: commandResults.length,
      changedFilesCount,
    });
    return {
      runId,
      status,
      safetyStatus,
      ignoredUntrackedCount,
      secretSuspectCount,
      commandResults,
    };
}
