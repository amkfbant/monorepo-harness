import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { CodexExecRunner } from "../codex/codex-exec-runner.js";
import { assertPathSafeReviewerId } from "../db/repositories/reviewers.js";
import type {
  ReviewRefuteCounterEvidenceKind,
  ReviewRefuteVerdict,
  ReviewRefuteVoteInsertResult,
} from "../db/repositories/review-refute-votes.js";
import {
  TARGET_CHANGE_HASH_MISSING_SENTINEL,
  targetChangeHash,
  verifyRefuteBinding,
  type RefuteBindingResult,
  type RefuteBindingVote,
  type RefuteRequiredChange,
  type RefuteBindingRecorder,
} from "./refute-binding.js";
import { ReviewerAgentGateError } from "./reviewer-agent-errors.js";
import {
  materializeReviewerInput,
  reviewerArtifactRelDir,
  snapshotRunDir,
  verifyArtifactsUnchanged,
} from "./reviewer-artifact-isolation.js";

const RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const REFUTE_WRITE_ALLOWLIST = new Set([
  "refute-agent.out.log",
  "refute-agent.err.log",
  ".refute-agent.events.raw.jsonl",
]);

const REFUTE_INPUT_DIRS = [
  { dir: "commands", include: isCommandOutLogArtifactRef },
] as const;

export const REFUTE_AGENT_PROMPT_TEMPLATE = {
  name: "refute-run-artifacts",
  version: 1,
} as const;

export const REFUTE_AGENT_PROMPT = `You are an automated refute reviewer. Read the run artifacts in the
current working directory and decide whether one target required_change still
blocks approval.

Output ONLY a single fenced YAML block, nothing else. Use this shape:

\`\`\`yaml
target_change_hash: "sha256 hash from the target list"
refute_verdict: uphold | refute | inconclusive
refute_reason: "required only when refute_verdict is refute"
counter_evidence:
  kind: diff | test | none
  ref: "required only for diff/test"
refute_condition: "required only when refute_verdict is refute"
retract_condition: "required only when refute_verdict is refute"
reasoning: "optional short rationale"
confidence: 0.0
\`\`\`

Verdict guide:
- uphold       - the target required_change still blocks approval.
- refute       - the target required_change is disproven by run artifacts.
- inconclusive - you cannot decide from the artifacts.

A refute verdict must cite concrete diff or test evidence from this run.
`;

export interface RefuteAgentInputs {
  runsDir: string;
  runId: string;
  repository: RefuteBindingRecorder;
  activeRequiredChanges: RefuteRequiredChange[];
  reviewerName: string;
  codexRunner: CodexExecRunner;
  hitchId?: string;
  findingId?: string;
  model?: string;
  now?: Date;
  signal?: AbortSignal;
}

export type RefuteAgentResult = ReviewRefuteVoteInsertResult & {
  binding: RefuteBindingResult;
};

interface RawRefuteOutput {
  target_change_hash?: unknown;
  targetChangeHash?: unknown;
  target_change_text?: unknown;
  targetChangeText?: unknown;
  refute_verdict?: unknown;
  refuteVerdict?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  refute_reason?: unknown;
  refuteReason?: unknown;
  counter_evidence?: unknown;
  counterEvidence?: unknown;
  counter_evidence_kind?: unknown;
  counterEvidenceKind?: unknown;
  counter_evidence_ref?: unknown;
  counterEvidenceRef?: unknown;
  refute_condition?: unknown;
  refuteCondition?: unknown;
  retract_condition?: unknown;
  retractCondition?: unknown;
}

interface NormalizedRefuteOutput {
  bindingVote: RefuteBindingVote;
  refuteVerdict?: ReviewRefuteVerdict;
  confidence?: number;
  reasoning?: string;
  refuteReason?: string;
  counterEvidenceKind?: ReviewRefuteCounterEvidenceKind;
  counterEvidenceRef?: string;
  refuteCondition?: string;
  retractCondition?: string;
}

export async function runRefuteAgent(
  inputs: RefuteAgentInputs,
): Promise<RefuteAgentResult> {
  if (!RUN_ID_RE.test(inputs.runId)) {
    throw new Error(`invalid runId: ${JSON.stringify(inputs.runId)}`);
  }
  assertPathSafeReviewerId(inputs.reviewerName);

  const runDir = join(inputs.runsDir, inputs.runId);
  const reviewerRelDir = reviewerArtifactRelDir(inputs.reviewerName);
  const reviewerDir = join(runDir, "reviewers", inputs.reviewerName);
  await mkdir(reviewerDir, { recursive: true });
  const stdoutPath = join(reviewerDir, "refute-agent.out.log");
  const stderrPath = join(reviewerDir, "refute-agent.err.log");
  const eventsPath = join(reviewerDir, ".refute-agent.events.raw.jsonl");
  const prompt = buildRefutePrompt(inputs.activeRequiredChanges);
  const promptSha256 = sha256Hex(prompt);
  const createdAt = (inputs.now ?? new Date()).toISOString();

  const snapshot = await snapshotRunDir(
    runDir,
    reviewerRelDir,
    REFUTE_WRITE_ALLOWLIST,
  );
  const refuteInputDir = await mkdtemp(join(tmpdir(), "harness-refute-input-"));
  let codexResult: Awaited<ReturnType<CodexExecRunner["run"]>>;
  try {
    await materializeReviewerInput(
      runDir,
      refuteInputDir,
      await refuteInputFiles(runDir),
      REFUTE_INPUT_DIRS,
    );
    codexResult = await inputs.codexRunner.run({
      worktreePath: refuteInputDir,
      prompt,
      logPaths: { stdout: stdoutPath, stderr: stderrPath, events: eventsPath },
      ...(inputs.signal !== undefined ? { signal: inputs.signal } : {}),
    });
  } finally {
    await rm(refuteInputDir, { recursive: true, force: true });
  }
  const tamperRejectReason = await refuteTamperRejectReason(
    runDir,
    snapshot,
    reviewerRelDir,
  );
  const rawOutput = await readFile(stdoutPath, "utf8").catch(() => "");
  const yamlText =
    codexResult.exitCode === 0 && !codexResult.timedOut
      ? extractYamlBlock(rawOutput)
      : "";
  const sourceYaml = yamlText;
  const sourceSha256 = sha256Hex(sourceYaml);

  const normalized = parseRefuteOutput(yamlText);
  const binding = verifyRefuteBinding({
    refuteVote: normalized.bindingVote,
    activeRequiredChanges: inputs.activeRequiredChanges,
  });
  const rejectReason =
    tamperRejectReason ??
    (codexResult.timedOut
      ? "codex_timed_out"
      : codexResult.exitCode !== 0
        ? "codex_failed"
        : validationRejectReason(normalized, binding, runDir));
  const validationStatus = rejectReason === undefined ? "passed" : "rejected";
  const target = binding.bound
    ? {
        targetChangeHash: binding.targetChangeHash,
        targetChangeIdx: binding.boundToIdx,
      }
    : {
        targetChangeHash: rejectedAuditTargetHash(binding),
      };

  const recorded = inputs.repository.insert({
    runId: inputs.runId,
    ...(inputs.hitchId !== undefined ? { hitchId: inputs.hitchId } : {}),
    ...target,
    ...(inputs.findingId !== undefined ? { findingId: inputs.findingId } : {}),
    reviewerId: inputs.reviewerName,
    ...(normalized.refuteVerdict !== undefined
      ? { refuteVerdict: normalized.refuteVerdict }
      : {}),
    ...(normalized.confidence !== undefined
      ? { confidence: normalized.confidence }
      : {}),
    ...(normalized.reasoning !== undefined
      ? { reasoning: normalized.reasoning }
      : {}),
    ...(normalized.refuteReason !== undefined
      ? { refuteReason: normalized.refuteReason }
      : {}),
    ...(normalized.counterEvidenceKind !== undefined
      ? { counterEvidenceKind: normalized.counterEvidenceKind }
      : {}),
    ...(normalized.counterEvidenceRef !== undefined
      ? { counterEvidenceRef: normalized.counterEvidenceRef }
      : {}),
    ...(normalized.refuteCondition !== undefined
      ? { refuteCondition: normalized.refuteCondition }
      : {}),
    ...(normalized.retractCondition !== undefined
      ? { retractCondition: normalized.retractCondition }
      : {}),
    ...(inputs.model !== undefined ? { model: inputs.model } : {}),
    promptSha256,
    promptProvenance: { template: REFUTE_AGENT_PROMPT_TEMPLATE },
    sourceYaml,
    sourceSha256,
    validationStatus,
    ...(rejectReason !== undefined ? { rejectReason } : {}),
    createdAt,
  });
  return { ...recorded, binding };
}

async function refuteTamperRejectReason(
  runDir: string,
  snapshot: Awaited<ReturnType<typeof snapshotRunDir>>,
  reviewerRelDir: string,
): Promise<string | undefined> {
  try {
    await verifyArtifactsUnchanged(
      runDir,
      snapshot,
      reviewerRelDir,
      REFUTE_WRITE_ALLOWLIST,
    );
    return undefined;
  } catch (e) {
    if (e instanceof ReviewerAgentGateError) {
      return "artifact_tamper";
    }
    throw e;
  }
}

function buildRefutePrompt(activeRequiredChanges: RefuteRequiredChange[]): string {
  const targets = [...activeRequiredChanges]
    .sort((a, b) => a.idx - b.idx)
    .map((change) => {
      const text = change.changeText ?? change.change_text ?? "";
      return [
        `- idx: ${change.idx}`,
        `  target_change_hash: ${targetChangeHash(text)}`,
        `  change_text: ${JSON.stringify(text)}`,
      ].join("\n");
    })
    .join("\n");
  return `${REFUTE_AGENT_PROMPT}\nTarget required_changes:\n${targets}\n`;
}

function parseRefuteOutput(yamlText: string): NormalizedRefuteOutput {
  let raw: unknown;
  try {
    raw = yamlText.trim() === "" ? {} : parseYaml(yamlText);
  } catch {
    raw = {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    raw = {};
  }
  const obj = raw as RawRefuteOutput;
  const counter = readCounterEvidence(obj);
  const targetHash = readString(obj.targetChangeHash ?? obj.target_change_hash);
  const targetText = readString(obj.targetChangeText ?? obj.target_change_text);
  const bindingVote: RefuteBindingVote = {
    ...(targetHash !== undefined ? { targetChangeHash: targetHash } : {}),
    ...(targetText !== undefined ? { targetChangeText: targetText } : {}),
  };
  const verdict = readVerdict(obj.refuteVerdict ?? obj.refute_verdict);
  const confidence = readConfidence(obj.confidence);
  const reasoning = readString(obj.reasoning);
  const refuteReason = readString(obj.refuteReason ?? obj.refute_reason);
  const refuteCondition = readString(
    obj.refuteCondition ?? obj.refute_condition,
  );
  const retractCondition = readString(
    obj.retractCondition ?? obj.retract_condition,
  );
  return {
    bindingVote,
    ...(verdict !== undefined ? { refuteVerdict: verdict } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(refuteReason !== undefined ? { refuteReason } : {}),
    ...(counter.kind !== undefined ? { counterEvidenceKind: counter.kind } : {}),
    ...(counter.ref !== undefined ? { counterEvidenceRef: counter.ref } : {}),
    ...(refuteCondition !== undefined ? { refuteCondition } : {}),
    ...(retractCondition !== undefined ? { retractCondition } : {}),
  };
}

function validationRejectReason(
  output: NormalizedRefuteOutput,
  binding: RefuteBindingResult,
  runDir: string,
): string | undefined {
  if (!binding.bound) return binding.reason;
  if (output.refuteVerdict === undefined) return "missing_field";
  if (output.refuteVerdict !== "refute") return undefined;
  if (
    isBlank(output.refuteReason) ||
    isBlank(output.refuteCondition) ||
    isBlank(output.retractCondition) ||
    output.counterEvidenceKind === undefined
  ) {
    return "missing_field";
  }
  if (output.counterEvidenceKind === "none") return "evidence_none";
  const counterEvidenceRef = output.counterEvidenceRef;
  if (
    counterEvidenceRef === undefined ||
    counterEvidenceRef.trim() === "" ||
    !isSafeArtifactRef(counterEvidenceRef) ||
    !isRegularRunArtifact(runDir, counterEvidenceRef)
  ) {
    return "artifact_absent";
  }
  if (
    !counterEvidenceRefMatchesKind(
      output.counterEvidenceKind,
      counterEvidenceRef,
    )
  ) {
    return "evidence_kind_mismatch";
  }
  return undefined;
}

function isRegularRunArtifact(runDir: string, ref: string): boolean {
  if (!existsSync(join(runDir, ref))) return false;
  const segments = ref.split("/");
  let current = runDir;
  try {
    for (let i = 0; i < segments.length; i += 1) {
      current = join(current, segments[i]!);
      const st = lstatSync(current);
      if (st.isSymbolicLink()) return false;
      if (i === segments.length - 1) return st.isFile();
      if (!st.isDirectory()) return false;
    }
    return false;
  } catch {
    return false;
  }
}

function counterEvidenceRefMatchesKind(
  kind: Exclude<ReviewRefuteCounterEvidenceKind, "none">,
  ref: string,
): boolean {
  if (kind === "diff") {
    return ref === "final-diff.patch" || isUntrackedPatchRef(ref);
  }
  return isCommandOutLogArtifactRef(ref);
}

async function refuteInputFiles(runDir: string): Promise<string[]> {
  const rootEntries = await readdir(runDir, { withFileTypes: true });
  const untrackedPatchFiles = rootEntries
    .filter((entry) => entry.isFile() && isUntrackedPatchRef(entry.name))
    .map((entry) => entry.name)
    .sort(compareStrings);
  return ["final-diff.patch", ...untrackedPatchFiles];
}

function isCommandOutLogArtifactRef(ref: string): boolean {
  return /^commands\/[^/]+\.out\.log$/.test(ref);
}

function isUntrackedPatchRef(ref: string): boolean {
  return (
    !ref.includes("/") &&
    ref.startsWith("untracked-") &&
    ref.endsWith(".patch")
  );
}

function readCounterEvidence(output: RawRefuteOutput): {
  kind?: ReviewRefuteCounterEvidenceKind;
  ref?: string;
} {
  const directKind = readEvidenceKind(
    output.counterEvidenceKind ?? output.counter_evidence_kind,
  );
  const directRef = readString(
    output.counterEvidenceRef ?? output.counter_evidence_ref,
  );
  const nested = output.counterEvidence ?? output.counter_evidence;
  if (nested === null || typeof nested !== "object" || Array.isArray(nested)) {
    return {
      ...(directKind !== undefined ? { kind: directKind } : {}),
      ...(directRef !== undefined ? { ref: directRef } : {}),
    };
  }
  const obj = nested as { kind?: unknown; ref?: unknown };
  const nestedKind = readEvidenceKind(obj.kind);
  const nestedRef = readString(obj.ref);
  const kind = nestedKind ?? directKind;
  const ref = nestedRef ?? directRef;
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(ref !== undefined ? { ref } : {}),
  };
}

function readVerdict(value: unknown): ReviewRefuteVerdict | undefined {
  return value === "uphold" || value === "refute" || value === "inconclusive"
    ? value
    : undefined;
}

function readEvidenceKind(
  value: unknown,
): ReviewRefuteCounterEvidenceKind | undefined {
  return value === "diff" || value === "test" || value === "none"
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function readConfidence(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : undefined;
}

function extractYamlBlock(output: string): string {
  const fenced = output.match(/```ya?ml\s*\n([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  return output.trim();
}

function rejectedAuditTargetHash(
  binding: Extract<RefuteBindingResult, { bound: false }>,
): string {
  return (
    binding.computedTargetChangeHash ??
    binding.targetChangeHash ??
    TARGET_CHANGE_HASH_MISSING_SENTINEL
  );
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function isSafeArtifactRef(ref: string): boolean {
  if (
    ref === "" ||
    ref.includes("\0") ||
    ref.includes("\\") ||
    ref.startsWith("/")
  ) {
    return false;
  }
  return ref.split("/").every((segment) => segment !== "." && segment !== "..");
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
