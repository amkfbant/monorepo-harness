import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../../src/db/managed-connection.js";
import { runMigrations } from "../../../../src/db/migrations.js";
import { HitchRepository } from "../../../../src/hitch/repository.js";
import { createOrchestratorRunners } from "../../../../src/hitch/orchestrator-runners.js";
import { HitchOrchestrator } from "../../../../src/hitch/orchestrator.js";
import type { OrchestratorRunners } from "../../../../src/hitch/orchestrator-types.js";
import type { CodexExecRunner } from "../../../../src/codex/codex-exec-runner.js";
import {
  routingRunner,
  routingKey,
  REFUTE_ROUTE_KEY,
  type RoutingMap,
  type RoutedResponse,
} from "./_fake-jury-runner.js";
import { JURY_LENSES } from "../../../../src/hitch/jury/types.js";
import { DEFAULT_HITCH_POLICY } from "../../../../src/hitch/types.js";

/**
 * #230 Task D1 — classify runner 3-phase deliberation (orchestrator-level RED).
 *
 * These tests drive the REAL `createOrchestratorRunners(...).classify` runner so
 * the safety boundary (LLM output -> deterministic gate -> repo.classifyFinding)
 * is exercised end to end against a real DB + a real worktree fixture. The jury
 * codex calls are routed by the prompt-routing fake runner (per-lens / per-stage).
 */

interface Harness {
  harnessRoot: string;
  dbPath: string;
  runId: string;
  worktree: string;
}

/**
 * TMPDIR HYGIENE: every `makeHarness` root is registered for `afterEach` rm so
 * the suite never leaks full worktree + .harness SQLite + jury audit-log dirs
 * (the suite has a documented history of TMPDIR leakage filling the disk).
 */
let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a leftover on rm failure must not fail the test.
    }
  }
  tmpDirs = [];
});

/**
 * Build a harness root with a hitch session, a coding run + attempt (so the
 * classify runner can resolve the latest run's worktree), a real worktree dir
 * with `src/a.ts` (10 lines) for file-kind evidence, and a repo policy file.
 */
function makeHarness(hitchId: string): Harness {
  const harnessRoot = mkdtempSync(join(tmpdir(), "jury-classify-"));
  tmpDirs = [...tmpDirs, harnessRoot];
  mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
  const dbPath = join(harnessRoot, ".harness", "harness.sqlite");
  const runId = `run-${hitchId}`;
  const worktree = join(harnessRoot, "workspaces", runId, "repo");
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(
    join(worktree, "src", "a.ts"),
    Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
    "utf8",
  );
  // minimal repo policy so the evidence ctx can compile a CompiledPolicyView
  mkdirSync(join(harnessRoot, "policies", "repos"), { recursive: true });
  writeFileSync(
    join(harnessRoot, "policies", "global.yaml"),
    "always_deny_write: []\n",
    "utf8",
  );
  writeFileSync(
    join(harnessRoot, "policies", "repos", "t.yaml"),
    "repo_id: t\nread: []\ndomains: {}\n",
    "utf8",
  );

  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    const repo = new HitchRepository(db);
    repo.createSession({
      hitchId,
      title: "Jury classify",
      repoId: "t",
      domain: "docs",
      // No targetFiles so the heuristic returns `unknown` for review-source
      // findings (-> jury), but excludedCategories lets us craft heuristic hits.
      scope: {},
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      // Permissive divergence budget so seeding many unknown findings (for the
      // cap test) routes convergence to `needs_classification` rather than
      // tripping the divergence circuit-breaker (tested elsewhere).
      policy: {
        ...DEFAULT_HITCH_POLICY,
        divergence: {
          ...DEFAULT_HITCH_POLICY.divergence,
          maxTotalNewFindings: 1000,
          maxNewFindingsPerCycle: 1000,
        },
      },
      maxTotalNewFindings: 1000,
      createdBy: "test",
      createdSource: "worker",
    });
    repo.createAttempt({
      hitchId,
      attemptType: "implement",
      status: "succeeded",
      runId,
      createdAt: "2026-06-13T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, base_sha, source_mode, db_revision, export_status,
         updated_at, meta_json)
       VALUES (?, 't', 'docs', 'domain-coding', 'main', 'approved',
         'deadbeef', 'db-first', 1, 'disabled', '2026-06-13T00:00:00.000Z', ?)`,
    ).run(runId, JSON.stringify({ runId, repoId: "t", domain: "docs" }));
    // A completed review cycle so convergence is past review and routes
    // `needs_classification` (not "review the latest run first") once unknown
    // findings exist (the path under test).
    const cycle = repo.startReviewCycle({
      hitchId,
      reviewMode: "initial",
      sourceRunId: runId,
      createdAt: "2026-06-13T00:00:00.000Z",
    });
    repo.completeReviewCycle({
      cycleId: cycle.cycleId,
      completedAt: "2026-06-13T00:00:00.000Z",
      summary: "reviewed",
    });
  } finally {
    close();
  }
  return { harnessRoot, dbPath, runId, worktree };
}

function seedFinding(
  h: Harness,
  hitchId: string,
  input: {
    source: "review" | "human" | "mcp" | "doctor";
    summary: string;
    filePath?: string;
    category?: string;
    severity?: "P0" | "P1" | "P2" | "P3" | "info";
  },
): string {
  const { db, close } = openManagedDb({ dbPath: h.dbPath });
  try {
    const repo = new HitchRepository(db);
    const f = repo.upsertFinding({
      hitchId,
      source: input.source,
      severity: input.severity ?? "P1",
      category: input.category ?? "bug",
      scopeStatus: "unknown",
      summary: input.summary,
      ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
    }).finding;
    return f.findingId;
  } finally {
    close();
  }
}

/** A single lens propose JSON with one file citation (verifiable + proximate). */
function proposeJson(
  scope: "in_scope" | "out_of_scope",
  citation = "src/a.ts:1",
  severity: "P0" | "P1" | "P2" | "P3" | "info" = "P1",
): RoutedResponse {
  return {
    stdout: JSON.stringify({
      proposedScope: scope,
      evidence: [{ citation, kind: "file", claim: "the change touches this line" }],
      refutationCondition: "the cited line does not actually relate to the finding",
      reasoning: "the lens reasons it is " + scope,
      proposedSeverity: severity,
    }),
  };
}

/** Build a unanimous routing map (all 3 lenses propose `scope`) + refuter uphold. */
function unanimousRouting(
  scope: "in_scope" | "out_of_scope",
  refute: "uphold" | "refute" | "inconclusive" = "uphold",
  citation = "src/a.ts:1",
): RoutingMap {
  const map: RoutingMap = {};
  for (const lens of JURY_LENSES) {
    map[routingKey("propose", lens)] = proposeJson(scope, citation);
  }
  map[REFUTE_ROUTE_KEY] = {
    stdout: JSON.stringify({
      refuteVerdict: refute,
      whyNotFalseConsensus: "the lenses cite real, proximate evidence",
      refutationConditions: "if the cited file were unrelated",
      reasoning: "adversarial check " + refute,
    }),
  };
  return map;
}

/**
 * Build a unanimous in_scope routing map that diverges on SEVERITY: all 3
 * lenses agree in_scope (proximate verified evidence + refuter uphold so the
 * scope auto_confirms) but unanimously propose a DIVERGENT severity. The
 * advisory severity audit then sets `escalate:true` while the scope is still
 * auto-confirmed (the D2b non-escalating severity packet path).
 */
function severityDivergedRouting(
  jurySeverity: "P0" | "P1" | "P2" | "P3" | "info",
): RoutingMap {
  const map: RoutingMap = {};
  for (const lens of JURY_LENSES) {
    map[routingKey("propose", lens)] = proposeJson("in_scope", "src/a.ts:1", jurySeverity);
  }
  map[REFUTE_ROUTE_KEY] = {
    stdout: JSON.stringify({
      refuteVerdict: "uphold",
      whyNotFalseConsensus: "the lenses cite real, proximate evidence",
      refutationConditions: "if the cited file were unrelated",
      reasoning: "adversarial check uphold",
    }),
  };
  return map;
}

/**
 * Build a VALID round-2 critique for one lens that targets every OTHER lens
 * with a concrete (>=12 char, non-boilerplate), JP-enum-typed objection so the
 * strict CritiqueSchema parses AND the anti-ritualization gate ACCEPTS it. The
 * critique keeps the lens's scope vote so the final round stays genuinely split.
 */
function validCritique(
  lens: (typeof JURY_LENSES)[number],
  revisedScope: "in_scope" | "out_of_scope",
): RoutedResponse {
  const others = JURY_LENSES.filter((l) => l !== lens);
  return {
    stdout: JSON.stringify({
      objections: others.map((target) => ({
        targetLens: target,
        type: "代替仮説",
        objection:
          `lens ${target} overlooks an alternative reading of the cited evidence`,
      })),
      citationRelevance: [
        { citation: "src/a.ts:1", relevance: "supports my " + revisedScope + " view" },
      ],
      revisedScope,
      voteChanged: false,
    }),
  };
}

/**
 * Build a split routing map (2 lenses in_scope, 1 out_of_scope) whose round-2
 * critiques are VALID under the strict CritiqueSchema (targetLens at each other
 * lens, JP-enum type, concrete objection accepted by the anti-ritualization
 * gate). The final round stays genuinely split (spec_adherence out_of_scope),
 * so the escalate fires on a REAL scope split — not on 3x-inconclusive.
 */
function splitRouting(): RoutingMap {
  const map: RoutingMap = {};
  map[routingKey("propose", "correctness")] = proposeJson("in_scope");
  map[routingKey("propose", "scope_fit")] = proposeJson("in_scope");
  map[routingKey("propose", "spec_adherence")] = proposeJson("out_of_scope");
  // split -> critique fires; route round-2 VALID critiques that keep the split.
  for (const lens of JURY_LENSES) {
    const scope = lens === "spec_adherence" ? "out_of_scope" : "in_scope";
    map[routingKey("critique", lens)] = validCritique(lens, scope);
  }
  return map;
}

function makeRunners(h: Harness, jury: CodexExecRunner): OrchestratorRunners {
  return createOrchestratorRunners({
    dbPath: h.dbPath,
    harnessRoot: h.harnessRoot,
    createdBy: "worker",
    coderRunner: jury,
    reviewerRunner: jury,
    repoPath: h.worktree,
  });
}

function readFinding(h: Harness, findingId: string) {
  const { db, close } = openManagedDb({ dbPath: h.dbPath });
  try {
    return new HitchRepository(db).requireFinding(findingId);
  } finally {
    close();
  }
}

function countRows(h: Harness, table: string, findingId: string): number {
  const { db, close } = openManagedDb({ dbPath: h.dbPath });
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE finding_id = ?`)
      .get(findingId) as { n: number };
    return row.n;
  } finally {
    close();
  }
}

/** Count persisted proposals at a given round with a given proposal_status. */
function countProposalsByRoundStatus(
  h: Harness,
  findingId: string,
  round: 1 | 2,
  status: string,
): number {
  const { db, close } = openManagedDb({ dbPath: h.dbPath });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM jury_classification_proposals
         WHERE finding_id = ? AND round = ? AND proposal_status = ?`,
      )
      .get(findingId, round, status) as { n: number };
    return row.n;
  } finally {
    close();
  }
}

/** Read the persisted advisory severity audit row for a finding (or null). */
function readSeverityAudit(
  h: Harness,
  findingId: string,
): { audit_status: string; escalate_flag: number; jury_severity: string | null } | null {
  const { db, close } = openManagedDb({ dbPath: h.dbPath });
  try {
    const row = db
      .prepare(
        `SELECT audit_status, escalate_flag, jury_severity
         FROM jury_severity_audits WHERE finding_id = ?`,
      )
      .get(findingId) as
      | { audit_status: string; escalate_flag: number; jury_severity: string | null }
      | undefined;
    return row ?? null;
  } finally {
    close();
  }
}

describe("classify runner — 3 phase deliberation (#230 D1)", () => {
  it("operator-origin unknown is NOT heuristic/jury classified; escalates with operator_origin_unknown packet", async () => {
    const h = makeHarness("op-origin");
    const fid = seedFinding(h, "op-origin", {
      source: "human",
      summary: "operator raised concern",
    });
    // route nothing: a jury call would fail closed, proving the jury never runs.
    const r = await makeRunners(h, routingRunner({})).classify("op-origin");
    expect(r.resolved).toBe(false);
    if (r.resolved) throw new Error("unreachable");
    const packet = r.recommendedNextAction.decisionPacket;
    expect(packet).toBeDefined();
    expect(packet?.decisionKinds).toContain("operator_origin_unknown");
    const entry = packet?.findings.find((f) => f.findingId === fid);
    expect(entry?.origin).toBe("operator");
    // still unknown (never machine-classified)
    expect(readFinding(h, fid).scopeStatus).toBe("unknown");
  });

  it("harness-origin heuristic-resolvable finding is written immediately, jury bypassed", async () => {
    const h = makeHarness("heur");
    // category match via allowedFindingCategories -> heuristic in_scope.
    {
      const { db, close } = openManagedDb({ dbPath: h.dbPath });
      try {
        const repo = new HitchRepository(db);
        // overwrite session scope to allow the category
        db.prepare("UPDATE hitch_sessions SET scope_json = ? WHERE hitch_id = ?").run(
          JSON.stringify({ allowedFindingCategories: ["bug"] }),
          "heur",
        );
      } finally {
        close();
      }
    }
    const fid = seedFinding(h, "heur", {
      source: "review",
      summary: "a bug",
      category: "bug",
    });
    // route nothing: heuristic must resolve so the jury never runs.
    const r = await makeRunners(h, routingRunner({})).classify("heur");
    expect(r.resolved).toBe(true);
    expect(readFinding(h, fid).scopeStatus).toBe("in_scope");
    // no jury rows persisted (jury bypassed)
    expect(countRows(h, "jury_classification_proposals", fid)).toBe(0);
  });

  it("harness-origin still-unknown -> deliberate -> auto_confirm -> classifyFinding with deliberation_id in reason", async () => {
    const h = makeHarness("auto");
    const fid = seedFinding(h, "auto", {
      source: "review",
      summary: "ambiguous finding",
      filePath: "src/a.ts",
      category: "core",
    });
    const r = await makeRunners(h, routingRunner(unanimousRouting("in_scope"))).classify(
      "auto",
    );
    expect(r.resolved).toBe(true);
    const f = readFinding(h, fid);
    expect(f.scopeStatus).toBe("in_scope");
    expect(f.classificationReason).toMatch(/jury auto_confirm \(deliberation_id=[0-9a-f]{64}\)/);
    // audit rows persisted: round-1 proposals (3) + refutation (1) + severity (1)
    expect(countRows(h, "jury_classification_proposals", fid)).toBeGreaterThanOrEqual(3);
    expect(countRows(h, "jury_classification_refutations", fid)).toBe(1);
    expect(countRows(h, "jury_severity_audits", fid)).toBe(1);
  });

  it("FIX 7: PRODUCTION review-finding shape (filePath OMITTED) ESCALATES even on a unanimous, verified, refuter-upheld jury (proximityOk false, fail-closed)", async () => {
    // The realistic dominant jury population: a review-source finding WITHOUT a
    // locatable `filePath` (the proposer still cites a real file `src/a.ts:1`,
    // which verifyEvidence proves EXISTS). The deterministic proximity filter
    // (design §0.1 R1) requires `finding.filePath` for a file-kind citation, so
    // a missing filePath fail-closes to escalate even though every other
    // condition (unanimous + verified + refuter uphold) is satisfied. This pins
    // the DESIGN's deliberate strict-proximity limitation through the REAL
    // classify runner — it is NOT masked by the filePath-injecting helpers used
    // by the auto_confirm tests above.
    const h = makeHarness("noproximity");
    const fid = seedFinding(h, "noproximity", {
      source: "review",
      summary: "review finding lacking a locatable filePath",
      // NOTE: NO filePath — the production review-finding shape.
      category: "core",
    });
    const r = await makeRunners(
      h,
      routingRunner(unanimousRouting("in_scope")),
    ).classify("noproximity");

    // Fail-closed: a unanimous + verified + upheld jury STILL escalates because
    // the finding has no locatable filePath for the file-kind proximity check.
    expect(r.resolved).toBe(false);
    if (r.resolved) throw new Error("unreachable");
    expect(r.recommendedNextAction.decisionPacket?.decisionKinds).toContain(
      "classify_scope",
    );
    // The finding was NEVER auto-classified — it stays unknown.
    expect(readFinding(h, fid).scopeStatus).toBe("unknown");
    // The escalate decision's gate trace records proximityOk:false as the cause
    // (scopeUnanimous true, refuterUpheld true, but proximityOk false).
    const gateTrace =
      r.recommendedNextAction.decisionPacket?.deliberation.gateTrace;
    expect(gateTrace?.scopeUnanimous).toBe(true);
    expect(gateTrace?.refuterUpheld).toBe(true);
    expect(gateTrace?.proximityOk).toBe(false);
    // Audit rows are STILL persisted (P2k) — the escalation is auditable.
    expect(
      countRows(h, "jury_classification_proposals", fid),
    ).toBeGreaterThanOrEqual(3);
  });

  it("harness-origin still-unknown -> split -> resolved:false with a split decision packet", async () => {
    const h = makeHarness("split");
    const fid = seedFinding(h, "split", {
      source: "review",
      summary: "split finding",
      filePath: "src/a.ts",
      category: "core",
    });
    const r = await makeRunners(h, routingRunner(splitRouting())).classify("split");
    expect(r.resolved).toBe(false);
    if (r.resolved) throw new Error("unreachable");
    expect(r.recommendedNextAction.decisionPacket).toBeDefined();
    expect(r.recommendedNextAction.decisionPacket?.decisionKinds).toContain(
      "classify_scope",
    );
    // finding stays unknown (no auto classification on a split)
    expect(readFinding(h, fid).scopeStatus).toBe("unknown");
    // audit rows STILL persisted (P2k): proposals exist for the split
    expect(countRows(h, "jury_classification_proposals", fid)).toBeGreaterThanOrEqual(3);
    // The escalate must fire on a REAL scope split — the round-2 critiques are
    // VALID (strict CritiqueSchema + anti-ritualization gate accept them), so
    // all 3 round-2 proposals are `complete`, NONE inconclusive. (A malformed
    // critique would silently make them inconclusive and escalate via 3x-
    // inconclusive, masking that the split path is never exercised.)
    expect(countProposalsByRoundStatus(h, fid, 2, "complete")).toBe(3);
    expect(countProposalsByRoundStatus(h, fid, 2, "inconclusive")).toBe(0);
    // The escalate reason reflects a scope split (in_scope + out_of_scope), not
    // an all-incomplete set.
    expect(r.escalateReason).toMatch(/in_scope\(2\), out_of_scope\(1\), unknown\(0\), incomplete\(0\)/);
  });

  it("P2k: a finding classified by another path mid-run skips classifyFinding but persists audit rows", async () => {
    const h = makeHarness("midrun");
    const fid = seedFinding(h, "midrun", {
      source: "review",
      summary: "race finding",
      filePath: "src/a.ts",
      category: "core",
    });
    // route a runner that, on its FIRST codex call (a jury propose), classifies
    // the finding out-of-band so Phase 3 re-verification sees it already resolved.
    let classifiedMidRun = false;
    const racing: CodexExecRunner = {
      run: async (input) => {
        if (!classifiedMidRun) {
          classifiedMidRun = true;
          const { db, close } = openManagedDb({ dbPath: h.dbPath });
          try {
            new HitchRepository(db).classifyFinding({
              findingId: fid,
              scopeStatus: "out_of_scope",
              reason: "classified by another path",
            });
          } finally {
            close();
          }
        }
        return routingRunner(unanimousRouting("in_scope")).run(input);
      },
    };
    const r = await makeRunners(h, racing).classify("midrun");
    // the out-of-band classification stands (jury did NOT overwrite it)
    const f = readFinding(h, fid);
    expect(f.scopeStatus).toBe("out_of_scope");
    expect(f.classificationReason).toBe("classified by another path");
    // but the generated audit rows were still persisted (P2k)
    expect(countRows(h, "jury_classification_proposals", fid)).toBeGreaterThanOrEqual(3);
    expect(r.resolved).toBe(true);
  });

  it("freshness: a verified file citation whose file changes after Phase 2 escalates (no auto_confirm)", async () => {
    const h = makeHarness("stale");
    const fid = seedFinding(h, "stale", {
      source: "review",
      summary: "stale citation finding",
      filePath: "src/a.ts",
      category: "core",
    });
    // route a runner that, after producing the proposals (its last codex call is
    // the refute), DELETES the cited file so Phase 3 re-stat finds it stale.
    let calls = 0;
    const base = routingRunner(unanimousRouting("in_scope", "uphold", "src/a.ts:5"));
    const staleRunner: CodexExecRunner = {
      run: async (input) => {
        const result = await base.run(input);
        calls += 1;
        // after the refute call (the last codex invocation of deliberate),
        // truncate the file so line 5 is now out of range.
        if (input.prompt.includes("[[stage:refute]]")) {
          writeFileSync(join(h.worktree, "src", "a.ts"), "only one line\n", "utf8");
        }
        return result;
      },
    };
    const r = await makeRunners(h, staleRunner).classify("stale");
    expect(calls).toBeGreaterThan(0);
    expect(r.resolved).toBe(false);
    if (r.resolved) throw new Error("unreachable");
    // NOT auto_confirmed -> still unknown
    expect(readFinding(h, fid).scopeStatus).toBe("unknown");
    expect(r.escalateReason).toMatch(/stale|fresh/i);
  });

  it("DB is closed during Phase 2 (the jury codex runner sees no open handle)", async () => {
    const h = makeHarness("dbclosed");
    seedFinding(h, "dbclosed", {
      source: "review",
      summary: "db-closed probe",
      filePath: "src/a.ts",
      category: "core",
    });
    let openWriterDuringJury = true;
    const probing: CodexExecRunner = {
      run: async (input) => {
        // During Phase 2, the classify runner must hold NO db handle. Prove it by
        // taking an exclusive write lock from a fresh connection (succeeds iff no
        // other writer is mid-transaction on the same file).
        const { db, close } = openManagedDb({ dbPath: h.dbPath });
        try {
          db.exec("BEGIN IMMEDIATE; COMMIT;");
        } catch {
          openWriterDuringJury = false;
        } finally {
          close();
        }
        return routingRunner(unanimousRouting("in_scope")).run(input);
      },
    };
    await makeRunners(h, probing).classify("dbclosed");
    expect(openWriterDuringJury).toBe(true);
  });

  it("R14 bundled packet: a harness split + an operator-origin unknown fuse into ONE packet (plural kinds, per-finding origin, no hidden action)", async () => {
    const h = makeHarness("bundle");
    // ONE harness-origin (review) still-unknown finding the jury SPLITS, and ONE
    // operator-origin (human) unknown finding — in the SAME hitch.
    const harnessFid = seedFinding(h, "bundle", {
      source: "review",
      summary: "harness split finding",
      filePath: "src/a.ts",
      category: "core",
    });
    const operatorFid = seedFinding(h, "bundle", {
      source: "human",
      summary: "operator raised concern",
    });
    const r = await makeRunners(h, routingRunner(splitRouting())).classify("bundle");
    expect(r.resolved).toBe(false);
    if (r.resolved) throw new Error("unreachable");
    const packet = r.recommendedNextAction.decisionPacket;
    expect(packet).toBeDefined();
    if (packet === undefined) throw new Error("unreachable");

    // A single packet carries BOTH decision kinds (R14: plural decisionKinds).
    expect(packet.decisionKinds).toContain("classify_scope");
    expect(packet.decisionKinds).toContain("operator_origin_unknown");

    // Per-finding origin is correct, and the harness one carries a deliberationId.
    const harnessEntry = packet.findings.find((f) => f.findingId === harnessFid);
    const operatorEntry = packet.findings.find((f) => f.findingId === operatorFid);
    expect(harnessEntry?.origin).toBe("harness");
    expect(operatorEntry?.origin).toBe("operator");
    expect(harnessEntry?.deliberationId).toMatch(/^[0-9a-f]{64}$/);

    // nextActions cover BOTH findings — neither side's manual action is hidden.
    const actionsBlob = packet.nextActions.map((a) => a.action).join(" | ");
    expect(actionsBlob).toContain(harnessFid);
    expect(actionsBlob).toContain(operatorFid);

    // Neither finding was machine-classified (both stay unknown, fail-closed).
    expect(readFinding(h, harnessFid).scopeStatus).toBe("unknown");
    expect(readFinding(h, operatorFid).scopeStatus).toBe("unknown");
  });

  it("severity diverged on an auto_confirm: scope is classified, severity is UNCHANGED, a non-escalating severity packet is surfaced (D2b)", async () => {
    const h = makeHarness("sevdiv");
    // Seed a finding with harness severity P2; the jury unanimously agrees
    // in_scope (auto_confirm) but unanimously proposes a DIVERGENT severity P0.
    const fid = seedFinding(h, "sevdiv", {
      source: "review",
      summary: "severity-diverged finding",
      filePath: "src/a.ts",
      category: "core",
      severity: "P2",
    });
    const r = await makeRunners(
      h,
      routingRunner(severityDivergedRouting("P0")),
    ).classify("sevdiv");

    // The scope auto_confirmed -> resolved:true, finding classified in_scope.
    expect(r.resolved).toBe(true);
    if (!r.resolved) throw new Error("unreachable");
    const f = readFinding(h, fid);
    expect(f.scopeStatus).toBe("in_scope");
    // Severity is NEVER auto-modified by the advisory audit (stays P2).
    expect(f.severity).toBe("P2");

    // The non-escalating severity divergence packet is surfaced (D2b).
    expect(r.severityAuditPacket).toBeDefined();
    const packet = r.severityAuditPacket;
    if (packet === undefined) throw new Error("unreachable");
    expect(packet.decisionKinds).toContain("severity_audit");
    expect(packet.severityAudit?.status).toBe("diverged");
    expect(packet.severityAudit?.escalate).toBe(true);
    expect(packet.severityAudit?.harnessSeverity).toBe("P2");
    expect(packet.severityAudit?.juryConsensus).toBe("P0");

    // The persisted advisory severity audit row records the divergence too.
    const audit = readSeverityAudit(h, fid);
    expect(audit?.audit_status).toBe("diverged");
    expect(audit?.escalate_flag).toBe(1);
    expect(audit?.jury_severity).toBe("P0");
  });
});

describe("classify runner — cap/defer (#230 D1 / codex#252-P2)", () => {
  it("processes at most JURY_BATCH_LIMIT candidates, sets moreUnknownsPending, is NOT a no-progress escalate", async () => {
    const h = makeHarness("cap");
    // seed more harness-origin still-unknown findings than the jury cap.
    // JURY_BATCH_LIMIT is small (<= FINDING_BATCH_LIMIT). Seed 30 (cap is 25).
    const total = 30;
    for (let i = 0; i < total; i += 1) {
      seedFinding(h, "cap", {
        source: "review",
        summary: `cap finding ${i}`,
        filePath: "src/a.ts",
        category: "core",
      });
    }
    const r = await makeRunners(h, routingRunner(unanimousRouting("in_scope"))).classify(
      "cap",
    );
    expect(r.resolved).toBe(true);
    if (!r.resolved) throw new Error("unreachable");
    expect(r.moreUnknownsPending).toBe(true);
    // exactly the cap was auto_confirmed this invocation; the rest remain unknown.
    const { db, close } = openManagedDb({ dbPath: h.dbPath });
    try {
      const repo = new HitchRepository(db);
      const remaining = repo.countFindings({
        hitchId: "cap",
        scopeStatus: "unknown",
        lifecycleStatusIn: ["open", "reopened", "escalated"],
      });
      const classified = repo.countFindings({
        hitchId: "cap",
        scopeStatus: "in_scope",
      });
      expect(classified).toBe(25);
      expect(remaining).toBe(total - 25);
    } finally {
      close();
    }
  });

  it("orchestrator halts after ONE jury batch (does not run a 2nd batch up to maxSteps)", async () => {
    const h = makeHarness("cap-orch");
    const total = 30;
    for (let i = 0; i < total; i += 1) {
      seedFinding(h, "cap-orch", {
        source: "review",
        summary: `cap-orch finding ${i}`,
        filePath: "src/a.ts",
        category: "core",
      });
    }
    let classifyCalls = 0;
    const baseRunners = makeRunners(h, routingRunner(unanimousRouting("in_scope")));
    const countingRunners: OrchestratorRunners = {
      ...baseRunners,
      classify: async (hitchId) => {
        classifyCalls += 1;
        return baseRunners.classify(hitchId);
      },
    };
    const orch = new HitchOrchestrator({ dbPath: h.dbPath });
    const result = await orch.run({
      hitchId: "cap-orch",
      runners: countingRunners,
      maxSteps: 10,
      createdBy: "worker",
    });
    // exactly ONE jury batch this invocation (no second batch up to maxSteps).
    expect(classifyCalls).toBe(1);
    // it is NOT an escalation (a clean halt — partial progress).
    expect(result.outcome).not.toBe("escalated");
  });
});
