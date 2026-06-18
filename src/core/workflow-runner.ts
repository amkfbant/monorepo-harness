import { dirname, join } from "node:path";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { stringify as yamlStringify } from "yaml";
import { harnessPaths } from "../config/paths.js";
import { harnessVersion } from "../config/version.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { partitionUntracked } from "../policy/untracked-filter.js";
import {
  validateChangedPaths,
  type Violation,
} from "../policy/path-policy-validator.js";
import type {
  ResolvedPolicy,
  GlobalPolicy,
  RepoPolicy,
  ChangeBudget,
} from "../policy/schema.js";
import type Database from "better-sqlite3";
import {
  type RunLog,
  type RunMeta,
  type RunStatus,
  type SafetyStatus,
} from "../logging/run-log.js";
import { openManagedDb, type ManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { SCHEMA_VERSION } from "../db/schema.js";
import { createDbRunLog } from "../db/run-log-db.js";
import { ingestRunArtifacts } from "../db/run-artifacts.js";
import { fileExportEnabled } from "../config/export-mode.js";
import { createReadStream, rmSync } from "node:fs";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";
import {
  RunRepository,
  type ChangedFileInput,
} from "../db/repositories/runs.js";
import { recordEffectivePolicySnapshot } from "../db/repositories/policy-templates.js";
import { RerunGateError } from "./rerun.js";
import { writeArtifact } from "../logging/artifacts.js";
import { generateRunId } from "./run-id.js";
import { runAllowedCommands } from "./command-runner.js";
import { warnLegacyFileLocks } from "../workspace/legacy-file-lock-warning.js";
import {
  resolveEffectiveRule,
  type ReviewRuleResolution,
} from "./review-rule.js";
import { ReviewRulesRepository } from "../db/repositories/review-rules.js";
import {
  acquireDomainLock as acquireDbDomainLock,
  heartbeatIntervalMs,
  assertActiveLease,
  LeaseGuardFailedError,
  type DomainLockHandle as DbDomainLockHandle,
} from "../workspace/db-domain-lock.js";
import { hostname } from "node:os";
import { runBranchName } from "../workspace/branch-name.js";
import { createWorktree } from "../workspace/git-worktree.js";
import { gitCli } from "../git/git-cli.js";
import {
  collectDiff,
  resolveBaseSha,
  type DiffResult,
  type DiffStat,
} from "../git/diff.js";
import {
  normalizeDiffBudget,
  validateDiffBudget,
} from "../policy/diff-budget-validator.js";
import { detectsTestWeakening } from "./automerge-tiers.js";
import {
  buildCodexPrompt,
  CODER_PROMPT_TEMPLATE,
} from "../codex/prompt-builder.js";
import { summarizeCodexEvents } from "../codex/events-summary.js";
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
import {
  publishRedactedCodexEvents,
  type CodexEventsIo,
} from "../codex/events-lifecycle.js";
import { recordCodexUsage } from "../db/repositories/run-usage.js";

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

function warnUsageRecordFailed(runId: string, e: unknown): void {
  process.stderr.write(
    `warning: run ${runId}: codex usage telemetry was not recorded: ` +
      `${(e as Error).message}\n`,
  );
}

function elapsedMs(start: number): number {
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

async function readTail(path: string, maxBytes = 8 * 1024): Promise<string> {
  try {
    const buf = await readFile(path);
    if (buf.length <= maxBytes) return buf.toString("utf8");
    return buf.subarray(buf.length - maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

async function readOptionalUtf8(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if (isNodeError(e) && e.code === "ENOENT") return null;
    throw e;
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

interface DiffOutcome {
  ok: boolean;
  error?: string;
  trackedChangedPaths: string[];
  stagedChangedPaths: string[];
  untrackedAll: string[];
  stat?: DiffStat;
  patch: string;
}

interface DiffAndValidate {
  diff: DiffOutcome;
  untrackedKept: string[];
  untrackedIgnored: string[];
  violations: Violation[];
  safetyStatus: SafetyStatus;
  budgetStat?: DiffStat;
  diffDurationMs: number;
  policyValidationDurationMs: number;
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(8192, buf.length));
  if (sample.length === 0) return false;
  if (sample.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, {
      stream: true,
    });
    return false;
  } catch {
    return true;
  }
}

export async function countTextLinesStreaming(path: string): Promise<number> {
  let sawAnyByte = false;
  let lastByteWasNewline = false;
  let newlineCount = 0;
  let sample = Buffer.alloc(0);
  let binary = false;
  const sampleBytes = 8192;

  for await (const chunk of createReadStream(path)) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) continue;
    sawAnyByte = true;

    if (sample.length < sampleBytes) {
      const need = sampleBytes - sample.length;
      sample = Buffer.concat([sample, buf.subarray(0, need)]);
      binary = looksBinary(sample);
      if (binary) return 0;
    }

    for (const byte of buf) {
      if (byte === 0x0a) newlineCount += 1;
    }
    lastByteWasNewline = buf[buf.length - 1] === 0x0a;
  }

  if (binary || !sawAnyByte) return 0;
  return newlineCount + (lastByteWasNewline ? 0 : 1);
}

async function statWithAllowedUntracked(
  worktreePath: string,
  trackedStat: DiffStat,
  untrackedAllowed: readonly string[],
): Promise<DiffStat> {
  if (untrackedAllowed.length === 0) return trackedStat;
  let untrackedInsertions = 0;
  for (const p of untrackedAllowed) {
    const fullPath = join(worktreePath, p);
    const st = await lstat(fullPath);
    if (!st.isFile()) continue;
    untrackedInsertions += await countTextLinesStreaming(fullPath);
  }
  return {
    ...trackedStat,
    filesChanged: trackedStat.filesChanged + untrackedAllowed.length,
    insertions: trackedStat.insertions + untrackedInsertions,
  };
}

async function diffAndValidate(opts: {
  worktreePath: string;
  baseSha: string;
  gitTimeoutMs: number;
  policy: ResolvedPolicy;
}): Promise<DiffAndValidate> {
  const diffStartedAt = performance.now();
  const diff = await attemptDiff(
    opts.worktreePath,
    opts.baseSha,
    opts.gitTimeoutMs,
  );
  const { kept: untrackedKept, ignored: untrackedIgnored } = partitionUntracked(
    diff.untrackedAll,
    opts.policy.ignoreUntracked,
  );
  const diffDurationMs = elapsedMs(diffStartedAt);
  let violations: Violation[] = [];
  let safetyStatus: SafetyStatus;
  if (!diff.ok) {
    safetyStatus = "skipped";
  } else {
    if (diff.stat === undefined) {
      throw new Error("diff collection succeeded without a diff stat");
    }
    const allChangedPaths = uniquePaths([
      ...diff.trackedChangedPaths,
      ...diff.stagedChangedPaths,
      ...untrackedKept,
    ]);
    const policyValidationStartedAt = performance.now();
    const validation = validateChangedPaths(opts.policy, allChangedPaths);
    violations = validation.violations;
    safetyStatus = validation.status === "allowed" ? "allowed" : "denied";
    const policyValidationDurationMs = elapsedMs(policyValidationStartedAt);
    const violatedPaths = new Set<string>(violations.map((v) => v.path));
    const untrackedAllowed = untrackedKept.filter((p) => !violatedPaths.has(p));
    const budgetStat = await statWithAllowedUntracked(
      opts.worktreePath,
      diff.stat,
      untrackedAllowed,
    );
    return {
      diff,
      untrackedKept,
      untrackedIgnored,
      violations,
      safetyStatus,
      budgetStat,
      diffDurationMs,
      policyValidationDurationMs,
    };
  }
  return {
    diff,
    untrackedKept,
    untrackedIgnored,
    violations,
    safetyStatus,
    diffDurationMs,
    policyValidationDurationMs: 0,
  };
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
      stagedChangedPaths: d.stagedChangedPaths,
      untrackedAll: d.untrackedPaths,
      stat: d.stat,
      patch: d.patch,
    };
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      trackedChangedPaths: [],
      stagedChangedPaths: [],
      untrackedAll: [],
      patch: "",
    };
  }
}

function applyChangeBudgetOverride(
  base: ChangeBudget,
  override: RunChangeBudgetOverride | undefined,
): ChangeBudget {
  if (override === undefined || !base.enforce) return base;
  return {
    ...base,
    maxDeletedLines:
      override.maxDeletedLines !== undefined
        ? Math.max(base.maxDeletedLines, override.maxDeletedLines)
        : base.maxDeletedLines,
    maxTotalChangedLines:
      override.maxTotalChangedLines !== undefined
        ? Math.max(base.maxTotalChangedLines, override.maxTotalChangedLines)
        : base.maxTotalChangedLines,
    maxDeletedFiles:
      override.maxDeletedFiles !== undefined
        ? Math.max(base.maxDeletedFiles, override.maxDeletedFiles)
        : base.maxDeletedFiles,
    maxChangedFiles:
      override.maxChangedFiles !== undefined
        ? Math.max(base.maxChangedFiles, override.maxChangedFiles)
        : base.maxChangedFiles,
  };
}

type DiffBudgetStage = "post-codex" | "post-command";

async function evaluateChangeBudget(opts: {
  log: RunLog;
  budget: ChangeBudget;
  stat: DiffStat;
  stage: DiffBudgetStage;
}): Promise<NonNullable<RunMeta["changeBudget"]>> {
  const budget = normalizeDiffBudget(opts.budget);
  const result = validateDiffBudget(budget, opts.stat);
  const disabled = !budget.enforce;
  await opts.log.emit({
    type: "diff_budget_evaluated",
    stage: opts.stage,
    status: result.status,
    disabled,
    stat: opts.stat,
    budget,
    breaches: result.breaches,
  });
  if (disabled) {
    await opts.log.emit({
      type: "change_budget_disabled",
      stage: opts.stage,
      stat: opts.stat,
      budget,
      status: result.status,
      breaches: result.breaches,
    });
  }
  return {
    status: result.status,
    disabled,
    stage: opts.stage,
    budget,
    breaches: result.breaches,
  };
}

export interface MaterializeOutcome {
  /** true when at least one path was carried forward into the child worktree. */
  materialized: boolean;
  /** the policy-validated surface that was copied/removed (audit). */
  paths: string[];
  /** set when materialization fell back to fresh-from-base. */
  skippedReason?: ContinueFromSkipReason;
}

/**
 * (#163) Thrown when the atomic reset that undoes a partial materialization
 * (`git reset --hard <baseSha>` + `git clean -ffdx`) FAILS — we cannot return
 * the child worktree to clean fresh-from-base. A worktree we cannot prove is
 * fresh-from-base is unsafe to amend, so this is NOT a skip: it propagates out
 * of `materializeParentWork` and `runDomainCoding` finalizes the run as a
 * failure (fail-closed-hard), rather than proceeding on a possibly-partial
 * worktree.
 */
export class WorktreeResetError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorktreeResetError";
  }
}

/**
 * (#163) Materialize the parent run's policy-validated diff surface INTO the
 * child worktree as UNCOMMITTED working-tree changes. This is the whole
 * continuation mechanism — there is NO commit, NO `git add`, NO branch
 * mutation anywhere. The parent's work lives only as the child worktree's
 * uncommitted state, so the existing untracked-denied / secret-suspect /
 * redaction handling applies to the child run with no special-casing, and
 * `git diff baseSha` of the child = parent's changes + codex's amends.
 *
 * Surface (mirrors the live-run validated surface in `diffAndValidate`):
 *   tracked changed paths (added/modified/deleted) +
 *   partitionUntracked(untracked, policy.ignoreUntracked).kept
 * Policy-IGNORED untracked (node_modules/dist/.harness) are EXCLUDED.
 *
 * Symlinks are NEVER dereferenced (matches the live-run no-follow model):
 * a symlink entry in the surface is recreated AS A SYMLINK in the child
 * (its link target is copied via `readlink`/`symlink`, not its dereferenced
 * bytes). A broken/dangling symlink stays a symlink — it is not treated as a
 * deletion.
 *
 * Atomicity (all-or-nothing): the copy/remove loop applies the surface entry
 * by entry. If ANY entry fails after earlier entries were already applied, the
 * child worktree is RESET back to clean fresh-from-base (`git reset --hard
 * <baseSha>` + `git clean -ffdx`) BEFORE returning, so a mid-copy failure never
 * leaves a partial carry for codex to amend.
 *
 * Fail-closed: a recoverable git/copy failure (or an empty surface) returns a
 * `skippedReason` and leaves the child worktree fresh-from-base — the caller
 * records the reason and proceeds with a normal run. The ONE case that does NOT
 * skip is when the atomic reset itself fails: the worktree cannot be proven
 * fresh-from-base, so a {@link WorktreeResetError} is thrown (fail-closed-hard)
 * and `runDomainCoding` finalizes the run as a failure instead of amending a
 * possibly-partial worktree.
 */
export async function materializeParentWork(opts: {
  parentWorktreePath: string;
  childWorktreePath: string;
  baseSha: string;
  policy: ResolvedPolicy;
  gitTimeoutMs: number;
}): Promise<MaterializeOutcome> {
  let diff: DiffResult;
  try {
    diff = await collectDiff({
      repoPath: opts.parentWorktreePath,
      baseSha: opts.baseSha,
      timeoutMs: opts.gitTimeoutMs,
    });
  } catch {
    // parent worktree absent/cleaned, base SHA unknown there, or any git
    // failure → fail closed, no carry-forward.
    return {
      materialized: false,
      paths: [],
      skippedReason: "parent_work_unavailable",
    };
  }
  const { kept: untrackedKept } = partitionUntracked(
    diff.untrackedPaths,
    opts.policy.ignoreUntracked,
  );
  // de-dup while preserving a deterministic order (tracked first).
  const surface = Array.from(
    new Set([...diff.trackedChangedPaths, ...untrackedKept]),
  );
  if (surface.length === 0) {
    // parent has no policy-relevant changes vs the base — nothing to carry.
    return {
      materialized: false,
      paths: [],
      skippedReason: "parent_work_unavailable",
    };
  }
  try {
    for (const rel of surface) {
      const src = join(opts.parentWorktreePath, rel);
      const dst = join(opts.childWorktreePath, rel);
      await materializeEntry(src, dst);
    }
  } catch {
    // ATOMICITY: a copy/remove threw after earlier entries were already
    // applied. Reset the child back to clean fresh-from-base BEFORE falling
    // back, so the run never proceeds on a half-materialized partial carry.
    // If the reset itself fails, `resetWorktreeToBase` throws a
    // WorktreeResetError that PROPAGATES out (not swallowed): a worktree we
    // cannot return to fresh-from-base is unsafe to amend, so the run fails
    // hard rather than skip-with-partial.
    await resetWorktreeToBase(
      opts.childWorktreePath,
      opts.baseSha,
      opts.gitTimeoutMs,
    );
    return {
      materialized: false,
      paths: [],
      skippedReason: "parent_work_unmaterializable",
    };
  }
  return { materialized: true, paths: surface };
}

/**
 * (#163) Materialize ONE surface entry from the parent worktree into the child,
 * using `lstat` (NO symlink dereference). The `dst` in the child is FIRST
 * cleared with a recursive+force `rm` (drops a base file, symlink, OR directory
 * without following links / EISDIR), so a parent that swapped a path's KIND
 * still materializes cleanly:
 *   - absent in the parent (deleted vs base) → the recursive rm removes it
 *     (handles a base directory the parent deleted too).
 *   - a symlink → recreate it AS A SYMLINK (copy the link target, never the
 *     dereferenced bytes); a broken/dangling target stays a symlink.
 *   - a directory (parent replaced a tracked FILE with a directory) → recreate
 *     the directory tree, symlinks preserved (`cp` no-dereference).
 *   - a regular file (incl. parent replaced a tracked DIRECTORY with a file)
 *     → copy its content into the child (uncommitted).
 * Throws on any unexpected error so the caller's atomic reset fires.
 */
async function materializeEntry(src: string, dst: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(src);
  } catch (e) {
    // ENOENT → the path is gone in the parent (deleted vs base). ENOTDIR → an
    // ANCESTOR of this path is now a non-directory in the parent (e.g. the
    // parent collapsed a tracked DIRECTORY into a regular file, so the old
    // `dir/child.ts` entries no longer exist). Both mean "absent in the parent"
    // → remove it in the child too. recursive so a base DIRECTORY the parent
    // deleted is removed, not just a file.
    if (
      isNodeError(e) &&
      (e.code === "ENOENT" || e.code === "ENOTDIR")
    ) {
      await rm(dst, { recursive: true, force: true });
      return;
    }
    throw e;
  }
  // Always clear the dst first (recursive + force, no-follow): drops any base
  // file / symlink / DIRECTORY at this path so the recreate below never writes
  // THROUGH a base symlink (escape) and never hits EEXIST/EISDIR/ENOTDIR when
  // the parent swapped the path's kind (file↔dir, link↔file).
  await mkdir(dirname(dst), { recursive: true });
  await rm(dst, { recursive: true, force: true });
  if (info.isSymbolicLink()) {
    // recreate AS a symlink — never follow it into a regular file.
    await symlink(await readlink(src), dst);
    return;
  }
  if (info.isDirectory()) {
    // parent replaced a tracked file with a directory → recreate the tree.
    // `dereference: false` (default) preserves any symlinks inside it.
    await cp(src, dst, { recursive: true });
    return;
  }
  // added/modified/untracked regular file → copy content into the child.
  await copyFile(src, dst);
}

/**
 * (#163) Reset a worktree back to clean fresh-from-base: discard all tracked
 * changes (`reset --hard <baseSha>`) and remove every untracked/ignored file
 * (`clean -ffdx`). Run under the domain lock to undo a partial materialization.
 *
 * FAIL-CLOSED: `gitCli` does NOT throw on a non-zero exit / timeout, so each
 * result is checked explicitly. If EITHER command fails, the worktree cannot be
 * proven fresh-from-base — a {@link WorktreeResetError} is thrown so the run
 * fails hard rather than amending a possibly-partial worktree.
 */
async function resetWorktreeToBase(
  worktreePath: string,
  baseSha: string,
  gitTimeoutMs: number,
): Promise<void> {
  const opts = { cwd: worktreePath, timeoutMs: gitTimeoutMs };
  await runResetStep(["reset", "--hard", baseSha], opts);
  await runResetStep(["clean", "-ffdx"], opts);
}

/**
 * Fold any commits or staged-index entries the coder (or an allowed command)
 * created in the run worktree back into the WORKING TREE: `git reset --mixed
 * <baseSha>` moves HEAD and the index to the run base while leaving every
 * working-tree edit — and every untracked file — in place. The reviewed-surface
 * model is working-tree-based: the reviewed fingerprint is computed over the
 * working tree, close-check requires a clean index against it, and `harness pr
 * create` re-derives a SINGLE reviewed commit via `git add -- reviewedPaths`.
 *
 * codex sometimes COMMITS its work in the worktree. Without this normalization a
 * committed worktree would (a) escalate close-check (its index != base) and,
 * worse, (b) leak the coder's intermediate, unreviewed commits onto the pushed
 * run branch (PR creation pushes the branch as-is and only validates the NET
 * base..HEAD diff). Unlike `reset --hard`, this preserves the net change; it only
 * discards the commit/staging STRUCTURE, never the content.
 *
 * FAIL-CLOSED: a non-zero / timed-out reset throws {@link WorktreeResetError} so
 * the run cannot proceed on a worktree we cannot prove is index-clean. The throw
 * is transitive — it is raised by the shared {@link runResetStep} helper, not in
 * this function body.
 */
async function normalizeWorktreeIndexToBase(
  worktreePath: string,
  baseSha: string,
  gitTimeoutMs: number,
): Promise<void> {
  await runResetStep(["reset", "--mixed", baseSha], {
    cwd: worktreePath,
    timeoutMs: gitTimeoutMs,
  });
}

async function runResetStep(
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<void> {
  let r: Awaited<ReturnType<typeof gitCli>>;
  try {
    r = await gitCli(args, opts);
  } catch (e) {
    throw new WorktreeResetError(
      `worktree reset step \`git ${args.join(" ")}\` errored: ${(e as Error).message}`,
      { cause: e },
    );
  }
  if (r.timedOut) {
    throw new WorktreeResetError(
      `worktree reset step \`git ${args.join(" ")}\` timed out after ${opts.timeoutMs}ms`,
    );
  }
  if (r.exitCode !== 0) {
    throw new WorktreeResetError(
      `worktree reset step \`git ${args.join(" ")}\` failed (${r.exitCode}): ${r.stderr.trim()}`,
    );
  }
}

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

function snapshotReviewRuleForRun(input: {
  opts: RunDomainCodingOpts;
  db: Database.Database;
  runId: string;
}): void {
  const { opts, db, runId } = input;
  const resolution =
    opts.reviewRuleResolution ??
    resolveEffectiveRule({
      ...(opts.project !== undefined ? { projectId: opts.project.projectId } : {}),
      repoId: opts.repoId,
      domain: opts.domain,
    });
  try {
    const rulesRepo = new ReviewRulesRepository(db);
    const template = rulesRepo.upsertRuleTemplate({
      ...(opts.project !== undefined ? { projectId: opts.project.projectId } : {}),
      repoId: opts.repoId,
      domain: opts.domain,
      source: resolution.source,
      rule: resolution.rule,
    });
    rulesRepo.snapshotForRun({ runId, template });
  } catch (e) {
    if (resolution.source === "project-profile") {
      throw e;
    }
    // best-effort for legacy default snapshots: Phase 11 review process
    // still falls back to DEFAULT_REVIEW_RULE if the snapshot row is absent.
    process.stderr.write(
      `warning: could not snapshot review rule for ${runId}: ${(e as Error).message}\n`,
    );
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
  runStartedAt: number;
}

async function runDomainCodingInner(
  inner: InnerOpts,
): Promise<RunDomainCodingResult> {
  const {
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
  } = inner;
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

    // (#163) The resolver DECLINED a continuation up front (e.g. base advanced,
    // worktree cleaned). Record the reason; the run proceeds fresh-from-base.
    if (opts.continueFrom === undefined && opts.continueFromSkipped !== undefined) {
      await log.emit({
        type: "continuation_skipped",
        reason: opts.continueFromSkipped,
      });
    }
    // (#163) Continuation: materialize the parent run's policy-validated diff
    // surface into THIS fresh worktree as UNCOMMITTED changes, under the domain
    // lock, after the worktree exists. The branch tip stays at baseSha — there
    // is no commit anywhere. A fail-closed outcome leaves the worktree
    // fresh-from-base and records why (no throw, no escalation).
    if (opts.continueFrom !== undefined) {
      const outcome = await materializeParentWork({
        parentWorktreePath: opts.continueFrom.parentWorktreePath,
        childWorktreePath: wt.path,
        baseSha,
        policy,
        gitTimeoutMs,
      });
      if (outcome.materialized) {
        await log.emit({
          type: "continuation_materialized",
          parentRunId: opts.continueFrom.parentRunId,
          baseSha,
          paths: outcome.paths,
        });
      } else {
        await log.emit({
          type: "continuation_skipped",
          parentRunId: opts.continueFrom.parentRunId,
          reason: outcome.skippedReason,
        });
      }
    }

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
    await log.setPromptSha256(
      createHash("sha256").update(prompt).digest("hex"),
    );
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
    const codexEventsPath = join(log.runDir, "codex-events.jsonl");
    const codexRawEventsPath = join(log.runDir, ".codex-events.raw.jsonl");
    const codexRedactedTmpPath = join(
      log.runDir,
      ".codex-events.redacted.tmp",
    );
    const codex = await opts.codexRunner.run({
      worktreePath: wt.path,
      prompt,
      logPaths: {
        stdout: codexStdoutPath,
        stderr: codexStderrPath,
        events: codexRawEventsPath,
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
    await log.emit({
      type: "codex_exec_completed",
      exitCode: codex.exitCode,
      timedOut: codex.timedOut,
      durationMs: codex.durationMs,
    });
    const codexEventsRedaction = await publishRedactedCodexEvents({
      rawPath: codexRawEventsPath,
      tmpPath: codexRedactedTmpPath,
      officialPath: codexEventsPath,
      io: opts.codexEventsIo,
      runId,
    });
    let codexEventsContent: string | null = null;
    try {
      codexEventsContent = await readOptionalUtf8(codexEventsPath);
    } catch {
      codexEventsContent = null;
    }
    recordCodexUsage({
      db,
      runId,
      kind: "coder",
      eventsContent: codexEventsContent,
      beforeWrite: () => assertActiveLease(db, runId),
      onError: (error) => warnUsageRecordFailed(runId, error),
    });
    if (!codexEventsRedaction.failed) {
      if (
        codexEventsRedaction.redactedCount +
          codexEventsRedaction.droppedCount >
        0
      ) {
        await log.emit({
          type: "codex_events_redacted",
          redactedCount: codexEventsRedaction.redactedCount,
          droppedCount: codexEventsRedaction.droppedCount,
        });
      }
    }
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
    const changeBudget = applyChangeBudgetOverride(
      policy.limits.changeBudget,
      opts.changeBudgetOverride,
    );
    let changeBudgetResult: RunMeta["changeBudget"] | undefined;
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
        durationMs: dv.policyValidationDurationMs,
      });
    }
    if (dv.diff.ok && dv.budgetStat !== undefined) {
      changeBudgetResult = await evaluateChangeBudget({
        log,
        budget: changeBudget,
        stat: dv.budgetStat,
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
      changeBudgetResult?.status !== "exceeded" &&
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
          durationMs: dv.policyValidationDurationMs,
        });
      }
      if (dv.diff.ok && dv.budgetStat !== undefined) {
        changeBudgetResult = await evaluateChangeBudget({
          log,
          budget: changeBudget,
          stat: dv.budgetStat,
          stage: "post-command",
        });
      }
    }

    // Capture the PRE-normalize evaluation BEFORE folding any coder commits /
    // staged index back into the working tree. STATUS (safetyStatus +
    // change-budget) and the RECORDED violations are derived from this PRE view:
    // it preserves the #141 change-budget gating of staged-only mutations AND
    // the detection of COMMITTED out-of-scope content (a committed/staged
    // out-of-scope file is a TRACKED addition here, so it is in `preViolations`
    // → drives failed-policy-violation / failed-budget-exceeded).
    const preSafetyStatus = dv.safetyStatus;
    const preViolations = dv.violations;
    const preBudgetStat = dv.budgetStat;
    // Normalize + RE-COLLECT for the ARTIFACT / REVIEWED view (only when the
    // worktree diff is ok). `git reset --mixed <base>` folds coder commits and
    // staged-index entries back into the working tree, so a COMMITTED
    // out-of-scope file (a tracked addition pre-normalize) folds to an UNTRACKED
    // file post-normalize. `diffAndValidate` is a pure function and emits NO
    // events, so this re-collection does not double-emit policy/budget/diff
    // events. The re-collected `dv` describes the POST-normalize worktree.
    if (dv.diff.ok) {
      await normalizeWorktreeIndexToBase(wt.path, baseSha, gitTimeoutMs);
      dv = await diffAndValidate({
        worktreePath: wt.path,
        baseSha,
        gitTimeoutMs,
        policy,
      });
    }

    // STATUS / budget / violations use the PRE-normalize evaluation (preserves
    // #141 staged-only gating + committed-out-of-scope detection). Artifacts
    // (final-diff.patch, untracked-files.{txt,patch}, untracked-denied.txt,
    // secret reports) and the reviewed surface (reviewedPaths, fingerprint) use
    // the POST-normalize re-collected `dv`: this SUPPRESSES committed
    // out-of-scope BYTES (the committed file is now untracked, not in
    // diff.patch) and treats it as untracked-denied (metadata only).
    const { diff, untrackedKept, untrackedIgnored } = dv; // now POST-normalize
    const finalDiffStat = preBudgetStat ?? diff.stat;
    const safetyStatus = preSafetyStatus;
    const violations = preViolations;
    // `violatedPaths` is derived from the PRE violation set, then used to split
    // the POST-normalize `untrackedKept`: a committed out-of-scope file (now
    // POST-untracked) is in PRE violatedPaths → untrackedDenied (metadata only,
    // no bytes); a committed IN-scope new file (now POST-untracked, not a
    // violation) → untrackedAllowed → reviewedPaths.
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
    let reviewed:
      | { paths: string[]; fingerprint: string; weakensTests?: boolean }
      | undefined;
    if (diff.ok) {
      // The worktree was already normalized (`git reset --mixed <base>`) above —
      // BEFORE the artifacts were written — folding any coder commits /
      // staged-index entries back into the working tree. So `diff` here is the
      // POST-normalize re-collection: the reviewed surface sees a clean index,
      // PR-creation publishes exactly one fresh reviewed commit, and a coder
      // that COMMITTED its work neither escalates close-check nor leaks its
      // intermediate, unreviewed commits onto the pushed run branch (#141/#197).
      // The change-budget already ran on the PRE-normalize evaluation, so a
      // staged-only mutation is still gated by the budget (#141).
      await log.emit({
        type: "diff_collected",
        tracked: diff.trackedChangedPaths,
        untrackedAllowed,
        untrackedDenied,
        ignored: untrackedIgnored,
        // reflects which worktree state these lists describe: when commands
        // ran, the diff was re-collected against the post-command worktree.
        stage: commandsRan ? "post-command" : "post-codex",
        durationMs: dv.diffDurationMs,
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
        // Captured at run time for the auto-merge tier gate: a tests-only
        // (Tier-0) change that deletes a test file or adds a skip/only marker
        // weakens coverage and must not auto-merge silently.
        weakensTests: detectsTestWeakening(diff.patch),
      };
    }

    // Phase 7-4: persist the diff-verification result to the DB. Phase 6
    // left run_changed_files / policy_violations empty (the importer
    // cannot derive them from files); a DB-first run writes them here
    // from the in-memory validation result.
    const runRepo = new RunRepository(db);
    // Phase 9-6: each direct write to the run's child tables verifies the
    // active domain lease before touching the DB — the RunLog guard above
    // already covers RunLog writes, but these inline writes need their own.
    assertActiveLease(db, runId);
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
      assertActiveLease(db, runId);
      runRepo.upsertChangedFiles(runId, changedFiles);
    }

    // Status priority (evaluated against POST-command worktree if commands ran):
    //   diff failure > codex timeout > codex non-zero > policy violation
    //   > enforced budget exceeded > command failure > needs_review
    // safetyStatus is reported independently so callers can detect e.g.
    // "timeout AND scope violation" cases.
    const budgetExceeded = changeBudgetResult?.status === "exceeded";
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
    } else if (budgetExceeded) {
      status = "failed-budget-exceeded";
    } else if (commandsRan && !commandsPassed) {
      status = "failed-command";
    } else {
      status = "needs_review";
    }

    const codexStdoutTail = await readTail(codexStdoutPath);
    const codexStderrTail = await readStderrTail(codexStderrPath);
    const codexEventsSummary =
      codex.timedOut || codex.exitCode !== 0
        ? summarizeCodexEvents(codexEventsContent ?? "")
        : "";
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
      ...(finalDiffStat !== undefined ? { diffStat: finalDiffStat } : {}),
      ...(changeBudgetResult !== undefined
        ? { changeBudget: changeBudgetResult }
        : {}),
      codexExitCode: codex.exitCode,
      codexTimedOut: codex.timedOut,
      codexStdoutTail,
      codexStderrTail,
      ...(codexEventsSummary !== "" ? { codexEventsSummary } : {}),
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
        ...(finalDiffStat !== undefined ? { diffStat: finalDiffStat } : {}),
        ...(changeBudgetResult !== undefined
          ? { changeBudget: changeBudgetResult }
          : {}),
        codexExitCode: codex.exitCode,
        codexTimedOut: codex.timedOut,
        codexStdoutTail,
        codexStderrTail,
        ...(codexEventsSummary !== "" ? { codexEventsSummary } : {}),
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
    let ingestOk = false;
    let ingestedArtifacts: ReturnType<typeof ingestRunArtifacts> | undefined;
    let artifactIngestDurationMs = 0;
    try {
      assertActiveLease(db, runId);
      const artifactIngestStartedAt = performance.now();
      ingestedArtifacts = ingestRunArtifacts(db, log.runDir, runId);
      artifactIngestDurationMs = elapsedMs(artifactIngestStartedAt);
      ingestOk = true;
    } catch (e) {
      warnArtifactIngestFailed(runId, e);
    }
    if (ingestedArtifacts !== undefined) {
      await log.emit({
        type: "artifacts_ingested",
        count: ingestedArtifacts.count,
        totalBytes: ingestedArtifacts.totalBytes,
        durationMs: artifactIngestDurationMs,
      });
    }
    await log.finalize({
      status,
      safetyStatus,
      ignoredUntrackedCount,
      secretSuspectCount,
      commandResults,
      changedFilesCount,
      ...(finalDiffStat !== undefined ? { diffStat: finalDiffStat } : {}),
      ...(changeBudgetResult !== undefined
        ? { changeBudget: changeBudgetResult }
        : {}),
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
      runElapsedMs: elapsedMs(runStartedAt),
    });
    // Phase 9-7: with file export OFF the run dir is scratch — delete it
    // once artifacts are safely DB-canonical. On ingest failure we keep
    // the dir for debugging (a warning has already been emitted).
    if (ingestOk && !fileExportEnabled()) {
      try {
        rmSync(log.runDir, { recursive: true, force: true });
      } catch (e) {
        process.stderr.write(
          `warning: could not remove scratch run dir ${log.runDir}: ` +
            `${(e as Error).message}\n`,
        );
      }
    }
    return {
      runId,
      status,
      safetyStatus,
      ignoredUntrackedCount,
      secretSuspectCount,
      commandResults,
    };
}
