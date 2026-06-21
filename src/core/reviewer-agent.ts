import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { RunMeta } from "../logging/run-log.js";
import {
  loadReviewDecision,
  serializeReviewDecision,
  writeReviewDecision,
} from "./review-decision-loader.js";
import {
  ensureRunMaterialized,
  quarantinePriorReviewerVerdictArtifacts,
} from "./run-materialize.js";
import type { ReviewDecisionFile } from "./review-decision-schema.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { createHash } from "node:crypto";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";
import { ReviewProposalRepository } from "../db/repositories/review-proposals.js";
import { ReviewRulesRepository } from "../db/repositories/review-rules.js";
import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";
import {
  assertPathSafeReviewerId,
  InvalidReviewerMetadataError,
  ReviewerRepository,
  reviewerLensMetadata,
} from "../db/repositories/reviewers.js";
import { evaluateConsensus } from "./review-consensus.js";
import {
  enrichActiveProposals,
  enrichRefuteVotesForRun,
} from "./consensus-enrichment.js";
import {
  DEFAULT_REVIEW_RULE,
  frozenReviewerIdsForRule,
  parseReviewRuleSnapshot,
  ruleSha256,
  type ReviewRule,
} from "./review-rule.js";
import { ReviewRefuteVotesRepository } from "../db/repositories/review-refute-votes.js";
import type Database from "better-sqlite3";
import { fileExportEnabled } from "../config/export-mode.js";
import { ReviewerAgentGateError } from "./reviewer-agent-errors.js";
import { classifyReviewGate } from "./review-gate-classify.js";
import { buildOperationalKnowledgeReviewSection } from "./operational-knowledge.js";
import { publishRedactedCodexEvents } from "../codex/events-lifecycle.js";
import { redactClaudeEvents } from "../claude/redact-events.js";
import { sanitizeGateReason } from "./gate-reason.js";
import { recordReviewerUsage } from "./reviewer-agent-usage.js";
import type {
  ReviewerAgentInputs,
  ReviewerAgentResult,
  ReviewerLensPrompt,
} from "./reviewer-agent-types.js";
import {
  PROMPT_PREAMBLE,
  REVIEWER_PROMPT_TEMPLATE,
  buildReviewerLensSection,
  reviewerLensProvenance,
} from "./reviewer-agent-prompt.js";
import {
  extractYamlBlock,
  buildDecision,
  type PartialDecision,
} from "./reviewer-agent-decision.js";
import {
  REVIEWER_WRITE_ALLOWLIST,
  materializeReviewerInput,
  reviewerArtifactRelDir,
  snapshotRunDir,
  verifyArtifactsUnchanged,
} from "./reviewer-artifact-isolation.js";

export { ReviewerAgentGateError } from "./reviewer-agent-errors.js";
// Re-export the moved public surface so existing `./reviewer-agent.js` importers
// (review-evaluator, orchestrator-runners, tests) keep their import paths.
export { PROMPT_PREAMBLE, REVIEWER_PROMPT_TEMPLATE };
export { extractYamlBlock, buildDecision };
export type {
  PartialDecision,
  ReviewerAgentInputs,
  ReviewerAgentResult,
  ReviewerLensPrompt,
};

/** Diagnostic artifact written when codex output cannot be parsed/validated. */
export const REVIEW_AUTO_ERROR_FILE = "review-auto-error.json";

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertReviewerPathSafeForAgent(reviewerId: string): void {
  try {
    assertPathSafeReviewerId(reviewerId);
  } catch (e) {
    throw new ReviewerAgentGateError((e as Error).message);
  }
}

/**
 * The latest recorded review decision for a run, or null. Used (#77) to tell a
 * run whose `review-decision.yaml` sidecar was deleted under export-OFF (but
 * whose verdict is in the DB) apart from a genuinely incomplete run.
 */
function latestRecordedDecision(
  dbPath: string | undefined,
  runId: string,
): string | null {
  if (dbPath === undefined || !existsSync(dbPath)) return null;
  const probe = openManagedDb({ dbPath, readonly: true });
  try {
    const repo = new ReviewProposalRepository(probe.db);
    const proposal =
      repo.getLatestProcessedProposal(runId) ??
      repo.getLatestActiveProposal(runId);
    return proposal?.decision ?? null;
  } finally {
    probe.close();
  }
}

export async function runReviewerAgent(
  inputs: ReviewerAgentInputs,
): Promise<ReviewerAgentResult> {
  if (!RUN_ID_RE.test(inputs.runId)) {
    throw new ReviewerAgentGateError(
      `invalid runId: ${JSON.stringify(inputs.runId)}`,
    );
  }
  const reviewer = inputs.reviewerName ?? "codex-reviewer";
  assertReviewerPathSafeForAgent(reviewer);
  let reviewerLens = inputs.reviewerLens;
  const hasDb = inputs.dbPath !== undefined && existsSync(inputs.dbPath);
  const runDir = join(inputs.runsDir, inputs.runId);
  // the reviewer spawns codex with a read-only sandbox over the run dir,
  // so the run's files must exist. With file export OFF a db-first run
  // has none — materialize them from the DB first (Phase 8-13).
  if (inputs.dbPath !== undefined) {
    ensureRunMaterialized({
      dbPath: inputs.dbPath,
      runsDir: inputs.runsDir,
      runId: inputs.runId,
      repairMissingReviewDecision: true,
    });
  }
  const metaPath = join(runDir, "meta.json");
  const decisionPath = join(runDir, "review-decision.yaml");
  const reviewerRelDir = reviewerArtifactRelDir(reviewer);
  const reviewerDir = join(runDir, "reviewers", reviewer);
  const reviewerDecisionPath = join(reviewerDir, "review-decision.yaml");

  let metaRaw: unknown;
  try {
    metaRaw = JSON.parse(await readFile(metaPath, "utf8"));
  } catch (e) {
    throw new ReviewerAgentGateError(
      `failed to read meta.json for ${inputs.runId}: ${(e as Error).message}`,
    );
  }
  if (!metaRaw || typeof metaRaw !== "object" || Array.isArray(metaRaw)) {
    throw new ReviewerAgentGateError(
      `meta.json for ${inputs.runId} is not an object`,
    );
  }
  const meta = metaRaw as RunMeta;
  const decisionFileExists = existsSync(decisionPath);
  // #77 — the DB is canonical: distinguish an already-decided run
  // (re-orchestrate is a no-op; with export OFF the sidecar is deleted after a
  // decision) from a genuinely incomplete one. Probe the DB only on the
  // missing-file path so the normal success path stays a single DB open below.
  const recordedDecision =
    meta.status === "needs_review" && !decisionFileExists
      ? latestRecordedDecision(inputs.dbPath, inputs.runId)
      : null;
  const gate = classifyReviewGate({
    runId: inputs.runId,
    status: meta.status ?? "",
    decisionFileExists,
    recordedDecision,
  });
  if (gate.kind !== "ok") {
    throw new ReviewerAgentGateError(gate.message, { kind: gate.kind });
  }

  // Load the current decision file. Malformed → refuse (we'd otherwise
  // not know whether it held a human verdict).
  const existingDecision = await loadReviewDecision(decisionPath).catch(
    () => {
      throw new ReviewerAgentGateError(
        `existing review-decision.yaml is malformed; refusing to overwrite`,
      );
    },
  );
  // Phase 9 post-close (second review) P1-5 fix — the overwrite guard
  // must be DB-aware. With export OFF the sidecar may be a scratch
  // materialization or a stale `pending` template from a re-export, so a
  // DB-canonical active proposal must be the primary guard. The file
  // sidecar is a fallback for legacy / non-DB runs.
  let activeDbProposal: Awaited<
    ReturnType<ReviewProposalRepository["getLatestActiveProposal"]>
  > = null;
  // Operational knowledge (issue #57) is injected into the REVIEWER prompt only
  // (never the coder prompt). Scoped to this run's project + repo (not domain),
  // bounded — see the call below.
  let reviewerOpsSection = "";
  let reviewerOpsKnowledge: { entryId: string; version: number }[] = [];
  if (inputs.dbPath !== undefined && existsSync(inputs.dbPath)) {
    const probe = openManagedDb({ dbPath: inputs.dbPath, readonly: true });
    try {
      activeDbProposal = new ReviewProposalRepository(
        probe.db,
      ).getLatestActiveProposal(inputs.runId);
      if (reviewerLens === undefined) {
        const reviewerRow = new ReviewerRepository(probe.db).findById(reviewer);
        if (reviewerRow !== null) {
          try {
            reviewerLens = reviewerLensMetadata(reviewerRow) ?? undefined;
          } catch (e) {
            if (e instanceof InvalidReviewerMetadataError) {
              throw new ReviewerAgentGateError(e.message);
            }
            throw e;
          }
        }
      }
      // Scope by project + repo only (both include portable, project/repo-less
      // entries). Operational knowledge is rarely domain-specific, and the
      // domain filter would exclude portable notes — so it is intentionally not
      // applied here.
      const reviewerOps = buildOperationalKnowledgeReviewSection(probe.db, {
        projectId: meta.project?.projectId ?? null,
        repoId: meta.repoId ?? null,
      });
      reviewerOpsSection = reviewerOps.section;
      reviewerOpsKnowledge = reviewerOps.included;
    } finally {
      probe.close();
    }
  }
  if (!inputs.allowOverwrite) {
    if (activeDbProposal !== null) {
      throw new ReviewerAgentGateError(
        `review_proposals already has an active proposal for ${inputs.runId} ` +
          `(decision="${activeDbProposal.decision}", reviewer="${activeDbProposal.reviewer}"); ` +
          `pass --allow-overwrite to replace it`,
      );
    }
    if (existingDecision.decision !== "pending") {
      throw new ReviewerAgentGateError(
        `review-decision.yaml already has decision="${existingDecision.decision}"; pass --allow-overwrite to replace it`,
      );
    }
  }

  // #272 / P1-ISO — make EVERY prior reviewer's / pass's / command's verdict
  // UNREACHABLE on disk BEFORE codex runs (and before the tamper snapshot). codex
  // `--sandbox read-only` can absolute-read ANY path, so cwd isolation alone does
  // not stop a sequential reviewer recovering a prior verdict verbatim — from a
  // sibling `reviewers/<other>/reviewer-agent.out.log` (the fenced verdict YAML)
  // or events (redaction is secret-only, NOT verdict-stripping), a refute
  // transcript (`refute-agent.out.log`), a `review-evaluations/**` log/decision,
  // or the root/scoped `review-decision.yaml`. Rather than chase a verdict-file
  // denylist (which kept missing producers), quarantine by INPUT-ALLOWLIST: keep
  // only the reviewer inputs, remove every other run-dir entry. In DB-backed
  // file-export-OFF review the verdict is DB-canonical (`review_proposals`) and
  // each ingestable prior output is ingested to the DB before removal (audit set
  // stays recoverable); raw dotfile streams are remove-only. The CURRENT
  // reviewer's scoped dir is created below (after this), so only prior/completed
  // artifacts are removed. No-DB legacy review keeps the root verdict (canonical
  // there); export-ON keeps the sidecars/logs for compatibility; both are
  // unaffected by this gate. `assertReviewerInputDirHasNoVerdict` (cwd) remains as
  // a fail-closed backstop on the materialized input dir.
  if (hasDb && inputs.dbPath !== undefined && !fileExportEnabled()) {
    // The inversion removes root + scoped `review-decision.yaml` (and every other
    // prior output) ITSELF, and ONLY for a confirmed `source_mode='db-first'` run
    // (fail-closed gate inside the function). A DB-backed file-first / legacy run
    // is a no-op — its canonical verdict sidecar is NOT removed. The decision-yaml
    // suppression that `suppressRunDirVerdictFiles` used to provide is subsumed
    // here under the SAME db-first gate, so it is not called ungated (which would
    // have removed a file-first run's canonical verdict without recovery).
    quarantinePriorReviewerVerdictArtifacts({
      dbPath: inputs.dbPath,
      runsDir: inputs.runsDir,
      runId: inputs.runId,
    });
  }

  // Invoke codex from an isolated input copy. Sandbox is read-only; the agent
  // only needs the materialized run artifacts, not the live runDir tree.
  await mkdir(reviewerDir, { recursive: true });
  const stdoutPath = join(reviewerDir, "reviewer-agent.out.log");
  const stderrPath = join(reviewerDir, "reviewer-agent.err.log");
  const rawEventsPath = join(reviewerDir, ".reviewer-agent.events.raw.jsonl");
  const tmpEventsPath = join(reviewerDir, ".reviewer-agent.events.redacted.tmp");
  const eventsPath = join(reviewerDir, "reviewer-agent.events.jsonl");
  const errorArtifactPath = join(reviewerDir, REVIEW_AUTO_ERROR_FILE);

  // Defense in depth: even though the runner is configured with
  // sandbox=read-only, a misconfigured HARNESS_CODEX_BIN or sandbox
  // failure could let the agent tamper with run artifacts. Snapshot
  // every file (size + mtime) under runDir before codex runs, then
  // verify nothing outside the writable allowlist changed.
  const snapshot = await snapshotRunDir(
    runDir,
    reviewerRelDir,
    REVIEWER_WRITE_ALLOWLIST,
  );

  const reviewerPrompt =
    PROMPT_PREAMBLE + buildReviewerLensSection(reviewerLens) + reviewerOpsSection;
  const promptSha256 = createHash("sha256").update(reviewerPrompt).digest("hex");
  const lensProvenance = reviewerLensProvenance(reviewer, reviewerLens);

  // P1-ISO (#229): the reviewer's codex sandbox cwd must live OUTSIDE the run
  // dir tree. codex `--sandbox read-only` sets `-C` as cwd but does NOT jail
  // reads to that subtree, so a cwd anywhere under runDir lets the agent reach
  // a prior reviewer's verdict via `../` (e.g. ../../alice/review-decision.yaml
  // or the repaired root review-decision.yaml). A fresh OS-temp dir shares no
  // `..`-reachable ancestor with runDir, so no parent-relative path resolves to
  // any verdict. Only the allowed inputs are copied in; logs/decision stay in
  // reviewerDir (run dir, tamper-snapshotted). Created right before the try so
  // the finally always owns its cleanup (no leak window).
  const reviewerInputDir = await mkdtemp(
    join(tmpdir(), "harness-reviewer-input-"),
  );
  let codexResult: Awaited<ReturnType<CodexExecRunner["run"]>>;
  try {
    // materialize inside the try so a copy failure still cleans up the temp dir
    await materializeReviewerInput(runDir, reviewerInputDir);
    codexResult = await inputs.codexRunner.run({
      worktreePath: reviewerInputDir,
      prompt: reviewerPrompt,
      logPaths: { stdout: stdoutPath, stderr: stderrPath, events: rawEventsPath },
      ...(inputs.signal !== undefined ? { signal: inputs.signal } : {}),
    });
  } finally {
    await rm(reviewerInputDir, { recursive: true, force: true });
  }
  const reviewedAt = (inputs.now ?? new Date()).toISOString();
  const writeGateErrorArtifact = async (
    e: ReviewerAgentGateError,
  ): Promise<void> => {
    const reason =
      e.sanitizedReason ??
      sanitizeGateReason({
        code: e.kind ?? "reviewer_agent_gate_error",
      });
    await writeFile(
      errorArtifactPath,
      `${JSON.stringify(
        {
          type: "review-auto-error",
          runId: inputs.runId,
          reviewer,
          failedAt: reviewedAt,
          reason,
          rawOutputPath: `${reviewerRelDir}/reviewer-agent.out.log`,
          codexExitCode: codexResult.exitCode,
          timedOut: codexResult.timedOut,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  // Everything after codex runs is wrapped: ANY ReviewerAgentGateError —
  // artifact tampering, codex timeout, non-zero exit, or unparseable /
  // invalid output — writes review-auto-error.json (unless dry-run) so the
  // operator (and `harness workflow reviewed-run`) can inspect what went
  // wrong. review-decision.yaml is NOT touched on this path.
  let decision: ReviewDecisionFile;
  let reviewerEventsPublished = false;
  try {
    // Tamper check FIRST — before the timeout/exitCode gates. A sandbox
    // escape that mutates an artifact and THEN exits non-zero / times out
    // would otherwise slip past detection.
    await verifyArtifactsUnchanged(
      runDir,
      snapshot,
      reviewerRelDir,
      REVIEWER_WRITE_ALLOWLIST,
    );
    // #191: a claude reviewer needs the claude-shaped redactor (the codex
    // redactor's parsed.item gate would pass claude events through un-redacted).
    const reviewerBackend = inputs.reviewerBackend ?? "codex";
    const publishResult = await publishRedactedCodexEvents({
      rawPath: rawEventsPath,
      tmpPath: tmpEventsPath,
      officialPath: eventsPath,
      runId: inputs.runId,
      ...(reviewerBackend === "claude" ? { redact: redactClaudeEvents } : {}),
    });
    reviewerEventsPublished = !publishResult.failed;

    // token-usage G2: record reviewer codex usage right after the publish
    // attempt, BEFORE the timeout/exit/parse gates, so usage is captured on
    // EVERY outcome (success, timeout, non-zero exit, invalid YAML). Reads
    // ONLY the redacted official events; when publish failed the events are
    // unavailable, so a null content records an `unavailable` row rather than
    // reading a possibly-stale file. fail-open: telemetry never affects review.
    if (!inputs.dryRun) {
      const eventsContent = reviewerEventsPublished
        ? await readFile(eventsPath, "utf8").catch(() => null)
        : null;
      await recordReviewerUsage(
        inputs.dbPath,
        inputs.runId,
        eventsContent,
        reviewerBackend,
      );
    }

    if (codexResult.timedOut) {
      throw new ReviewerAgentGateError(
        `reviewer codex timed out for ${inputs.runId}`,
        {
          sanitizedReason: sanitizeGateReason({
            code: "reviewer_codex_timed_out",
          }),
        },
      );
    }
    // Defense-in-depth (#132 / lease-loss symmetry): an aborted codex run
    // (course lease loss → SIGKILL → aborted/exit -1) carries a DISTINCT gate
    // code that is NOT a CLEAN_REVIEWER_FAILURE_CODE. This is checked BEFORE the
    // generic non-zero-exit gate so an abort is never collapsed into the clean
    // `reviewer_codex_nonzero_exit` class (which the frozen-consensus loop would
    // otherwise demote to a pending consensus under a lost lease). The primary
    // lease-loss rethrow lives in the dispatch loop (deps.signal / transient
    // cause); this code is the structural backstop.
    if (codexResult.aborted === true) {
      throw new ReviewerAgentGateError(
        `reviewer codex aborted for ${inputs.runId} (lease loss / interrupted); see ${stderrPath}`,
        {
          sanitizedReason: sanitizeGateReason({
            code: "reviewer_codex_aborted",
          }),
        },
      );
    }
    if (codexResult.exitCode !== 0) {
      throw new ReviewerAgentGateError(
        `reviewer codex exited ${codexResult.exitCode} for ${inputs.runId}; see ${stderrPath}`,
        {
          sanitizedReason: sanitizeGateReason({
            code: "reviewer_codex_nonzero_exit",
            field: "exitCode",
            value: codexResult.exitCode,
          }),
        },
      );
    }
    if (typeof meta.domain !== "string") {
      throw new ReviewerAgentGateError(`meta.json domain is not a string`, {
        sanitizedReason: sanitizeGateReason({
          code: "reviewer_meta_domain_not_string",
          field: "domain",
          value: meta.domain,
        }),
      });
    }

    const rawOutput = await readFile(stdoutPath, "utf8");
    const yamlText = extractYamlBlock(rawOutput);
    let parsed: PartialDecision;
    try {
      parsed = parseYaml(yamlText) as PartialDecision;
    } catch (e) {
      throw new ReviewerAgentGateError(
        `reviewer agent produced unparseable YAML: ${(e as Error).message}`,
        {
          sanitizedReason: sanitizeGateReason({
            code: "reviewer_output_unparseable_yaml",
            field: "reviewer_output",
            value: yamlText,
          }),
        },
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ReviewerAgentGateError(
        `reviewer agent output is not a YAML object`,
        {
          sanitizedReason: sanitizeGateReason({
            code: "reviewer_output_not_yaml_object",
            field: "reviewer_output",
            value: parsed,
          }),
        },
      );
    }
    decision = buildDecision(
      inputs.runId,
      meta.domain,
      parsed,
      reviewer,
      reviewedAt,
    );
  } catch (e) {
    if (e instanceof ReviewerAgentGateError && !inputs.dryRun) {
      await writeGateErrorArtifact(e);
    }
    if (e instanceof ReviewerAgentGateError) {
      throw new ReviewerAgentGateError(e.message, {
        ...(e.kind !== undefined ? { kind: e.kind } : {}),
        ...(e.sanitizedReason !== undefined
          ? { sanitizedReason: e.sanitizedReason }
          : {}),
        reviewerEventsPublished,
      });
    }
    throw e;
  } finally {
    // Fail-closed (S4 / #191): publishRedactedCodexEvents consumes the raw events
    // file (redacts → official, removes raw) on the happy AND publish-failure
    // paths. But the tamper check runs BEFORE publish, so a tamper/throw leaves
    // the UN-redacted raw file on disk — and it is allowlisted (not quarantined),
    // so for a claude reviewer it can persist tool_result/result secrets.
    // Best-effort remove it so no unredacted secrets survive any failure path.
    await rm(rawEventsPath, { force: true }).catch(() => {});
  }

  if (inputs.dryRun) {
    // dry-run: validated successfully but write nothing.
    return {
      runId: inputs.runId,
      decision: decision.decision,
      reviewer,
      reviewedAt,
      rawOutputPath: stdoutPath,
      dryRun: true,
    };
  }

  // Phase 9 post-close (second review) P1-3 fix — DB is canonical for
  // Phase 9, so the proposal goes into `review_proposals` FIRST. A DB
  // failure must not leave a stale file sidecar around. The sidecar is
  // compatibility export and only written when export is ON (P1-3 second
  // half — `exportRun` will regenerate it from the active proposal
  // anyway via P1-2 fix).
  //
  // Phase 9 post-close (second review) P1-4 fix — the run.status guard
  // INSIDE the DB transaction guards a race where `review process`
  // promoted a prior proposal between our pre-codex overwrite check and
  // this insert. A status that is no longer `needs_review` aborts.
  //
  // Skip the DB write entirely if the DB file does not yet exist —
  // `review auto` must not silently create an empty (un-migrated) DB.
  if (inputs.dbPath !== undefined && existsSync(inputs.dbPath)) {
    const sourceYaml = serializeReviewDecision(decision);
    const sha = createHash("sha256").update(sourceYaml).digest("hex");
    const dbHandle = openManagedDb({ dbPath: inputs.dbPath });
    try {
      runMigrations(dbHandle.db);
      assertNoLegacyRuntimeRows(dbHandle.db);
      new ReviewProposalRepository(dbHandle.db).insertProposal({
        runId: inputs.runId,
        reviewer,
        decision: decision.decision,
        requiredChanges: decision.required_changes,
        nonBlockingComments: decision.non_blocking_comments,
        outOfScopeSuggestions: decision.out_of_scope_suggestions,
        reviewedAt,
        sourceYaml,
        sourceSha256: sha,
        createdAt: reviewedAt,
        promptSha256,
        promptProvenance: {
          template: REVIEWER_PROMPT_TEMPLATE,
          knowledge: reviewerOpsKnowledge,
          ...(lensProvenance !== undefined ? { lens: lensProvenance } : {}),
        },
        failIfSupersedes: !inputs.allowOverwrite,
      });
      // Phase 2: in consensus mode, re-evaluate consensus over all active
      // proposals and record a (possibly pending) consensus row so the
      // timeline accumulates for stall detection and the active consensus
      // reflects every reviewer. latest-proposal mode keeps its
      // single-writer flow untouched.
      recordConsensusReEvaluation(dbHandle.db, inputs.runId, reviewedAt);
    } catch (e) {
      if (e instanceof ReviewerAgentGateError) {
        await writeGateErrorArtifact(e);
      }
      throw e;
    } finally {
      dbHandle.close();
    }
  }

  // #272 / P1-ISO — the per-reviewer verdict sidecar is gated behind file
  // export. During a sequential frozen-consensus round the NEXT reviewer's
  // read-only codex can absolute-read a sibling verdict at the predictable
  // path `reviewers/<reviewer>/review-decision.yaml`; codex `--sandbox
  // read-only` does NOT jail reads (verified codex-cli 0.139, no readable-root
  // config), so the only deterministic enforcement is to NOT persist the
  // sibling verdict to a readable predictable path during the round. The
  // verdict is DB-canonical (`review_proposals`, inserted above); with export
  // ON the sidecar is regenerated as a compatibility export.
  if (fileExportEnabled()) {
    await writeReviewDecision(reviewerDecisionPath, decision);
  }
  // Phase 9 post-close P1-3 fix — the ROOT sidecar is compatibility export
  // only. Skip with export OFF: `db export-files` / `ensureRunMaterialized`
  // will regenerate it from the DB-canonical active proposal when needed
  // (P1-2 fix in exportRun).
  if (!hasDb) {
    await writeReviewDecision(decisionPath, decision);
  } else if (!fileExportEnabled()) {
    // export OFF: leave the (possibly stale `pending` template) sidecar
    // alone — the DB is the canonical store. Remove it so `review
    // process` doesn't read a stale verdict on the file fallback path.
    await rm(decisionPath, { force: true });
  }
  // success — clear any stale error artifact from a prior failed run.
  await rm(errorArtifactPath, { force: true });

  return {
    runId: inputs.runId,
    decision: decision.decision,
    reviewer,
    reviewedAt,
    rawOutputPath: stdoutPath,
    dryRun: false,
  };
}

/**
 * Phase 2: re-evaluate consensus after a `review auto` proposal insert.
 * No-op for latest-proposal mode. Best-effort: a recording failure must not
 * unwind the just-inserted proposal (the verdict is already persisted).
 *
 * facet4 (fail-closed cross-ref): this re-evaluation row is advisory only.
 * Promotion is NEVER driven from here — `processReviewDecision`
 * (`processConsensusModePath` in review-processor.ts) independently and
 * fail-closed re-evaluates the frozen-set proposals at promote time. So a lost
 * / stale re-eval row here can only leave the visible consensus snapshot
 * momentarily behind; it can never produce a fail-open promotion, because the
 * gate that actually promotes recomputes consensus from scratch.
 */
function recordConsensusReEvaluation(
  db: Database.Database,
  runId: string,
  evaluatedAt: string,
): void {
  try {
    // The status guard + re-evaluation + insert run in ONE immediate
    // transaction so the "skip if already promoted" check is not subject to a
    // TOCTOU race: a concurrent `review process` that promotes the run (and
    // writes the final consensus) cannot be superseded by a late re-eval.
    const tx = db.transaction(() => {
      const statusRow = db
        .prepare("SELECT status FROM runs WHERE run_id = ?")
        .get(runId) as { status: string } | undefined;
      if (statusRow === undefined || statusRow.status !== "needs_review") return;
      const snapshot = new ReviewRulesRepository(db).findSnapshotByRun(runId);
      const rule: ReviewRule =
        snapshot === null
          ? DEFAULT_REVIEW_RULE
          : parseReviewRuleSnapshot(snapshot.ruleJson);
      if (rule.mode !== "consensus") return;
      const ruleSha = snapshot?.sourceSha256 ?? ruleSha256(rule);
      const frozenReviewerIds = frozenReviewerIdsForRule(rule);
      const proposals = enrichActiveProposals(
        new ReviewProposalRepository(db),
        new ReviewerRepository(db),
        runId,
        {
          ...(frozenReviewerIds.length > 0
            ? { reviewerIds: frozenReviewerIds }
            : {}),
        },
      );
      const result = evaluateConsensus({
        rule,
        ruleSha256: ruleSha,
        proposals,
        refuteVotes: enrichRefuteVotesForRun(
          new ReviewRefuteVotesRepository(db),
          new ReviewerRepository(db),
          runId,
        ),
        evaluatedAt,
      });
      new ReviewConsensusRepository(db).insertActive({
        runId,
        ruleSha256: ruleSha,
        status: result.status,
        summary: result.summary,
        evaluatedAt,
        evaluatedBy: "review-auto",
        // Only proposals that actually fed the consensus (post stale-filter)
        // are the audit source — keep it consistent with the summary.
        sourceProposalIds: result.summary.proposals.map((p) => p.proposalId),
      });
    });
    tx.immediate();
  } catch (e) {
    process.stderr.write(
      `warning: could not re-evaluate review consensus for ${runId}: ` +
        `${(e as Error).message}\n`,
    );
  }
}
