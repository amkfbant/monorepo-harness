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
import { isWeakEvidence } from "../../../../src/hitch/jury/aggregation.js";
import type {
  JuryClassificationProposal,
  JuryLens,
  JuryProposerDeps,
  JuryStage,
  EvidenceCheckContext,
  VerifiedJuryEvidence,
} from "../../../../src/hitch/jury/types.js";
import { JURY_LENSES } from "../../../../src/hitch/jury/types.js";
import {
  routingRunner,
  routingKey,
  type RoutingMap,
} from "./_fake-jury-runner.js";
import type { CodexExecRunner } from "../../../../src/codex/codex-exec-runner.js";
import type { GlobalPolicy, RepoPolicy } from "../../../../src/policy/schema.js";

/**
 * #230 Task C2 — runCritiqueRound (Stage3: conditional mutual critique) +
 * isWeakEvidence (P2-b/P2-c deterministic Stage3 trigger). RED-first contract
 * (design §2 Stage3 + §0.1 R9 + 付録P Stage3 critique contract + plan PR5/PR4).
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

/** A well-formed Stage3 critique JSON: one concrete objection per other lens. */
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

describe("isWeakEvidence (P2-b/P2-c deterministic Stage3 trigger)", () => {
  it("true when ANY lens has zero verified evidence (boundary: 0)", () => {
    const proposals = [
      r1("correctness", "in_scope", [verifiedEvidence()]),
      r1("scope_fit", "in_scope", []), // zero verified evidence
      r1("spec_adherence", "in_scope", [verifiedEvidence()]),
    ];
    expect(isWeakEvidence(proposals)).toBe(true);
  });

  it("true when a lens has only verified:false evidence (no verified===true)", () => {
    const unverified: VerifiedJuryEvidence = {
      citation: "src/core/missing.ts:1",
      kind: "file",
      claim: "missing",
      verified: false,
    };
    const proposals = [
      r1("correctness", "in_scope", [verifiedEvidence()]),
      r1("scope_fit", "in_scope", [unverified]),
      r1("spec_adherence", "in_scope", [verifiedEvidence()]),
    ];
    expect(isWeakEvidence(proposals)).toBe(true);
  });

  it("false when EVERY lens has >=1 verified evidence (boundary: 1)", () => {
    const proposals = [
      r1("correctness", "in_scope", [verifiedEvidence()]),
      r1("scope_fit", "in_scope", [verifiedEvidence()]),
      r1("spec_adherence", "in_scope", [verifiedEvidence()]),
    ];
    expect(isWeakEvidence(proposals)).toBe(false);
  });

  it("deterministic: same input twice -> equal output", () => {
    const proposals = [
      r1("correctness", "in_scope"),
      r1("scope_fit", "in_scope", []),
      r1("spec_adherence", "in_scope"),
    ];
    expect(isWeakEvidence(proposals)).toBe(isWeakEvidence(proposals));
  });
});

describe("runCritiqueRound — produces round=2 proposals", () => {
  it("returns one round=2 proposal per lens, never auto-confirming", async () => {
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = {
        stdout: critiqueJson({ revisedScope: "in_scope", voteChanged: false }),
      };
    }
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
    const map: RoutingMap = {
      [routingKey("critique", "correctness")]: {
        stdout: critiqueJson({ revisedScope: "out_of_scope", voteChanged: true }),
      },
      [routingKey("critique", "scope_fit")]: {
        stdout: critiqueJson({ revisedScope: "in_scope", voteChanged: false }),
      },
      [routingKey("critique", "spec_adherence")]: {
        stdout: critiqueJson({ revisedScope: "in_scope", voteChanged: false }),
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
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("critique", lens)] = {
        stdout: critiqueJson({ revisedScope: "in_scope", voteChanged: false, objectionCount: 2 }),
      };
    }
    const out = await runCritiqueRound(deps(routingRunner(map)), FINDING, r1set());
    expect(out).toHaveLength(3);
    for (const p of out) {
      expect(p.proposalStatus).toBe("complete");
      expect(p.round).toBe(2);
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
