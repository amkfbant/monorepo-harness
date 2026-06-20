

import { performance } from "node:perf_hooks";
import { stringify as yamlStringify } from "yaml";
import { harnessPaths } from "../config/paths.js";
import { harnessVersion } from "../config/version.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";

import type { ResolvedPolicy } from "../policy/schema.js";
import type Database from "better-sqlite3";
import type { RunMeta } from "../logging/run-log.js";
import { openManagedDb, type ManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { SCHEMA_VERSION } from "../db/schema.js";
import { createDbRunLog } from "../db/run-log-db.js";
import { ingestRunArtifacts } from "../db/run-artifacts.js";
import { fileExportEnabled } from "../config/export-mode.js";
import { rmSync } from "node:fs";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";
import { RunRepository } from "../db/repositories/runs.js";
import { recordEffectivePolicySnapshot } from "../db/repositories/policy-templates.js";
import { RerunGateError } from "./rerun.js";

import { generateRunId } from "./run-id.js";

import { warnLegacyFileLocks } from "../workspace/legacy-file-lock-warning.js";

import { acquireDomainLock as acquireDbDomainLock, heartbeatIntervalMs, assertActiveLease, LeaseGuardFailedError, type DomainLockHandle as DbDomainLockHandle } from "../workspace/db-domain-lock.js";
import { hostname } from "node:os";
import { runBranchName } from "../workspace/branch-name.js";

import { resolveBaseSha } from "../git/diff.js";

import { CODER_PROMPT_TEMPLATE } from "../codex/prompt-builder.js";

import { warnArtifactIngestFailed, RunFinalizedError } from "./workflow-runner-shared.js";
import type { RunDomainCodingOpts, RunDomainCodingResult } from "./workflow-runner-shared.js";
import { snapshotReviewRuleForRun, runDomainCodingInner } from "./workflow-runner-inner.js";
// Re-export the public surface that moved to the split modules so existing
// importers keep using "./workflow-runner.js".
export {
  VALIDATED_CONTINUATION_STATUSES,
  isValidatedContinuationParent,
} from "./workflow-runner-shared.js";
export type {
  ContinueFromSkipReason,
  ContinueFromSpec,
  RunChangeBudgetOverride,
} from "./workflow-runner-shared.js";
export { RunFinalizedError };
export type { RunDomainCodingOpts, RunDomainCodingResult };
export {
  filterPatchEcho,
  countTextLinesStreaming,
  materializeParentWork,
  WorktreeResetError,
} from "./workflow-runner-diff.js";
export type { MaterializeOutcome } from "./workflow-runner-diff.js";

export async function runDomainCoding(
  opts: RunDomainCodingOpts,
): Promise<RunDomainCodingResult> {
  const runStartedAt = performance.now();
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

  // Phase 10-1: the file domain lock (.harness/locks/*.lock) is retired;
  // the DB domain lock below is the sole serialization. Surface a one-shot
  // warning if older harness binaries left lock sentinels behind.
  warnLegacyFileLocks(paths.locksDir);

  // Phase 7: the run is DB-first. Open the harness DB (read-write) and
  // ensure the schema is current before any run state is written; the
  // run log writes the DB and exports `meta.json` / `events.jsonl`.
  //
  // Phase 9 post-close P0 fix: open through the managed wrapper so the
  // DB-wide shared maintenance lock is held for the lifetime of the run
  // — a concurrent `db restore` must wait until this run releases the
  // lock (after the DB handle is closed, see teardown below).
  let dbHandle: ManagedDb | undefined;
  let db: Database.Database | undefined;
  // Phase 10-1: DB-backed domain lease (with heartbeat) is the sole
  // serialization for this domain. A stolen lease is detected by the
  // active-lease guard on the next write (see assertActiveLease).
  let dbLock: DbDomainLockHandle | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const domainKey = `${opts.repoId}::${opts.domain}`;
  try {
    dbHandle = openManagedDb({ dbPath: paths.dbPath });
    db = dbHandle.db;
    runMigrations(db);
    // Phase 9-11: refuse runtime writes when the DB still has legacy-file
    // rows — operators must run `db migrate-legacy` first. Migration tools
    // bypass this guard themselves.
    assertNoLegacyRuntimeRows(db);

    // acquire the DB lease — the only domain serialization in Phase 10
    // (Phase 9 also held a file lock; that has been retired).
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

    // Phase 7-6 / (#163): a rerun produces exactly one child. The duplicate
    // check runs UNDER the domain lock — two reruns of the same parent share a
    // domain, so the lock serializes them and check-then-create is atomic. The
    // gate keys on the lineage parent of EITHER rerun path: `parentRunId` (the
    // non-hitch `harness rerun` flow) OR `continuationParentRunId` (the hitch
    // continuation path, set on success AND on a fail-closed skip), so two
    // concurrent orchestrators resolving the same parent cannot both create a
    // child. Sequential reruns do not false-trip: each child's row records its
    // OWN parent, so the gate for the NEXT parent finds no existing child.
    const dupGateParentRunId =
      opts.parentRunId ?? opts.continuationParentRunId;
    if (dupGateParentRunId !== undefined) {
      const existingChild = db
        .prepare("SELECT run_id FROM runs WHERE parent_run_id = ? LIMIT 1")
        .get(dupGateParentRunId) as { run_id: string } | undefined;
      if (existingChild !== undefined) {
        throw new RerunGateError(
          `parent run ${dupGateParentRunId} already has a rerun child ` +
            `(${existingChild.run_id}); refusing to create a second one`,
        );
      }
    }

    // (#163) Use the gate-validated base when the continuation resolver
    // supplied one — the diff base must equal the base the base-equality gate
    // checked against, with no re-resolve TOCTOU between gate and run. A bare
    // run (no continuation) — and a continuation the resolver DECLINED without a
    // base (e.g. its own base resolve failed) — re-resolves the base branch as
    // before: the normal fresh-from-base behavior. The skip reason is recorded
    // once the run row exists (no extra throw is introduced on that path).
    if (
      opts.resolvedBaseSha !== undefined &&
      !/^[0-9a-f]{7,40}$/.test(opts.resolvedBaseSha)
    ) {
      // defense-in-depth: a gate-validated base must be a hex SHA. A malformed
      // value would otherwise become the diff/policy base — fail closed.
      throw new Error(
        `resolvedBaseSha is not a valid git SHA: ${opts.resolvedBaseSha}`,
      );
    }
    const baseSha =
      opts.resolvedBaseSha ??
      (await resolveBaseSha({
        repoPath: opts.repoPath,
        baseBranch: opts.baseBranch,
        timeoutMs: gitTimeoutMs,
      }));

    const policySnapshot = recordEffectivePolicySnapshot(db, {
      runId,
      ...(opts.project?.projectId !== undefined
        ? { projectId: opts.project.projectId }
        : {}),
      repoId: opts.repoId,
      domain: opts.domain,
      generatedPolicyYaml: yamlStringify(policy),
      provenance: {
        source: opts.compiledPolicy !== undefined ? "project-runtime" : "repo-policy",
        project: opts.project ?? null,
      },
    });

    const assetAttribution: RunMeta["assetAttribution"] = {
      ...(opts.project?.profileRevisionId !== undefined
        ? { projectProfileRevisionId: opts.project.profileRevisionId }
        : {}),
      effectivePolicySnapshotId: policySnapshot.snapshotId,
      ...(opts.knowledgeContext?.revisionIds !== undefined
        ? { knowledgeRevisionIds: opts.knowledgeContext.revisionIds }
        : {}),
    };

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
        // (#163) Lineage parent recorded in meta → run row `parent_run_id`.
        // The hitch continuation path sets `continuationParentRunId` (lineage +
        // dup-fence) on BOTH a materialized continuation and a fail-closed skip,
        // so the rerun chain/audit is recorded even when materialization was
        // skipped (never becomes a new root). `parentRunId` (the non-hitch rerun
        // path) takes precedence; `continueFrom` is the legacy fallback.
        ...(opts.parentRunId !== undefined
          ? { parentRunId: opts.parentRunId }
          : opts.continuationParentRunId !== undefined
            ? { parentRunId: opts.continuationParentRunId }
            : opts.continueFrom !== undefined
              ? { parentRunId: opts.continueFrom.parentRunId }
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
        assetAttribution,
        promptTemplate: {
          name: CODER_PROMPT_TEMPLATE.name,
          version: CODER_PROMPT_TEMPLATE.version,
        },
        startedAt,
      },
      provenance: {
        harnessVersion: harnessVersion(),
        schemaVersionAtRun: SCHEMA_VERSION,
        codexModel: null,
        codexBinaryVersion: opts.codexBinaryVersion ?? null,
      },
      // Phase 9 post-close P2 #1 fix — stamp the lease fencing token in
      // the SAME INSERT as the run row so `assertActiveLease` is
      // enforceable from the very first write (Phase 9-6 fencing guard).
      // Previously a UPDATE happened after `createDbRunLog`, leaving a
      // tiny bootstrap window where the row + export ran without the
      // lease columns populated.
      lease: {
        lockId: dbLock.lockId,
        fencingToken: dbLock.fencingToken,
        domainKey,
      },
    });

    // Any failure after createDbRunLog leaves status='running' in the DB.
    // Wrap the rest of the workflow so unexpected throws still finalize the
    // run as failed-internal-error instead of silently rotting the status.
    try {
      snapshotReviewRuleForRun({ opts, db, runId });
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
        runStartedAt,
      });
    } catch (e) {
      // Phase 9 post-close (second review) P1-6 — detect a stolen-lease
      // case up front. Once the lease is gone, every commitThenExport
      // call (emit / finalize / ingest with lease guard) will throw
      // LeaseGuardFailedError again, leaving runs.status stuck at
      // 'running'. The fallback path uses `forceFailFinalize` which
      // bypasses the lease guard and uses an expected-status guard.
      const leaseLost = e instanceof LeaseGuardFailedError;

      await log
        .emit({ type: "run_failed", error: (e as Error).message })
        .catch(() => {});
      // ingest the artifact manifest + bodies BEFORE the failure finalize,
      // so the finalize export records whatever artifacts the partial run
      // produced in `exported_files` — same ordering as the happy path
      // (Phase 8 — external review P1-2). Skip on lease-lost because
      // assertActiveLease is the failure mode we're recovering from.
      let ingestOk = false;
      if (!leaseLost) {
        try {
          assertActiveLease(db, runId);
          ingestRunArtifacts(db, log.runDir, runId);
          ingestOk = true;
        } catch (inner) {
          warnArtifactIngestFailed(runId, inner);
        }
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
      // P1-6 fallback — if RunLog.finalize couldn't flip the status
      // (lease guard rejected it, transaction error, etc.), force the
      // run to `failed-internal-error` via the lease-bypass path so the
      // row doesn't rot at 'running'. forceFailFinalize is no-op on a
      // row that already reached a terminal status.
      //
      // Phase 10-2: on a stolen-lease recovery, pass the lost lockId so
      // a *new* attempt that reacquired this same run_id under a fresh
      // lease (rerun) is not flipped by this finalize.
      try {
        new RunRepository(db).forceFailFinalize({
          runId,
          finishedAt: new Date().toISOString(),
          reason: leaseLost ? "lease_lost" : "internal_error",
          errorMessage: (e as Error).message,
          ...(leaseLost && dbLock !== undefined
            ? { lostLockId: dbLock.lockId }
            : {}),
        });
      } catch {
        // last-resort: lease was lost AND the DB is unhappy; the lease
        // will eventually expire and a Phase 10 maintenance command can
        // mark orphans. Surface a warning so an operator notices.
        process.stderr.write(
          `warning: could not force-finalize run ${runId} after lease loss\n`,
        );
      }
      // Phase 9-7: with export OFF, remove the scratch run dir on the
      // failure path too — only when the ingest actually captured what
      // the partial run produced. Keep the dir otherwise (debug aid).
      if (ingestOk && !fileExportEnabled()) {
        try {
          rmSync(log.runDir, { recursive: true, force: true });
        } catch {
          // best-effort cleanup
        }
      }
      // Rethrow as a typed error carrying the (now finalized) runId so an
      // orchestrator can record the failed attempt. `harness run` still
      // surfaces it as an exception (message preserved) → exit 2.
      throw new RunFinalizedError(runId, "failed-internal-error", e);
    }
  } finally {
    // teardown order (Phase 10-1: file lock removed):
    //   1. stop heartbeat
    //   2. release DB lease (uses the still-open db connection)
    //   3. close DB AND release the shared maintenance lock (dbHandle.close
    //      does both, in that order)
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (dbLock !== undefined) {
      try {
        dbLock.release({ reason: "normal", releasedBy: `pid:${process.pid}` });
      } catch {
        // DB may be in a bad state; the lease will eventually expire.
      }
    }
    dbHandle?.close();
  }
}

