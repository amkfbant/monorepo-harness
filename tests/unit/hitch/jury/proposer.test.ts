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
import {
  generateJuryProposals,
  type JuryProposerFinding,
} from "../../../../src/hitch/jury/proposer.js";
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
  type RoutingMap,
} from "./_fake-jury-runner.js";
import type { CodexExecRunner } from "../../../../src/codex/codex-exec-runner.js";
import type { GlobalPolicy, RepoPolicy } from "../../../../src/policy/schema.js";

/**
 * #230 Task C1 — generateJuryProposals (Stage1: 3 independent lens proposals +
 * deterministic Stage2 evidence verification). RED-first contract (design §2
 * Stage1/Stage2 + §0.1 R1 + 付録P Stage1 propose contract + plan PR4/PR5).
 */

let worktreePath: string;
let auditDir: string;

const GLOBAL: GlobalPolicy = { always_deny_write: [], ignore_untracked: [] };
const REPO: RepoPolicy = {
  repo_id: "fixture-repo",
  read: [],
  domains: {
    "src/core": {
      read: ["src/core/**"],
      write: ["src/core/**"],
      deny_write: [],
    },
  },
};

const evidenceCtx = (): EvidenceCheckContext => ({
  worktreePath,
  compiledPolicy: { global: GLOBAL, repo: REPO },
});

const FINDING: JuryProposerFinding = {
  findingId: "finding-1",
  summary: "ambiguous scope finding",
  filePath: "src/core/widget.ts",
  category: "core",
};

function logPaths(stageDir: string) {
  return (findingId: string, lens: JuryLens, stage: JuryStage) => ({
    stdout: join(auditDir, stageDir, `${findingId}.${lens}.${stage}.out.log`),
    stderr: join(auditDir, stageDir, `${findingId}.${lens}.${stage}.err.log`),
    events: join(auditDir, stageDir, `${findingId}.${lens}.${stage}.events.jsonl`),
  });
}

function deps(runner: CodexExecRunner): JuryProposerDeps {
  return {
    reviewerRunner: runner,
    harnessRoot: worktreePath,
    worktreePath,
    logPaths: logPaths("propose"),
    timeoutMs: 60_000,
    parseSchema: undefined,
    auditDir,
    evidenceCtx: evidenceCtx(),
  };
}

/** A well-formed Stage1 propose JSON for a lens, citing an existing file. */
function proposeJson(
  scope: "in_scope" | "out_of_scope" | "unknown",
  citation = "src/core/widget.ts:1",
): string {
  return JSON.stringify({
    proposedScope: scope,
    evidence: [{ citation, kind: "file", claim: "the widget lives here" }],
    refutationCondition: "if the file did not exist this would be wrong",
    uncertainty: "low",
    reasoning: "the diff touches this file directly",
    proposedSeverity: "P2",
  });
}

/** Build a routing map where every propose lens returns `json`. */
function unanimousMap(json: string): RoutingMap {
  const map: RoutingMap = {};
  for (const lens of JURY_LENSES) {
    map[routingKey("propose", lens)] = { stdout: json };
  }
  return map;
}

beforeAll(() => {
  worktreePath = mkdtempSync(join(tmpdir(), "harness-jury-proposer-"));
  mkdirSync(join(worktreePath, "src", "core"), { recursive: true });
  writeFileSync(
    join(worktreePath, "src", "core", "widget.ts"),
    ["export const widget = 1;", "export const other = 2;"].join("\n"),
  );
  auditDir = mkdtempSync(join(tmpdir(), "harness-jury-audit-"));
});

afterAll(() => {
  rmSync(worktreePath, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

describe("generateJuryProposals — Stage1 per-lens launch", () => {
  it("launches exactly the 3 lenses, each with its own per-lens prompt", async () => {
    const promptsSeen: string[] = [];
    const recordingRunner: CodexExecRunner = {
      async run(input) {
        promptsSeen.push(input.prompt);
        // Delegate to a routing runner so a valid proposal still comes back.
        return routingRunner(unanimousMap(proposeJson("in_scope"))).run(input);
      },
    };
    const proposals = await generateJuryProposals(
      deps(recordingRunner),
      FINDING,
    );

    expect(proposals).toHaveLength(3);
    expect(new Set(proposals.map((p) => p.lens))).toEqual(
      new Set(["correctness", "scope_fit", "spec_adherence"]),
    );
    // every proposal is round 1 and carries the finding id
    for (const p of proposals) {
      expect(p.round).toBe(1);
      expect(p.findingId).toBe("finding-1");
    }
    // exactly 3 codex launches, each prompt embedding a DISTINCT lens token
    expect(promptsSeen).toHaveLength(3);
    expect(promptsSeen.some((p) => p.includes("[[lens:correctness]]"))).toBe(true);
    expect(promptsSeen.some((p) => p.includes("[[lens:scope_fit]]"))).toBe(true);
    expect(
      promptsSeen.some((p) => p.includes("[[lens:spec_adherence]]")),
    ).toBe(true);
    // each prompt is a Stage1 propose prompt
    for (const p of promptsSeen) {
      expect(p).toContain("[[stage:propose]]");
    }
    // a lens prompt must NOT contain another lens's token (independence)
    const correctnessPrompt = promptsSeen.find((p) =>
      p.includes("[[lens:correctness]]"),
    );
    expect(correctnessPrompt).toBeDefined();
    expect(correctnessPrompt).not.toContain("[[lens:scope_fit]]");
    expect(correctnessPrompt).not.toContain("[[lens:spec_adherence]]");
  });

  it("a clean unanimous in_scope set yields 3 complete proposals", async () => {
    const proposals = await generateJuryProposals(
      deps(routingRunner(unanimousMap(proposeJson("in_scope")))),
      FINDING,
    );
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.proposalStatus).toBe("complete");
      expect(p.proposedScope).toBe("in_scope");
    }
  });
});

describe("generateJuryProposals — R1 evidence type boundary (design §0.1 R1)", () => {
  it("parser does NOT accept verified/resolvedRef supplied by the LLM", async () => {
    // The LLM tries to self-assert verification on a NON-EXISTENT citation.
    const cheatingJson = JSON.stringify({
      proposedScope: "in_scope",
      evidence: [
        {
          citation: "src/core/does-not-exist.ts:1",
          kind: "file",
          claim: "i swear it exists",
          verified: true,
          resolvedRef: "/totally/made/up/path.ts",
        },
      ],
      refutationCondition: "n/a",
      uncertainty: "none",
      reasoning: "trust me",
      proposedSeverity: "P1",
    });
    const proposals = await generateJuryProposals(
      deps(routingRunner(unanimousMap(cheatingJson))),
      FINDING,
    );
    // Strict schema rejects the unknown keys -> parse_error (the LLM's
    // verified/resolvedRef NEVER reaches the output proposal).
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.proposalStatus).toBe("parse_error");
      // no evidence carrying the LLM's forged verified=true / resolvedRef
      for (const ev of p.evidence) {
        expect(ev.resolvedRef).not.toBe("/totally/made/up/path.ts");
      }
    }
  });

  it("a non-existent citation ends up verified:false after verifyEvidence", async () => {
    const json = JSON.stringify({
      proposedScope: "in_scope",
      evidence: [
        {
          citation: "src/core/missing.ts:99",
          kind: "file",
          claim: "claims this file",
        },
      ],
      refutationCondition: "if missing this is wrong",
      uncertainty: "low",
      reasoning: "points at a file that does not exist",
      proposedSeverity: "P2",
    });
    const proposals = await generateJuryProposals(
      deps(routingRunner(unanimousMap(json))),
      FINDING,
    );
    // every cited file is non-existent -> verifyEvidence => verified:false ->
    // zero verified evidence -> inconclusive (fail-closed).
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.proposalStatus).toBe("inconclusive");
      expect(p.evidence).toHaveLength(1);
      expect(p.evidence[0]?.verified).toBe(false);
    }
  });

  it("a verified citation is carried through with verified:true", async () => {
    const proposals = await generateJuryProposals(
      deps(routingRunner(unanimousMap(proposeJson("in_scope")))),
      FINDING,
    );
    for (const p of proposals) {
      expect(p.evidence.length).toBeGreaterThanOrEqual(1);
      expect(p.evidence.some((e) => e.verified === true)).toBe(true);
    }
  });
});

describe("generateJuryProposals — fail-closed status mapping", () => {
  it("evidence:[] -> inconclusive (zero verifiable evidence)", async () => {
    const json = JSON.stringify({
      proposedScope: "in_scope",
      evidence: [],
      refutationCondition: "n/a",
      uncertainty: "low",
      reasoning: "no evidence cited",
      proposedSeverity: "P2",
    });
    const proposals = await generateJuryProposals(
      deps(routingRunner(unanimousMap(json))),
      FINDING,
    );
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.proposalStatus).toBe("inconclusive");
    }
  });

  it("parse garbage -> parse_error", async () => {
    const map = unanimousMap("this is not json at all {");
    const proposals = await generateJuryProposals(
      deps(routingRunner(map)),
      FINDING,
    );
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.proposalStatus).toBe("parse_error");
    }
  });

  it("missing a required field (reasoning) -> parse_error", async () => {
    const json = JSON.stringify({
      proposedScope: "in_scope",
      evidence: [
        { citation: "src/core/widget.ts:1", kind: "file", claim: "here" },
      ],
      refutationCondition: "x",
      uncertainty: "low",
      // reasoning intentionally omitted
      proposedSeverity: "P2",
    });
    const proposals = await generateJuryProposals(
      deps(routingRunner(unanimousMap(json))),
      FINDING,
    );
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.proposalStatus).toBe("parse_error");
    }
  });

  it("missing refutationCondition -> parse_error", async () => {
    const json = JSON.stringify({
      proposedScope: "in_scope",
      evidence: [
        { citation: "src/core/widget.ts:1", kind: "file", claim: "here" },
      ],
      uncertainty: "low",
      reasoning: "ok",
      proposedSeverity: "P2",
    });
    const proposals = await generateJuryProposals(
      deps(routingRunner(unanimousMap(json))),
      FINDING,
    );
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.proposalStatus).toBe("parse_error");
    }
  });

  it("codex timeout -> proposalStatus=timeout", async () => {
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("propose", lens)] = {
        stdout: proposeJson("in_scope"),
        timedOut: true,
      };
    }
    const proposals = await generateJuryProposals(
      deps(routingRunner(map)),
      FINDING,
    );
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.proposalStatus).toBe("timeout");
    }
  });

  it("codex non-zero exit -> parse_error (fail-closed, not complete)", async () => {
    const map: RoutingMap = {};
    for (const lens of JURY_LENSES) {
      map[routingKey("propose", lens)] = {
        stdout: proposeJson("in_scope"),
        exitCode: 7,
      };
    }
    const proposals = await generateJuryProposals(
      deps(routingRunner(map)),
      FINDING,
    );
    expect(proposals).toHaveLength(3);
    for (const p of proposals) {
      expect(p.proposalStatus).not.toBe("complete");
    }
  });
});

describe("generateJuryProposals — per-lens divergence (split injection)", () => {
  it("a 1-lens-out_of_scope split is reflected per lens", async () => {
    const map: RoutingMap = {
      [routingKey("propose", "correctness")]: {
        stdout: proposeJson("in_scope"),
      },
      [routingKey("propose", "scope_fit")]: {
        stdout: proposeJson("out_of_scope"),
      },
      [routingKey("propose", "spec_adherence")]: {
        stdout: proposeJson("in_scope"),
      },
    };
    const proposals = await generateJuryProposals(
      deps(routingRunner(map)),
      FINDING,
    );
    const byLens = new Map(proposals.map((p) => [p.lens, p]));
    expect(byLens.get("correctness")?.proposedScope).toBe("in_scope");
    expect(byLens.get("scope_fit")?.proposedScope).toBe("out_of_scope");
    expect(byLens.get("spec_adherence")?.proposedScope).toBe("in_scope");
  });
});

describe("generateJuryProposals — DB-closed (Stage1)", () => {
  it("creates no sqlite DB file anywhere under the worktree or audit dir", async () => {
    // Stage1 runs DB-closed: the proposer is given NO dbPath/handle, so it
    // structurally cannot write the DB. Assert no *.sqlite* artifact appears.
    await generateJuryProposals(
      deps(routingRunner(unanimousMap(proposeJson("in_scope")))),
      FINDING,
    );
    const sqliteUnder = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
        /\.sqlite/.test(f),
      );
    expect(sqliteUnder(worktreePath)).toEqual([]);
    expect(sqliteUnder(auditDir)).toEqual([]);
  });
});
