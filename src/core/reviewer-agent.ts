import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
  rm,
} from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import type { RunMeta } from "../logging/run-log.js";
import {
  loadReviewDecision,
  serializeReviewDecision,
  writeReviewDecision,
} from "./review-decision-loader.js";
import { ensureRunMaterialized } from "./run-materialize.js";
import {
  ReviewDecisionFileSchema,
  type ReviewDecisionFile,
} from "./review-decision-schema.js";
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
  ReviewerRepository,
} from "../db/repositories/reviewers.js";
import { evaluateConsensus } from "./review-consensus.js";
import { enrichActiveProposals } from "./consensus-enrichment.js";
import { DEFAULT_REVIEW_RULE, ruleSha256, type ReviewRule } from "./review-rule.js";
import type Database from "better-sqlite3";
import { fileExportEnabled } from "../config/export-mode.js";
import { ReviewerAgentGateError } from "./reviewer-agent-errors.js";
import { classifyReviewGate } from "./review-gate-classify.js";
import { buildOperationalKnowledgeReviewSection } from "./operational-knowledge.js";
import { publishRedactedCodexEvents } from "../codex/events-lifecycle.js";
import { sanitizeGateReason } from "./gate-reason.js";
import { recordCodexUsage } from "../db/repositories/run-usage.js";

export { ReviewerAgentGateError } from "./reviewer-agent-errors.js";

/** Diagnostic artifact written when codex output cannot be parsed/validated. */
export const REVIEW_AUTO_ERROR_FILE = "review-auto-error.json";

/**
 * Telemetry-only warning (token-usage G2). Recording reviewer codex usage is
 * fail-open: a telemetry write must never change the review outcome.
 */
function warnReviewerUsageRecordFailed(runId: string, e: unknown): void {
  process.stderr.write(
    `warning: run ${runId}: reviewer codex usage telemetry was not recorded: ` +
      `${(e as Error).message}\n`,
  );
}

/**
 * Record the reviewer codex invocation's token usage (kind='reviewer') from
 * the already-read redacted events content (null when the events were not
 * published / unreadable → an `unavailable` row). Fail-open and best-effort:
 * any error (missing DB, write failure, lock) is warned and swallowed so the
 * review path is never affected. Called on ALL reviewer outcomes (success,
 * timeout, non-zero exit, invalid YAML) because codex consumed tokens
 * regardless of whether the verdict later passes its gate.
 */
async function recordReviewerUsage(
  dbPath: string | undefined,
  runId: string,
  eventsContent: string | null,
): Promise<void> {
  if (dbPath === undefined || !existsSync(dbPath)) return;
  try {
    const usageDb = openManagedDb({ dbPath });
    try {
      // Ensure the run_usage schema is current (per-invocation kind/seq).
      // On a not-yet-migrated (e.g. v29) DB the INSERT would otherwise fail
      // and the reviewer usage would be silently lost. runMigrations is
      // idempotent; the surrounding fail-open guard still covers any error.
      runMigrations(usageDb.db);
      recordCodexUsage({
        db: usageDb.db,
        runId,
        kind: "reviewer",
        eventsContent,
        onError: (err) => warnReviewerUsageRecordFailed(runId, err),
      });
    } finally {
      usageDb.close();
    }
  } catch (err) {
    warnReviewerUsageRecordFailed(runId, err);
  }
}

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The ONLY files allowed to appear/change during the codex window. The
 * codex runner writes the agent's final message, stderr, and JSONL events
 * into these files, so they legitimately change. Everything else under
 * runDir — including review-decision.yaml and review-auto-error.json —
 * must match its pre-codex snapshot, or the run is rejected as tampering.
 *
 * review-decision.yaml / review-auto-error.json are written (and the
 * latter rm'd) by the harness itself, but ONLY after snapshot
 * verification has passed — so they belong in the snapshot, not here.
 */
const REVIEWER_WRITE_ALLOWLIST = new Set([
  "reviewer-agent.out.log",
  "reviewer-agent.err.log",
  ".reviewer-agent.events.raw.jsonl",
]);

const REVIEWER_INPUT_FILES = [
  "review-request.md",
  "summary.md",
  "final-diff.patch",
  "untracked-files.patch",
  "untracked-files.txt",
  "untracked-secrets.txt",
  "untracked-denied.txt",
] as const;

const REVIEWER_INPUT_DIRS = ["commands"] as const;

interface FileSnapshot {
  size: number;
  mtimeMs: number;
}

/**
 * Snapshot every file under runDir (recursively — `commands/` etc.
 * included), keyed by path relative to runDir. The two reviewer-agent log
 * files are excluded since codex legitimately writes them.
 */
async function snapshotRunDir(
  runDir: string,
  writablePrefix: string,
): Promise<Map<string, FileSnapshot>> {
  const out = new Map<string, FileSnapshot>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(join(dir, e.name), rel);
      } else if (e.isFile()) {
        if (isReviewerWritable(rel, writablePrefix)) continue;
        const st = await stat(join(dir, e.name));
        out.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk(runDir, "");
  return out;
}

async function verifyArtifactsUnchanged(
  runDir: string,
  before: Map<string, FileSnapshot>,
  writablePrefix: string,
): Promise<void> {
  const after = await snapshotRunDir(runDir, writablePrefix);
  // detect modifications and additions
  for (const [name, snap] of after) {
    const prev = before.get(name);
    if (!prev) {
      throw new ReviewerAgentGateError(
        `reviewer agent created unexpected file: ${name}`,
      );
    }
    if (prev.size !== snap.size || prev.mtimeMs !== snap.mtimeMs) {
      throw new ReviewerAgentGateError(
        `reviewer agent modified run artifact: ${name}`,
      );
    }
  }
  // detect deletions
  for (const [name] of before) {
    if (!after.has(name)) {
      throw new ReviewerAgentGateError(
        `reviewer agent deleted run artifact: ${name}`,
      );
    }
  }
}

function isReviewerWritable(rel: string, writablePrefix: string): boolean {
  // Only the three codex-written log files are exempt from tamper detection —
  // at runDir root (legacy) or under the per-reviewer prefix. Do NOT exempt the
  // whole reviewers/<id>/ subtree: a misconfigured/escaped runner that writes
  // any OTHER file there during the codex window (e.g. a fake review-decision
  // or a leak.txt) must still be flagged and must not be silently ingested into
  // DB artifacts (codex SP-11). Harness-written files (decision/error/published
  // events) land AFTER verifyArtifactsUnchanged, so they need no exemption.
  if (REVIEWER_WRITE_ALLOWLIST.has(rel)) return true;
  for (const name of REVIEWER_WRITE_ALLOWLIST) {
    if (rel === `${writablePrefix}/${name}`) return true;
  }
  return false;
}

function reviewerArtifactRelDir(reviewerId: string): string {
  return `reviewers/${reviewerId}`;
}

async function materializeReviewerInput(
  runDir: string,
  inputDir: string,
): Promise<void> {
  await rm(inputDir, { recursive: true, force: true });
  await mkdir(inputDir, { recursive: true });
  for (const rel of REVIEWER_INPUT_FILES) {
    const src = join(runDir, rel);
    if (!existsSync(src)) continue;
    // fail-closed: never materialize a symlink — it could resolve to a verdict
    // or sibling reviewer artifact and re-introduce the cross-reviewer leak.
    if (lstatSync(src).isSymbolicLink()) continue;
    await cp(src, join(inputDir, rel), { force: true });
  }
  for (const rel of REVIEWER_INPUT_DIRS) {
    const src = join(runDir, rel);
    if (!existsSync(src)) continue;
    if (lstatSync(src).isSymbolicLink()) continue;
    await cp(src, join(inputDir, rel), {
      recursive: true,
      force: true,
      filter: (s) => !lstatSync(s).isSymbolicLink(),
    });
  }
}

function assertReviewerPathSafeForAgent(reviewerId: string): void {
  try {
    assertPathSafeReviewerId(reviewerId);
  } catch (e) {
    throw new ReviewerAgentGateError((e as Error).message);
  }
}

export interface ReviewerAgentInputs {
  runsDir: string;
  runId: string;
  /**
   * harness DB path. When set, a db-first run with no exported files is
   * materialized from the DB before the reviewer runs (Phase 8-13) so
   * `review auto` works in DB-only mode.
   */
  dbPath?: string;
  /**
   * Reviewer identity stamped into review-decision.yaml. Defaults to
   * "codex-reviewer". Operators can pass e.g. "codex-reviewer-gpt-5.5"
   * to distinguish models.
   */
  reviewerName?: string;
  /**
   * When review-decision.yaml already has a non-pending decision, the run
   * is refused unless this is set. Protects a human/earlier verdict from
   * being clobbered by a re-run of `review auto`.
   */
  allowOverwrite?: boolean;
  /**
   * Run codex and validate the output, but do NOT write
   * review-decision.yaml (or review-auto-error.json). For inspection.
   */
  dryRun?: boolean;
  codexRunner: CodexExecRunner;
  /** Abort the in-flight reviewer codex run on course-lease loss (#132). */
  signal?: AbortSignal;
  now?: Date;
}

export interface ReviewerAgentResult {
  runId: string;
  decision: ReviewDecisionFile["decision"];
  reviewer: string;
  reviewedAt: string;
  rawOutputPath: string;
  /** true when dryRun was set — review-decision.yaml was NOT written */
  dryRun: boolean;
}

/**
 * The reviewer agent's prompt template (Phase 3-3). The reviewer runs
 * under a read-only sandbox and only proposes a review-decision.yaml — it
 * cannot edit code or change a run's status. Bump `version` whenever
 * PROMPT_PREAMBLE changes.
 */
export const REVIEWER_PROMPT_TEMPLATE = {
  name: "reviewer-run-artifacts",
  version: 3,
} as const;

export const PROMPT_PREAMBLE = `You are an automated code reviewer. Read the run artifacts in the
current working directory (you have read-only access) and produce a
single YAML block that captures your verdict.

Output ONLY a single fenced YAML block, nothing else. Use this shape:

\`\`\`yaml
decision: approved | changes_requested | rejected
required_changes:
  - "one short sentence per required change"
non_blocking_comments:
  - "optional notes that do not block approval"
out_of_scope_suggestions:
  - "ideas that belong to a different domain or workflow"
\`\`\`

Decision guide:
- approved             — diff is on-scope, no blocking issues, tests still trustworthy
- changes_requested    — specific blocking issues that must be addressed in a follow-up run
- rejected             — fundamentally wrong direction; do not retry as-is

Artifacts to read (in this order of priority):
- review-request.md   (summary for reviewers; highest signal)
- summary.md          (status / changed files / violations / codex tail)
- final-diff.patch    (tracked changes against base)
- untracked-files.patch  (new files; may not exist if there were no allowed untracked)
- untracked-secrets.txt  (secret-shape hits, if any)
- untracked-denied.txt   (denied untracked, metadata-only, if any)
- commands/<id>.out.log / commands/<id>.err.log (allowedCommands output, if any)

Be strict but fair. Prefer specific required_changes over vague ones.
An approved decision means static review passed; review_consensus does not execute tests.
Command logs live only under runs/<runId>/commands/ and are present only when
policy.allowedCommands defines commands for the harness to run. The absence of
commands/ is normal and MUST NOT be treated as a deficiency or required_change.
Never instruct or expect the coder to create commands/ inside the write scope.
If command logs that do exist do not show tests/checks actually ran, do not
block approval solely for that reason; add a concise non_blocking_comments
advisory that tests/checks were not run or evidence is limited to the run
summary.
`;

/**
 * Extract the YAML body from a fenced block. Codex sometimes adds prose
 * around the block; we only trust the contents of the first fence.
 */
export function extractYamlBlock(output: string): string {
  const fenced = output.match(/```ya?ml\s*\n([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  // fall back: try the whole output as YAML
  return output.trim();
}

/**
 * Try to coerce the codex output into a ReviewDecisionFile. The agent
 * only writes the four optional fields; we merge with runId/domain from
 * meta.json and stamp reviewer + reviewed_at ourselves.
 */
export interface PartialDecision {
  decision?: unknown;
  required_changes?: unknown;
  non_blocking_comments?: unknown;
  out_of_scope_suggestions?: unknown;
}

function requireStringArray(field: string, v: unknown): string[] {
  if (!Array.isArray(v)) {
    throw new ReviewerAgentGateError(
      `reviewer output field "${field}" must be an array of strings`,
      {
        sanitizedReason: sanitizeGateReason({
          code: "reviewer_output_field_not_string_array",
          field,
          value: v,
        }),
      },
    );
  }
  for (const x of v) {
    if (typeof x !== "string") {
      throw new ReviewerAgentGateError(
        `reviewer output field "${field}" contains non-string entries`,
        {
          sanitizedReason: sanitizeGateReason({
            code: "reviewer_output_field_non_string_entry",
            field,
            value: x,
          }),
        },
      );
    }
  }
  return v as string[];
}

export function buildDecision(
  runId: string,
  domain: string,
  raw: PartialDecision,
  reviewer: string,
  reviewedAt: string,
): ReviewDecisionFile {
  if (
    raw.decision !== "approved" &&
    raw.decision !== "changes_requested" &&
    raw.decision !== "rejected"
  ) {
    throw new ReviewerAgentGateError(
      `reviewer output has missing or unknown decision: ${JSON.stringify(raw.decision)} (expected approved | changes_requested | rejected)`,
      {
        sanitizedReason: sanitizeGateReason({
          code: "reviewer_output_unknown_decision",
          field: "decision",
          value: raw.decision,
        }),
      },
    );
  }
  const required = requireStringArray("required_changes", raw.required_changes);
  const nonBlocking = requireStringArray(
    "non_blocking_comments",
    raw.non_blocking_comments,
  );
  const outOfScope = requireStringArray(
    "out_of_scope_suggestions",
    raw.out_of_scope_suggestions,
  );
  if (raw.decision === "changes_requested" && required.length === 0) {
    throw new ReviewerAgentGateError(
      "reviewer output is decision=changes_requested but required_changes is empty",
      {
        sanitizedReason: sanitizeGateReason({
          code: "reviewer_output_empty_required_changes",
          field: "required_changes",
          value: raw.required_changes,
        }),
      },
    );
  }
  const file: ReviewDecisionFile = {
    runId,
    domain,
    decision: raw.decision,
    required_changes: required,
    non_blocking_comments: nonBlocking,
    out_of_scope_suggestions: outOfScope,
    reviewer,
    reviewed_at: reviewedAt,
  };
  return ReviewDecisionFileSchema.parse(file);
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

  // Invoke codex with the run directory as cwd. Sandbox is read-only —
  // the agent doesn't need to touch the worktree, just read artifacts.
  await mkdir(reviewerDir, { recursive: true });
  // P1-ISO (#229): the reviewer's codex sandbox cwd must live OUTSIDE the run
  // dir tree. codex `--sandbox read-only` sets `-C` as cwd but does NOT jail
  // reads to that subtree, so a cwd anywhere under runDir lets the agent reach
  // a prior reviewer's verdict via `../` (e.g. ../../alice/review-decision.yaml
  // or the repaired root review-decision.yaml). A fresh OS-temp dir shares no
  // `..`-reachable ancestor with runDir, so no parent-relative path resolves to
  // any verdict. Only the allowed inputs are copied in; logs/decision stay in
  // reviewerDir (run dir, tamper-snapshotted). The dir is removed after the run.
  const reviewerInputDir = await mkdtemp(
    join(tmpdir(), "harness-reviewer-input-"),
  );
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
  const snapshot = await snapshotRunDir(runDir, reviewerRelDir);

  const reviewerPrompt = PROMPT_PREAMBLE + reviewerOpsSection;
  const promptSha256 = createHash("sha256").update(reviewerPrompt).digest("hex");

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
    await verifyArtifactsUnchanged(runDir, snapshot, reviewerRelDir);
    const publishResult = await publishRedactedCodexEvents({
      rawPath: rawEventsPath,
      tmpPath: tmpEventsPath,
      officialPath: eventsPath,
      runId: inputs.runId,
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
      await recordReviewerUsage(inputs.dbPath, inputs.runId, eventsContent);
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

  // Phase 9 post-close P1-3 fix — sidecar is compatibility export only.
  // Skip with export OFF: `db export-files` / `ensureRunMaterialized`
  // will regenerate the sidecar from the DB-canonical active proposal
  // when needed (P1-2 fix in exportRun).
  await writeReviewDecision(reviewerDecisionPath, decision);
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
          : (JSON.parse(snapshot.ruleJson) as ReviewRule);
      if (rule.mode !== "consensus") return;
      const ruleSha = snapshot?.sourceSha256 ?? ruleSha256(rule);
      const proposals = enrichActiveProposals(
        new ReviewProposalRepository(db),
        new ReviewerRepository(db),
        runId,
      );
      const result = evaluateConsensus({
        rule,
        ruleSha256: ruleSha,
        proposals,
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
