import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { verifyEvidence } from "./evidence.js";
import { runJuryCodex } from "./run-codex.js";
import {
  JURY_LENSES,
  type JuryLens,
  type JuryProposedScope,
  type JuryProposerDeps,
  type RawJuryEvidence,
  type RefuterVerdict,
  type VerifiedJuryEvidence,
} from "./types.js";

/**
 * #230 Task C3 — Stage4 adversarial classification refuter
 * (`runClassificationRefuter`). Layer 2 (LLM stage, DB-closed).
 *
 * Invoked (by Task C4) ONLY when the post-critique final-round proposals are
 * unanimous AND every proposal carries verified evidence (design §2 Stage4).
 * A SINGLE adversarial agent receives the unanimous verdict + each proposer's
 * refutationCondition + the verified evidence + (when critique ran) who changed
 * their vote, and tries to BREAK the consensus — "is this a conformity-driven
 * false consensus?".
 *
 * ★ Monotonic fail-closed (design §3 invariant 1): the refuter can only `uphold`
 * (does NOT block the gate) or `refute`/`inconclusive` (veto). It NEVER creates
 * an auto_confirm — the deterministic gate (`aggregateDeliberation`) still
 * requires unanimity + verified+proximate evidence + refuteVerdict==='uphold'.
 * Deliberation can only ADD safety, never subtract it.
 *
 * Anti-ritualization (design §0.1 R9 / 付録P): an `uphold` MUST supply BOTH
 * `whyNotFalseConsensus` AND `refutationConditions` (non-empty). Either missing
 * downgrades the verdict to `inconclusive` (veto = fail-closed). `refute` /
 * `inconclusive` pass through unchanged.
 *
 * Fail-closed status mapping (design §2 / 付録P / plan PR5):
 * - codex timeout / non-zero exit / unparseable / strict violation -> inconclusive
 * - uphold missing a required justification (R9)                    -> inconclusive
 * - otherwise                                                       -> the parsed verdict
 *
 * counterEvidence is ADVISORY ONLY (design §0.1 P3): it never drives the gate.
 * When present it is passed through `verifyEvidence` so the packet records
 * `VerifiedJuryEvidence` (the LLM's claimed `verified` is never trusted).
 * This module performs NO DB IO (Stage4 is DB-closed).
 */

/** One proposer's refutationCondition, carried into the refuter prompt. */
export interface RefuterRefutationCondition {
  lens: JuryLens;
  condition: string;
}

/** One lens's R1->R2 vote change (only present when critique ran; P2-j). */
export interface RefuterVoteChange {
  lens: JuryLens;
  voteChanged: boolean;
}

/**
 * Input to the Stage4 refuter (design §2 Stage4 + P2-j). `voteChanges` is
 * OPTIONAL: when critique was skipped (clean unanimous + strong evidence), the
 * refuter input does NOT include voteChanged (P2-j) — pass it through only when
 * the critique round actually ran.
 */
export interface RefuterInput {
  findingId: string;
  filePath?: string;
  category?: string;
  /** The single post-critique unanimous verdict (Stage4 trigger value). */
  unanimousScope: Exclude<JuryProposedScope, "unknown">;
  refutationConditions: RefuterRefutationCondition[];
  verifiedEvidence: VerifiedJuryEvidence[];
  /** Present ONLY when critique ran (P2-j); omitted when critique was skipped. */
  voteChanges?: RefuterVoteChange[];
}

/**
 * STRICT zod schema for the 付録P Stage4 refuter contract. `.strict()` rejects
 * unknown keys (an injected extra key fails the parse -> inconclusive).
 *
 * `whyNotFalseConsensus` / `refutationConditions` are OPTIONAL at the schema
 * level so a missing one is a CLEAN parse, not a structural failure — the R9
 * veto (uphold-requires-both) is then applied deterministically below. This
 * keeps "uphold missing X" => inconclusive distinct from "garbage" => inconclusive
 * in the audit trail.
 */
const RawCounterEvidenceSchema = z
  .object({
    citation: z.string().min(1),
    kind: z.enum(["file", "spec", "policy"]),
    claim: z.string().min(1),
  })
  .strict();

const RefuteSchema = z
  .object({
    refuteVerdict: z.enum(["uphold", "refute", "inconclusive"]),
    whyNotFalseConsensus: z.string().optional(),
    refutationConditions: z.string().optional(),
    counterEvidence: z.array(RawCounterEvidenceSchema).optional(),
    reasoning: z.string().min(1),
  })
  .strict();

type ParsedRefute = z.infer<typeof RefuteSchema>;

/** Build the single Stage4 refuter prompt. Carries `[[stage:refute]]`, no lens. */
function buildRefutePrompt(input: RefuterInput): string {
  const conditions = input.refutationConditions.map(
    (c) => `  - [${c.lens}] ${c.condition}`,
  );
  const evidence = input.verifiedEvidence.map(
    (e) => `  - [${e.kind}] ${e.citation} (verified=${e.verified}): ${e.claim}`,
  );
  // P2-j: include the vote-change block ONLY when critique ran.
  const voteBlock =
    input.voteChanges !== undefined
      ? [
          "Who changed their vote during the critique round:",
          ...input.voteChanges.map(
            (v) => `  - ${v.lens}: voteChanged=${v.voteChanged}`,
          ),
          "",
        ]
      : [];
  return [
    "You are an ADVERSARIAL refuter in an automated deliberation jury. Three",
    "independent lenses reached a UNANIMOUS scope verdict. Your job is to try to",
    "BREAK that consensus: is this a conformity-driven FALSE consensus, or does",
    "it genuinely hold? Attack the verdict — do not rubber-stamp it.",
    "",
    "[[stage:refute]]",
    `Unanimous verdict to attack: ${input.unanimousScope}`,
    "",
    "Finding under review:",
    `- id: ${input.findingId}`,
    input.filePath !== undefined ? `- filePath: ${input.filePath}` : "",
    input.category !== undefined ? `- category: ${input.category}` : "",
    "",
    "Each lens's refutation condition (what would prove its vote wrong):",
    ...conditions,
    "",
    "Verified evidence supporting the consensus:",
    evidence.length > 0 ? evidence.join("\n") : "  (none)",
    "",
    ...voteBlock,
    "Output ONLY a single JSON object (no prose, no fences required) of shape:",
    "{",
    '  "refuteVerdict": "uphold" | "refute" | "inconclusive",',
    '  "whyNotFalseConsensus": "<why this is NOT a conformity false consensus>"',
    "                            (REQUIRED when refuteVerdict is uphold),",
    '  "refutationConditions": "<under what conditions this verdict would flip>"',
    "                            (REQUIRED when refuteVerdict is uphold),",
    '  "counterEvidence": [{ "citation": "<cite>", "kind": "file"|"spec"|"policy",',
    '                        "claim": "<what it shows>" }] (advisory only),',
    '  "reasoning": "<your adversarial analysis> (REQUIRED)"',
    "}",
    "An uphold that omits whyNotFalseConsensus OR refutationConditions is treated",
    "as inconclusive (a veto). counterEvidence does NOT decide the gate; the",
    'harness recomputes any citation\'s verified status — never trust a "verified"',
    "claim from you.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Extract the JSON object body from codex output (fenced ```json block first,
 * else the first balanced `{...}` span).
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

/** Parse codex stdout into a validated refute object, or undefined on failure. */
function parseRefute(rawOutput: string): ParsedRefute | undefined {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonBlock(rawOutput));
  } catch {
    return undefined;
  }
  const result = RefuteSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/** A fail-closed inconclusive verdict (veto). */
function inconclusiveVerdict(reasoning: string): RefuterVerdict {
  return { refuteVerdict: "inconclusive", reasoning };
}

/** Whether a justification string is present and non-empty after trim. */
function hasJustification(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/**
 * Map a structurally-valid parsed refute to a `RefuterVerdict`, applying the R9
 * anti-ritualization veto and recomputing any counterEvidence (advisory).
 */
function mapParsedRefute(
  parsed: ParsedRefute,
  ctx: JuryProposerDeps["evidenceCtx"],
): RefuterVerdict {
  // R9 (anti-ritualization): an uphold MUST justify why this is not a false
  // consensus AND under what conditions it would flip. Either missing -> veto.
  if (
    parsed.refuteVerdict === "uphold" &&
    !(
      hasJustification(parsed.whyNotFalseConsensus) &&
      hasJustification(parsed.refutationConditions)
    )
  ) {
    return inconclusiveVerdict(
      "uphold rejected: missing whyNotFalseConsensus and/or refutationConditions (R9 veto)",
    );
  }

  // counterEvidence is advisory (P3): recompute verified deterministically; the
  // LLM's claimed verified is never trusted. It never drives the gate.
  const counterEvidence: VerifiedJuryEvidence[] = (parsed.counterEvidence ?? [])
    .map((ev: RawJuryEvidence) => verifyEvidence(ev, ctx));

  // Fold the R9 justifications into `reasoning` for the audit record — the
  // `RefuterVerdict` gate type carries no dedicated fields for them, and the
  // gate only reads `refuteVerdict`.
  const reasoning = [
    parsed.reasoning.trim(),
    parsed.refuteVerdict === "uphold" && parsed.whyNotFalseConsensus !== undefined
      ? `whyNotFalseConsensus: ${parsed.whyNotFalseConsensus.trim()}`
      : "",
    parsed.refuteVerdict === "uphold" && parsed.refutationConditions !== undefined
      ? `refutationConditions: ${parsed.refutationConditions.trim()}`
      : "",
  ]
    .filter((s) => s !== "")
    .join(" | ");

  return {
    refuteVerdict: parsed.refuteVerdict,
    reasoning,
    ...(counterEvidence.length > 0 ? { counterEvidence } : {}),
  };
}

/**
 * Stage4: run the single adversarial refutation over a post-critique unanimous,
 * fully-verified consensus. Returns a `RefuterVerdict`. Performs no DB IO.
 * Fail-closed: timeout / non-zero exit / unparseable output / an R9-deficient
 * uphold all become `inconclusive` (a veto), never a thrown rejection. The
 * caller (Task C4) only invokes this when the trigger conditions hold; this
 * function does not re-derive them.
 */
export async function runClassificationRefuter(
  deps: JuryProposerDeps,
  input: RefuterInput,
): Promise<RefuterVerdict> {
  // The refuter is a single lens-less invocation; use the first lens slot only
  // for deterministic log-path file naming (logPaths needs a lens arg).
  const logLens: JuryLens = JURY_LENSES[0];
  const paths = deps.logPaths(input.findingId, logLens, "refute");
  try {
    // P2 (codex): TRUNCATE the deterministic stdout/stderr/events paths before
    // the run so a codex that exits 0 WITHOUT writing stdout cannot leave a STALE
    // prior refute for readFile to reparse (fail-closed -> empty => inconclusive).
    for (const p of [paths.stdout, paths.stderr, paths.events]) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, "", "utf8");
    }
    const prompt = buildRefutePrompt(input);
    const result = await runJuryCodex(deps, {
      worktreePath: deps.worktreePath,
      prompt,
      logPaths: {
        stdout: paths.stdout,
        stderr: paths.stderr,
        events: paths.events,
      },
    });

    if (result.timedOut || result.exitCode !== 0) {
      return inconclusiveVerdict("refuter codex did not complete (fail-closed)");
    }

    const rawOutput = await readFile(paths.stdout, "utf8").catch(() => "");
    const parsed = parseRefute(rawOutput);
    if (parsed === undefined) {
      return inconclusiveVerdict("refuter output unparseable (fail-closed)");
    }

    return mapParsedRefute(parsed, deps.evidenceCtx);
  } catch (e) {
    // Fail-closed: an unexpected IO/runner error vetoes (never an exception
    // that would abort the deliberation; the gate then escalates).
    await writeFile(
      paths.stderr,
      `jury refuter error: ${(e as Error).message}\n`,
      "utf8",
    ).catch(() => undefined);
    return inconclusiveVerdict("refuter errored (fail-closed)");
  }
}
