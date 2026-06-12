import {
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
  stat,
  lstat,
  readlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import type { RunMeta } from "../logging/run-log.js";
import {
  PROMPT_PREAMBLE,
  extractYamlBlock,
  buildDecision,
  type PartialDecision,
} from "./reviewer-agent.js";
import { loadReviewDecision } from "./review-decision-loader.js";
import { buildOperationalKnowledgeReviewSection } from "./operational-knowledge.js";
import { openManagedDb } from "../db/managed-connection.js";

export class ReviewEvaluateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewEvaluateError";
  }
}

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type SampleDecision =
  | "approved"
  | "changes_requested"
  | "rejected"
  | "invalid";

export interface SampleResult {
  /** 1-based sample index */
  index: number;
  decision: SampleDecision;
  requiredChanges: number;
  nonBlocking: number;
  outOfScope: number;
  /** set when decision === "invalid" */
  error?: string;
}

export interface EvaluateResult {
  runId: string;
  samples: SampleResult[];
  /** decision value -> count */
  decisionCounts: Record<string, number>;
  /** advisories surfaced for human attention */
  dangerFlags: string[];
}

export interface EvaluateOpts {
  runsDir: string;
  runId: string;
  samples: number;
  /** read-only codex runner; invoked once per sample */
  codexRunner: CodexExecRunner;
  reviewerName?: string;
  /**
   * harness DB path. When set, each sample's prompt gets the same operational-
   * knowledge section the production reviewer (`runReviewerAgent`) injects, so
   * the stability measurement reflects the real prompt (issue #57).
   */
  dbPath?: string;
  now?: Date;
}

/**
 * Run the reviewer agent `samples` times against the SAME run and record
 * each verdict — to observe how stable / trustworthy the agent is. This
 * is an observation tool: it never touches the run's own
 * review-decision.yaml or meta.status. Each sample's raw output and
 * parsed decision land in runs/<runId>/review-evaluations/eval-NNN/.
 */
export async function evaluateReviewer(
  opts: EvaluateOpts,
): Promise<EvaluateResult> {
  if (!RUN_ID_RE.test(opts.runId)) {
    throw new ReviewEvaluateError(
      `invalid runId: ${JSON.stringify(opts.runId)}`,
    );
  }
  if (!Number.isInteger(opts.samples) || opts.samples < 1) {
    throw new ReviewEvaluateError(
      `samples must be a positive integer (got ${String(opts.samples)})`,
    );
  }
  const runDir = join(opts.runsDir, opts.runId);
  if (!existsSync(join(runDir, "meta.json"))) {
    throw new ReviewEvaluateError(`run ${opts.runId} not found`);
  }
  const meta = JSON.parse(
    await readFile(join(runDir, "meta.json"), "utf8"),
  ) as RunMeta;
  const reviewer = opts.reviewerName ?? "codex-reviewer";
  const evalRoot = join(runDir, "review-evaluations");

  // Same operational-knowledge section the production reviewer injects, so the
  // sampled prompt matches `runReviewerAgent` (issue #57). Built once — the run
  // is identical across samples.
  let reviewerOpsSection = "";
  if (opts.dbPath !== undefined && existsSync(opts.dbPath)) {
    const probe = openManagedDb({ dbPath: opts.dbPath, readonly: true });
    try {
      reviewerOpsSection = buildOperationalKnowledgeReviewSection(probe.db, {
        projectId: meta.project?.projectId ?? null,
        repoId: meta.repoId ?? null,
      }).section;
    } finally {
      probe.close();
    }
  }

  const samples: SampleResult[] = [];
  for (let i = 1; i <= opts.samples; i++) {
    const evalDir = join(evalRoot, `eval-${String(i).padStart(3, "0")}`);
    // a re-evaluation must start each eval dir clean — never mix a stale
    // review-decision.yaml with a fresh review-auto-error.json (or vice versa).
    await rm(evalDir, { recursive: true, force: true });
    await mkdir(evalDir, { recursive: true });
    const stdoutPath = join(evalDir, "reviewer-agent.out.log");
    const stderrPath = join(evalDir, "reviewer-agent.err.log");

    // Observation-only: the run itself must not be mutated. Snapshot
    // everything OUTSIDE review-evaluations/ and verify it after codex —
    // a misconfigured HARNESS_CODEX_BIN / sandbox failure that touches
    // meta.json or review-decision.yaml is then detected.
    const before = await snapshotExcludingEvals(runDir);
    const codexResult = await opts.codexRunner.run({
      worktreePath: runDir,
      prompt: PROMPT_PREAMBLE + reviewerOpsSection,
      logPaths: { stdout: stdoutPath, stderr: stderrPath },
    });
    verifyUnchanged(before, await snapshotExcludingEvals(runDir));
    const sample = await captureSample({
      index: i,
      evalDir,
      stdoutPath,
      runId: opts.runId,
      domain: typeof meta.domain === "string" ? meta.domain : "unknown",
      reviewer,
      reviewedAt: (opts.now ?? new Date()).toISOString(),
      codexFailed: codexResult.timedOut || codexResult.exitCode !== 0,
      codexNote: codexResult.timedOut
        ? "reviewer codex timed out"
        : `reviewer codex exited ${codexResult.exitCode}`,
    });
    samples.push(sample);
  }

  const decisionCounts: Record<string, number> = {};
  for (const s of samples) {
    decisionCounts[s.decision] = (decisionCounts[s.decision] ?? 0) + 1;
  }
  const dangerFlags = computeDangerFlags(meta, samples, evalRoot);

  await writeFile(
    join(evalRoot, "evaluation-summary.md"),
    renderSummary(opts.runId, meta, samples, decisionCounts, dangerFlags),
    "utf8",
  );

  return { runId: opts.runId, samples, decisionCounts, dangerFlags };
}

/**
 * A snapshot entry. Files / directories / symlinks are all recorded so a
 * misconfigured reviewer agent that creates a symlink or an empty dir is
 * still detected (parity with the Phase 2-6 reviewer-agent snapshot).
 */
type SnapEntry =
  | { type: "file"; size: number; mtimeMs: number }
  | { type: "dir" }
  | { type: "symlink"; target: string };

/**
 * Snapshot every entry under runDir EXCEPT those in review-evaluations/
 * (the evaluator's own output), keyed by path relative to runDir. Walks
 * with lstat so symlinks are recorded as symlinks (never followed).
 */
async function snapshotExcludingEvals(
  runDir: string,
): Promise<Map<string, SnapEntry>> {
  const out = new Map<string, SnapEntry>();
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (rel === "review-evaluations") continue;
      const full = join(dir, e.name);
      if (e.isSymbolicLink()) {
        out.set(rel, { type: "symlink", target: await readlink(full) });
      } else if (e.isDirectory()) {
        out.set(rel, { type: "dir" });
        await walk(full, rel);
      } else if (e.isFile()) {
        const st = await lstat(full);
        out.set(rel, { type: "file", size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  }
  await walk(runDir, "");
  return out;
}

/** Throw if the run was mutated between two snapshots. */
function verifyUnchanged(
  before: Map<string, SnapEntry>,
  after: Map<string, SnapEntry>,
): void {
  const same = (a: SnapEntry, b: SnapEntry): boolean => {
    if (a.type !== b.type) return false;
    if (a.type === "file" && b.type === "file") {
      return a.size === b.size && a.mtimeMs === b.mtimeMs;
    }
    if (a.type === "symlink" && b.type === "symlink") {
      return a.target === b.target;
    }
    return true; // both dir
  };
  for (const [p, b] of before) {
    const a = after.get(p);
    if (!a) {
      throw new ReviewEvaluateError(
        `evaluation must not modify the run — entry removed: ${p}`,
      );
    }
    if (!same(a, b)) {
      throw new ReviewEvaluateError(
        `evaluation must not modify the run — entry changed: ${p}`,
      );
    }
  }
  for (const p of after.keys()) {
    if (!before.has(p)) {
      throw new ReviewEvaluateError(
        `evaluation must not modify the run — unexpected entry: ${p}`,
      );
    }
  }
}

interface CaptureArgs {
  index: number;
  evalDir: string;
  stdoutPath: string;
  runId: string;
  domain: string;
  reviewer: string;
  reviewedAt: string;
  codexFailed: boolean;
  codexNote: string;
}

/** Parse one sample's codex output into a SampleResult + per-sample artifact. */
async function captureSample(a: CaptureArgs): Promise<SampleResult> {
  const invalid = async (reason: string): Promise<SampleResult> => {
    await writeFile(
      join(a.evalDir, "review-auto-error.json"),
      `${JSON.stringify(
        { type: "review-auto-error", runId: a.runId, sample: a.index, reason },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return {
      index: a.index,
      decision: "invalid",
      requiredChanges: 0,
      nonBlocking: 0,
      outOfScope: 0,
      error: reason,
    };
  };

  if (a.codexFailed) return invalid(a.codexNote);

  let raw: string;
  try {
    raw = await readFile(a.stdoutPath, "utf8");
  } catch (e) {
    return invalid(`could not read codex output: ${(e as Error).message}`);
  }
  let parsed: PartialDecision;
  try {
    parsed = parseYaml(extractYamlBlock(raw)) as PartialDecision;
  } catch (e) {
    return invalid(`unparseable YAML: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("codex output is not a YAML object");
  }
  let decision;
  try {
    decision = buildDecision(
      a.runId,
      a.domain,
      parsed,
      a.reviewer,
      a.reviewedAt,
    );
  } catch (e) {
    return invalid((e as Error).message);
  }
  // valid — persist the parsed decision for this sample
  await writeFile(
    join(a.evalDir, "review-decision.yaml"),
    renderDecisionYaml(decision),
    "utf8",
  );
  return {
    // buildDecision threw on any non-approved/changes_requested/rejected
    // value, so this is never "pending".
    index: a.index,
    decision: decision.decision as SampleDecision,
    requiredChanges: decision.required_changes.length,
    nonBlocking: decision.non_blocking_comments.length,
    outOfScope: decision.out_of_scope_suggestions.length,
  };
}

function renderDecisionYaml(d: {
  runId: string;
  domain: string;
  decision: string;
  required_changes: string[];
  non_blocking_comments: string[];
  out_of_scope_suggestions: string[];
  reviewer: string | null;
  reviewed_at: string | null;
}): string {
  const list = (xs: string[]) =>
    xs.length === 0
      ? " []"
      : "\n" + xs.map((x) => `  - ${JSON.stringify(x)}`).join("\n");
  return [
    `runId: ${d.runId}`,
    `domain: ${JSON.stringify(d.domain)}`,
    `decision: ${d.decision}`,
    `required_changes:${list(d.required_changes)}`,
    `non_blocking_comments:${list(d.non_blocking_comments)}`,
    `out_of_scope_suggestions:${list(d.out_of_scope_suggestions)}`,
    `reviewer: ${JSON.stringify(d.reviewer)}`,
    `reviewed_at: ${JSON.stringify(d.reviewed_at)}`,
    "",
  ].join("\n");
}

/**
 * Surface samples where the agent's verdict looks unsafe vs the run's
 * own meta — an approved verdict on a denied / secret-suspect run.
 */
function computeDangerFlags(
  meta: RunMeta,
  samples: SampleResult[],
  _evalRoot: string,
): string[] {
  const flags: string[] = [];
  const approved = samples.filter((s) => s.decision === "approved");
  if (meta.safetyStatus === "denied" && approved.length > 0) {
    flags.push(
      `${approved.length} sample(s) returned "approved" but the run's safetyStatus is "denied"`,
    );
  }
  if (
    typeof meta.secretSuspectCount === "number" &&
    meta.secretSuspectCount > 0 &&
    approved.length > 0
  ) {
    flags.push(
      `${approved.length} sample(s) returned "approved" but the run has secretSuspectCount=${meta.secretSuspectCount} — confirm the reviewer addressed it`,
    );
  }
  return flags;
}

function renderSummary(
  runId: string,
  meta: RunMeta,
  samples: SampleResult[],
  decisionCounts: Record<string, number>,
  dangerFlags: string[],
): string {
  const distinct = new Set(samples.map((s) => s.decision));
  const lines: string[] = [
    "# Reviewer evaluation",
    "",
    `- run: ${runId}`,
    `- run status: ${meta.status ?? "?"}`,
    `- run safetyStatus: ${meta.safetyStatus ?? "?"}`,
    `- samples: ${samples.length}`,
    `- decision stability: ${distinct.size === 1 ? "stable (all samples agree)" : `UNSTABLE (${distinct.size} distinct verdicts)`}`,
    "",
    "## Decision distribution",
    "",
  ];
  for (const [k, v] of Object.entries(decisionCounts)) {
    lines.push(`- ${k}: ${v}`);
  }
  lines.push("", "## Samples", "");
  lines.push("| sample | decision | required | non_blocking | out_of_scope |");
  lines.push("|-------:|----------|---------:|-------------:|-------------:|");
  for (const s of samples) {
    lines.push(
      `| ${s.index} | ${s.decision}${s.error ? ` (${s.error})` : ""} | ${s.requiredChanges} | ${s.nonBlocking} | ${s.outOfScope} |`,
    );
  }
  lines.push("", "## Danger flags", "");
  if (dangerFlags.length === 0) {
    lines.push("(none)");
  } else {
    for (const f of dangerFlags) lines.push(`- ⚠️ ${f}`);
  }
  lines.push("");
  return lines.join("\n");
}

// --- review compare ------------------------------------------------------

export interface CompareResult {
  decisionMatch: boolean;
  humanDecision: string;
  agentDecision: string;
  report: string;
}

/**
 * Compare two review-decision.yaml files (typically a human's vs an
 * agent's) and produce a short report.
 */
export async function compareDecisions(opts: {
  humanPath: string;
  agentPath: string;
}): Promise<CompareResult> {
  for (const [label, p] of [
    ["--human", opts.humanPath],
    ["--agent", opts.agentPath],
  ] as const) {
    if (!existsSync(p)) {
      throw new ReviewEvaluateError(`${label} file not found: ${p}`);
    }
  }
  const human = await loadReviewDecision(opts.humanPath);
  const agent = await loadReviewDecision(opts.agentPath);
  const decisionMatch = human.decision === agent.decision;
  const report = [
    "# Review comparison",
    "",
    `- decision match: ${decisionMatch ? "YES" : "NO"}`,
    `- human decision: ${human.decision}`,
    `- agent decision: ${agent.decision}`,
    "",
    "| field | human | agent |",
    "|-------|------:|------:|",
    `| required_changes | ${human.required_changes.length} | ${agent.required_changes.length} |`,
    `| non_blocking_comments | ${human.non_blocking_comments.length} | ${agent.non_blocking_comments.length} |`,
    `| out_of_scope_suggestions | ${human.out_of_scope_suggestions.length} | ${agent.out_of_scope_suggestions.length} |`,
    "",
  ].join("\n");
  return {
    decisionMatch,
    humanDecision: human.decision,
    agentDecision: agent.decision,
    report,
  };
}
