// workflow-runner の diff / validate / materialize helper 層。

import { dirname, join } from "node:path";
import { copyFile, cp, lstat, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";

import { performance } from "node:perf_hooks";

import { partitionUntracked } from "../policy/untracked-filter.js";
import { validateChangedPaths, type Violation } from "../policy/path-policy-validator.js";
import type { ResolvedPolicy, ChangeBudget } from "../policy/schema.js";

import type { RunLog, RunMeta, SafetyStatus } from "../logging/run-log.js";

import { createReadStream } from "node:fs";

import { gitCli } from "../git/git-cli.js";
import { collectDiff, type DiffResult, type DiffStat } from "../git/diff.js";
import { normalizeDiffBudget, validateDiffBudget } from "../policy/diff-budget-validator.js";

import { elapsedMs } from "./workflow-runner-shared.js";
import type { ContinueFromSkipReason, RunChangeBudgetOverride } from "./workflow-runner-shared.js";

export async function readTail(path: string, maxBytes = 8 * 1024): Promise<string> {
  try {
    const buf = await readFile(path);
    if (buf.length <= maxBytes) return buf.toString("utf8");
    return buf.subarray(buf.length - maxBytes).toString("utf8");
  } catch {
    return "";
  }
}

export function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

export async function readOptionalUtf8(path: string): Promise<string | null> {
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

export async function readStderrTail(
  path: string,
  maxBytes = 8 * 1024,
): Promise<string> {
  return filterPatchEcho(await readTail(path, maxBytes));
}

export interface DiffOutcome {
  ok: boolean;
  error?: string;
  trackedChangedPaths: string[];
  stagedChangedPaths: string[];
  untrackedAll: string[];
  stat?: DiffStat;
  patch: string;
}

export interface DiffAndValidate {
  diff: DiffOutcome;
  untrackedKept: string[];
  untrackedIgnored: string[];
  violations: Violation[];
  safetyStatus: SafetyStatus;
  budgetStat?: DiffStat;
  diffDurationMs: number;
  policyValidationDurationMs: number;
}

export function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

export function looksBinary(buf: Buffer): boolean {
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

export async function statWithAllowedUntracked(
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

export async function diffAndValidate(opts: {
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

export async function attemptDiff(
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

export function applyChangeBudgetOverride(
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

export async function evaluateChangeBudget(opts: {
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
export async function materializeEntry(src: string, dst: string): Promise<void> {
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
export async function resetWorktreeToBase(
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
export async function normalizeWorktreeIndexToBase(
  worktreePath: string,
  baseSha: string,
  gitTimeoutMs: number,
): Promise<void> {
  await runResetStep(["reset", "--mixed", baseSha], {
    cwd: worktreePath,
    timeoutMs: gitTimeoutMs,
  });
}

export async function runResetStep(
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

