// orchestrator-runners の run-context 解決 + (#163) rerun continuation 事実読取り層。

import { existsSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { harnessPaths } from "../config/paths.js";

import { isValidatedContinuationParent, type ContinueFromSpec, type ContinueFromSkipReason, type RunDomainCodingOpts } from "../core/workflow-runner.js";
import { resolveBaseSha } from "../git/diff.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { DEFAULT_GIT_TIMEOUT_MS, GlobalPolicySchema, RepoPolicySchema } from "../policy/schema.js";

import type { HitchRepository } from "./repository.js";

import type { CompiledPolicyView } from "./jury/types.js";

import type { HitchAttemptType, HitchSession } from "./types.js";

import type { HitchRunContext, OrchestratorRunnerDeps, ProjectRuntimeDeps } from "./orchestrator-runners-types.js";

export function assertProjectRuntimeComplete(
  projectRuntime: ProjectRuntimeDeps | undefined,
): void {
  if (projectRuntime === undefined) return;
  if (projectRuntime === null || typeof projectRuntime !== "object") {
    throw new Error(
      "projectRuntime must be an object with compiledPolicy and project",
    );
  }
  const runtime = projectRuntime as Partial<ProjectRuntimeDeps>;
  // Reject nullish (not just undefined): runDomainCoding treats a null
  // compiledPolicy as absent (`?? raw`), so a malformed project-runtime would
  // silently fall back to the broader raw repo policy — the exact safety
  // boundary this gate exists to close.
  if (runtime.compiledPolicy == null || runtime.project == null) {
    throw new Error(
      "project runtime deps must be passed atomically as projectRuntime " +
        "with compiledPolicy and project",
    );
  }
  const compiled = runtime.compiledPolicy as { global?: unknown; repo?: unknown };
  if (compiled.global == null || compiled.repo == null) {
    throw new Error(
      "projectRuntime.compiledPolicy must contain both global and repo policy",
    );
  }
  if (runtime.reviewRuleResolution == null) {
    throw new Error(
      "project runtime deps must be passed atomically as projectRuntime " +
        "with reviewRuleResolution",
    );
  }
}

export function assertCoderProjectRuntime(
  deps: OrchestratorRunnerDeps,
  session: HitchSession,
): void {
  assertProjectRuntimeComplete(deps.projectRuntime);
  if (session.projectId !== null && deps.projectRuntime === undefined) {
    throw new Error(
      `hitch ${session.hitchId} is project-scoped (projectId=${session.projectId}); ` +
        "the coder runner requires compiled project policy via projectRuntime. " +
        "Raw repo policy fallback is a safety boundary violation.",
    );
  }
}

export function projectRuntimeFields(
  deps: OrchestratorRunnerDeps,
): Partial<
  Pick<
    RunDomainCodingOpts,
    "compiledPolicy" | "reviewRuleResolution" | "project" | "projectContextPacks"
  >
> {
  const projectRuntime = deps.projectRuntime;
  if (projectRuntime === undefined) return {};
  return {
    compiledPolicy: projectRuntime.compiledPolicy,
    reviewRuleResolution: projectRuntime.reviewRuleResolution,
    project: projectRuntime.project,
    ...(projectRuntime.projectContextPacks !== undefined
      ? { projectContextPacks: projectRuntime.projectContextPacks }
      : {}),
  };
}

export function defaultGoalText(session: HitchSession): string {
  const parts = [session.title, session.description ?? ""]
    .map((p) => p.trim())
    .filter((p) => p !== "");
  return parts.join("\n\n");
}

export function resolveRunContext(
  deps: OrchestratorRunnerDeps,
  session: HitchSession,
): HitchRunContext {
  if (deps.resolveRunContext !== undefined) {
    return deps.resolveRunContext(session);
  }
  if (session.repoId === null || session.domain === null) {
    throw new Error(
      `hitch ${session.hitchId} has no repoId/domain; cannot run the coder ` +
        `(provide resolveRunContext or set the hitch's repoId+domain)`,
    );
  }
  if (deps.repoPath === undefined) {
    throw new Error(
      `hitch ${session.hitchId}: no repoPath configured for the orchestrator ` +
        `(pass deps.repoPath or deps.resolveRunContext)`,
    );
  }
  return {
    repoPath: deps.repoPath,
    repoId: session.repoId,
    domain: session.domain,
    goal: defaultGoalText(session),
    baseBranch: deps.baseBranch ?? "main",
  };
}

/** Attempt types that produce a coding run whose runId review/PR operate on. */
export const CODING_ATTEMPT_TYPES = new Set<HitchAttemptType>(["implement", "rerun"]);

export interface LatestCodingRun {
  runId: string;
  iteration: number;
}

/**
 * The latest run id recorded against a hitch — the run the review / pr steps
 * operate on. Attempts are ordered (iteration ASC, created_at ASC), so the
 * last CODING attempt (implement / rerun) carrying a runId is the most recent
 * run. A close-check or other attempt's runId must not be picked.
 */
export function latestRunId(repo: HitchRepository, hitchId: string): string {
  return latestCodingRun(repo, hitchId).runId;
}

export function latestCodingRun(repo: HitchRepository, hitchId: string): LatestCodingRun {
  const found = latestCodingRunOrNull(repo, hitchId);
  if (found === null) {
    throw new Error(
      `hitch ${hitchId} has no recorded run yet; run the coder before reviewing`,
    );
  }
  return found;
}

export function latestCodingRunOrNull(
  repo: HitchRepository,
  hitchId: string,
): LatestCodingRun | null {
  const attempts = repo.listAttempts(hitchId);
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined) continue;
    if (!CODING_ATTEMPT_TYPES.has(attempt.attemptType)) continue;
    if (typeof attempt.runId === "string" && attempt.runId !== "") {
      return { runId: attempt.runId, iteration: attempt.iteration };
    }
  }
  return null;
}

/**
 * (#163) The continuation inputs for a rerun, threaded into `runDomainCoding`.
 * `continueFrom` + `resolvedBaseSha` drive the uncommitted materialization of
 * the parent run's work; the lineage fields populate meta.json / the rerun
 * chain. When a continuation cannot be set up safely the resolver returns
 * `continueFrom: undefined` and a `skippedReason` (fail-closed → fresh run).
 */
export interface ContinuationResolution {
  continueFrom?: ContinueFromSpec;
  /**
   * (#163 P2) Lineage parent — set on a materialized continuation AND on every
   * fail-closed skip that has a resolvable parent, so `runDomainCoding` records
   * the rerun chain (`parent_run_id` / dup-fence) even when materialization was
   * skipped. Absent only for `parent_run_missing` (no parent at all).
   */
  parentRunId?: string;
  resolvedBaseSha?: string;
  rootRunId?: string;
  rerunAttempt?: number;
  skippedReason?: ContinueFromSkipReason;
}

/** Minimal run-row fields the continuation resolver reads (read-only). */
export interface ParentRunRow {
  runId: string;
  baseSha: string | null;
  status: string | null;
  safetyStatus: string | null;
  parentRunId: string | null;
  rootRunId: string | null;
  rerunAttempt: number | null;
}

export function readRunRow(
  db: Database.Database,
  runId: string,
): ParentRunRow | null {
  const r = db
    .prepare(
      "SELECT run_id, base_sha, status, safety_status, parent_run_id, root_run_id, rerun_attempt " +
        "FROM runs WHERE run_id = ?",
    )
    .get(runId) as
    | {
        run_id: string;
        base_sha: string | null;
        status: string | null;
        safety_status: string | null;
        parent_run_id: string | null;
        root_run_id: string | null;
        rerun_attempt: number | null;
      }
    | undefined;
  if (r === undefined) return null;
  return {
    runId: r.run_id,
    baseSha: r.base_sha,
    status: r.status,
    safetyStatus: r.safety_status,
    parentRunId: r.parent_run_id,
    rootRunId: r.root_run_id,
    rerunAttempt: r.rerun_attempt,
  };
}

/**
 * (#163) Derive the rerun-chain root for a parent run. Fast path: the parent
 * already records `root_run_id`. Otherwise walk `parent_run_id` links up to
 * the root — a legacy parent that itself has a parentRunId must NOT default to
 * its own runId (that would re-root a chain mid-way). A parent with no
 * parentRunId is itself the root.
 */
export function deriveRootRunId(db: Database.Database, parent: ParentRunRow): string {
  if (parent.rootRunId !== null && parent.rootRunId !== "") {
    return parent.rootRunId;
  }
  if (parent.parentRunId === null || parent.parentRunId === "") {
    return parent.runId;
  }
  // Walk up parent_run_id links, bounded by the row count to avoid a cycle
  // hang (a corrupt self/loop link falls back to the deepest node reached).
  let current = parent;
  const seen = new Set<string>([current.runId]);
  for (let i = 0; i < 10_000; i++) {
    const next =
      current.parentRunId !== null && current.parentRunId !== ""
        ? readRunRow(db, current.parentRunId)
        : null;
    if (next === null) return current.runId;
    if (seen.has(next.runId)) return current.runId; // cycle guard
    if (next.rootRunId !== null && next.rootRunId !== "") return next.rootRunId;
    seen.add(next.runId);
    current = next;
  }
  return current.runId;
}

/**
 * (#163) The rerun_attempt for the NEXT child = parent depth + 1. Fast path:
 * the parent records `rerun_attempt` (its own depth) → child is `parent + 1`.
 * Otherwise the parent is a LEGACY rerun row whose `rerun_attempt` was never
 * stamped: reconstruct the parent's depth by walking `parent_run_id` links (the
 * number of ancestors), so a migrated chain keeps the correct depth instead of
 * collapsing to `0 + 1`. A run with no parentRunId is depth 0 (its child = 1).
 */
export function deriveRerunAttempt(db: Database.Database, parent: ParentRunRow): number {
  if (parent.rerunAttempt !== null) {
    return parent.rerunAttempt + 1;
  }
  if (parent.parentRunId === null || parent.parentRunId === "") {
    return 1; // parent is the root (depth 0) → its first child is attempt 1.
  }
  // Count ancestors via the parent_run_id chain (bounded; cycle-guarded).
  let depth = 0;
  let current = parent;
  const seen = new Set<string>([current.runId]);
  for (let i = 0; i < 10_000; i++) {
    if (current.parentRunId === null || current.parentRunId === "") break;
    const next = readRunRow(db, current.parentRunId);
    if (next === null) break;
    if (seen.has(next.runId)) break; // cycle guard
    // a stamped ancestor pins absolute depth: parent depth = ancestor + steps.
    if (next.rerunAttempt !== null) {
      depth += next.rerunAttempt + 1;
      return depth + 1;
    }
    depth += 1;
    seen.add(next.runId);
    current = next;
  }
  // parent depth = number of ancestors walked → child = depth + 1.
  return depth + 1;
}

/**
 * (#163) Resolve the effective `limits.gitTimeoutMs` the run will use, so the
 * resolver's read-only base `git rev-parse` is bounded by the SAME timeout as
 * the run itself. Uses the compiled project policy when present (mirroring
 * `runDomainCoding`), else loads the repo policy files; any load failure falls
 * back to the harness default rather than throwing on the read-only path.
 */
export async function resolveGitTimeoutMs(
  deps: OrchestratorRunnerDeps,
  context: HitchRunContext,
): Promise<number> {
  try {
    const paths = harnessPaths(deps.harnessRoot);
    const { global, repo } = deps.projectRuntime?.compiledPolicy ?? {
      global: await loadGlobalPolicy(paths.globalPolicyPath),
      repo: await loadRepoPolicy(paths.repoPolicyPath(context.repoId)),
    };
    return resolvePolicy(global, repo, context.domain).limits.gitTimeoutMs;
  } catch {
    return DEFAULT_GIT_TIMEOUT_MS;
  }
}

/**
 * (#230) Resolve the compiled policy view the jury's `verifyEvidence` resolves
 * `policy` citations against. Prefers the compiled project policy when present
 * (mirroring `runDomainCoding`), else loads the repo policy files. Any load
 * failure falls back to a minimal valid policy (empty domains) — a missing
 * policy must NOT throw on the read-only evidence path; an unresolvable policy
 * citation simply fails verification, which is the safe (fail-closed) outcome.
 */
export async function resolveJuryCompiledPolicy(
  deps: OrchestratorRunnerDeps,
  context: HitchRunContext,
): Promise<CompiledPolicyView> {
  if (deps.projectRuntime?.compiledPolicy !== undefined) {
    return deps.projectRuntime.compiledPolicy;
  }
  const paths = harnessPaths(deps.harnessRoot);
  try {
    return {
      global: await loadGlobalPolicy(paths.globalPolicyPath),
      repo: await loadRepoPolicy(paths.repoPolicyPath(context.repoId)),
    };
  } catch {
    return {
      global: GlobalPolicySchema.parse({}),
      repo: RepoPolicySchema.parse({ repo_id: context.repoId, domains: {} }),
    };
  }
}

/**
 * (#163) Sync DB-read half of the continuation resolver. Reads the latest
 * coding run row + derives the rerun-chain root + computes the parent worktree
 * path — all read-only, inside one short-lived DB handle. Returns null when
 * there is no resolvable parent (→ fresh-from-base, `parent_run_missing`).
 */
export interface ParentContinuationFacts {
  parentRunId: string;
  parentBaseSha: string;
  parentStatus: string | null;
  parentSafetyStatus: string | null;
  parentWorktreePath: string;
  rootRunId: string;
  rerunAttempt: number;
}

export function readParentContinuationFacts(opts: {
  db: Database.Database;
  repo: HitchRepository;
  hitchId: string;
  harnessRoot: string;
}): ParentContinuationFacts | null {
  const latest = latestCodingRunOrNull(opts.repo, opts.hitchId);
  if (latest === null) return null;
  const parent = readRunRow(opts.db, latest.runId);
  if (parent === null || parent.baseSha === null || parent.baseSha === "") {
    return null;
  }
  return {
    parentRunId: parent.runId,
    parentBaseSha: parent.baseSha,
    parentStatus: parent.status,
    parentSafetyStatus: parent.safetyStatus,
    parentWorktreePath: join(
      harnessPaths(opts.harnessRoot).workspacesDir,
      parent.runId,
      "repo",
    ),
    rootRunId: deriveRootRunId(opts.db, parent),
    // (#163 P3) chain-depth aware: a legacy parent with no rerun_attempt is not
    // collapsed to `0 + 1` — its depth is reconstructed from the parent chain.
    rerunAttempt: deriveRerunAttempt(opts.db, parent),
  };
}

/**
 * (#163) Async base-gate half of the continuation resolver. GATEs on (1) the
 * parent run being POLICY-VALIDATED (a completed+passed status, or
 * `failed-command` with safety_status=`allowed`), (2) base-equality
 * (parent.baseSha === the freshly resolved base), and (3) the parent worktree's
 * existence. Performs NO git mutation and NO DB write — only a read-only
 * `git rev-parse` for the base and a worktree-existence stat. Every ambiguity
 * fails CLOSED to a fresh run with a recorded `skippedReason`; a thrown git
 * error maps to `parent_work_unmaterializable`, never a throw.
 *
 * (#163 P2) LINEAGE is recorded on the success branch AND on every skip branch
 * with a resolvable parent — only the MATERIALIZATION is gated, never the rerun
 * chain / dup-fence audit.
 */
export async function gateContinuation(opts: {
  facts: ParentContinuationFacts;
  context: HitchRunContext;
  gitTimeoutMs: number;
}): Promise<ContinuationResolution> {
  const { facts } = opts;
  // Lineage is always recorded (chain + dup-fence), regardless of whether the
  // continuation materializes or fails closed to a fresh run.
  const lineage = {
    parentRunId: facts.parentRunId,
    rootRunId: facts.rootRunId,
    rerunAttempt: facts.rerunAttempt,
  };

  // (#163 P1 / #275) Validated-parent gate: continue ONLY from a run whose
  // persisted status/safety pair proves it passed path-policy validation. Most
  // eligible runs prove that by status alone (needs_review / approved /
  // changes_requested). `failed-command` never reached review, but it is
  // eligible when its final post-command policy verdict is safetyStatus=allowed:
  // the command failed after the worktree surface was already validated, so the
  // recovery rerun should amend that safe surface instead of starting blind.
  if (
    !isValidatedContinuationParent({
      status: facts.parentStatus,
      safetyStatus: facts.parentSafetyStatus,
    })
  ) {
    return { ...lineage, skippedReason: "parent_not_validated" };
  }

  let freshBaseSha: string;
  try {
    freshBaseSha = await resolveBaseSha({
      repoPath: opts.context.repoPath,
      baseBranch: opts.context.baseBranch,
      timeoutMs: opts.gitTimeoutMs,
    });
  } catch {
    // Cannot resolve the base → cannot prove base-equality; fail closed to a
    // fresh run. We deliberately return NO `resolvedBaseSha`: `runDomainCoding`
    // then resolves its own base for a normal fresh-from-base run (the existing
    // behavior) and records the skip reason once the run row exists. This is a
    // clean no-throw skip — the resolver does not pin a base it could not
    // resolve, and introduces no throw path before the run/attempt row.
    return { ...lineage, skippedReason: "parent_work_unmaterializable" };
  }

  // Base-equality gate: the parent's work was made against parent.baseSha. If
  // the base branch advanced, carrying that work forward would diverge from
  // the new base — fail closed and let codex re-implement from the fresh base.
  if (facts.parentBaseSha !== freshBaseSha) {
    return {
      ...lineage,
      skippedReason: "base_advanced",
      resolvedBaseSha: freshBaseSha,
    };
  }

  if (!existsSync(facts.parentWorktreePath)) {
    // worktree cleaned / never created — nothing to materialize.
    return {
      ...lineage,
      skippedReason: "parent_work_unavailable",
      resolvedBaseSha: freshBaseSha,
    };
  }

  return {
    ...lineage,
    continueFrom: {
      parentRunId: facts.parentRunId,
      parentWorktreePath: facts.parentWorktreePath,
    },
    resolvedBaseSha: freshBaseSha,
  };
}

// Exported for unit tests: the safety boundary "only short-circuit a run that
// is approved" must be pinned directly. A changes_requested / rejected decided
// run must NOT short-circuit and must NOT append a close-check. Exercising this
// through `review()` would require an on-disk reviewer fixture; the helper is a
// deterministic DB-only function, so it is the precise unit under test.
