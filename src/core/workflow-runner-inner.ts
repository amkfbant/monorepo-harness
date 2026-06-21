// workflow-runner の runDomainCodingInner（FROZEN: lease/dup-gate + PRE/POST-normalize #141/#197 + all-or-nothing materialize）。

import { join } from "node:path";

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { stringify as yamlStringify } from "yaml";
import { harnessPaths } from "../config/paths.js";

import type { ResolvedPolicy } from "../policy/schema.js";
import type Database from "better-sqlite3";
import type { RunLog, RunMeta, RunStatus } from "../logging/run-log.js";

import { ingestRunArtifacts } from "../db/run-artifacts.js";
import { fileExportEnabled } from "../config/export-mode.js";
import { rmSync } from "node:fs";

import { RunRepository, type ChangedFileInput } from "../db/repositories/runs.js";

import { writeArtifact } from "../logging/artifacts.js";

import { runAllowedCommands } from "./command-runner.js";

import { resolveEffectiveRule } from "./review-rule.js";
import { ReviewRulesRepository } from "../db/repositories/review-rules.js";
import { assertActiveLease } from "../workspace/db-domain-lock.js";

import { createWorktree } from "../workspace/git-worktree.js";

import { detectsTestWeakening } from "./automerge-tiers.js";
import { buildCodexPrompt } from "../codex/prompt-builder.js";
import { summarizeCodexEvents } from "../codex/events-summary.js";
import { computeReviewedFingerprint } from "./reviewed-fingerprint.js";

import { buildSummary } from "../reporter/summary.js";
import { buildKnowledgeCandidates } from "../reporter/knowledge-candidates.js";
import { buildReviewRequest } from "../reporter/review-request.js";
import { buildReviewDecision } from "../reporter/review-decision.js";
import { buildUntrackedPatch, buildUntrackedDeniedReport, buildUntrackedSecretsReport } from "../reporter/untracked-patch.js";
import { publishRedactedCodexEvents } from "../codex/events-lifecycle.js";
import { redactClaudeEvents } from "../claude/redact-events.js";
import { recordClaudeUsage } from "../db/repositories/claude-usage.js";
import { resolveAgentBackend, resolveClaudeModel } from "./agent-runner.js";
import {
  recordCodexUsage,
  resolveCodexModel,
} from "../db/repositories/run-usage.js";
import { warnArtifactIngestFailed, warnUsageRecordFailed, elapsedMs } from "./workflow-runner-shared.js";
import type { RunDomainCodingOpts, RunDomainCodingResult } from "./workflow-runner-shared.js";
import { applyChangeBudgetOverride, diffAndValidate, evaluateChangeBudget, materializeParentWork, normalizeWorktreeIndexToBase, readOptionalUtf8, readStderrTail, readTail } from "./workflow-runner-diff.js";

export function snapshotReviewRuleForRun(input: {
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

export interface InnerOpts {
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

export async function runDomainCodingInner(
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
    // #191 — the coder runner may be claude (opt-in). The runner was injected
    // by the same resolveAgentBackend('coder') the dispatch below reads, so the
    // events shape, redactor, and usage parser agree by construction.
    const coderBackend = resolveAgentBackend("coder");
    const codexEventsRedaction = await publishRedactedCodexEvents({
      rawPath: codexRawEventsPath,
      tmpPath: codexRedactedTmpPath,
      officialPath: codexEventsPath,
      io: opts.codexEventsIo,
      runId,
      ...(coderBackend === "claude" ? { redact: redactClaudeEvents } : {}),
    });
    let codexEventsContent: string | null = null;
    try {
      codexEventsContent = await readOptionalUtf8(codexEventsPath);
    } catch {
      codexEventsContent = null;
    }
    if (coderBackend === "claude") {
      recordClaudeUsage({
        db,
        runId,
        kind: "coder",
        eventsContent: codexEventsContent,
        model: resolveClaudeModel(),
        beforeWrite: () => assertActiveLease(db, runId),
        onError: (error) => warnUsageRecordFailed(runId, error),
      });
    } else {
      recordCodexUsage({
        db,
        runId,
        kind: "coder",
        eventsContent: codexEventsContent,
        model: resolveCodexModel(policy.codex.model),
        beforeWrite: () => assertActiveLease(db, runId),
        onError: (error) => warnUsageRecordFailed(runId, error),
      });
    }
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
