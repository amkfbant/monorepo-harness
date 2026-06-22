import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { parse as parseYaml } from "yaml";
import { harnessPaths } from "../../config/paths.js";
import { coderBackendOpts, coderRunnerDeps } from "../../core/agent-runner.js";
import { resolveRepoCodexDefaults } from "../../policy/loader.js";
import type { ResolvedPolicy } from "../../policy/schema.js";
import { type DbHitchTokenUsage } from "../../db/repositories/aggregates.js";
import { BacklogError } from "../../core/backlog.js";
import { DbError } from "../../db/connection.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations, readSchemaVersion } from "../../db/migrations.js";
import { evaluateSchemaCompatibility } from "../../db/schema-compat.js";
import type { PrMergeMethod } from "../../core/pr-creator.js";
import { ConvergenceService, RECOVERABLE_DIVERGENCE_REASON, divergenceReasonForBudget } from "../../hitch/convergence.js";
import { findTransientLeaseCause } from "../../workspace/db-domain-lock.js";
import { type OrchestratorRunnerDeps } from "../../hitch/orchestrator-runners.js";
import { HitchRepository, type CompleteHitchReviewCycleInput } from "../../hitch/repository.js";
import { HITCH_SCOPE_STATUSES, HitchValidationError, type HitchFinding, type HitchConvergenceResult, type HitchScopeStatus } from "../../hitch/types.js";
import type { HitchOrchestrationResult } from "../../hitch/orchestrator-types.js";
import { prepareProjectRun } from "../../project/run-project.js";

/**
 * `harness hitch` / `harness phase`(no) CLI の共有ヘルパー（#125 A15: cli/hitch.ts から
 * behaviour-zero 分割）。型(RegisterHitchCommandsOptions/HitchContext)・runner deps
 * 解決(resolveHitchClose/CoderRunnerDeps)・DB/repo wrapper・出力整形(formatHitch*)・
 * parse/assert ヘルパー・error マッパー(hitchError/mapHitchErrorExit/HitchCliError)を集約。
 * HitchContext⇔HitchCliError の相互参照ゆえ 1 モジュールに統合(循環回避)。
 */
export interface RegisterHitchCommandsOptions {
  getHarnessRoot: () => string;
}

export interface HitchContext {
  root: string;
  paths: ReturnType<typeof harnessPaths>;
  repo: HitchRepository;
  db: Database.Database;
}

export function hitchGoalText(session: { title: string; description: string | null }): string {
  return [session.title, session.description ?? ""]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join("\n\n");
}

export function resolveHitchCloseRunnerDeps(input: {
  dbPath: string;
  hitchId: string;
  repoPath: string;
  /** explicit `--base-branch`; defaults to "main" when omitted (#236). */
  baseBranch?: string;
}): Pick<OrchestratorRunnerDeps, "repoPath" | "baseBranch"> {
  const { db, close } = openManagedDb({ dbPath: input.dbPath });
  try {
    runMigrations(db);
    new HitchRepository(db).requireSession(input.hitchId);
  } finally {
    close();
  }
  return {
    repoPath: input.repoPath,
    baseBranch: input.baseBranch ?? "main",
  };
}

export async function resolveHitchCoderRunnerDeps(input: {
  harnessRoot: string;
  dbPath: string;
  hitchId: string;
  repoPath: string;
  /** Codex binary (#191): the coder runner is built HERE so the per-project
   * resolved backend (claude vs codex) is applied — building it at the call site
   * would only see the global env. */
  codexBin: string;
  /**
   * Explicit `--base-branch`. When set it OVERRIDES the project profile's
   * `repo.base_branch` (#236); when omitted, a project-scoped hitch falls back to
   * the profile's base branch and a project-less hitch to "main".
   */
  baseBranch?: string;
}): Promise<
  Pick<
    OrchestratorRunnerDeps,
    | "repoPath"
    | "baseBranch"
    | "resolveRunContext"
    | "projectRuntime"
    | "coderRunner"
    | "coderBackend"
    | "coderCodexBinaryVersion"
  >
> {
  const { db, close } = openManagedDb({ dbPath: input.dbPath });
  let projectId: string | null;
  let domain: string | null;
  let repoId: string | null;
  try {
    runMigrations(db);
    const session = new HitchRepository(db).requireSession(input.hitchId);
    projectId = session.projectId;
    domain = session.domain;
    repoId = session.repoId;
  } finally {
    close();
  }

  if (projectId === null) {
    // Project-less (repo-id-mode) hitch: no profile, but a repoId+domain still
    // resolves a global+repo policy (the same one runDomainCoding loads), so
    // honour its coder backend. No repoId/domain → no policy → env fallback.
    // FAIL-OPEN: this runs before convergence even on close-only flows
    // (orchestrate of an already close_ready hitch builds a coder it never runs).
    // A missing/renamed repo policy must NOT block opening/merging that PR — fall
    // back to env rather than throwing.
    let codex: ResolvedPolicy["codex"] | undefined;
    if (domain !== null && repoId !== null) {
      try {
        codex = await resolveRepoCodexDefaults(input.harnessRoot, repoId, domain);
      } catch (e) {
        // ONLY a missing policy FILE (ENOENT — renamed/absent repo) falls back
        // to env so a close-only flow isn't blocked. A PRESENT-but-INVALID
        // policy (malformed YAML, schema/domain/command errors) still fails
        // CLOSED — env-defaulting a broken policy would be a silent safety hole.
        if ((e as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw e;
        codex = undefined;
      }
    }
    return {
      ...resolveHitchCloseRunnerDeps({
        dbPath: input.dbPath,
        hitchId: input.hitchId,
        repoPath: input.repoPath,
        ...(input.baseBranch !== undefined
          ? { baseBranch: input.baseBranch }
          : {}),
      }),
      ...coderRunnerDeps(
        input.codexBin,
        codex !== undefined ? coderBackendOpts(codex) : undefined,
      ),
    };
  }
  if (domain === null) {
    throw new HitchCliError(
      `hitch ${input.hitchId} has projectId ${projectId} but no domain`,
    );
  }

  const prepared = await prepareProjectRun({
    harnessRoot: input.harnessRoot,
    projectId,
    domain,
    repoOverride: input.repoPath,
  });
  // #236 — an explicit `--base-branch` overrides the profile's base branch.
  // `prepareProjectRun` only RETURNS base_branch (nothing internal depends on
  // it), so overriding here is safe; the run resolves origin/<name> downstream.
  const baseBranch = input.baseBranch ?? prepared.baseBranch;
  return {
    // #191: build the coder with the run's per-project resolved backend.
    ...coderRunnerDeps(
      input.codexBin,
      coderBackendOpts(prepared.resolvedPolicy.codex),
    ),
    repoPath: prepared.repoPath,
    baseBranch,
    resolveRunContext: (session) => ({
      repoPath: prepared.repoPath,
      repoId: prepared.repoId,
      domain: prepared.domain,
      goal: hitchGoalText(session),
      baseBranch,
    }),
    projectRuntime: {
      compiledPolicy: prepared.compiledPolicy,
      reviewRuleResolution: prepared.reviewRuleResolution,
      project: prepared.project,
      ...(prepared.projectContextPacks !== undefined
        ? { projectContextPacks: prepared.projectContextPacks }
        : {}),
    },
  };
}


export function formatHitchOrchestrateResultLine(
  hitchId: string,
  result: HitchOrchestrationResult,
  link: { linked: boolean; agent?: string },
): string {
  return (
    `hitch=${hitchId} outcome=${result.outcome}` +
    (result.draft !== undefined ? ` draft=${result.draft}` : "") +
    (result.prUrl !== undefined ? ` pr=${result.prUrl}` : "") +
    (result.escalateReason !== undefined
      ? ` escalate=${result.escalateReason}`
      : "") +
    (link.linked ? ` workspace=${link.agent}` : "")
  );
}

export function formatHitchStatusLine(result: {
  session: {
    hitchId: string;
    status: string;
    closeConditions: Array<{ id: string; kind: string; required: boolean }>;
  };
  convergence: {
    decision: string;
    metrics: { openInScopeP1: number; openUnknownScope: number };
  };
  closeChecks: Array<{
    conditionId: string;
    status: string;
    checkedAt?: string;
    evidence?: Record<string, unknown>;
  }>;
  lifecycleEvents?: Array<{
    event: string;
    createdAt?: string;
    detail?: Record<string, unknown> | null;
  }>;
  tokenUsage?: DbHitchTokenUsage;
}): string {
  const reviewAdvisoryCount = countReviewConsensusAdvisories(result);
  const staticConsensus = hasPassedReviewConsensusCheck(result)
    ? " review_consensus=static_pass tests=not_run_by_consensus"
    : "";
  const advisories =
    reviewAdvisoryCount > 0 ? ` review_advisories=${reviewAdvisoryCount}` : "";
  const adoptedPr = latestAdoptedPrEvent(result.lifecycleEvents ?? []);
  const adoptedPrText =
    adoptedPr === null ? "" : formatAdoptedPrStatusFields(adoptedPr.detail);
  const statusLine =
    `hitch=${result.session.hitchId} status=${result.session.status} ` +
    `decision=${result.convergence.decision} ` +
    `openP1=${result.convergence.metrics.openInScopeP1} ` +
    `unknown=${result.convergence.metrics.openUnknownScope}` +
    adoptedPrText +
    staticConsensus +
    advisories;
  return statusLine + formatHitchTokenUsageLine(result.tokenUsage);
}

/**
 * Render the per-hitch token usage as a second status line (retry-inclusive
 * sum over the hitch's attempts, with the coder/reviewer/evaluator split).
 * Empty string when no usage telemetry is present so older hitches stay quiet.
 */
export function formatHitchTokenUsageLine(usage?: DbHitchTokenUsage): string {
  if (usage === undefined || usage.runsWithUsage === 0) return "";
  const k = usage.byKind;
  return (
    `\ntokens total=${usage.totalTokens} ` +
    `(in=${usage.inputTokens} cached=${usage.cachedInputTokens} ` +
    `out=${usage.outputTokens} reasoning=${usage.reasoningOutputTokens}) ` +
    `runsWithUsage=${usage.runsWithUsage} ` +
    `byKind[coder=${k.coder.totalTokens} reviewer=${k.reviewer.totalTokens} ` +
    `evaluator=${k.evaluator.totalTokens}]`
  );
}

export function formatHitchFindingList(findings: HitchFinding[]): string {
  if (findings.length === 0) return "";
  return (
    findings
      .map((finding) =>
        [
          finding.findingId,
          finding.severity,
          finding.lifecycleStatus,
          finding.scopeStatus,
          finding.category,
          finding.summary,
        ].join("\t"),
      )
      .join("\n") + "\n"
  );
}

export function hasPassedReviewConsensusCheck(result: {
  session: { closeConditions: Array<{ id: string; kind: string }> };
  closeChecks: Array<{ conditionId: string; status: string; checkedAt?: string }>;
}): boolean {
  const reviewConditionIds = new Set(
    result.session.closeConditions
      .filter((condition) => condition.kind === "review_consensus")
      .map((condition) => condition.id),
  );
  for (const conditionId of reviewConditionIds) {
    const latest = latestCloseCheck(result.closeChecks, conditionId);
    if (latest?.status === "passed") return true;
  }
  return false;
}

export function latestAdoptedPrEvent(
  events: Array<{
    event: string;
    createdAt?: string;
    detail?: Record<string, unknown> | null;
  }>,
): { detail: Record<string, unknown> | null } | null {
  let latest: { createdAt: string; detail: Record<string, unknown> | null } | null =
    null;
  for (const event of events) {
    if (event.event !== "pr_adopted") continue;
    const normalized = {
      createdAt: event.createdAt ?? "",
      detail: event.detail ?? null,
    };
    if (latest === null || normalized.createdAt >= latest.createdAt) {
      latest = normalized;
    }
  }
  return latest === null ? null : { detail: latest.detail };
}

export function formatAdoptedPrStatusFields(
  detail: Record<string, unknown> | null,
): string {
  const adopted = readPrRef(detail, "adoptedPr");
  const superseded = readPrRef(detail, "supersededPr");
  const adoptedText = adopted === null ? null : formatPrReference(adopted);
  const supersededText =
    superseded === null ? null : formatPrReference(superseded);
  return (
    (adoptedText === null ? "" : ` pr=${adoptedText}`) +
    (supersededText === null ? "" : ` supersededPr=${supersededText}`)
  );
}

export function readPrRef(
  detail: Record<string, unknown> | null,
  key: string,
): { prUrl?: string | null; prNumber?: number | null } | null {
  if (detail === null) return null;
  const value = detail[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const url = typeof record.url === "string" ? record.url : null;
  const number = typeof record.number === "number" ? record.number : null;
  if (url === null && number === null) return null;
  return { prUrl: url, prNumber: number };
}

export function countReviewConsensusAdvisories(result: {
  session: { closeConditions: Array<{ id: string; kind: string }> };
  closeChecks: Array<{
    conditionId: string;
    status: string;
    checkedAt?: string;
    evidence?: Record<string, unknown>;
  }>;
}): number {
  const reviewConditionIds = new Set(
    result.session.closeConditions
      .filter((condition) => condition.kind === "review_consensus")
      .map((condition) => condition.id),
  );
  let count = 0;
  for (const conditionId of reviewConditionIds) {
    const latest = latestCloseCheck(result.closeChecks, conditionId);
    const advisories = latest?.evidence?.reviewerAdvisories;
    if (Array.isArray(advisories)) count += advisories.length;
  }
  return count;
}

export function latestCloseCheck(
  checks: Array<{
    conditionId: string;
    status: string;
    checkedAt?: string;
    evidence?: Record<string, unknown>;
  }>,
  conditionId: string,
): {
  conditionId: string;
  status: string;
  checkedAt?: string;
  evidence?: Record<string, unknown>;
} | null {
  return checks
    .filter((check) => check.conditionId === conditionId)
    .reduce<{
      conditionId: string;
      status: string;
      checkedAt?: string;
      evidence?: Record<string, unknown>;
    } | null>(
      (latest, check) => {
        if (latest === null) return check;
        if ((check.checkedAt ?? "") >= (latest.checkedAt ?? "")) return check;
        return latest;
      },
      null,
    );
}

/**
 * Early schema-version-skew preflight for `hitch orchestrate` (#271). Opens a
 * read-only handle (shared lock — non-contending), reads the on-disk schema
 * version WITHOUT migrating, and throws a friendly, actionable `DbError`
 * (mapped to exit 1 by the hitch CLI error mapper) BEFORE any deep work when
 * the DB is newer than this harness. The `runMigrations` guard inside
 * `withHitchRepo*` remains the fail-closed backstop.
 */
export function assertHitchOrchestrateSchemaCompatible(
  opts: RegisterHitchCommandsOptions,
): void {
  const paths = harnessPaths(opts.getHarnessRoot());
  // A fresh/uninitialized harness root has no DB to be skewed against — skip the
  // read-only preflight and let the normal create+migrate path run (with the
  // runMigrations backstop). The read-only handle below requires the file to
  // exist (fileMustExist), so opening it on a fresh root would throw.
  if (!existsSync(paths.dbPath)) return;
  const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  try {
    const dbVersion = readSchemaVersion(handle.db);
    const compat = evaluateSchemaCompatibility(dbVersion);
    if (compat.kind === "db-newer-than-harness") {
      throw new DbError(compat.message);
    }
  } finally {
    handle.close();
  }
}

export function withHitchRepo<T>(
  opts: RegisterHitchCommandsOptions,
  fn: (ctx: HitchContext) => T,
): T {
  const root = opts.getHarnessRoot();
  const paths = harnessPaths(root);
  const handle = openManagedDb({ dbPath: paths.dbPath });
  try {
    runMigrations(handle.db);
    return fn({ root, paths, repo: new HitchRepository(handle.db), db: handle.db });
  } finally {
    handle.close();
  }
}

export async function withHitchRepoAsync<T>(
  opts: RegisterHitchCommandsOptions,
  fn: (ctx: HitchContext) => Promise<T>,
): Promise<T> {
  const root = opts.getHarnessRoot();
  const paths = harnessPaths(root);
  const handle = openManagedDb({ dbPath: paths.dbPath });
  try {
    runMigrations(handle.db);
    return await fn({
      root,
      paths,
      repo: new HitchRepository(handle.db),
      db: handle.db,
    });
  } finally {
    handle.close();
  }
}

/**
 * Open the harness DB READ-ONLY for a pure reporter (#84 `hitch summary`): a
 * shared-lock handle, NO migrations (a report must never mutate — not even
 * schema), and a fail-closed schema preflight. Mirrors the read-only open used
 * by the MCP read tools / run-db-reader. Use this — NOT `withHitchRepo`, which
 * opens read-write and runs migrations — for any command that only reads.
 */
export function withHitchReadonlyDb<T>(
  opts: RegisterHitchCommandsOptions,
  fn: (ctx: { db: Database.Database }) => T,
): T {
  const paths = harnessPaths(opts.getHarnessRoot());
  if (!existsSync(paths.dbPath)) {
    throw new HitchCliError(`no harness DB at ${paths.dbPath}`);
  }
  const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  try {
    // A read-only handle cannot migrate; reject a DB NEWER than this harness
    // (unreadable) with the actionable skew message. Older/equal additive
    // schemas read fine for the core tables the reporter touches.
    const compat = evaluateSchemaCompatibility(readSchemaVersion(handle.db));
    if (compat.kind === "db-newer-than-harness") {
      throw new DbError(compat.message);
    }
    return fn({ db: handle.db });
  } finally {
    handle.close();
  }
}

export function withHitchErrorExit(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    hitchError(e);
  }
}

export async function withHitchErrorExitAsync(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    hitchError(e);
  }
}

export function hitchError(e: unknown): never {
  const mapped = mapHitchErrorExit(e);
  if (mapped !== null) {
    process.stderr.write(`harness error: ${mapped.message}\n`);
    process.exit(mapped.code);
  }
  throw e;
}

/**
 * #280 — the deterministic `recover-diverging` gate. Computed ONLY from
 * `ConvergenceService.evaluate()` metrics + a fresh close-condition eval (never
 * an LLM/self-report). Throws `HitchCliError` (fail-closed, exit 1) on any unmet
 * invariant; returns the computed minimal budget extension on success. Run BOTH
 * as the CLI pre-check AND, re-bound to the transaction's repo, as the in-tx
 * revalidation (P2#2) so concurrent drift cannot land recovery on stale state.
 *
 * When `extendOverride` is supplied (operator flag, or the pre-check's fixed
 * extension re-proven in-transaction) it is used verbatim; otherwise the minimal
 * deficit+1 extension is computed. The residual re-derivation under the post-bump
 * EFFECTIVE budget must clear ALL divergence triggers, else it refuses.
 */
export function assertRecoverDivergingGate(
  repo: HitchRepository,
  hitchId: string,
  extendOverride: number | undefined,
): { extend: number } {
  const session = repo.requireSession(hitchId);
  if (session.status !== "diverging") {
    throw new HitchCliError(
      `hitch ${hitchId} is "${session.status}", not diverging; ` +
        `recover-diverging only applies to a diverging hitch`,
    );
  }
  const convergence = new ConvergenceService(repo).evaluate(hitchId);
  if (convergence.decision !== "diverging") {
    throw new HitchCliError(
      `hitch ${hitchId} no longer diverges live (decision=` +
        `${convergence.decision}); the trigger already cleared — no ` +
        `recovery needed`,
    );
  }
  // Only the cumulative SESSION-budget trigger is recoverable by a budget bump.
  // Per-cycle / reopen-count / non-decreasing-trend triggers are NOT.
  if (convergence.reason !== RECOVERABLE_DIVERGENCE_REASON) {
    throw new HitchCliError(
      `hitch ${hitchId} cannot recover from diverging: the divergence ` +
        `trigger ("${convergence.reason}") is not recoverable via a ` +
        `budget extension; investigate or cancel+recreate ` +
        `(this is NOT a gate-skip)`,
    );
  }
  // The close pre-gate: STRICTLY STRONGER than `close --force`. Refuse on any
  // open in-scope P0/P1, open unknown-scope, or red/pending required close-check.
  const reasons: string[] = [];
  if (convergence.metrics.openInScopeP0 > 0) {
    reasons.push("open in-scope P0 findings");
  }
  if (convergence.metrics.openInScopeP1 > 0) {
    reasons.push("open in-scope P1 findings");
  }
  if (convergence.metrics.openUnknownScope > 0) {
    reasons.push("open unknown-scope findings");
  }
  if (convergence.metrics.closeConditionsFailed > 0) {
    reasons.push("failed required close-checks");
  }
  if (convergence.metrics.closeConditionsPending > 0) {
    reasons.push("pending required close-checks");
  }
  if (reasons.length > 0) {
    throw new HitchCliError(
      `hitch ${hitchId} cannot recover from diverging: ` +
        `${reasons.join(", ")}; resolve these then retry ` +
        `(this is NOT a gate-skip)`,
    );
  }
  // Minimal extension that lifts the cumulative count ABOVE the strict `>` budget
  // comparison (deficit + 1), unless an extension is supplied.
  const deficit = Math.max(
    0,
    convergence.metrics.harnessOriginNewFindings - session.maxTotalNewFindings,
  );
  const extend = extendOverride ?? deficit + 1;
  // PROVE re-derivation under the post-bump budget no longer fires ANY divergence
  // trigger (the EFFECTIVE total ceiling is max(session,policy), so a default
  // hitch where session==policy is correctly cleared) — fail-closed otherwise.
  const residual = divergenceReasonForBudget(
    session,
    convergence.metrics,
    session.maxTotalNewFindings + extend,
  );
  if (residual !== null) {
    throw new HitchCliError(
      `hitch ${hitchId} cannot recover from diverging: a budget ` +
        `extension of ${extend} would still leave it diverging ` +
        `("${residual}"); raise --extend-divergence-budget or ` +
        `cancel+recreate (this is NOT a gate-skip)`,
    );
  }
  return { extend };
}

export function mapHitchErrorExit(
  e: unknown,
): { code: 1; message: string } | null {
  const lease = findTransientLeaseCause(e);
  if (lease !== undefined) {
    return {
      code: 1,
      message: `hitch deferred/lock_busy (${lease.name}): ${lease.message}`,
    };
  }
  if (
    e instanceof HitchCliError ||
    e instanceof DbError ||
    e instanceof BacklogError ||
    e instanceof HitchValidationError
  ) {
    return { code: 1, message: e.message };
  }
  return null;
}

export class HitchCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HitchCliError";
  }
}

export function writeOutput(raw: Record<string, unknown>, value: unknown, text: string): void {
  process.stdout.write(raw.json === true ? `${JSON.stringify(value, null, 2)}\n` : text);
}

export function warnBacklogExport(exportWarning: string | undefined): void {
  if (exportWarning !== undefined) {
    process.stderr.write(`warning: ${exportWarning}\n`);
  }
}

export function writeConvergence(
  raw: Record<string, unknown>,
  value: HitchConvergenceResult & { decisionRecord: unknown },
): void {
  if (raw.json === true) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `hitch=${value.hitchId} decision=${value.decision} reason=${value.reason}\n`,
  );
}

export function parsePrReference(text: string): {
  prUrl?: string | null;
  prNumber?: number | null;
} {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new HitchCliError("<pr-url-or-number> must not be empty");
  }
  if (/^\d+$/.test(trimmed)) {
    return { prNumber: Number(trimmed) };
  }
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(trimmed);
  return {
    prUrl: trimmed,
    ...(match?.[1] !== undefined ? { prNumber: Number(match[1]) } : {}),
  };
}

export function formatPrReference(input: {
  prUrl?: string | null;
  prNumber?: number | null;
}): string {
  if (input.prUrl !== undefined && input.prUrl !== null) return input.prUrl;
  if (input.prNumber !== undefined && input.prNumber !== null) {
    return `#${input.prNumber}`;
  }
  return "-";
}

export function readStructuredFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return JSON.parse(text) as unknown;
  return parseYaml(text) as unknown;
}

export function parseJsonRecord(text: string, flag: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HitchCliError(`${flag} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function parseScope(value: unknown): HitchScopeStatus {
  const normalized = String(value).replace(/-/g, "_");
  return parseChoice(normalized, HITCH_SCOPE_STATUSES, "--scope") as HitchScopeStatus;
}

export function parseChoice<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  flag: string,
): T[number] {
  const str = String(value);
  if (!(allowed as readonly string[]).includes(str)) {
    throw new HitchCliError(
      `${flag} must be one of ${allowed.join("|")} (got ${JSON.stringify(str)})`,
    );
  }
  return str as T[number];
}

export function parsePositiveInt(value: unknown, flag: string): number {
  const parsed = parseNonNegativeInt(value, flag);
  if (parsed < 1) throw new HitchCliError(`${flag} must be a positive integer`);
  return parsed;
}

export function parseMergeMethod(value: unknown): PrMergeMethod {
  if (value === "squash" || value === "merge" || value === "rebase") {
    return value;
  }
  throw new HitchCliError("--merge-method must be one of: squash, merge, rebase");
}

export function parseNonNegativeInt(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new HitchCliError(`${flag} must be a non-negative integer`);
  }
  return n;
}

export function countOption(
  raw: Record<string, unknown>,
  key: keyof CompleteHitchReviewCycleInput,
  flag: string,
): Partial<CompleteHitchReviewCycleInput> {
  const value = raw[key];
  return value === undefined ? {} : { [key]: parseNonNegativeInt(value, flag) };
}

export function parseCycleCounts(value: unknown): Partial<CompleteHitchReviewCycleInput> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HitchCliError("--from-findings must contain an object");
  }
  const raw = value as Record<string, unknown>;
  return {
    ...parseCountField(raw, "findingsSeen"),
    ...parseCountField(raw, "findingsNew"),
    ...parseCountField(raw, "findingsReopened"),
    ...parseCountField(raw, "findingsFixed"),
    ...parseCountField(raw, "findingsDeferred"),
    ...parseCountField(raw, "findingsInScopeOpen"),
    ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
  };
}

export function parseCountField(
  raw: Record<string, unknown>,
  key: keyof CompleteHitchReviewCycleInput,
): Partial<CompleteHitchReviewCycleInput> {
  return raw[key] === undefined
    ? {}
    : { [key]: parseNonNegativeInt(raw[key], key) };
}
