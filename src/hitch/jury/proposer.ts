import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { verifyEvidence } from "./evidence.js";
import { runJuryCodex } from "./run-codex.js";
import {
  JURY_LENSES,
  type JuryClassificationProposal,
  type JuryLens,
  type JuryProposalStatus,
  type JuryProposedScope,
  type JuryProposerDeps,
  type RawJuryEvidence,
  type VerifiedJuryEvidence,
} from "./types.js";
import { HITCH_FINDING_SEVERITIES } from "../types.js";
import {
  renderScopeSnapshot,
  type HitchScopeSnapshot,
} from "./scope-snapshot.js";

/**
 * #230 Task C1 — Stage1 jury proposer (3 independent lens proposals) + Stage2
 * deterministic evidence verification. Layer 2 (LLM stage, DB-closed).
 *
 * Each of the 3 lenses runs an independent codex invocation that does NOT see
 * the other lenses (design §2 Stage1). The per-lens prompt embeds a lens token
 * `[[lens:<lens>]]` and a stage token `[[stage:propose]]` so the real codex (and
 * the test routing runner) answer per-lens independently.
 *
 * Safety boundary (design §0.1 R1): the parse schema is STRICT and rejects
 * `verified`/`resolvedRef` — the LLM may only supply `citation/kind/claim`.
 * Every parsed `RawJuryEvidence` is then passed through `verifyEvidence`
 * (Stage2, deterministic, read-only) to produce `VerifiedJuryEvidence`; the LLM
 * can never self-assert verification. This module performs NO DB IO (Stage1 is
 * DB-closed — `JuryProposerDeps` carries no DB handle).
 *
 * Fail-closed status mapping (design §2 / 付録P / plan PR5):
 * - codex timeout                                   -> `timeout`
 * - non-zero exit / unparseable / strict violation  -> `parse_error`
 * - parsed but zero verified evidence post-Stage2   -> `inconclusive`
 * - otherwise                                        -> `complete`
 */

/** The finding metadata the proposer needs (prompt context + proposal id). */
export interface JuryProposerFinding {
  findingId: string;
  summary: string;
  detail?: string;
  filePath?: string;
  category?: string;
}

const SEVERITY_VALUES = HITCH_FINDING_SEVERITIES;

/**
 * STRICT zod schema for the 付録P Stage1 propose contract. `.strict()` rejects
 * unknown keys — critically `verified`/`resolvedRef` on evidence (design §0.1
 * R1). `refutationCondition` and `reasoning` are required (non-empty); a missing
 * or empty required field fails the parse -> `parse_error` (fail-closed).
 */
const RawEvidenceSchema = z
  .object({
    citation: z.string().min(1),
    kind: z.enum(["file", "spec", "policy"]),
    claim: z.string().min(1),
  })
  .strict();

const ProposeSchema = z
  .object({
    proposedScope: z.enum(["in_scope", "out_of_scope", "unknown"]),
    evidence: z.array(RawEvidenceSchema),
    refutationCondition: z.string().min(1),
    uncertainty: z.string().optional(),
    reasoning: z.string().min(1),
    proposedSeverity: z.enum(SEVERITY_VALUES).optional(),
  })
  .strict();

type ParsedPropose = z.infer<typeof ProposeSchema>;

/**
 * Build one lens's independent Stage1 propose prompt. The lens/stage tokens let
 * the model (and the test routing runner) answer per-lens. A lens prompt NEVER
 * embeds another lens's token, so the lenses cannot see each other.
 */
function buildProposePrompt(
  lens: JuryLens,
  finding: JuryProposerFinding,
  scopeSnapshot: HitchScopeSnapshot,
): string {
  const lensGuide: Record<JuryLens, string> = {
    correctness:
      "Does the change do what it claims, with no logic/regression defects?",
    scope_fit:
      "Does the change stay inside the declared domain scope (not bleed into another domain)?",
    spec_adherence:
      "Does the change match the written specs / documented contracts?",
  };
  return [
    "You are ONE lens of an automated deliberation jury classifying whether a",
    "finding is in scope for the current change. Reason ONLY from your lens.",
    "",
    `[[stage:propose]] [[lens:${lens}]]`,
    `Lens: ${lens} — ${lensGuide[lens]}`,
    "",
    // FIX 1 (codex#254 P1): classify AGAINST the frozen scope, not just the text.
    renderScopeSnapshot(scopeSnapshot),
    "",
    "Finding under review:",
    `- id: ${finding.findingId}`,
    `- summary: ${finding.summary}`,
    finding.detail !== undefined ? `- detail: ${finding.detail}` : "",
    finding.filePath !== undefined ? `- filePath: ${finding.filePath}` : "",
    finding.category !== undefined ? `- category: ${finding.category}` : "",
    "",
    "Output ONLY a single JSON object (no prose, no fences required) of shape:",
    "{",
    '  "proposedScope": "in_scope" | "out_of_scope" | "unknown",',
    '  "evidence": [{ "citation": "<file:line | spec#anchor | policy-glob>",',
    '                 "kind": "file" | "spec" | "policy", "claim": "<what it shows>" }],',
    '  "refutationCondition": "<what would prove this proposal wrong>" (REQUIRED),',
    '  "uncertainty": "<optional>",',
    '  "reasoning": "<why> (REQUIRED)",',
    '  "proposedSeverity": "P0"|"P1"|"P2"|"P3"|"info" (optional)',
    "}",
    "Cite at least one concrete piece of evidence. Do NOT claim a citation is",
    'verified — you may only supply citation/kind/claim. The "verified" status is',
    "recomputed deterministically by the harness, never trusted from you.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Extract the JSON object body from codex output. The model is asked for a bare
 * JSON object, but may wrap it in a ```json fence or add prose; trust a fenced
 * block first, else fall back to the first balanced `{...}` span.
 */
function extractJsonBlock(output: string): string {
  const fenced = output.match(/```json\s*\n([\s\S]*?)```/i);
  if (fenced && fenced[1] !== undefined) return fenced[1].trim();
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return output.slice(start, end + 1).trim();
  }
  return output.trim();
}

/** Parse codex stdout into a validated propose object, or undefined on failure. */
function parsePropose(rawOutput: string): ParsedPropose | undefined {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonBlock(rawOutput));
  } catch {
    return undefined;
  }
  const result = ProposeSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/** Map a parsed-and-verified lens result to a proposal status (fail-closed). */
function statusForVerified(evidence: VerifiedJuryEvidence[]): JuryProposalStatus {
  // design Stage2: zero verifiable evidence -> inconclusive (fail-closed).
  return evidence.some((e) => e.verified === true) ? "complete" : "inconclusive";
}

/**
 * Build a non-complete proposal (timeout / parse_error / inconclusive). Evidence
 * is empty for timeout/parse_error (no trustworthy parse); inconclusive carries
 * the verified-but-unproven evidence so the audit/packet can record it.
 */
function failedProposal(
  finding: JuryProposerFinding,
  lens: JuryLens,
  status: JuryProposalStatus,
  evidence: VerifiedJuryEvidence[],
): JuryClassificationProposal {
  return {
    findingId: finding.findingId,
    lens,
    proposedScope: "unknown" satisfies JuryProposedScope,
    proposalStatus: status,
    evidence,
    round: 1,
  };
}

/** Run one lens's Stage1 propose + Stage2 verify, fully fail-closed. */
async function proposeForLens(
  deps: JuryProposerDeps,
  finding: JuryProposerFinding,
  lens: JuryLens,
): Promise<JuryClassificationProposal> {
  const prompt = buildProposePrompt(lens, finding, deps.scopeSnapshot);
  const paths = deps.logPaths(finding.findingId, lens, "propose");
  // P2 (codex round5): the deterministic stdout/stderr/events log paths are
  // truncated INSIDE runJuryCodex, AFTER its already-aborted short-circuit, so a
  // stale lease-lost worker cannot erase the authoritative worker's log files.
  const result = await runJuryCodex(deps, {
    worktreePath: deps.worktreePath,
    prompt,
    logPaths: { stdout: paths.stdout, stderr: paths.stderr, events: paths.events },
  });

  if (result.timedOut) {
    return failedProposal(finding, lens, "timeout", []);
  }
  if (result.exitCode !== 0) {
    return failedProposal(finding, lens, "parse_error", []);
  }

  const rawOutput = await readFile(paths.stdout, "utf8").catch(() => "");
  const parsed = parsePropose(rawOutput);
  if (parsed === undefined) {
    return failedProposal(finding, lens, "parse_error", []);
  }

  // Stage2: deterministically verify every cited piece of evidence. The LLM's
  // (rejected) verified/resolvedRef can never reach here — only citation/kind/
  // claim survive the strict schema (design §0.1 R1).
  const verified: VerifiedJuryEvidence[] = parsed.evidence.map(
    (ev: RawJuryEvidence) => verifyEvidence(ev, deps.evidenceCtx),
  );
  const status = statusForVerified(verified);
  if (status !== "complete") {
    return failedProposal(finding, lens, status, verified);
  }

  return {
    findingId: finding.findingId,
    lens,
    proposedScope: parsed.proposedScope,
    proposalStatus: "complete",
    evidence: verified,
    refutationCondition: parsed.refutationCondition,
    ...(parsed.uncertainty !== undefined
      ? { uncertainty: parsed.uncertainty }
      : {}),
    reasoning: parsed.reasoning,
    ...(parsed.proposedSeverity !== undefined
      ? { proposedSeverity: parsed.proposedSeverity }
      : {}),
    round: 1,
  };
}

/**
 * Stage1: generate the 3 independent lens proposals for one finding, each with
 * its evidence verified by Stage2. Returns one round-1 proposal per lens (fixed
 * lens order). Performs no DB IO. Fail-closed: any per-lens failure becomes a
 * non-complete proposal, never an exception that would abort the batch.
 */
export async function generateJuryProposals(
  deps: JuryProposerDeps,
  finding: JuryProposerFinding,
): Promise<JuryClassificationProposal[]> {
  const proposals: JuryClassificationProposal[] = [];
  for (const lens of JURY_LENSES) {
    try {
      proposals.push(await proposeForLens(deps, finding, lens));
    } catch (e) {
      // Fail-closed: an unexpected IO/runner error for one lens degrades to a
      // parse_error proposal, never a thrown rejection (the gate then escalates).
      await writeFile(
        deps.logPaths(finding.findingId, lens, "propose").stderr,
        `jury proposer error (${lens}): ${(e as Error).message}\n`,
        "utf8",
      ).catch(() => undefined);
      proposals.push(failedProposal(finding, lens, "parse_error", []));
    }
  }
  return proposals;
}
