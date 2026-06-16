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
import { runClassificationRefuter } from "../../../../src/hitch/jury/refuter.js";
import type {
  JuryLens,
  JuryProposerDeps,
  JuryStage,
  EvidenceCheckContext,
  VerifiedJuryEvidence,
} from "../../../../src/hitch/jury/types.js";
import {
  routingRunner,
  refuteResponse,
  type RoutingMap,
} from "./_fake-jury-runner.js";
import type { CodexExecRunner } from "../../../../src/codex/codex-exec-runner.js";
import type { GlobalPolicy, RepoPolicy } from "../../../../src/policy/schema.js";

/**
 * #230 Task C3 — runClassificationRefuter (Stage4: adversarial refutation of a
 * post-critique unanimous, fully-verified consensus). RED-first contract (design
 * §2 Stage4 + §0.1 R9 + 付録P Stage4 refuter contract + plan PR5/PR4/P2-j).
 *
 * ★ The refuter NEVER creates an auto_confirm. It can only `uphold` (does not
 * block the gate) or `refute`/`inconclusive` (veto = fail-closed). Anti-
 * ritualization (R9): an `uphold` is downgraded to `inconclusive` unless it
 * supplies BOTH whyNotFalseConsensus AND refutationConditions.
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
    stdout: join(auditDir, "refute", `${findingId}.${lens}.${stage}.out.log`),
    stderr: join(auditDir, "refute", `${findingId}.${lens}.${stage}.err.log`),
    events: join(auditDir, "refute", `${findingId}.${lens}.${stage}.events.jsonl`),
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

const verifiedEvidence = (
  citation = "src/core/widget.ts:1",
): VerifiedJuryEvidence => ({
  citation,
  kind: "file",
  claim: "the widget lives here",
  verified: true,
});

/** A post-critique-unanimous, fully-verified refuter input. */
function refuterInput() {
  return {
    findingId: "finding-1",
    filePath: "src/core/widget.ts",
    category: "core",
    unanimousScope: "in_scope" as const,
    refutationConditions: [
      { lens: "correctness" as JuryLens, condition: "if the file did not exist this would be wrong" },
      { lens: "scope_fit" as JuryLens, condition: "if the change touched another domain" },
      { lens: "spec_adherence" as JuryLens, condition: "if the spec contradicted the change" },
    ],
    verifiedEvidence: [verifiedEvidence()],
    voteChanges: [
      { lens: "correctness" as JuryLens, voteChanged: false },
      { lens: "scope_fit" as JuryLens, voteChanged: true },
      { lens: "spec_adherence" as JuryLens, voteChanged: false },
    ],
  };
}

/** Build the Stage4 refuter JSON output. */
function refuteJson(opts: {
  refuteVerdict: "uphold" | "refute" | "inconclusive";
  whyNotFalseConsensus?: string;
  refutationConditions?: string;
  counterEvidence?: Array<{ citation: string; kind: "file" | "spec" | "policy"; claim: string }>;
  reasoning?: string;
}): string {
  const body: Record<string, unknown> = {
    refuteVerdict: opts.refuteVerdict,
    counterEvidence: opts.counterEvidence ?? [],
    reasoning: opts.reasoning ?? "the consensus survives an adversarial probe",
  };
  if (opts.whyNotFalseConsensus !== undefined) {
    body.whyNotFalseConsensus = opts.whyNotFalseConsensus;
  }
  if (opts.refutationConditions !== undefined) {
    body.refutationConditions = opts.refutationConditions;
  }
  return JSON.stringify(body);
}

beforeAll(() => {
  worktreePath = mkdtempSync(join(tmpdir(), "harness-jury-refute-"));
  mkdirSync(join(worktreePath, "src", "core"), { recursive: true });
  writeFileSync(
    join(worktreePath, "src", "core", "widget.ts"),
    ["export const widget = 1;", "export const other = 2;"].join("\n"),
  );
  auditDir = mkdtempSync(join(tmpdir(), "harness-jury-refute-audit-"));
});

afterAll(() => {
  rmSync(worktreePath, { recursive: true, force: true });
  rmSync(auditDir, { recursive: true, force: true });
});

describe("runClassificationRefuter — valid verdicts", () => {
  it("uphold with BOTH whyNotFalseConsensus and refutationConditions -> uphold", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({
          refuteVerdict: "uphold",
          whyNotFalseConsensus:
            "each lens cited distinct verified evidence, not echoing one another",
          refutationConditions:
            "this would flip if the cited file were actually outside the domain",
        }),
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("uphold");
    expect(typeof verdict.reasoning).toBe("string");
    expect(verdict.reasoning.length).toBeGreaterThan(0);
  });

  it("refute passes through (veto)", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({ refuteVerdict: "refute" }),
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("refute");
  });

  it("inconclusive passes through (veto)", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({ refuteVerdict: "inconclusive" }),
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("inconclusive");
  });
});

describe("runClassificationRefuter — anti-ritualization (R9)", () => {
  it("uphold with whyNotFalseConsensus MISSING -> inconclusive", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({
          refuteVerdict: "uphold",
          refutationConditions: "would flip if the file were out of domain",
          // whyNotFalseConsensus omitted
        }),
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("inconclusive");
  });

  it("uphold with refutationConditions MISSING -> inconclusive", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({
          refuteVerdict: "uphold",
          whyNotFalseConsensus: "each lens cited distinct verified evidence",
          // refutationConditions omitted
        }),
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("inconclusive");
  });

  it("uphold with BOTH present but EMPTY -> inconclusive", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({
          refuteVerdict: "uphold",
          whyNotFalseConsensus: "   ",
          refutationConditions: "",
        }),
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("inconclusive");
  });

  it("a valid uphold requires BOTH justifications (positive control)", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({
          refuteVerdict: "uphold",
          whyNotFalseConsensus: "distinct verified evidence per lens",
          refutationConditions: "would flip if any citation were unverifiable",
        }),
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("uphold");
  });
});

describe("runClassificationRefuter — fail-closed (timeout/parse/exit)", () => {
  it("codex timeout -> inconclusive", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({
          refuteVerdict: "uphold",
          whyNotFalseConsensus: "x",
          refutationConditions: "y",
        }),
        timedOut: true,
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("inconclusive");
  });

  it("non-zero exit -> inconclusive", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({
          refuteVerdict: "uphold",
          whyNotFalseConsensus: "x",
          refutationConditions: "y",
        }),
        exitCode: 9,
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("inconclusive");
  });

  it("parse garbage -> inconclusive", async () => {
    const map: RoutingMap = {
      ...refuteResponse({ stdout: "not json at all {" }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("inconclusive");
  });

  it("strict schema rejects unknown keys -> inconclusive", async () => {
    const bad = JSON.stringify({
      refuteVerdict: "uphold",
      whyNotFalseConsensus: "x",
      refutationConditions: "y",
      counterEvidence: [],
      reasoning: "z",
      unexpectedExtraKey: "should be rejected",
    });
    const map: RoutingMap = { ...refuteResponse({ stdout: bad }) };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("inconclusive");
  });
});

describe("runClassificationRefuter — fenced ```json parse path (P3 coverage)", () => {
  it("parses a refute object wrapped in a ```json fence (intended verdict)", async () => {
    // The real codex frequently wraps its JSON in a ```json … ``` fence; the
    // extractJsonBlock fenced branch (vs. the bare balanced-brace fallback) is
    // otherwise never exercised. Trailing prose containing a stray brace makes
    // the balanced-brace FALLBACK (first `{` … last `}`) capture an invalid
    // span — so a clean parse PROVES the fenced branch ran, not the fallback.
    const body = refuteJson({
      refuteVerdict: "uphold",
      whyNotFalseConsensus:
        "each lens cited distinct verified evidence, not echoing one another",
      refutationConditions:
        "this would flip if the cited file were actually outside the domain",
    });
    const map: RoutingMap = {
      ...refuteResponse({
        stdout:
          "```json\n" +
          body +
          "\n```\n\nNote: the trailing prose {has a stray brace} after the fence.",
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("uphold");
    expect(typeof verdict.reasoning).toBe("string");
    expect(verdict.reasoning.length).toBeGreaterThan(0);
  });
});

describe("runClassificationRefuter — counterEvidence advisory (P3)", () => {
  it("counterEvidence is recomputed by verifyEvidence (LLM verified claim ignored)", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({
          refuteVerdict: "refute",
          counterEvidence: [
            { citation: "src/core/widget.ts:1", kind: "file", claim: "real file" },
            { citation: "src/core/missing.ts:1", kind: "file", claim: "does not exist" },
          ],
        }),
      }),
    };
    const verdict = await runClassificationRefuter(
      deps(routingRunner(map)),
      refuterInput(),
    );
    expect(verdict.refuteVerdict).toBe("refute");
    expect(verdict.counterEvidence).toBeDefined();
    const byCitation = new Map(
      (verdict.counterEvidence ?? []).map((e) => [e.citation, e.verified]),
    );
    expect(byCitation.get("src/core/widget.ts:1")).toBe(true);
    expect(byCitation.get("src/core/missing.ts:1")).toBe(false);
  });
});

describe("runClassificationRefuter — prompt contract", () => {
  it("the prompt embeds [[stage:refute]], the unanimous verdict, and each refutationCondition", async () => {
    let seen = "";
    const recording: CodexExecRunner = {
      async run(input) {
        seen = input.prompt;
        const map: RoutingMap = {
          ...refuteResponse({
            stdout: refuteJson({
              refuteVerdict: "uphold",
              whyNotFalseConsensus: "x",
              refutationConditions: "y",
            }),
          }),
        };
        return routingRunner(map).run(input);
      },
    };
    await runClassificationRefuter(deps(recording), refuterInput());
    expect(seen).toContain("[[stage:refute]]");
    expect(seen).toContain("in_scope");
    expect(seen).toContain("if the file did not exist this would be wrong");
    // verified evidence is shown
    expect(seen).toContain("src/core/widget.ts:1");
  });

  it("P2-j: when critique was skipped, the prompt does NOT include voteChanged", async () => {
    let seen = "";
    const recording: CodexExecRunner = {
      async run(input) {
        seen = input.prompt;
        const map: RoutingMap = {
          ...refuteResponse({
            stdout: refuteJson({
              refuteVerdict: "uphold",
              whyNotFalseConsensus: "x",
              refutationConditions: "y",
            }),
          }),
        };
        return routingRunner(map).run(input);
      },
    };
    const input = refuterInput();
    // critique skipped: no voteChanges supplied.
    const { voteChanges: _omit, ...skipped } = input;
    await runClassificationRefuter(deps(recording), skipped);
    expect(seen).not.toContain("voteChanged");
    expect(seen).not.toContain("changed their vote");
  });
});

describe("runClassificationRefuter — DB-closed (Stage4)", () => {
  it("creates no sqlite DB file anywhere under the worktree or audit dir", async () => {
    const map: RoutingMap = {
      ...refuteResponse({
        stdout: refuteJson({
          refuteVerdict: "uphold",
          whyNotFalseConsensus: "x",
          refutationConditions: "y",
        }),
      }),
    };
    await runClassificationRefuter(deps(routingRunner(map)), refuterInput());
    const sqliteUnder = (dir: string): string[] =>
      readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
        /\.sqlite/.test(f),
      );
    expect(sqliteUnder(worktreePath)).toEqual([]);
    expect(sqliteUnder(auditDir)).toEqual([]);
  });
});
