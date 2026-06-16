import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliberate, type DeliberateFinding } from "../../../../src/hitch/jury/deliberate.js";
import { computeDeliberationId } from "../../../../src/hitch/jury/ids.js";
import type {
  JuryLens,
  JuryProposerDeps,
  JuryStage,
  EvidenceCheckContext,
} from "../../../../src/hitch/jury/types.js";
import { JURY_LENSES } from "../../../../src/hitch/jury/types.js";
import {
  routingRunner,
  routingKey,
  refuteResponse,
  type RoutingMap,
} from "./_fake-jury-runner.js";
import type { CodexExecRunner } from "../../../../src/codex/codex-exec-runner.js";
import type { GlobalPolicy, RepoPolicy } from "../../../../src/policy/schema.js";

/**
 * #230 Task C4 — deliberate (Stage1-5 orchestration, in-memory) +
 * computeDeliberationId. RED-first contract (design §2 full pipeline + §0.1
 * R1/R8 + P2-j + plan Task C4/PR3).
 *
 * The pipeline is driven entirely in memory (DB stays closed); the routing fake
 * runner discriminates the 3 lenses x 3 stages via [[lens:...]]/[[stage:...]]
 * tokens so a single test can compose a full propose -> critique -> refute flow.
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
    stdout: join(auditDir, stage, `${findingId}.${lens}.${stage}.out.log`),
    stderr: join(auditDir, stage, `${findingId}.${lens}.${stage}.err.log`),
    events: join(auditDir, stage, `${findingId}.${lens}.${stage}.events.jsonl`),
  });
}

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
    scopeSnapshot: { goal: "deliberate test scope" },
  };
}

const FINDING: DeliberateFinding = {
  findingId: "finding-1",
  summary: "ambiguous scope finding",
  filePath: "src/core/widget.ts",
  category: "core",
  harnessSeverity: "P2",
};

const HITCH_ID = "hitch-1";

/** A well-formed Stage1 propose JSON citing the fixture file (verifiable). */
function proposeJson(
  scope: "in_scope" | "out_of_scope" | "unknown",
  opts: { citation?: string; severity?: string } = {},
): string {
  return JSON.stringify({
    proposedScope: scope,
    evidence: [
      {
        citation: opts.citation ?? "src/core/widget.ts:1",
        kind: "file",
        claim: "the widget lives here",
      },
    ],
    refutationCondition: "if the file did not exist this would be wrong",
    uncertainty: "low",
    reasoning: "the diff touches this file directly",
    proposedSeverity: opts.severity ?? "P2",
  });
}

const CRITIQUE_OBJECTION_TYPES = ["事実誤認", "推論飛躍", "代替仮説"] as const;

/**
 * A well-formed, LENS-AWARE Stage3 critique JSON: one concrete objection per
 * OTHER lens of the given critiquing lens. This produces GENUINE per-target
 * coverage (anti-ritualization design §0.1 R9 / 付録P) — the gate requires that
 * every other proposal receives at least one concrete objection targeting it,
 * not merely a total count.
 */
function critiqueJson(
  lens: JuryLens,
  opts: {
    revisedScope: "in_scope" | "out_of_scope" | "unknown";
    voteChanged: boolean;
  },
): string {
  const others = JURY_LENSES.filter((l) => l !== lens);
  const objections = others.map((target, i) => ({
    targetLens: target,
    type: CRITIQUE_OBJECTION_TYPES[i % CRITIQUE_OBJECTION_TYPES.length],
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

/**
 * Build a critique-stage routing map where every lens returns a GENUINE
 * per-target critique (one concrete objection per its OTHER lenses) with the
 * given revised vote.
 */
function lensAwareCritiqueMap(opts: {
  revisedScope: "in_scope" | "out_of_scope" | "unknown";
  voteChanged: boolean;
}): RoutingMap {
  const map: RoutingMap = {};
  for (const lens of JURY_LENSES) {
    map[routingKey("critique", lens)] = { stdout: critiqueJson(lens, opts) };
  }
  return map;
}

/** A Stage4 refute JSON. */
function refuteJson(opts: {
  refuteVerdict: "uphold" | "refute" | "inconclusive";
  whyNotFalseConsensus?: string;
  refutationConditions?: string;
}): string {
  const body: Record<string, unknown> = {
    refuteVerdict: opts.refuteVerdict,
    counterEvidence: [],
    reasoning: "the consensus survives an adversarial probe",
  };
  if (opts.whyNotFalseConsensus !== undefined) {
    body.whyNotFalseConsensus = opts.whyNotFalseConsensus;
  }
  if (opts.refutationConditions !== undefined) {
    body.refutationConditions = opts.refutationConditions;
  }
  return JSON.stringify(body);
}

/** Build a propose-stage routing map where every lens returns `json`. */
function unanimousProposeMap(json: string): RoutingMap {
  const map: RoutingMap = {};
  for (const lens of JURY_LENSES) {
    map[routingKey("propose", lens)] = { stdout: json };
  }
  return map;
}

/** A valid uphold verdict map (both R9 justifications supplied). */
const upholdMap = (): RoutingMap =>
  refuteResponse({
    stdout: refuteJson({
      refuteVerdict: "uphold",
      whyNotFalseConsensus: "each lens cited distinct verified evidence",
      refutationConditions: "would flip if any citation were unverifiable",
    }),
  });

beforeAll(() => {
  worktreePath = mkdtempSync(join(tmpdir(), "harness-jury-deliberate-"));
  mkdirSync(join(worktreePath, "src", "core"), { recursive: true });
  writeFileSync(
    join(worktreePath, "src", "core", "widget.ts"),
    ["export const widget = 1;", "export const other = 2;"].join("\n"),
  );
  // a second domain file so an out-of-domain (non-proximate) citation can exist.
  mkdirSync(join(worktreePath, "src", "other"), { recursive: true });
  writeFileSync(
    join(worktreePath, "src", "other", "unrelated.ts"),
    ["export const unrelated = 1;"].join("\n"),
  );
  auditDir = mkdtempSync(join(tmpdir(), "harness-jury-deliberate-audit-"));
});

afterAll(() => {
  rmSync(worktreePath, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

describe("computeDeliberationId — deterministic id", () => {
  it("same (hitchId, findingId, gateInputSha256) -> same id", () => {
    const a = computeDeliberationId("h1", "f1", "deadbeef");
    const b = computeDeliberationId("h1", "f1", "deadbeef");
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("different gate input -> different id", () => {
    const a = computeDeliberationId("h1", "f1", "deadbeef");
    const b = computeDeliberationId("h1", "f1", "cafebabe");
    expect(a).not.toBe(b);
  });

  it("different finding -> different id", () => {
    const a = computeDeliberationId("h1", "f1", "deadbeef");
    const b = computeDeliberationId("h1", "f2", "deadbeef");
    expect(a).not.toBe(b);
  });
});

describe("deliberate — (a) clean unanimous + strong proximate evidence", () => {
  it("skips critique, runs refuter, upholds -> auto_confirm", async () => {
    const map: RoutingMap = {
      ...unanimousProposeMap(proposeJson("in_scope")),
      ...upholdMap(),
    };
    const out = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);

    expect(out.critiqueRan).toBe(false);
    expect(out.refutation).not.toBeNull();
    expect(out.refutation?.verdict.refuteVerdict).toBe("uphold");
    // the refutation carries the unanimous verdict it attacked (target_scope).
    expect(out.refutation?.targetScope).toBe("in_scope");
    expect(out.result.decision).toBe("auto_confirm");
    expect(out.result.scope).toBe("in_scope");
    // only round-1 proposals exist (critique skipped).
    expect(out.proposals.every((p) => p.round === 1)).toBe(true);
    expect(out.proposals).toHaveLength(3);
  });
});

describe("deliberate — FIX 5: critique fires IFF R1 is non-unanimous", () => {
  it("a unanimous R1 with all-verified evidence -> critique SKIPPED (no round-2 proposals)", async () => {
    // shouldRunCritique fires critique IFF the R1 aggregate is non-unanimous.
    // A clean unanimous-and-verified R1 must never trigger critique — and the
    // "unanimous but weak" case cannot arise (a zero-verified lens is
    // inconclusive -> R1 is non-unanimous -> the split branch already fires),
    // so the dead isWeakEvidence trigger is gone with no behavior change.
    const map: RoutingMap = {
      ...unanimousProposeMap(proposeJson("in_scope")),
      ...upholdMap(),
    };
    const out = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    expect(out.critiqueRan).toBe(false);
    expect(out.proposals.every((p) => p.round === 1)).toBe(true);
    expect(out.proposals.some((p) => p.round === 2)).toBe(false);
  });

  it("a non-unanimous (split) R1 -> critique RUNS (round-2 proposals exist)", async () => {
    const map: RoutingMap = {
      [routingKey("propose", "correctness")]: { stdout: proposeJson("in_scope") },
      [routingKey("propose", "scope_fit")]: { stdout: proposeJson("out_of_scope") },
      [routingKey("propose", "spec_adherence")]: { stdout: proposeJson("in_scope") },
      ...lensAwareCritiqueMap({ revisedScope: "in_scope", voteChanged: false }),
      ...upholdMap(),
    };
    const out = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    expect(out.critiqueRan).toBe(true);
    expect(out.proposals.some((p) => p.round === 2)).toBe(true);
  });
});

describe("deliberate — (b) R1 split", () => {
  it("runs critique, still split -> escalate, refuter NOT invoked", async () => {
    let refuteCalls = 0;
    const baseMap: RoutingMap = {
      [routingKey("propose", "correctness")]: { stdout: proposeJson("in_scope") },
      [routingKey("propose", "scope_fit")]: { stdout: proposeJson("out_of_scope") },
      [routingKey("propose", "spec_adherence")]: { stdout: proposeJson("in_scope") },
      // critique keeps the split (each lens re-votes its own R1 scope).
      [routingKey("critique", "correctness")]: {
        stdout: critiqueJson("correctness", { revisedScope: "in_scope", voteChanged: false }),
      },
      [routingKey("critique", "scope_fit")]: {
        stdout: critiqueJson("scope_fit", { revisedScope: "out_of_scope", voteChanged: false }),
      },
      [routingKey("critique", "spec_adherence")]: {
        stdout: critiqueJson("spec_adherence", { revisedScope: "in_scope", voteChanged: false }),
      },
      ...upholdMap(),
    };
    const countingRunner: CodexExecRunner = {
      async run(input) {
        if (input.prompt.includes("[[stage:refute]]")) refuteCalls += 1;
        return routingRunner(baseMap).run(input);
      },
    };
    const out = await deliberate(FINDING, deps(countingRunner), HITCH_ID);

    expect(out.critiqueRan).toBe(true);
    expect(out.result.decision).toBe("escalate");
    expect(out.refutation).toBeNull();
    expect(refuteCalls).toBe(0);
    // both round-1 and round-2 proposals are carried for persistence.
    expect(out.proposals.some((p) => p.round === 1)).toBe(true);
    expect(out.proposals.some((p) => p.round === 2)).toBe(true);
  });
});

describe("deliberate — (c) critique converges to unanimous VIA A VOTE FLIP -> ESCALATE (Round6 FIX 3)", () => {
  it("an R1 split that the critique round converges to unanimous via a vote flip ESCALATES (the flipped lens lacks fresh evidence)", async () => {
    // Round6 FIX 3 (codex#254 P2, fail-closed): R1 is split (scope_fit dissents
    // out_of_scope). To make the FINAL round unanimous in_scope, scope_fit must
    // FLIP its vote (out_of_scope -> in_scope). The critique round does NOT
    // collect fresh citations, so the flipped lens's R1 evidence (gathered for
    // the OLD out_of_scope position) is now EMPTIED — it cannot support the new
    // in_scope vote. The gate's allHaveVerifiedEvidence is therefore FALSE for
    // the flipped lens, so the deliberation ESCALATES rather than auto_confirms.
    // This is the STRICTER correct behavior: a critique-driven vote flip can
    // never auto_confirm on stale evidence (requires human review). It is NOT a
    // weakening — convergence-via-flip used to (wrongly) auto_confirm.
    const map: RoutingMap = {
      [routingKey("propose", "correctness")]: { stdout: proposeJson("in_scope") },
      [routingKey("propose", "scope_fit")]: { stdout: proposeJson("out_of_scope") },
      [routingKey("propose", "spec_adherence")]: { stdout: proposeJson("in_scope") },
      // every lens lands on in_scope; scope_fit FLIPS (out_of_scope -> in_scope).
      ...lensAwareCritiqueMap({ revisedScope: "in_scope", voteChanged: true }),
      ...upholdMap(),
    };
    const out = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    expect(out.critiqueRan).toBe(true);
    // The round-2 set is scope-unanimous in_scope, but the flipped lens carries
    // no verified evidence -> the gate fails allHaveVerifiedEvidence -> escalate.
    expect(out.result.gateTrace.scopeUnanimous).toBe(true);
    expect(out.result.gateTrace.allHaveVerifiedEvidence).toBe(false);
    expect(out.result.decision).toBe("escalate");
    // The refuter never ran (a non-verified final round skips Stage4).
    expect(out.refutation).toBeNull();
  });
});

describe("deliberate — weak-evidence trigger + fail-closed convergence", () => {
  it("a weak (unverifiable) R1 citation triggers critique then escalates (fail-closed)", async () => {
    // scope_fit cites a NON-EXISTENT file -> verifyEvidence => verified:false ->
    // proposalStatus=inconclusive -> R1 is NOT unanimous -> critique runs. The
    // critique carries the unverifiable evidence forward, so the final round
    // still lacks verified evidence for scope_fit -> the gate escalates. This
    // proves weak evidence that critique cannot strengthen NEVER auto_confirms.
    const map: RoutingMap = {
      [routingKey("propose", "correctness")]: { stdout: proposeJson("in_scope") },
      [routingKey("propose", "scope_fit")]: {
        stdout: proposeJson("in_scope", { citation: "src/core/missing.ts:1" }),
      },
      [routingKey("propose", "spec_adherence")]: { stdout: proposeJson("in_scope") },
      ...lensAwareCritiqueMap({ revisedScope: "in_scope", voteChanged: false }),
      ...upholdMap(),
    };
    const out = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    expect(out.critiqueRan).toBe(true);
    expect(out.result.decision).toBe("escalate");
  });
});

describe("deliberate — (d) clean-unanimous R1 + refuter refute -> escalate", () => {
  it("escalates when the refuter refutes a (clean, no-critique) unanimous consensus", async () => {
    // The refute-veto path. A critique-CONVERGED consensus can no longer reach
    // the refuter (Round6 FIX 3: a vote flip empties the flipped lens's evidence
    // so Stage4 is skipped), so the refute veto is exercised on the CLEAN
    // unanimous R1 path instead: R1 is unanimous in_scope with verified+proximate
    // evidence (no critique), the refuter RUNS and REFUTES -> escalate. This
    // still proves a refuting verdict vetoes auto_confirm.
    const map: RoutingMap = {
      ...unanimousProposeMap(proposeJson("in_scope")),
      ...refuteResponse({ stdout: refuteJson({ refuteVerdict: "refute" }) }),
    };
    const out = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    expect(out.critiqueRan).toBe(false);
    expect(out.refutation?.verdict.refuteVerdict).toBe("refute");
    expect(out.result.gateTrace.refuterUpheld).toBe(false);
    expect(out.result.decision).toBe("escalate");
  });
});

describe("deliberate — (e) deliberationId consistency", () => {
  it("the outcome's deliberationId matches the gate input recomputation", async () => {
    const map: RoutingMap = {
      ...unanimousProposeMap(proposeJson("in_scope")),
      ...upholdMap(),
    };
    const out = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    expect(typeof out.deliberationId).toBe("string");
    expect(out.deliberationId.length).toBeGreaterThan(0);
    // deterministic: rerunning the identical deliberation yields the same id.
    const out2 = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    expect(out2.deliberationId).toBe(out.deliberationId);
  });

  it("a different hitch id yields a different deliberationId", async () => {
    const map: RoutingMap = {
      ...unanimousProposeMap(proposeJson("in_scope")),
      ...upholdMap(),
    };
    const a = await deliberate(FINDING, deps(routingRunner(map)), "hitch-A");
    const b = await deliberate(FINDING, deps(routingRunner(map)), "hitch-B");
    expect(a.deliberationId).not.toBe(b.deliberationId);
  });
});

describe("deliberate — (f) outcome carries everything for persistence", () => {
  it("carries R1+R2 proposals + severityAudit on a critique-converged (flip) path, refutation NULL (Round6 FIX 3)", async () => {
    // A critique-converged (vote-flip) path: BOTH rounds are persisted, but the
    // refuter is SKIPPED because the flipped lens lost its evidence (Round6 FIX
    // 3), so refutation is NULL and the gate escalates. This asserts the audit
    // payload (both rounds + advisory severity audit + gate trace) is carried
    // even on the escalate path.
    const map: RoutingMap = {
      [routingKey("propose", "correctness")]: { stdout: proposeJson("in_scope") },
      [routingKey("propose", "scope_fit")]: { stdout: proposeJson("out_of_scope") },
      [routingKey("propose", "spec_adherence")]: { stdout: proposeJson("in_scope") },
      ...lensAwareCritiqueMap({ revisedScope: "in_scope", voteChanged: true }),
      ...upholdMap(),
    };
    const out = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    // both rounds present
    expect(out.proposals.some((p) => p.round === 1)).toBe(true);
    expect(out.proposals.some((p) => p.round === 2)).toBe(true);
    // refutation SKIPPED (the flipped lens has no verified evidence -> Stage4
    // never runs -> the gate escalates).
    expect(out.refutation).toBeNull();
    expect(out.result.decision).toBe("escalate");
    // severity audit present and advisory
    expect(out.severityAudit).toBeDefined();
    expect(out.severityAudit.harnessSeverity).toBe("P2");
    // gate trace present
    expect(out.result.gateTrace).toBeDefined();
  });

  it("carries the refutation on a clean-unanimous (no-critique) auto_confirm path", async () => {
    // The complement: a clean unanimous R1 (no flip, no critique) runs the
    // refuter and auto_confirms, so the refutation IS carried for persistence.
    const map: RoutingMap = {
      ...unanimousProposeMap(proposeJson("in_scope")),
      ...upholdMap(),
    };
    const out = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    expect(out.critiqueRan).toBe(false);
    expect(out.refutation).not.toBeNull();
    expect(out.refutation?.verdict.refuteVerdict).toBe("uphold");
    expect(out.result.decision).toBe("auto_confirm");
    expect(out.severityAudit).toBeDefined();
  });

  it("severity audit reflects the proposers' proposedSeverity vs harness severity", async () => {
    // all three lenses vote P0 severity but harness assigned P2 -> diverged.
    const map: RoutingMap = {
      ...unanimousProposeMap(proposeJson("in_scope", { severity: "P0" })),
      ...upholdMap(),
    };
    const out = await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    expect(out.severityAudit.status).toBe("diverged");
    expect(out.severityAudit.juryConsensus).toBe("P0");
    expect(out.severityAudit.harnessSeverity).toBe("P2");
  });
});

describe("deliberate — (g) critique-skip does NOT pass voteChanged to refuter", () => {
  it("the refuter prompt omits voteChanged on the clean-unanimous path", async () => {
    let refutePrompt = "";
    const map: RoutingMap = {
      ...unanimousProposeMap(proposeJson("in_scope")),
      ...upholdMap(),
    };
    const recording: CodexExecRunner = {
      async run(input) {
        if (input.prompt.includes("[[stage:refute]]")) refutePrompt = input.prompt;
        return routingRunner(map).run(input);
      },
    };
    const out = await deliberate(FINDING, deps(recording), HITCH_ID);
    expect(out.critiqueRan).toBe(false);
    expect(refutePrompt).toContain("[[stage:refute]]");
    expect(refutePrompt).not.toContain("voteChanged");
    expect(refutePrompt).not.toContain("changed their vote");
  });

  it("a critique-CONVERGED (vote-flip) path never reaches the refuter at all (Round6 FIX 3)", async () => {
    // Round6 FIX 3 stricter behavior: a critique-driven convergence from a split
    // necessarily involves a vote FLIP, which empties the flipped lens's
    // evidence, so the final round is NOT all-verified -> Stage4 (the refuter) is
    // SKIPPED entirely and the gate escalates. The refuter prompt is therefore
    // NEVER built on this path (its voteChanged plumbing is unreachable here).
    // This replaces the prior "critique-ran DOES pass voteChanged to refuter"
    // expectation, which is now structurally impossible (a flip blocks Stage4) —
    // the new, stricter, fail-closed truth.
    let refutePrompt = "";
    const map: RoutingMap = {
      [routingKey("propose", "correctness")]: { stdout: proposeJson("in_scope") },
      [routingKey("propose", "scope_fit")]: { stdout: proposeJson("out_of_scope") },
      [routingKey("propose", "spec_adherence")]: { stdout: proposeJson("in_scope") },
      ...lensAwareCritiqueMap({ revisedScope: "in_scope", voteChanged: true }),
      ...upholdMap(),
    };
    const recording: CodexExecRunner = {
      async run(input) {
        if (input.prompt.includes("[[stage:refute]]")) refutePrompt = input.prompt;
        return routingRunner(map).run(input);
      },
    };
    const out = await deliberate(FINDING, deps(recording), HITCH_ID);
    expect(out.critiqueRan).toBe(true);
    // The refuter never ran -> no refute prompt was built, refutation is null.
    expect(refutePrompt).toBe("");
    expect(out.refutation).toBeNull();
    expect(out.result.decision).toBe("escalate");
  });
});

describe("deliberate — DB-closed (Stage1-5)", () => {
  it("creates no sqlite DB file anywhere under the worktree or audit dir", async () => {
    const { readdirSync } = await import("node:fs");
    const map: RoutingMap = {
      ...unanimousProposeMap(proposeJson("in_scope")),
      ...upholdMap(),
    };
    await deliberate(FINDING, deps(routingRunner(map)), HITCH_ID);
    const sqliteUnder = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
        /\.sqlite/.test(f),
      );
    expect(sqliteUnder(worktreePath)).toEqual([]);
    expect(sqliteUnder(auditDir)).toEqual([]);
  });
});
