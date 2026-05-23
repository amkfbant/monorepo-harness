import { readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RunMeta } from "../logging/run-log.js";
import {
  loadReviewDecision,
  writeReviewDecision,
} from "./review-decision-loader.js";
import { ensureRunMaterialized } from "./run-materialize.js";
import {
  ReviewDecisionFileSchema,
  type ReviewDecisionFile,
} from "./review-decision-schema.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { createHash } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { assertNoLegacyRuntimeRows } from "../db/legacy-check.js";
import { ReviewProposalRepository } from "../db/repositories/review-proposals.js";
import { fileExportEnabled } from "../config/export-mode.js";

export class ReviewerAgentGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerAgentGateError";
  }
}

/** Diagnostic artifact written when codex output cannot be parsed/validated. */
export const REVIEW_AUTO_ERROR_FILE = "review-auto-error.json";

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The ONLY files allowed to appear/change during the codex window. The
 * codex runner pipes the agent's stdout/stderr into these two files, so
 * they legitimately change. Everything else under runDir — including
 * review-decision.yaml and review-auto-error.json — must match its
 * pre-codex snapshot, or the run is rejected as tampering.
 *
 * review-decision.yaml / review-auto-error.json are written (and the
 * latter rm'd) by the harness itself, but ONLY after snapshot
 * verification has passed — so they belong in the snapshot, not here.
 */
const REVIEWER_WRITE_ALLOWLIST = new Set([
  "reviewer-agent.out.log",
  "reviewer-agent.err.log",
]);

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
): Promise<Map<string, FileSnapshot>> {
  const out = new Map<string, FileSnapshot>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(join(dir, e.name), rel);
      } else if (e.isFile()) {
        if (REVIEWER_WRITE_ALLOWLIST.has(rel)) continue;
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
): Promise<void> {
  const after = await snapshotRunDir(runDir);
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
  version: 1,
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
    );
  }
  for (const x of v) {
    if (typeof x !== "string") {
      throw new ReviewerAgentGateError(
        `reviewer output field "${field}" contains non-string entries`,
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

export async function runReviewerAgent(
  inputs: ReviewerAgentInputs,
): Promise<ReviewerAgentResult> {
  if (!RUN_ID_RE.test(inputs.runId)) {
    throw new ReviewerAgentGateError(
      `invalid runId: ${JSON.stringify(inputs.runId)}`,
    );
  }
  const runDir = join(inputs.runsDir, inputs.runId);
  // the reviewer spawns codex with a read-only sandbox over the run dir,
  // so the run's files must exist. With file export OFF a db-first run
  // has none — materialize them from the DB first (Phase 8-13).
  if (inputs.dbPath !== undefined) {
    ensureRunMaterialized({
      dbPath: inputs.dbPath,
      runsDir: inputs.runsDir,
      runId: inputs.runId,
    });
  }
  const metaPath = join(runDir, "meta.json");
  const decisionPath = join(runDir, "review-decision.yaml");

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
  if (meta.status !== "needs_review") {
    throw new ReviewerAgentGateError(
      `run ${inputs.runId} status is "${meta.status}", only needs_review can be auto-reviewed`,
    );
  }
  if (!existsSync(decisionPath)) {
    throw new ReviewerAgentGateError(
      `${decisionPath} not found; the run may not have completed normally`,
    );
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
  if (inputs.dbPath !== undefined && existsSync(inputs.dbPath)) {
    const probe = openManagedDb({ dbPath: inputs.dbPath, readonly: true });
    try {
      activeDbProposal = new ReviewProposalRepository(
        probe.db,
      ).getLatestActiveProposal(inputs.runId);
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
  const stdoutPath = join(runDir, "reviewer-agent.out.log");
  const stderrPath = join(runDir, "reviewer-agent.err.log");
  const errorArtifactPath = join(runDir, REVIEW_AUTO_ERROR_FILE);

  // Defense in depth: even though the runner is configured with
  // sandbox=read-only, a misconfigured HARNESS_CODEX_BIN or sandbox
  // failure could let the agent tamper with run artifacts. Snapshot
  // every file (size + mtime) under runDir before codex runs, then
  // verify nothing outside the writable allowlist changed.
  const snapshot = await snapshotRunDir(runDir);

  const codexResult = await inputs.codexRunner.run({
    worktreePath: runDir,
    prompt: PROMPT_PREAMBLE,
    logPaths: { stdout: stdoutPath, stderr: stderrPath },
  });
  const reviewer = inputs.reviewerName ?? "codex-reviewer";
  const reviewedAt = (inputs.now ?? new Date()).toISOString();

  // Everything after codex runs is wrapped: ANY ReviewerAgentGateError —
  // artifact tampering, codex timeout, non-zero exit, or unparseable /
  // invalid output — writes review-auto-error.json (unless dry-run) so the
  // operator (and `harness workflow reviewed-run`) can inspect what went
  // wrong. review-decision.yaml is NOT touched on this path.
  let decision: ReviewDecisionFile;
  try {
    // Tamper check FIRST — before the timeout/exitCode gates. A sandbox
    // escape that mutates an artifact and THEN exits non-zero / times out
    // would otherwise slip past detection.
    await verifyArtifactsUnchanged(runDir, snapshot);

    if (codexResult.timedOut) {
      throw new ReviewerAgentGateError(
        `reviewer codex timed out for ${inputs.runId}`,
      );
    }
    if (codexResult.exitCode !== 0) {
      throw new ReviewerAgentGateError(
        `reviewer codex exited ${codexResult.exitCode} for ${inputs.runId}; see ${stderrPath}`,
      );
    }
    if (typeof meta.domain !== "string") {
      throw new ReviewerAgentGateError(`meta.json domain is not a string`);
    }

    const rawOutput = await readFile(stdoutPath, "utf8");
    const yamlText = extractYamlBlock(rawOutput);
    let parsed: PartialDecision;
    try {
      parsed = parseYaml(yamlText) as PartialDecision;
    } catch (e) {
      throw new ReviewerAgentGateError(
        `reviewer agent produced unparseable YAML: ${(e as Error).message}`,
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ReviewerAgentGateError(
        `reviewer agent output is not a YAML object`,
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
      await writeFile(
        errorArtifactPath,
        `${JSON.stringify(
          {
            type: "review-auto-error",
            runId: inputs.runId,
            reviewer,
            failedAt: reviewedAt,
            reason: e.message,
            rawOutputPath: "reviewer-agent.out.log",
            codexExitCode: codexResult.exitCode,
            timedOut: codexResult.timedOut,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
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
    const sourceYaml = stringifyYaml(decision);
    const sha = createHash("sha256").update(sourceYaml).digest("hex");
    const dbHandle = openManagedDb({ dbPath: inputs.dbPath });
    try {
      runMigrations(dbHandle.db);
      assertNoLegacyRuntimeRows(dbHandle.db);
      // P1-4 status guard: only `needs_review` accepts a new proposal.
      // A db-first run whose status changed since the pre-codex probe
      // (e.g. a concurrent `review process` already promoted a proposal)
      // is a StateConflictError-class race; reject with a clear message.
      const statusRow = dbHandle.db
        .prepare(
          "SELECT status, source_mode FROM runs WHERE run_id = ?",
        )
        .get(inputs.runId) as
        | { status: string; source_mode: string }
        | undefined;
      if (
        statusRow !== undefined &&
        statusRow.source_mode === "db-first" &&
        statusRow.status !== "needs_review"
      ) {
        throw new ReviewerAgentGateError(
          `run ${inputs.runId} status changed to "${statusRow.status}" ` +
            `during review auto (concurrent review process?); refusing to ` +
            `insert a stale proposal`,
        );
      }
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
      });
    } finally {
      dbHandle.close();
    }
  }

  // Phase 9 post-close P1-3 fix — sidecar is compatibility export only.
  // Skip with export OFF: `db export-files` / `ensureRunMaterialized`
  // will regenerate the sidecar from the DB-canonical active proposal
  // when needed (P1-2 fix in exportRun).
  if (fileExportEnabled()) {
    await writeReviewDecision(decisionPath, decision);
  } else {
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
