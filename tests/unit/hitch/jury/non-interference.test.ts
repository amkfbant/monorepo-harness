import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../../src/db/managed-connection.js";
import { runMigrations } from "../../../../src/db/migrations.js";
import { HitchRepository } from "../../../../src/hitch/repository.js";
import { createOrchestratorRunners } from "../../../../src/hitch/orchestrator-runners.js";
import type { HitchFindingSeverity } from "../../../../src/hitch/types.js";

/**
 * #230 Task D5 — jury NON-INTERFERENCE at the classify-runner layer.
 *
 * The deliberation jury (Stage1-5 + per-finding codex calls) is reached ONLY
 * for harness-origin findings the heuristic leaves `unknown`. These tests prove
 * the two BYPASS paths never touch the jury and never mutate state from LLM
 * output:
 *
 *   1. A heuristic-confirmed finding (filePath inside targetFiles) is written
 *      immediately and NO jury audit rows are generated for it.
 *   2. An operator-origin (human/mcp) unknown finding is NEVER machine-classified
 *      (stays `unknown`), the reviewerRunner is NEVER invoked for it, NO jury
 *      audit rows are generated, and it is bundled into an operator-origin
 *      escalate packet.
 *   3. Severity is invariant on both paths (no auto-downgrade by the jury).
 *
 * The guards are deterministic and harness-side: a per-finding jury-row count of
 * zero AND a reviewerRunner invocation count of zero. (A throwing runner would
 * NOT suffice: `deliberate()` is fail-closed and SWALLOWS a runner throw into an
 * `inconclusive` proposal, so a throw never propagates — the call COUNT and the
 * persisted-row COUNT are the load-bearing signals that the jury did not run.)
 *
 * TMPDIR HYGIENE: every harness root is registered for `afterEach` rm so the
 * suite never leaks .harness dirs (the suite has a history of TMPDIR leakage
 * filling the disk).
 */

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeHarnessRoot(): { harnessRoot: string; dbPath: string } {
  const harnessRoot = mkdtempSync(join(tmpdir(), "harness-jury-noninterf-"));
  tmpDirs = [...tmpDirs, harnessRoot];
  mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
  return { harnessRoot, dbPath: join(harnessRoot, ".harness", "harness.sqlite") };
}

function createScopedHitch(dbPath: string, hitchId: string): void {
  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    new HitchRepository(db).createSession({
      hitchId,
      title: "Jury non-interference",
      projectId: "demo",
      // repoId/domain so the classify runner can resolve a run context.
      repoId: "t",
      domain: "docs",
      // targetFiles src/** so a finding in src/ is heuristic-resolvable (jury
      // bypass), while a finding without a filePath stays `unknown`.
      scope: { targetFiles: ["src/**"] },
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      createdBy: "test",
      createdSource: "worker",
    });
  } finally {
    close();
  }
}

/**
 * A reviewerRunner that COUNTS invocations. On a jury-bypass path
 * (heuristic-confirmed / operator-origin) `run` must be called ZERO times — the
 * call count is the precise, non-swallowed proof the jury never ran (a throwing
 * runner would be swallowed by the fail-closed deliberate()).
 */
function countingReviewerRunner(): {
  run: () => Promise<{
    exitCode: number;
    timedOut: boolean;
    aborted: boolean;
    durationMs: number;
  }>;
  calls: () => number;
} {
  let calls = 0;
  return {
    run: async () => {
      calls += 1;
      return { exitCode: 0, timedOut: false, aborted: false, durationMs: 0 };
    },
    calls: () => calls,
  };
}

function makeRunners(
  harnessRoot: string,
  dbPath: string,
  reviewerRunner: { run: () => Promise<unknown> },
) {
  return createOrchestratorRunners({
    dbPath,
    harnessRoot,
    createdBy: "worker",
    coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
    reviewerRunner: reviewerRunner as Parameters<
      typeof createOrchestratorRunners
    >[0]["reviewerRunner"],
    // Heuristic and operator-origin paths do not read the worktree, so the
    // harness root suffices as the repo path for run-context resolution.
    repoPath: harnessRoot,
  });
}

function juryRowCounts(
  dbPath: string,
  findingId: string,
): { proposals: number; refutations: number; severityAudits: number } {
  const { db, close } = openManagedDb({ dbPath });
  try {
    const count = (table: string): number =>
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE finding_id = ?`)
          .get(findingId) as { n: number }
      ).n;
    return {
      proposals: count("jury_classification_proposals"),
      refutations: count("jury_classification_refutations"),
      severityAudits: count("jury_severity_audits"),
    };
  } finally {
    close();
  }
}

function readFinding(dbPath: string, findingId: string) {
  const { db, close } = openManagedDb({ dbPath });
  try {
    return new HitchRepository(db).requireFinding(findingId);
  } finally {
    close();
  }
}

function seedFinding(
  dbPath: string,
  hitchId: string,
  input: {
    source: "review" | "human" | "mcp" | "doctor";
    severity: HitchFindingSeverity;
    summary: string;
    filePath?: string;
  },
): string {
  const { db, close } = openManagedDb({ dbPath });
  try {
    return new HitchRepository(db).upsertFinding({
      hitchId,
      source: input.source,
      severity: input.severity,
      category: "bug",
      scopeStatus: "unknown",
      summary: input.summary,
      ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
    }).finding.findingId;
  } finally {
    close();
  }
}

describe("#230 D5: jury non-interference (heuristic / operator-origin bypass)", () => {
  it("heuristic-confirmed finding bypasses the jury: classified, NO jury rows, severity unchanged", async () => {
    const { harnessRoot, dbPath } = makeHarnessRoot();
    createScopedHitch(dbPath, "g-heuristic");
    // filePath inside src/** → the heuristic resolves it in_scope (jury bypass).
    const fid = seedFinding(dbPath, "g-heuristic", {
      source: "review",
      severity: "P1",
      summary: "bug in scoped file",
      filePath: "src/file.ts",
    });

    const reviewer = countingReviewerRunner();
    const result = await makeRunners(harnessRoot, dbPath, reviewer).classify(
      "g-heuristic",
    );

    // Resolved with no escalation — and the reviewerRunner was never invoked,
    // proving the jury did not run for a heuristic-confirmed finding.
    expect(result.resolved).toBe(true);
    expect(reviewer.calls()).toBe(0);

    const f = readFinding(dbPath, fid);
    expect(f.scopeStatus).toBe("in_scope");
    expect(f.classificationReason).toMatch(/matches hitch targetFiles/);
    // Severity is never touched by classification (no auto-downgrade).
    expect(f.severity).toBe("P1");

    // No jury audit rows were generated for a heuristic-confirmed finding.
    expect(juryRowCounts(dbPath, fid)).toEqual({
      proposals: 0,
      refutations: 0,
      severityAudits: 0,
    });
  });

  it("operator-origin (human) unknown finding is never machine-classified: NO jury rows, escalate bundle, severity unchanged", async () => {
    const { harnessRoot, dbPath } = makeHarnessRoot();
    createScopedHitch(dbPath, "g-operator");
    // human source, no filePath → operator-origin AND unknown. It must NOT be
    // heuristic-classified, NOT jury-classified, only manual-escalated.
    const fid = seedFinding(dbPath, "g-operator", {
      source: "human",
      severity: "P2",
      summary: "operator-reported ambiguity",
    });

    const reviewer = countingReviewerRunner();
    const result = await makeRunners(harnessRoot, dbPath, reviewer).classify(
      "g-operator",
    );

    // Escalated (manual) — the reviewerRunner was never invoked, proving
    // operator-origin findings are not machine-classified.
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("unreachable");
    expect(result.decision).toBe("escalate");
    expect(reviewer.calls()).toBe(0);
    expect(result.escalateReason).toMatch(/operator-origin/);

    // The finding stays `unknown` (no machine classification at all).
    const f = readFinding(dbPath, fid);
    expect(f.scopeStatus).toBe("unknown");
    // Severity is untouched.
    expect(f.severity).toBe("P2");

    // No jury audit rows for an operator-origin finding.
    expect(juryRowCounts(dbPath, fid)).toEqual({
      proposals: 0,
      refutations: 0,
      severityAudits: 0,
    });

    // The operator-origin escalate packet bundles the finding as operator-origin.
    const packet = result.recommendedNextAction.decisionPacket;
    expect(packet).toBeDefined();
    if (packet === undefined) throw new Error("unreachable");
    expect(packet.packetVersion).toBe(2);
    expect(packet.decisionKinds).toContain("operator_origin_unknown");
    const entry = packet.findings.find((pf) => pf.findingId === fid);
    expect(entry).toBeDefined();
    expect(entry?.origin).toBe("operator");
  });

  it("a mixed batch never machine-classifies the operator-origin finding while heuristic-confirming the harness-origin one (both jury-free)", async () => {
    const { harnessRoot, dbPath } = makeHarnessRoot();
    createScopedHitch(dbPath, "g-mixed");
    const harnessFid = seedFinding(dbPath, "g-mixed", {
      source: "review",
      severity: "P1",
      summary: "heuristic-resolvable harness finding",
      filePath: "src/file.ts",
    });
    const operatorFid = seedFinding(dbPath, "g-mixed", {
      source: "mcp",
      severity: "P3",
      summary: "operator-reported finding",
    });

    const reviewer = countingReviewerRunner();
    const result = await makeRunners(harnessRoot, dbPath, reviewer).classify(
      "g-mixed",
    );

    // The harness-origin finding is heuristic-classified; the operator-origin one
    // forces an escalate. Neither path invokes the reviewerRunner (no jury).
    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("unreachable");
    expect(result.decision).toBe("escalate");
    expect(reviewer.calls()).toBe(0);

    const harness = readFinding(dbPath, harnessFid);
    expect(harness.scopeStatus).toBe("in_scope");
    expect(harness.severity).toBe("P1");

    const operator = readFinding(dbPath, operatorFid);
    expect(operator.scopeStatus).toBe("unknown");
    expect(operator.severity).toBe("P3");

    // No jury rows for EITHER finding (heuristic bypass + operator bypass).
    expect(juryRowCounts(dbPath, harnessFid)).toEqual({
      proposals: 0,
      refutations: 0,
      severityAudits: 0,
    });
    expect(juryRowCounts(dbPath, operatorFid)).toEqual({
      proposals: 0,
      refutations: 0,
      severityAudits: 0,
    });
  });
});
