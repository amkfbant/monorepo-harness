import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { runJuryCodex } from "./run-codex.js";
import {
  JURY_LENSES,
  type JuryClassificationProposal,
  type JuryLens,
  type JuryProposedScope,
  type JuryProposerDeps,
} from "./types.js";
import {
  renderScopeSnapshot,
  type HitchScopeSnapshot,
} from "./scope-snapshot.js";

/**
 * #230 Task C2 — Stage3 mutual critique round (`runCritiqueRound`). Layer 2
 * (LLM stage, DB-closed).
 *
 * Each lens sees the OTHER lenses' round-1 proposals + their verified evidence
 * and critiques them (design §2 Stage3 + 付録P Stage3 contract). The output is
 * one round=2 proposal per lens carrying the (possibly revised) scope, a
 * `voteChanged` flag, and the recorded `critique`.
 *
 * ★ Convergence after critique does NOT auto-confirm. Stage3 only PRODUCES the
 * round=2 proposals; the deterministic gate (Stage5 / `aggregateDeliberation`)
 * is the sole arbiter of auto_confirm vs escalate. This module performs NO DB
 * IO (Stage3 is DB-closed — `JuryProposerDeps` carries no DB handle).
 *
 * Anti-ritualization (design §0.1 R9 / 付録P): the critique must raise at least
 * one CONCRETE objection per OTHER proposal. Empty objections, boilerplate
 * objections (e.g. "問題なし"), or fewer than one-per-other-proposal are
 * REJECTED — the lens proposal becomes round=2 `inconclusive` (fail-closed).
 *
 * Fail-closed status mapping (design §2 / 付録P / plan PR5):
 * - codex timeout / non-zero exit / unparseable / strict violation -> round=2
 *   `inconclusive`
 * - critique rejected by the anti-ritualization gate                -> round=2
 *   `inconclusive`
 * - otherwise                                                        -> round=2
 *   `complete` (with revised scope / voteChanged / critique recorded)
 */

/** Finding metadata the critique prompt needs (id + optional context). */
export interface JuryCritiqueFinding {
  findingId: string;
  summary?: string;
  detail?: string;
  filePath?: string;
  category?: string;
}

/** The 付録P Stage3 objection type union (kind of flaw raised). */
const OBJECTION_TYPES = [
  "事実誤認",
  "推論飛躍",
  "代替仮説",
  "最悪ケース",
  "評価軸欠落",
] as const;

/**
 * STRICT zod schema for the 付録P Stage3 critique contract. `.strict()` rejects
 * unknown keys (an injected extra key fails the parse -> inconclusive). Note:
 * structural validity here does NOT imply the critique passes the
 * anti-ritualization gate — that check is applied separately on the parsed
 * objections.
 */
const ObjectionSchema = z
  .object({
    targetLens: z.enum(["correctness", "scope_fit", "spec_adherence"]),
    type: z.enum(OBJECTION_TYPES),
    objection: z.string(),
  })
  .strict();

const CitationRelevanceSchema = z
  .object({
    citation: z.string(),
    relevance: z.string(),
  })
  .strict();

const CritiqueSchema = z
  .object({
    objections: z.array(ObjectionSchema),
    citationRelevance: z.array(CitationRelevanceSchema),
    revisedScope: z.enum(["in_scope", "out_of_scope", "unknown"]),
    // Parsed for contract compatibility (the model still emits it, and `.strict()`
    // would reject the key otherwise) but NEVER trusted: the emitted round-2
    // `voteChanged` is DERIVED deterministically from `revisedScope` vs the
    // round-1 scope (FIX 2, codex#254 P1) — this field's value is discarded.
    voteChanged: z.boolean(),
  })
  .strict();

type ParsedCritique = z.infer<typeof CritiqueSchema>;

/**
 * Known boilerplate / ritual objection phrases. An objection whose trimmed text
 * matches one of these (case-insensitive) is non-concrete and does NOT count.
 */
const BOILERPLATE_OBJECTIONS: ReadonlySet<string> = new Set([
  "問題なし",
  "なし",
  "特になし",
  "問題ありません",
  "no objection",
  "none",
  "n/a",
  "lgtm",
  "ok",
]);

/**
 * Minimum length (after trim) for an objection to be considered CONCRETE.
 * Below this, a short fragment cannot describe a specific flaw. Pinned so the
 * anti-ritualization gate is deterministic (design §0.1 R9).
 */
const MIN_CONCRETE_OBJECTION_LEN = 12;

/** Whether one objection is a CONCRETE (non-boilerplate, specific) objection. */
function isConcreteObjection(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_CONCRETE_OBJECTION_LEN) return false;
  return !BOILERPLATE_OBJECTIONS.has(t.toLowerCase());
}

/**
 * Anti-ritualization gate (design §0.1 R9 / 付録P Stage3 frozen contract). The
 * critique is ACCEPTED only when EACH OTHER proposal receives at least one
 * CONCRETE objection whose `targetLens` is that proposal's lens. A total count
 * of concrete objections is NOT enough: 2 objections both aimed at one other
 * lens (leaving another uncovered), or objections aimed at the critiquing lens
 * itself, are REJECTED. Empty / boilerplate-only objections are REJECTED too
 * (fail-closed). This structurally prevents the ritualization the frozen output
 * contract was designed to block ("他者提案ごとに ≥1 具体 objection").
 */
function critiqueIsSubstantive(
  parsed: ParsedCritique,
  otherLenses: readonly JuryLens[],
): boolean {
  if (otherLenses.length === 0) return false;
  const coveredLenses = new Set<JuryLens>(
    parsed.objections
      .filter((o) => isConcreteObjection(o.objection))
      .map((o) => o.targetLens),
  );
  // Every OTHER proposal must have at least one concrete objection targeting it.
  // (Self-targeting objections are inherently excluded: the critiquing lens is
  // never in `otherLenses`, so they can never cover an other proposal.)
  return otherLenses.every((lens) => coveredLenses.has(lens));
}

/**
 * Build one lens's Stage3 critique prompt. The lens sees the OTHER lenses'
 * round-1 proposals (scope + reasoning + their verified evidence) and is asked
 * to critique each. The lens/stage tokens let the model (and the test routing
 * runner) answer per-lens.
 */
function buildCritiquePrompt(
  lens: JuryLens,
  finding: JuryCritiqueFinding,
  others: JuryClassificationProposal[],
  scopeSnapshot: HitchScopeSnapshot,
): string {
  const otherBlocks = others.map((p) => {
    const ev = p.evidence
      .map(
        (e) =>
          `    - [${e.kind}] ${e.citation} (verified=${e.verified}): ${e.claim}`,
      )
      .join("\n");
    return [
      `  lens: ${p.lens}`,
      `    proposedScope: ${p.proposedScope}`,
      p.reasoning !== undefined ? `    reasoning: ${p.reasoning}` : "",
      ev !== "" ? `    evidence:\n${ev}` : "    evidence: (none)",
    ]
      .filter((line) => line !== "")
      .join("\n");
  });
  return [
    "You are ONE lens of an automated deliberation jury. The independent",
    "round-1 proposals are in. Critique the OTHER lenses' proposals and",
    "re-evaluate your own scope vote. You must raise at least one CONCRETE",
    "objection for EACH other proposal — boilerplate (e.g. 問題なし) is rejected.",
    "",
    `[[stage:critique]] [[lens:${lens}]]`,
    `Your lens: ${lens}`,
    "",
    // FIX 1 (codex#254 P1): re-evaluate the scope vote AGAINST the frozen scope.
    renderScopeSnapshot(scopeSnapshot),
    "",
    "Finding under review:",
    `- id: ${finding.findingId}`,
    finding.summary !== undefined ? `- summary: ${finding.summary}` : "",
    finding.filePath !== undefined ? `- filePath: ${finding.filePath}` : "",
    finding.category !== undefined ? `- category: ${finding.category}` : "",
    "",
    "OTHER lenses' round-1 proposals to critique:",
    ...otherBlocks,
    "",
    "Output ONLY a single JSON object (no prose, no fences required) of shape:",
    "{",
    '  "objections": [{ "targetLens": "correctness"|"scope_fit"|"spec_adherence",',
    '                   "type": "事実誤認"|"推論飛躍"|"代替仮説"|"最悪ケース"|"評価軸欠落",',
    '                   "objection": "<a concrete, specific objection>" }]',
    `                 (at least one CONCRETE objection per other proposal),`,
    '  "citationRelevance": [{ "citation": "<cite>", "relevance": "<how it supports/refutes the finding>" }],',
    '  "revisedScope": "in_scope" | "out_of_scope" | "unknown",',
    '  "voteChanged": true | false',
    "}",
    "Do NOT state a verdict — the harness aggregates deterministically. Empty or",
    "boilerplate objections cause your proposal to be discarded (fail-closed).",
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

/** Parse codex stdout into a validated critique object, or undefined on failure. */
function parseCritique(rawOutput: string): ParsedCritique | undefined {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonBlock(rawOutput));
  } catch {
    return undefined;
  }
  const result = CritiqueSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/**
 * Build a round=2 `inconclusive` proposal from the lens's round-1 proposal,
 * keeping its verified evidence (for audit/packet) but forcing the scope to
 * `unknown` and recording an optional critique note. Used for every fail-closed
 * path (timeout / parse / exit / rejected-critique).
 */
function inconclusiveRound2(
  r1: JuryClassificationProposal,
  critique?: string,
): JuryClassificationProposal {
  return {
    findingId: r1.findingId,
    lens: r1.lens,
    proposedScope: "unknown" satisfies JuryProposedScope,
    proposalStatus: "inconclusive",
    evidence: r1.evidence,
    ...(r1.refutationCondition !== undefined
      ? { refutationCondition: r1.refutationCondition }
      : {}),
    ...(r1.uncertainty !== undefined ? { uncertainty: r1.uncertainty } : {}),
    ...(r1.reasoning !== undefined ? { reasoning: r1.reasoning } : {}),
    ...(r1.proposedSeverity !== undefined
      ? { proposedSeverity: r1.proposedSeverity }
      : {}),
    round: 2,
    voteChanged: false,
    ...(critique !== undefined ? { critique } : {}),
  };
}

/** Serialize the accepted critique into a single recorded string (audit). */
function serializeCritique(parsed: ParsedCritique): string {
  return parsed.objections
    .map((o) => `[${o.type} -> ${o.targetLens}] ${o.objection.trim()}`)
    .join("; ");
}

/** Run one lens's Stage3 critique (sees the other lenses' R1), fail-closed. */
async function critiqueForLens(
  deps: JuryProposerDeps,
  finding: JuryCritiqueFinding,
  lens: JuryLens,
  r1Proposals: readonly JuryClassificationProposal[],
): Promise<JuryClassificationProposal> {
  const r1 = r1Proposals.find((p) => p.lens === lens);
  if (r1 === undefined) {
    // No round-1 proposal for this lens: there is nothing to carry into round 2.
    // Synthesize a minimal inconclusive round-2 proposal (fail-closed).
    return {
      findingId: finding.findingId,
      lens,
      proposedScope: "unknown",
      proposalStatus: "inconclusive",
      evidence: [],
      round: 2,
      voteChanged: false,
    };
  }
  const others = r1Proposals.filter((p) => p.lens !== lens);

  const prompt = buildCritiquePrompt(lens, finding, others, deps.scopeSnapshot);
  const paths = deps.logPaths(finding.findingId, lens, "critique");
  // P2 (codex): TRUNCATE the deterministic stdout/stderr/events paths before the
  // run so a codex that exits 0 WITHOUT writing stdout cannot leave a STALE prior
  // critique for readFile to reparse (fail-closed -> empty file => inconclusive).
  for (const p of [paths.stdout, paths.stderr, paths.events]) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, "", "utf8");
  }
  const result = await runJuryCodex(deps, {
    worktreePath: deps.worktreePath,
    prompt,
    logPaths: { stdout: paths.stdout, stderr: paths.stderr, events: paths.events },
  });

  if (result.timedOut || result.exitCode !== 0) {
    return inconclusiveRound2(r1);
  }

  const rawOutput = await readFile(paths.stdout, "utf8").catch(() => "");
  const parsed = parseCritique(rawOutput);
  if (parsed === undefined) {
    return inconclusiveRound2(r1);
  }

  // Anti-ritualization (R9): require >=1 concrete objection PER OTHER proposal
  // (targeted by lens), not merely a total count.
  if (!critiqueIsSubstantive(parsed, others.map((p) => p.lens))) {
    return inconclusiveRound2(r1);
  }

  const critique = serializeCritique(parsed);
  // FIX 2 (codex#254 P1) — DERIVE voteChanged deterministically, NEVER trust the
  // model's self-reported `parsed.voteChanged`. Stage4 reads voteChanged as the
  // conformity / false-consensus signal: a lens that FLIPS its scope but reports
  // voteChanged:false would HIDE the conformity signal -> refuter uphold ->
  // Stage5 auto_confirm. The vote changed IFF the round-2 revised scope differs
  // from the round-1 scope (SAFETY: derive deterministically; the LLM's flag is
  // ignored entirely).
  const voteChanged = parsed.revisedScope !== r1.proposedScope;
  return {
    findingId: r1.findingId,
    lens,
    // revisedScope may change the vote; the gate (Stage5) is still the arbiter.
    proposedScope: parsed.revisedScope,
    proposalStatus: "complete",
    evidence: r1.evidence,
    ...(r1.refutationCondition !== undefined
      ? { refutationCondition: r1.refutationCondition }
      : {}),
    ...(r1.uncertainty !== undefined ? { uncertainty: r1.uncertainty } : {}),
    ...(r1.reasoning !== undefined ? { reasoning: r1.reasoning } : {}),
    ...(r1.proposedSeverity !== undefined
      ? { proposedSeverity: r1.proposedSeverity }
      : {}),
    round: 2,
    voteChanged,
    critique,
  };
}

/**
 * Stage3: run the conditional mutual critique round. Each lens critiques the
 * OTHER lenses' round-1 proposals and re-votes, yielding one round=2 proposal
 * per lens (fixed lens order). Performs no DB IO. Fail-closed: any per-lens
 * failure (timeout / parse / exit / rejected critique) becomes a round=2
 * `inconclusive` proposal, never an exception that would abort the batch.
 *
 * ★ This produces round=2 proposals ONLY. Whether the post-critique set is
 * unanimous is irrelevant here — `aggregateDeliberation` (Stage5) is the sole
 * arbiter and never auto-confirms on critique convergence alone.
 */
export async function runCritiqueRound(
  deps: JuryProposerDeps,
  finding: JuryCritiqueFinding,
  r1Proposals: readonly JuryClassificationProposal[],
): Promise<JuryClassificationProposal[]> {
  const out: JuryClassificationProposal[] = [];
  for (const lens of JURY_LENSES) {
    const r1 = r1Proposals.find((p) => p.lens === lens);
    try {
      out.push(await critiqueForLens(deps, finding, lens, r1Proposals));
    } catch (e) {
      // Fail-closed: an unexpected IO/runner error degrades to a round=2
      // inconclusive proposal (the gate then escalates), never a thrown
      // rejection that would abort the whole critique round.
      await writeFile(
        deps.logPaths(finding.findingId, lens, "critique").stderr,
        `jury critique error (${lens}): ${(e as Error).message}\n`,
        "utf8",
      ).catch(() => undefined);
      out.push(
        r1 !== undefined
          ? inconclusiveRound2(r1)
          : {
              findingId: finding.findingId,
              lens,
              proposedScope: "unknown",
              proposalStatus: "inconclusive",
              evidence: [],
              round: 2,
              voteChanged: false,
            },
      );
    }
  }
  return out;
}
