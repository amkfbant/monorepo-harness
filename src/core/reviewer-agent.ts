import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { RunMeta } from "../logging/run-log.js";
import {
  loadReviewDecision,
  writeReviewDecision,
} from "./review-decision-loader.js";
import {
  ReviewDecisionFileSchema,
  type ReviewDecisionFile,
} from "./review-decision-schema.js";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";

export class ReviewerAgentGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerAgentGateError";
  }
}

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface ReviewerAgentInputs {
  runsDir: string;
  runId: string;
  /**
   * Reviewer identity stamped into review-decision.yaml. Defaults to
   * "codex-reviewer". Operators can pass e.g. "codex-reviewer-gpt-5.5"
   * to distinguish models.
   */
  reviewerName?: string;
  codexRunner: CodexExecRunner;
  now?: Date;
}

export interface ReviewerAgentResult {
  runId: string;
  decision: ReviewDecisionFile["decision"];
  reviewer: string;
  reviewedAt: string;
  rawOutputPath: string;
}

const PROMPT_PREAMBLE = `You are an automated code reviewer. Read the run artifacts in the
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
interface PartialDecision {
  decision?: unknown;
  required_changes?: unknown;
  non_blocking_comments?: unknown;
  out_of_scope_suggestions?: unknown;
}

function coerceStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function buildDecision(
  runId: string,
  domain: string,
  raw: PartialDecision,
  reviewer: string,
  reviewedAt: string,
): ReviewDecisionFile {
  const file: ReviewDecisionFile = {
    runId,
    domain,
    decision:
      raw.decision === "approved" ||
      raw.decision === "changes_requested" ||
      raw.decision === "rejected"
        ? raw.decision
        : "changes_requested",
    required_changes: coerceStringArray(raw.required_changes),
    non_blocking_comments: coerceStringArray(raw.non_blocking_comments),
    out_of_scope_suggestions: coerceStringArray(raw.out_of_scope_suggestions),
    reviewer,
    reviewed_at: reviewedAt,
  };
  // Schema parse will throw if anything is off; that's surfaced as a gate
  // error to the CLI.
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

  // Preserve any human-edited fields by loading the current file first.
  await loadReviewDecision(decisionPath).catch(() => {
    throw new ReviewerAgentGateError(
      `existing review-decision.yaml is malformed; refusing to overwrite`,
    );
  });

  // Invoke codex with the run directory as cwd. Sandbox is read-only —
  // the agent doesn't need to touch the worktree, just read artifacts.
  const stdoutPath = join(runDir, "reviewer-agent.out.log");
  const stderrPath = join(runDir, "reviewer-agent.err.log");
  const codexResult = await inputs.codexRunner.run({
    worktreePath: runDir,
    prompt: PROMPT_PREAMBLE,
    logPaths: { stdout: stdoutPath, stderr: stderrPath },
  });
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

  const reviewer = inputs.reviewerName ?? "codex-reviewer";
  const reviewedAt = (inputs.now ?? new Date()).toISOString();
  if (typeof meta.domain !== "string") {
    throw new ReviewerAgentGateError(
      `meta.json domain is not a string`,
    );
  }
  const decision = buildDecision(
    inputs.runId,
    meta.domain,
    parsed,
    reviewer,
    reviewedAt,
  );
  await writeReviewDecision(decisionPath, decision);

  return {
    runId: inputs.runId,
    decision: decision.decision,
    reviewer,
    reviewedAt,
    rawOutputPath: stdoutPath,
  };
}
