// workflow-runner の共有 warn helper + run-coding の型/定数/error（leaf-ward）。

import { performance } from "node:perf_hooks";

import type { GlobalPolicy, RepoPolicy } from "../policy/schema.js";

import type { RunMeta, RunStatus, SafetyStatus } from "../logging/run-log.js";

import type { ReviewRuleResolution } from "./review-rule.js";

import type { CodexExecRunner } from "../codex/codex-exec-runner.js";

import type { CodexEventsIo } from "../codex/events-lifecycle.js";

/**
 * Surface a failed artifact-body ingest (Phase 8-2). The run still
 * succeeded — its bodies are file-backed — but the DB-canonical copy is
 * missing until `harness db migrate-artifacts` is run, so it is a loud
 * warning rather than a silently swallowed failure.
 */
export function warnArtifactIngestFailed(runId: string, e: unknown): void {
  process.stderr.write(
    `warning: run ${runId}: artifact body ingestion into the DB failed: ` +
      `${(e as Error).message} — run \`harness db migrate-artifacts\` to recover\n`,
  );
}

export function warnUsageRecordFailed(runId: string, e: unknown): void {
  process.stderr.write(
    `warning: run ${runId}: codex usage telemetry was not recorded: ` +
      `${(e as Error).message}\n`,
  );
}

export function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

/**
 * (#163) Reason a rerun fell back to a fresh-from-base run instead of
 * continuing the parent run's work. Recorded on the `continuation_skipped`
 * run event so an operator can see WHY a continuation did not happen.
 *   - parent_run_missing: no resolvable parent run row.
 *   - parent_work_unavailable: parent worktree absent/cleaned, or its diff
 *     against the base is empty (no policy surface to carry forward).
 *   - base_advanced: parent.baseSha != the freshly-resolved base (the base
 *     branch moved; carrying stale work would diverge — fail closed).
 *   - parent_work_unmaterializable: a git/copy failure while materializing.
 *   - parent_not_validated: the parent run is NOT a policy-validated run (e.g.
 *     `failed-policy-violation` carrying out-of-scope/deny-write paths, a
 *     `failed-command` run without safetyStatus=`allowed`, or
 *     `failed-internal-error` from an un-resettable partial-carry worktree).
 *     Continuing would carry forbidden/partial changes a fresh-from-base rerun
 *     would omit — so fail closed.
 */
export type ContinueFromSkipReason =
  | "parent_run_missing"
  | "parent_work_unavailable"
  | "base_advanced"
  | "parent_work_unmaterializable"
  | "parent_not_validated";

/**
 * (#163) Parent run statuses that are independently sufficient for a rerun to
 * CONTINUE. A run reaches one of these statuses ONLY after passing path-policy
 * validation (safetyStatus = `allowed`), so its worktree surface is
 * policy-validated and safe to carry forward. `failed-command` is handled by
 * `isValidatedContinuationParent`: it is eligible only when the row explicitly
 * records safetyStatus=`allowed`. Other `failed-*` statuses are NOT validated
 * (`failed-policy-violation` carries out-of-scope/deny-write paths;
 * `failed-internal-error` may be the un-resettable partial-carry worktree;
 * `failed-codex` never completed validation) → continuation is skipped
 * (`parent_not_validated`) and the rerun re-derives fresh-from-base. `rejected`
 * is excluded too: a rejected approach is completed work but should not be
 * carried into the next attempt.
 */
export const VALIDATED_CONTINUATION_STATUSES: ReadonlySet<RunStatus> = new Set<
  RunStatus
>(["needs_review", "approved", "changes_requested"]);

export function isValidatedContinuationParent(input: {
  status: string | null;
  safetyStatus: string | null;
}): boolean {
  if (input.status === null) return false;
  if (VALIDATED_CONTINUATION_STATUSES.has(input.status as RunStatus)) {
    return true;
  }
  return input.status === "failed-command" && input.safetyStatus === "allowed";
}

/**
 * (#163) Where to find the parent run's work to materialize. The resolver
 * passes the parent's run id (for audit) and its worktree path; the surface
 * is the parent worktree's policy-validated diff against the shared base.
 */
export interface ContinueFromSpec {
  parentRunId: string;
  /** absolute path to the parent run's worktree (`workspaces/<id>/repo`). */
  parentWorktreePath: string;
}

export interface RunChangeBudgetOverride {
  maxDeletedLines?: number;
  maxTotalChangedLines?: number;
  maxDeletedFiles?: number;
  maxChangedFiles?: number;
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
  /**
   * (#191) Which backend `codexRunner` is — captured ONCE by the caller next to
   * the runner construction so the coder dispatch (redaction / usage / final
   * message) cannot diverge from the injected runner if HARNESS_CODER_BACKEND is
   * mutated mid-process. Absent → 'codex' (every non-claude entry point).
   */
  coderBackend?: "codex" | "claude";
  /**
   * Abort the in-flight codex run (#132): forwarded to `codexRunner.run`. The
   * course orchestrator aborts it on lease loss, SIGKILLing codex; the killed
   * run finalizes `failed-codex` via the existing non-zero-exit path.
   */
  signal?: AbortSignal;
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
   * (#163) Continuation source for a rerun: the parent run's worktree whose
   * policy-validated diff surface is materialized into THIS run's freshly
   * created worktree as UNCOMMITTED working-tree changes, so codex amends the
   * parent's work in place rather than re-implementing from a clean base.
   *
   * Decoupled from `parentRunId` (which is lineage only): the resolver in the
   * orchestrator builds it after a read-only base-equality gate; `runDomainCoding`
   * performs the materialization under the domain lock, after `createWorktree`.
   * Any failure (worktree missing/clean, copy/git error) fails CLOSED to a
   * fresh-from-base run, recording a `continuation_skipped` event — never a throw.
   */
  continueFrom?: ContinueFromSpec;
  /**
   * (#163) Gate-validated base SHA. When set, `runDomainCoding` uses this as the
   * worktree base + diff base instead of re-resolving `baseBranch` — so the
   * diff base equals the base the continuation gate validated against (no
   * re-resolve TOCTOU between the gate and the run). Must be a 40-char SHA.
   */
  resolvedBaseSha?: string;
  /**
   * (#163) When a rerun's continuation was DECLINED by the read-only resolver
   * (parent_run_missing / parent_work_unavailable / base_advanced /
   * parent_work_unmaterializable), the reason is recorded as a
   * `continuation_skipped` run event for audit. The run still proceeds
   * fresh-from-base — this is a fail-closed fallback, never a throw.
   */
  continueFromSkipped?: ContinueFromSkipReason;
  /**
   * (#163) Lineage parent for a HITCH rerun, recorded whether or not the
   * continuation materialized (success OR fail-closed skip). It populates the
   * run row's `parent_run_id` and ALSO keys the under-lock duplicate-child gate,
   * so a continuation rerun (which sets this instead of `parentRunId`) is fenced
   * to one child per parent — even on a skipped continuation. Sequential reruns
   * never false-trip: each child's row records its OWN parent, so the gate for
   * the NEXT parent finds no existing child. `parentRunId` (the non-hitch rerun
   * path) takes precedence over this when both are set.
   */
  continuationParentRunId?: string;
  /**
   * Promoted-knowledge context to inject into the codex prompt (Phase 3-4).
   * `text` is appended to the prompt; `path` is recorded in meta/events.
   */
  knowledgeContext?: { path: string; text: string; revisionIds?: number[] };
  /**
   * Pre-compiled policy (Phase 5-7 `--project`). When set, the workflow
   * uses it instead of loading `policies/global.yaml` + the repo policy
   * file — a project profile compiles to exactly this {global, repo} pair.
   */
  compiledPolicy?: { global: GlobalPolicy; repo: RepoPolicy };
  /**
   * Pre-resolved review rule for a project profile. Missing means legacy
   * behaviour: resolve the default rule from repo/domain scope.
   */
  reviewRuleResolution?: ReviewRuleResolution;
  /** project profile provenance, recorded in meta.json (Phase 5-7). */
  project?: RunMeta["project"];
  /**
   * Explicit project context packs (Phase 5-7). `promptText` is appended
   * to the codex prompt as reference material; `manifestYaml` is saved as
   * the `context-pack-manifest.yaml` artifact.
   */
  projectContextPacks?: { promptText: string; manifestYaml: string };
  /** `codex --version` first line, resolved by callers that know codexBin. */
  codexBinaryVersion?: string | null;
  /** @internal test seam for fail-closed codex-events publish failures. */
  codexEventsIo?: CodexEventsIo;
  /**
   * Per-run budget override. It can only relax numeric limits while
   * enforcement is already true; it cannot disable enforcement.
   */
  changeBudgetOverride?: RunChangeBudgetOverride;
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
  readonly cause: unknown;
  constructor(runId: string, status: RunStatus, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RunFinalizedError";
    this.runId = runId;
    this.status = status;
    this.cause = cause;
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

