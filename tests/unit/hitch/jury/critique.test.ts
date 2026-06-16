import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCritiqueRound } from "../../../../src/hitch/jury/critique.js";
import type {
  JuryClassificationProposal,
  JuryLens,
  JuryProposerDeps,
  JuryStage,
  EvidenceCheckContext,
  VerifiedJuryEvidence,
} from "../../../../src/hitch/jury/types.js";
import { JURY_LENSES } from "../../../../src/hitch/jury/types.js";
import type { HitchScopeSnapshot } from "../../../../src/hitch/jury/scope-snapshot.js";
import {
  routingRunner,
  routingKey,
  type RoutingMap,
} from "./_fake-jury-runner.js";
import type { CodexExecRunner } from "../../../../src/codex/codex-exec-runner.js";
import type { GlobalPolicy, RepoPolicy } from "../../../../src/policy/schema.js";

/**
 * #230 Task C2 — runCritiqueRound (Stage3: conditional mutual critique).
 * RED-first contract (design §2 Stage3 + §0.1 R9 + 付録P Stage3 critique
 * contract + plan PR5/PR4).
 *
 * ★ Convergence after critique does NOT auto-confirm — Stage3 only produces
 * round=2 proposals; the gate (Stage5) is the sole arbiter.
 */

let worktreePath: string;
let auditDir: string;

const GLOBAL: GlobalPolicy = { always_deny_write: [], ignore_untracked: [] };
const REPO: RepoPolicy = {
  repo_id: "fixture-repo",
  read: [],
  domains: {
    "src/core": { read: ["src/core/**"], write: ["src/core/**"], deny_write: [] },
  },
};

const evidenceCtx = (): EvidenceCheckContext => ({
  worktreePath,
  compiledPolicy: { global: GLOBAL, repo: REPO },
});

function logPaths() {
  return (findingId: string, lens: JuryLens, stage: JuryStage) => ({
    stdout: join(auditDir, "critique", `${findingId}.${lens}.${stage}.out.log`),
    stderr: join(auditDir, "critique", `${findingId}.${lens}.${stage}.err.log`),
    events: join(auditDir, "critique", `${findingId}.${lens}.${stage}.events.jsonl`),
  });
}

const SCOPE_SNAPSHOT: HitchScopeSnapshot = {
  goal: "refactor the widget renderer — SCOPE_GOAL_SENTINEL",
  domain: "src/core",
  targetOperations: ["TARGET_OP_SENTINEL_refactor_render"],
  excludedCategories: ["EXCLUDED_CAT_SENTINEL_persistence"],
  closeConditions: ["cc-1 (command, required) — CLOSE_COND_SENTINEL tests pass"],
};

function deps(runner: CodexExecRunner): JuryProposerDeps {
  return {
    reviewerRunner: runner,
    harnessRoot: worktreePath,
    worktreePath,
    logPaths: logPaths(),
    timeoutMs: 60_000,
    parseSchema: undefined,
    auditDir,
    evidenceCtx: evidenceCtx(),
    scopeSnapshot: SCOPE_SNAPSHOT,
  };
}

/** A verified file-kind evidence pointing at the fixture file. */
const verifiedEvidence = (
  citation = "src/core/widget.ts:1",
): VerifiedJuryEvidence => ({
  citation,
  kind: "file",
  claim: "the widget lives here",
  verified: true,
});

/** A round-1 complete proposal for a lens. */
function r1(
  lens: JuryLens,
  scope: "in_scope" | "out_of_scope" | "unknown",
  evidence: VerifiedJuryEvidence[] = [verifiedEvidence()],
): JuryClassificationProposal {
  return {
    findingId: "finding-1",
    lens,
    proposedScope: scope,
    proposalStatus: "complete",
    evidence,
    refutationCondition: "if the file did not exist this would be wrong",
    reasoning: "the diff touches this file directly",
    round: 1,
  };
}

const OBJECTION_TYPES = ["事実誤認", "推論飛躍", "代替仮説"] as const;

/** The OTHER lenses for a critiquing lens, in fixed JURY_LENSES order. */
function otherLensesOf(lens: JuryLens): JuryLens[] {
  return JURY_LENSES.filter((l) => l !== lens);
}

/**
 * A well-formed, LENS-AWARE Stage3 critique JSON: one concrete objection per
 * OTHER lens of the given critiquing lens. This produces GENUINE per-target
 * coverage (anti-ritualization design §0.1 R9 / 付録P) rather than always
 * targeting the same two lenses regardless of the critiquing lens.
 */
function critiqueJsonForLens(
  lens: JuryLens,
  opts: {
    revisedScope: "in_scope" | "out_of_scope" | "unknown";
    voteChanged: boolean;
  },
): string {
  const objections = otherLensesOf(lens).map((target, i) => ({
    targetLens: target,
    type: OBJECTION_TYPES[i % OBJECTION_TYPES.length],
    objection: `concrete objection on ${target}: the cited file does not support that claim`,
  }));
  return JSON.stringify({
    objections,
    citationRelevance: [
      { citation: "src/core/widget.ts:1", relevance: "directly supports the finding" },
    ],
    revisedScope: opts.revisedScope,
    voteChanged: opts.voteChanged,
  });
}

/** Build a lens-aware routing map (one genuine per-target critique per lens). */
function lensAwareCritiqueMap(opts: {
  revisedScope: "in_scope" | "out_of_scope" | "unknown";
  voteChanged: boolean;
}): RoutingMap {
  const map: RoutingMap = {};
  for (const lens of JURY_LENSES) {
    map[routingKey("critique", lens)] = {
      stdout: critiqueJsonForLens(lens, opts),
    };
  }
  return map;
}

/**
 * A non-lens-aware Stage3 critique JSON. By default targets the same two lenses
 * (scope_fit, spec_adherence) regardless of the critiquing lens — used for the
 * NEGATIVE (ritualization) controls and the fail-closed paths where the routed
 * stdout content is irrelevant (timeout/exit/parse).
 */
function critiqueJson(opts: {
  revisedScope: "in_scope" | "out_of_scope" | "unknown";
  voteChanged: boolean;
  objectionCount?: number;
}): string {
  const count = opts.objectionCount ?? 2; // 2 other proposals by default
  const objections = Array.from({ length: count }, (_, i) => ({
    targetLens: i === 0 ? "scope_fit" : "spec_adherence",
    type: i === 0 ? "事実誤認" : "推論飛躍",
    objection: `concrete objection #${i + 1}: the cited file does not support that claim`,
  }));
  return JSON.stringify({
    objections,
    citationRelevance: [
      { citation: "src/core/widget.ts:1", relevance: "directly supports the finding" },
    ],
    revisedScope: opts.revisedScope,
    voteChanged: opts.voteChanged,
  });
}

beforeAll(() => {
  worktreePath = mkdtempSync(join(tmpdir(), "harness-jury-critique-"));
  mkdirSync(join(worktreePath, "src", "core"), { recursive: true });
  writeFileSync(
    join(worktreePath, "src", "core", "widget.ts"),
    ["export const widget = 1;", "export const other = 2;"].join("\n"),
  );
  auditDir = mkdtempSync(join(tmpdir(), "harness-jury-critique-audit-"));
});

afterAll(() => {
  rmSync(worktreePath, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

const FINDING = { findingId: "finding-1", filePath: "src/core/widget.ts", category: "core" };

describe("runCritiqueRound — produces round=2 proposals", () => {
  it("returns one round=2 proposal per lens, never auto-confirming", async () => {
    const map = lensAwareCritiqueMap({ revisedScope: "in_scope", voteChanged: false });
    const r1set = [
      r1("correctness", "in_scope"),
      r1("scope_fit", "in_scope"),
      r1("spec_adherence", "in_scope"),
    ];
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set);
    expect(out).toHaveLength(3);
    for (const p of out) {
      expect(p.round).toBe(2);
      expect(p.findingId).toBe("finding-1");
    }
    expect(new Set(out.map((p) => p.lens))).toEqual(
      new Set(["correctness", "scope_fit", "spec_adherence"]),
    );
  });

  it("a lens can change its vote in R2 (voteChanged + revisedScope recorded)", async () => {
    // Lens-aware (genuine per-target coverage) so the anti-ritualization gate
    // ACCEPTS each lens; the vote-change behaviour is what this test asserts.
    const map: RoutingMap = {
      [routingKey("critique", "correctness")]: {
        stdout: critiqueJsonForLens("correctness", { revisedScope: "out_of_scope", voteChanged: true }),
      },
      [routingKey("critique", "scope_fit")]: {
        stdout: critiqueJsonForLens("scope_fit", { revisedScope: "in_scope", voteChanged: false }),
      },
      [routingKey("critique", "spec_adherence")]: {
        stdout: critiqueJsonForLens("spec_adherence", { revisedScope: "in_scope", voteChanged: false }),
      },
    };
    const r1set = [
      r1("correctness", "in_scope"),
      r1("scope_fit", "in_scope"),
      r1("spec_adherence", "in_scope"),
    ];
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set);
    const byLens = new Map(out.map((p) => [p.lens, p]));
    const corr = byLens.get("correctness");
    expect(corr?.round).toBe(2);
    expect(corr?.proposedScope).toBe("out_of_scope");
    expect(corr?.voteChanged).toBe(true);
    expect(corr?.proposalStatus).toBe("complete");
    expect(typeof corr?.critique).toBe("string");
    expect(corr?.critique?.length).toBeGreaterThan(0);
    // a lens that did not change keeps its scope and voteChanged=false
    const sf = byLens.get("scope_fit");
    expect(sf?.proposedScope).toBe("in_scope");
    expect(sf?.voteChanged).toBe(false);
  });

  it("each lens prompt embeds [[stage:critique]] + its own lens token and sees the OTHER lenses' proposals", async () => {
    const promptsSeen = new Map<JuryLens, string>();
    const recording: CodexExecRunner = {
      async run(input) {
        const m = /\[\[lens:(correctness|scope_fit|spec_adherence)\]\]/.exec(input.prompt);
        if (m) promptsSeen.set(m[1] as JuryLens, input.prompt);
        const map: RoutingMap = {};
        for (const lens of JURY_LENSES) {
          map[routingKey("critique", lens)] = {
            stdout: critiqueJson({ revisedScope: "in_scope", voteChanged: false }),
          };
        }
        return routingRunner(map).run(input);
      },
    };
    const r1set = [
      r1("correctness", "in_scope"),
      r1("scope_fit", "out_of_scope"),
      r1("spec_adherence", "in_scope"),
    ];
    await runCritiqueRound(deps(recording), FINDING, r1set);
    const corrPrompt = promptsSeen.get("correctness");
    expect(corrPrompt).toBeDefined();
    expect(corrPrompt).toContain("[[stage:critique]]");
    expect(corrPrompt).toContain("[[lens:correctness]]");
    // critique sees the OTHER lenses' proposals (their scopes appear in the prompt)
    expect(corrPrompt).toContain("scope_fit");
    expect(corrPrompt).toContain("spec_adherence");
    expect(corrPrompt).toContain("out_of_scope");
  });
});

describe("runCritiqueRound — FIX 1 (codex#254 P1): scope in the critique prompt", () => {
  it("every per-lens critique prompt embeds the frozen hitch scope snapshot", async () => {
    const promptsSeen: string[] = [];
    const recording: CodexExecRunner = {
      async run(input) {
        promptsSeen.push(input.prompt);
        const map: RoutingMap = {};
        for (const lens of JURY_LENSES) {
          map[routingKey("critique", lens)] = {
            stdout: critiqueJson({ revisedScope: "in_scope", voteChanged: false }),
          };
        }
        return routingRunner(map).run(input);
      },
    };
    await runCritiqueRound(deps(recording), FINDING, [
      r1("correctness", "in_scope"),
      r1("scope_fit", "in_scope"),
      r1("spec_adherence", "in_scope"),
    ]);
    expect(promptsSeen).toHaveLength(3);
    for (const prompt of promptsSeen) {
      expect(prompt).toContain("SCOPE_GOAL_SENTINEL");
      expect(prompt).toContain("TARGET_OP_SENTINEL_refactor_render");
      expect(prompt).toContain("EXCLUDED_CAT_SENTINEL_persistence");
      expect(prompt).toContain("CLOSE_COND_SENTINEL");
      expect(prompt).toContain("Frozen hitch scope (READ-ONLY)");
    }
  });
});

describe("runCritiqueRound — anti-ritualization (design §0.1 R9 / 付録P)", () => {
  const r1set = () => [
    r1("correctness", "in_scope"),
    r1("scope_fit", "in_scope"),
    r1("spec_adherence", "in_scope"),
  ];

  it("empty objections -> reject -> round=2 inconclusive (fail-closed)", async () => {
    const empty = JSON.stringify({
      objections: [],
      citationRelevance: [],
      revisedScope: "in_scope",
      voteChanged: false,
    });
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = { stdout: empty };
    }
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    expect(out).toHaveLength(3);
    for (const p of out) {
      expect(p.round).toBe(2);
      expect(p.proposalStatus).toBe("inconclusive");
    }
  });

  it("boilerplate objection (問題なし) -> reject -> round=2 inconclusive", async () => {
    const boiler = JSON.stringify({
      objections: [
        { targetLens: "scope_fit", type: "事実誤認", objection: "問題なし" },
        { targetLens: "spec_adherence", type: "推論飛躍", objection: "問題なし" },
      ],
      citationRelevance: [],
      revisedScope: "in_scope",
      voteChanged: false,
    });
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = { stdout: boiler };
    }
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    expect(out).toHaveLength(3);
    for (const p of out) {
      expect(p.proposalStatus).toBe("inconclusive");
    }
  });

  it("a >=12-char BOILERPLATE_OBJECTIONS member is rejected by the SET (not the length gate)", async () => {
    // The existing 問題なし control is 4 chars, so the LENGTH gate rejects it
    // BEFORE the BOILERPLATE_OBJECTIONS set is ever consulted — leaving the
    // set-membership branch dead-untested. "no objection" is exactly 12 chars
    // (== MIN_CONCRETE_OBJECTION_LEN) so it PASSES the length gate and is
    // rejected ONLY by the set. This isolates the set rejection from length.
    const boilerSet = JSON.stringify({
      objections: [
        { targetLens: "scope_fit", type: "事実誤認", objection: "no objection" },
        { targetLens: "spec_adherence", type: "推論飛躍", objection: "No Objection" },
      ],
      citationRelevance: [],
      revisedScope: "in_scope",
      voteChanged: false,
    });
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = { stdout: boilerSet };
    }
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    expect(out).toHaveLength(3);
    for (const p of out) {
      expect(p.round).toBe(2);
      expect(p.proposalStatus).toBe("inconclusive");
    }
  });

  it("fewer than one objection per OTHER proposal -> reject -> inconclusive", async () => {
    // 2 other proposals but only 1 objection supplied.
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = {
        stdout: critiqueJson({ revisedScope: "in_scope", voteChanged: false, objectionCount: 1 }),
      };
    }
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    expect(out).toHaveLength(3);
    for (const p of out) {
      expect(p.proposalStatus).toBe("inconclusive");
    }
  });

  it("exactly one CONCRETE objection per OTHER proposal -> accepted (complete)", async () => {
    // GENUINE per-target coverage: each critiquing lens objects to each of ITS
    // OTHER lenses (not a fixed pair). This is the load-bearing positive control
    // for the anti-ritualization gate (design §0.1 R9 / 付録P).
    const map = lensAwareCritiqueMap({ revisedScope: "in_scope", voteChanged: false });
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    expect(out).toHaveLength(3);
    for (const p of out) {
      expect(p.proposalStatus).toBe("complete");
      expect(p.round).toBe(2);
    }
  });

  it("N concrete objections all on ONE other lens, another other lens uncovered -> inconclusive", async () => {
    // For correctness, the other lenses are {scope_fit, spec_adherence}. Supply
    // 2 concrete objections BOTH targeting scope_fit and ZERO for spec_adherence.
    // The total count (2) meets the old shortfall gate but spec_adherence is
    // uncovered -> per-proposal coverage fails -> inconclusive (付録P / R9).
    const uneven = JSON.stringify({
      objections: [
        {
          targetLens: "scope_fit",
          type: "事実誤認",
          objection: "concrete objection #1 on scope_fit: the cited file does not support that claim",
        },
        {
          targetLens: "scope_fit",
          type: "推論飛躍",
          objection: "concrete objection #2 on scope_fit: the inference overreaches the evidence",
        },
      ],
      citationRelevance: [
        { citation: "src/core/widget.ts:1", relevance: "directly supports the finding" },
      ],
      revisedScope: "in_scope",
      voteChanged: false,
    });
    const map: RoutingMap = {
      [routingKey("critique", "correctness")]: { stdout: uneven },
      // route the other two lenses through genuine per-target critiques so that
      // ONLY the correctness lens exercises the uncovered-target defect.
      [routingKey("critique", "scope_fit")]: {
        stdout: critiqueJsonForLens("scope_fit", { revisedScope: "in_scope", voteChanged: false }),
      },
      [routingKey("critique", "spec_adherence")]: {
        stdout: critiqueJsonForLens("spec_adherence", { revisedScope: "in_scope", voteChanged: false }),
      },
    };
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    const corr = out.find((p) => p.lens === "correctness");
    expect(corr?.round).toBe(2);
    expect(corr?.proposalStatus).toBe("inconclusive");
  });

  it("objections targeting the SELF/critiquing lens (not other proposals) -> inconclusive", async () => {
    // correctness critiquing correctness: 2 concrete objections, both targetLens
    // === the critiquing lens itself. The total count meets the old gate but NO
    // other proposal is examined -> per-proposal coverage fails -> inconclusive.
    const selfTargeting = JSON.stringify({
      objections: [
        {
          targetLens: "correctness",
          type: "事実誤認",
          objection: "concrete self objection #1: my own reasoning may overreach the evidence",
        },
        {
          targetLens: "correctness",
          type: "推論飛躍",
          objection: "concrete self objection #2: my own inference is not fully grounded",
        },
      ],
      citationRelevance: [
        { citation: "src/core/widget.ts:1", relevance: "directly supports the finding" },
      ],
      revisedScope: "in_scope",
      voteChanged: false,
    });
    const map: RoutingMap = {
      [routingKey("critique", "correctness")]: { stdout: selfTargeting },
      [routingKey("critique", "scope_fit")]: {
        stdout: critiqueJsonForLens("scope_fit", { revisedScope: "in_scope", voteChanged: false }),
      },
      [routingKey("critique", "spec_adherence")]: {
        stdout: critiqueJsonForLens("spec_adherence", { revisedScope: "in_scope", voteChanged: false }),
      },
    };
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    const corr = out.find((p) => p.lens === "correctness");
    expect(corr?.round).toBe(2);
    expect(corr?.proposalStatus).toBe("inconclusive");
  });
});

describe("runCritiqueRound — FIX 2 (codex#254 P1): voteChanged is DERIVED, not trusted", () => {
  const r1set = () => [
    r1("correctness", "in_scope"),
    r1("scope_fit", "in_scope"),
    r1("spec_adherence", "in_scope"),
  ];

  it("model reports voteChanged:false but revisedScope DIFFERS from r1 -> derived voteChanged===true", async () => {
    // SAFETY (CLAUDE.md): never trust an LLM self-report that feeds a state
    // transition. Stage4 reads voteChanged as the conformity / false-consensus
    // signal; a lens that FLIPS its scope (in_scope -> out_of_scope) yet reports
    // voteChanged:false would HIDE that flip from the refuter. The harness must
    // recompute voteChanged from revisedScope vs the round-1 scope, IGNORING the
    // model's flag.
    const lyingMap: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      // genuine per-target objections (so the critique is ACCEPTED) but the
      // revisedScope flips out_of_scope while the model dishonestly says
      // voteChanged:false.
      lyingMap[routingKey("critique", lens)] = {
        stdout: critiqueJsonForLens(lens, {
          revisedScope: "out_of_scope",
          voteChanged: false,
        }),
      };
    }
    const out = await runCritiqueRound(
      deps(routingRunner(lyingMap)),
      FINDING,
      r1set(), // every r1 is in_scope
    );
    expect(out).toHaveLength(3);
    for (const p of out) {
      expect(p.proposalStatus).toBe("complete");
      expect(p.proposedScope).toBe("out_of_scope");
      // DERIVED: out_of_scope !== in_scope -> true, regardless of the model's false.
      expect(p.voteChanged).toBe(true);
    }
  });

  it("model reports voteChanged:true but revisedScope UNCHANGED from r1 -> derived voteChanged===false", async () => {
    const lyingMap: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      // revisedScope stays in_scope (== r1) but the model dishonestly claims a flip.
      lyingMap[routingKey("critique", lens)] = {
        stdout: critiqueJsonForLens(lens, {
          revisedScope: "in_scope",
          voteChanged: true,
        }),
      };
    }
    const out = await runCritiqueRound(
      deps(routingRunner(lyingMap)),
      FINDING,
      r1set(), // every r1 is in_scope
    );
    expect(out).toHaveLength(3);
    for (const p of out) {
      expect(p.proposalStatus).toBe("complete");
      expect(p.proposedScope).toBe("in_scope");
      // DERIVED: in_scope === in_scope -> false, regardless of the model's true.
      expect(p.voteChanged).toBe(false);
    }
  });
});

describe("runCritiqueRound — Round6 FIX 3 (codex#254 P2): a vote-flip must NOT carry forward R1 evidence", () => {
  it("a FLIPPED lens (voteChanged===true) carries EMPTY evidence (fail-closed; gate cannot auto_confirm on stale evidence)", async () => {
    // SAFETY (CLAUDE.md fail-closed): the critique round does NOT collect fresh
    // citations. When a lens flips its scope (revisedScope !== r1 scope), the R1
    // evidence was gathered for the OLD position; carrying it forward would let
    // the deterministic gate accept stale evidence and auto_confirm a flipped
    // vote. So a flipped R2 proposal must carry NO gate-supporting evidence (`[]`)
    // -> the gate's allHaveVerifiedEvidence fails for that lens -> escalate.
    const map: RoutingMap = {
      [routingKey("critique", "correctness")]: {
        // FLIP: in_scope -> out_of_scope.
        stdout: critiqueJsonForLens("correctness", {
          revisedScope: "out_of_scope",
          voteChanged: true,
        }),
      },
      [routingKey("critique", "scope_fit")]: {
        // NO flip: stays in_scope.
        stdout: critiqueJsonForLens("scope_fit", {
          revisedScope: "in_scope",
          voteChanged: false,
        }),
      },
      [routingKey("critique", "spec_adherence")]: {
        stdout: critiqueJsonForLens("spec_adherence", {
          revisedScope: "in_scope",
          voteChanged: false,
        }),
      },
    };
    const r1set = [
      r1("correctness", "in_scope"),
      r1("scope_fit", "in_scope"),
      r1("spec_adherence", "in_scope"),
    ];
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set);
    const byLens = new Map(out.map((p) => [p.lens, p]));

    // The flipped lens: complete, vote changed, but EMPTY gate-supporting evidence.
    const flipped = byLens.get("correctness");
    expect(flipped?.proposalStatus).toBe("complete");
    expect(flipped?.proposedScope).toBe("out_of_scope");
    expect(flipped?.voteChanged).toBe(true);
    expect(flipped?.evidence).toEqual([]);

    // The non-flipped lenses keep their carried-forward verified R1 evidence.
    const same = byLens.get("scope_fit");
    expect(same?.voteChanged).toBe(false);
    expect(same?.evidence.length).toBeGreaterThan(0);
    expect(same?.evidence.every((e) => e.verified === true)).toBe(true);
  });
});

describe("runCritiqueRound — fenced ```json parse path (P3 coverage)", () => {
  const r1set = () => [
    r1("correctness", "in_scope"),
    r1("scope_fit", "in_scope"),
    r1("spec_adherence", "in_scope"),
  ];

  it("parses a critique object wrapped in a ```json fence (revised round-2 proposal)", async () => {
    // The real codex frequently wraps its JSON in a ```json … ``` fence; the
    // extractJsonBlock fenced branch (vs. the bare balanced-brace fallback) is
    // otherwise never exercised. Trailing prose containing a stray brace makes
    // the balanced-brace FALLBACK (first `{` … last `}`) capture an invalid
    // span — so a clean parse PROVES the fenced branch ran, not the fallback.
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      const body = critiqueJsonForLens(lens, {
        revisedScope: "out_of_scope",
        voteChanged: true,
      });
      map[routingKey("critique", lens)] = {
        stdout:
          "```json\n" +
          body +
          "\n```\n\nNote: the trailing prose {has a stray brace} after the fence.",
      };
    }
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    expect(out).toHaveLength(3);
    for (const p of out) {
      expect(p.round).toBe(2);
      expect(p.proposalStatus).toBe("complete");
      expect(p.proposedScope).toBe("out_of_scope");
      expect(p.voteChanged).toBe(true);
      expect(typeof p.critique).toBe("string");
      expect(p.critique?.length).toBeGreaterThan(0);
    }
  });
});

describe("runCritiqueRound — fail-closed (timeout/parse/exit)", () => {
  const r1set = () => [
    r1("correctness", "in_scope"),
    r1("scope_fit", "in_scope"),
    r1("spec_adherence", "in_scope"),
  ];

  it("codex timeout -> round=2 inconclusive", async () => {
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = {
        stdout: critiqueJson({ revisedScope: "in_scope", voteChanged: false }),
        timedOut: true,
      };
    }
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    for (const p of out) {
      expect(p.round).toBe(2);
      expect(p.proposalStatus).toBe("inconclusive");
    }
  });

  it("non-zero exit -> round=2 inconclusive", async () => {
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = {
        stdout: critiqueJson({ revisedScope: "in_scope", voteChanged: false }),
        exitCode: 9,
      };
    }
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    for (const p of out) {
      expect(p.proposalStatus).toBe("inconclusive");
    }
  });

  it("parse garbage -> round=2 inconclusive", async () => {
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = { stdout: "not json at all {" };
    }
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    for (const p of out) {
      expect(p.proposalStatus).toBe("inconclusive");
    }
  });

  it("strict schema rejects unknown keys -> inconclusive", async () => {
    const bad = JSON.stringify({
      objections: [
        { targetLens: "scope_fit", type: "事実誤認", objection: "a concrete and specific objection here" },
        { targetLens: "spec_adherence", type: "推論飛躍", objection: "another concrete specific objection" },
      ],
      citationRelevance: [],
      revisedScope: "in_scope",
      voteChanged: false,
      unexpectedExtraKey: "should be rejected",
    });
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = { stdout: bad };
    }
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    for (const p of out) {
      expect(p.proposalStatus).toBe("inconclusive");
    }
  });
});

describe("runCritiqueRound — FIX 2 (codex P2): stale stdout truncation", () => {
  it("a runner that exits 0 WITHOUT writing stdout does NOT reparse a stale prior critique", async () => {
    // Pre-seed every lens's deterministic critique stdout path with a STALE
    // VALID critique JSON (as if a prior retry wrote a `complete` round-2
    // critique), then run a runner that exits 0 but never overwrites stdout.
    // Without pre-run truncation, readFile would parse the stale critique ->
    // complete; with truncation the empty file -> inconclusive (fail-closed).
    const lp = logPaths();
    for (const lens of JURY_LENSES) {
      const p = lp(FINDING.findingId, lens, "critique");
      mkdirSync(join(p.stdout, ".."), { recursive: true });
      writeFileSync(
        p.stdout,
        critiqueJsonForLens(lens, { revisedScope: "in_scope", voteChanged: false }),
        "utf8",
      );
    }
    const noWriteRunner: CodexExecRunner = {
      async run() {
        return { exitCode: 0, timedOut: false, aborted: false, durationMs: 0 };
      },
    };
    const out = await runCritiqueRound(deps(noWriteRunner), FINDING, [
      r1("correctness", "in_scope"),
      r1("scope_fit", "in_scope"),
      r1("spec_adherence", "out_of_scope"),
    ]);
    for (const p of out) {
      expect(p.round).toBe(2);
      // NOT the stale `complete` critique — the empty stdout fails to parse.
      expect(p.proposalStatus).toBe("inconclusive");
    }
  });
});

describe("runCritiqueRound — DB-closed (Stage3)", () => {
  it("creates no sqlite DB file anywhere under the worktree or audit dir", async () => {
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = {
        stdout: critiqueJson({ revisedScope: "in_scope", voteChanged: false }),
      };
    }
    await runCritiqueRound(deps(routingRunner(map)), FINDING, [
      r1("correctness", "in_scope"),
      r1("scope_fit", "in_scope"),
      r1("spec_adherence", "in_scope"),
    ]);
    const sqliteUnder = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
        /\.sqlite/.test(f),
      );
    expect(sqliteUnder(worktreePath)).toEqual([]);
    expect(sqliteUnder(auditDir)).toEqual([]);
  });
});
