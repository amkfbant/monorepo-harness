import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../src/db/managed-connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { HitchRepository } from "../../src/hitch/repository.js";
import { HitchOrchestrator } from "../../src/hitch/orchestrator.js";
import { createOrchestratorRunners } from "../../src/hitch/orchestrator-runners.js";
import type { OrchestratorRunners } from "../../src/hitch/orchestrator-types.js";
import type { CodexExecRunner } from "../../src/codex/codex-exec-runner.js";
import {
  routingRunner,
  routingKey,
  REFUTE_ROUTE_KEY,
  type RoutingMap,
  type RoutedResponse,
} from "../unit/hitch/jury/_fake-jury-runner.js";
import { JURY_LENSES } from "../../src/hitch/jury/types.js";
import { DEFAULT_HITCH_POLICY } from "../../src/hitch/types.js";

/**
 * #230 Task D4 — END-TO-END integration of the deliberation jury through the
 * REAL `HitchOrchestrator` loop (not the classify runner in isolation).
 *
 * Each test seeds a hitch at `needs_classification` (a completed review cycle +
 * open unknown-scope findings), wires `createOrchestratorRunners` with a
 * prompt-routing fake `reviewerRunner` (the jury's per-lens / per-stage codex),
 * and drives `orchestrator.run(...)`. This exercises the full safety chain:
 *
 *   convergence → classify action → 3-phase deliberation (DB-closed Stage1-5,
 *   pure gate) → repo.classifyFinding (auto_confirm) OR
 *   recordConvergenceDecisionWithStatus (escalate / advisory packet).
 *
 * The assertions read the DB back: classified findings, persisted jury audit
 * rows (proposals / refutation / severity_audits), and the decision packets
 * serialized into `hitch_convergence_decisions.recommended_next_action`.
 *
 * TMPDIR HYGIENE: every test registers its harness root for `afterEach` rm so
 * the suite never leaks worktrees / .harness dirs (the suite has a history of
 * TMPDIR leakage filling the disk).
 */

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

interface Harness {
  harnessRoot: string;
  dbPath: string;
  runId: string;
  worktree: string;
}

/**
 * Build a harness root with a hitch session, a succeeded coding attempt + run
 * (so the classify runner resolves the latest run's worktree), a real worktree
 * with `src/a.ts` (10 lines) for file-kind evidence, a repo policy, and a
 * COMPLETED review cycle so convergence routes `needs_classification` once an
 * open unknown-scope finding exists. Mirrors the Task D1 unit harness but is
 * driven through the full orchestrator here.
 */
function makeHarness(hitchId: string): Harness {
  const harnessRoot = mkdtempSync(join(tmpdir(), "jury-orch-e2e-"));
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
      title: "Jury orchestrate e2e",
      repoId: "t",
      domain: "docs",
      // No targetFiles → review-source findings stay `unknown` (→ jury).
      scope: {},
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
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
      severity: input.severity ?? "P2",
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
      evidence: [
        { citation, kind: "file", claim: "the change touches this line" },
      ],
      refutationCondition: "the cited line does not actually relate to the finding",
      reasoning: "the lens reasons it is " + scope,
      proposedSeverity: severity,
    }),
  };
}

/** Build a unanimous routing map (all 3 lenses propose `scope`) + refuter uphold. */
function unanimousRouting(
  scope: "in_scope" | "out_of_scope",
  citation = "src/a.ts:1",
): RoutingMap {
  const map: RoutingMap = {};
  for (const lens of JURY_LENSES) {
    map[routingKey("propose", lens)] = proposeJson(scope, citation);
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
 * Unanimous in_scope BUT a divergent severity: all 3 lenses agree in_scope
 * (auto_confirm) while unanimously proposing a different severity than the
 * harness one — the advisory severity audit then sets escalate:true while the
 * scope is still auto-confirmed (the D2b non-escalating severity-packet path).
 */
function severityDivergedRouting(
  jurySeverity: "P0" | "P1" | "P2" | "P3" | "info",
): RoutingMap {
  const map: RoutingMap = {};
  for (const lens of JURY_LENSES) {
    map[routingKey("propose", lens)] = proposeJson(
      "in_scope",
      "src/a.ts:1",
      jurySeverity,
    );
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
 * A round-2 critique for one lens objecting to each OTHER lens with a concrete,
 * JP-enum-typed objection so the strict CritiqueSchema parses AND the
 * anti-ritualization gate accepts it. The lens keeps its scope vote so the
 * final round stays genuinely split.
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
        objection: `lens ${target} overlooks an alternative reading of the cited evidence`,
      })),
      citationRelevance: [
        {
          citation: "src/a.ts:1",
          relevance: "supports my " + revisedScope + " view",
        },
      ],
      revisedScope,
      voteChanged: false,
    }),
  };
}

/**
 * A genuine scope split (2 lenses in_scope, 1 out_of_scope) whose round-2
 * critiques are valid under the strict schema + anti-ritualization gate, so the
 * final round stays split (spec_adherence out_of_scope) and the escalate fires
 * on a REAL scope split — not on 3x-inconclusive.
 */
function splitRouting(): RoutingMap {
  const map: RoutingMap = {};
  map[routingKey("propose", "correctness")] = proposeJson("in_scope");
  map[routingKey("propose", "scope_fit")] = proposeJson("in_scope");
  map[routingKey("propose", "spec_adherence")] = proposeJson("out_of_scope");
  for (const lens of JURY_LENSES) {
    const scope = lens === "spec_adherence" ? "out_of_scope" : "in_scope";
    map[routingKey("critique", lens)] = validCritique(lens, scope);
  }
  return map;
}

/**
 * The genuine RESCUE path (FIX 6): R1 is a real split (spec_adherence
 * out_of_scope, the other two in_scope), so the critique round fires. The
 * critique flips the dissenting lens to in_scope with a VALID concrete objection
 * (passes the strict CritiqueSchema + the anti-ritualization gate, voteChanged
 * true), making the round-2 set UNANIMOUS in_scope. The refuter then upholds, so
 * the deterministic gate auto_confirms. This exercises the full
 * split -> critique-flip -> unanimous-R2 -> uphold -> auto_confirm chain that the
 * earlier tests (which only assert a STAYING split, or a NO-critique unanimous
 * R1) never reach.
 */
function rescueRouting(): RoutingMap {
  const map: RoutingMap = {};
  // R1: a genuine split (one lens dissents) so critique is triggered.
  map[routingKey("propose", "correctness")] = proposeJson("in_scope");
  map[routingKey("propose", "scope_fit")] = proposeJson("in_scope");
  map[routingKey("propose", "spec_adherence")] = proposeJson("out_of_scope");
  // R2 critiques: every lens lands on in_scope; spec_adherence FLIPS its vote.
  map[routingKey("critique", "correctness")] = validCritique("correctness", "in_scope");
  map[routingKey("critique", "scope_fit")] = validCritique("scope_fit", "in_scope");
  map[routingKey("critique", "spec_adherence")] = flippingCritique(
    "spec_adherence",
    "in_scope",
  );
  // The refuter upholds the now-unanimous in_scope verdict.
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
 * Like `validCritique` but records `voteChanged: true` — the lens genuinely
 * flips its round-1 scope vote during critique (used by the rescue path so the
 * dissenting lens converges to the majority with an honest vote-change flag).
 */
function flippingCritique(
  lens: (typeof JURY_LENSES)[number],
  revisedScope: "in_scope" | "out_of_scope",
): RoutedResponse {
  const others = JURY_LENSES.filter((l) => l !== lens);
  return {
    stdout: JSON.stringify({
      objections: others.map((target) => ({
        targetLens: target,
        type: "代替仮説",
        objection: `lens ${target} overlooks an alternative reading of the cited evidence`,
      })),
      citationRelevance: [
        {
          citation: "src/a.ts:1",
          relevance: "on reflection it supports the " + revisedScope + " reading",
        },
      ],
      revisedScope,
      voteChanged: true,
    }),
  };
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

describe("hitch orchestrate + deliberation jury (e2e #230 D4)", () => {
  it("needs_classification → classify → auto_confirm: loop continues, finding classified with deliberation_id, audit rows persisted", async () => {
    const h = makeHarness("e2e-auto");
    const fid = seedFinding(h, "e2e-auto", {
      source: "review",
      summary: "ambiguous finding",
      filePath: "src/a.ts",
      category: "core",
    });

    // maxSteps:1 isolates the single classify step so the assertion measures the
    // jury path itself, not the synthetic fixture's downstream close/PR machinery
    // (the seeded run carries no reviewed fingerprint, which the PR path needs).
    // Step 1 convergence is `needs_classification` → classify, which auto_confirms
    // and resolves; the loop then halts cleanly (max_steps_exhausted, NOT escalate).
    const result = await new HitchOrchestrator({ dbPath: h.dbPath }).run({
      hitchId: "e2e-auto",
      runners: makeRunners(h, routingRunner(unanimousRouting("in_scope"))),
      maxSteps: 1,
      createdBy: "worker",
    });

    // The classify step resolved WITHOUT escalating — a clean halt, not an
    // escalation (which would surface as outcome:"escalated").
    expect(result.outcome).toBe("max_steps_exhausted");
    const classifySteps = result.steps.filter((s) => s.action === "classify");
    expect(classifySteps).toHaveLength(1);
    // detail is String(resolved) — the classify step resolved.
    expect(classifySteps[0]?.detail).toBe("true");

    // The finding is classified in the DB; the reason embeds the deliberation_id.
    const f = readFinding(h, fid);
    expect(f.scopeStatus).toBe("in_scope");
    expect(f.classificationReason).toMatch(
      /jury auto_confirm \(deliberation_id=[0-9a-f]{64}\)/,
    );

    // Jury audit rows persisted: round-1 proposals (>=3) + refutation (1) +
    // severity audit (1).
    expect(
      countRows(h, "jury_classification_proposals", fid),
    ).toBeGreaterThanOrEqual(3);
    expect(countRows(h, "jury_classification_refutations", fid)).toBe(1);
    expect(countRows(h, "jury_severity_audits", fid)).toBe(1);

    // Status synced to escalated must NOT have happened.
    const { db, close } = openManagedDb({ dbPath: h.dbPath });
    try {
      expect(new HitchRepository(db).requireSession("e2e-auto").status).not.toBe(
        "escalated",
      );
    } finally {
      close();
    }
  });

  it("RESCUE path (Round6 FIX 3): R1 split → critique FLIPS the dissenting lens → unanimous R2 → ESCALATES (the flipped lens lacks fresh evidence); both rounds persisted, refuter SKIPPED", async () => {
    const h = makeHarness("e2e-rescue");
    const fid = seedFinding(h, "e2e-rescue", {
      source: "review",
      summary: "initially-disputed finding; critique flips a vote",
      filePath: "src/a.ts",
      category: "core",
    });

    // Round6 FIX 3 (codex#254 P2, fail-closed): step 1 convergence is
    // needs_classification → classify, which runs the full Stage1-5 pipeline:
    // R1 split → critique (spec_adherence FLIPS out_of_scope → in_scope) →
    // unanimous R2. The critique round collects NO fresh citations, so the
    // flipped lens's R1 evidence is emptied — the deterministic gate's
    // allHaveVerifiedEvidence is FALSE for it and the refuter is SKIPPED
    // entirely. The deliberation therefore ESCALATES (human review), NOT
    // auto_confirm. This is the STRICTER correct behavior — a critique-driven
    // vote flip can never auto_confirm on stale evidence — NOT a weakening.
    const result = await new HitchOrchestrator({ dbPath: h.dbPath }).run({
      hitchId: "e2e-rescue",
      runners: makeRunners(h, routingRunner(rescueRouting())),
      maxSteps: 8,
      createdBy: "worker",
    });

    // The flip-converged path escalates.
    expect(result.outcome).toBe("escalated");
    const classifySteps = result.steps.filter((s) => s.action === "classify");
    expect(classifySteps).toHaveLength(1);
    // The classify step did NOT resolve (escalate path -> String(resolved)).
    expect(classifySteps[0]?.detail).toBe("false");

    // The finding stays UNKNOWN (never auto_confirmed) — it was escalated.
    const f = readFinding(h, fid);
    expect(f.scopeStatus).toBe("unknown");

    // Both rounds of proposals STILL persisted (audit rows are written
    // regardless of the decision, P2k) — the critique ran.
    const { db, close } = openManagedDb({ dbPath: h.dbPath });
    try {
      const round1 = db
        .prepare(
          `SELECT COUNT(*) AS n FROM jury_classification_proposals
             WHERE finding_id = ? AND round = 1`,
        )
        .get(fid) as { n: number };
      const round2 = db
        .prepare(
          `SELECT COUNT(*) AS n FROM jury_classification_proposals
             WHERE finding_id = ? AND round = 2`,
        )
        .get(fid) as { n: number };
      expect(round1.n).toBe(3);
      expect(round2.n).toBe(3);
      // The dissenting lens's round-2 row records the genuine vote-change.
      const flipped = db
        .prepare(
          `SELECT vote_changed, evidence_json FROM jury_classification_proposals
             WHERE finding_id = ? AND round = 2 AND lens = 'spec_adherence'`,
        )
        .get(fid) as
        | { vote_changed: number; evidence_json: string }
        | undefined;
      expect(flipped?.vote_changed).toBe(1);
      // FIX 3: the flipped lens carries NO carried-forward evidence (fail-closed).
      expect(JSON.parse(flipped?.evidence_json ?? "null")).toEqual([]);
    } finally {
      close();
    }
    // The refuter was SKIPPED (no refutation row); the advisory severity audit
    // still persisted (always written).
    expect(countRows(h, "jury_classification_refutations", fid)).toBe(0);
    expect(countRows(h, "jury_severity_audits", fid)).toBe(1);

    // The hitch escalated; an escalate decision packet was persisted.
    {
      const { db, close } = openManagedDb({ dbPath: h.dbPath });
      try {
        const repo = new HitchRepository(db);
        expect(repo.requireSession("e2e-rescue").status).toBe("escalated");
        const escalateRows = repo
          .listDecisions("e2e-rescue")
          .filter((d) => d.decision === "escalate");
        expect(escalateRows.length).toBeGreaterThanOrEqual(1);
      } finally {
        close();
      }
    }
  });

  it("needs_classification → classify → split → escalate: packetVersion:2 decision packet persisted to hitch_convergence_decisions", async () => {
    const h = makeHarness("e2e-split");
    const fid = seedFinding(h, "e2e-split", {
      source: "review",
      summary: "split finding",
      filePath: "src/a.ts",
      category: "core",
    });

    const result = await new HitchOrchestrator({ dbPath: h.dbPath }).run({
      hitchId: "e2e-split",
      runners: makeRunners(h, routingRunner(splitRouting())),
      maxSteps: 8,
      createdBy: "worker",
    });

    expect(result.outcome).toBe("escalated");

    const { db, close } = openManagedDb({ dbPath: h.dbPath });
    try {
      const repo = new HitchRepository(db);
      // The hitch escalated (status synced; default updateStatus:true).
      expect(repo.requireSession("e2e-split").status).toBe("escalated");

      // The escalate decision row was persisted with the full decision packet
      // serialized into recommended_next_action; read it back from the DB.
      const escalateRows = repo
        .listDecisions("e2e-split")
        .filter((d) => d.decision === "escalate");
      expect(escalateRows.length).toBeGreaterThanOrEqual(1);
      const persisted = escalateRows[escalateRows.length - 1]!;
      const action = persisted.recommendedNextAction;
      expect(action).not.toBeNull();
      const packet = action?.decisionPacket;
      expect(packet).toBeDefined();
      if (packet === undefined) throw new Error("unreachable");

      // packetVersion:2 + the bundled finding (with its per-finding
      // deliberationId) survived the JSON round-trip through the DB column.
      expect(packet.packetVersion).toBe(2);
      expect(packet.decisionKinds).toContain("classify_scope");
      const entry = packet.findings.find((pf) => pf.findingId === fid);
      expect(entry).toBeDefined();
      expect(entry?.origin).toBe("harness");
      expect(entry?.deliberationId).toMatch(/^[0-9a-f]{64}$/);

      // The split also persisted its jury audit rows (P2k).
      expect(
        countRows(h, "jury_classification_proposals", fid),
      ).toBeGreaterThanOrEqual(3);
    } finally {
      close();
    }
  });

  it("scope unanimous + severity diverged: finding classified (severity UNCHANGED), advisory severity packet persisted non-escalating, hitch NOT escalated", async () => {
    const h = makeHarness("e2e-sevdiv");
    // harness severity P2; the jury unanimously agrees in_scope (auto_confirm)
    // but unanimously proposes a divergent severity P0.
    const fid = seedFinding(h, "e2e-sevdiv", {
      source: "review",
      summary: "severity-diverged finding",
      filePath: "src/a.ts",
      category: "core",
      severity: "P2",
    });

    // maxSteps:1 isolates the single classify step (auto_confirm + advisory
    // severity packet) from the synthetic fixture's downstream PR machinery.
    const result = await new HitchOrchestrator({ dbPath: h.dbPath }).run({
      hitchId: "e2e-sevdiv",
      runners: makeRunners(h, routingRunner(severityDivergedRouting("P0"))),
      maxSteps: 1,
      createdBy: "worker",
    });

    // The scope auto_confirmed; the advisory severity record never escalates —
    // a clean halt after the single classify step, NOT an escalation.
    expect(result.outcome).toBe("max_steps_exhausted");

    const f = readFinding(h, fid);
    expect(f.scopeStatus).toBe("in_scope");
    // Severity is NEVER auto-modified by the advisory audit (stays P2).
    expect(f.severity).toBe("P2");

    const { db, close } = openManagedDb({ dbPath: h.dbPath });
    try {
      const repo = new HitchRepository(db);
      // hitch status UNCHANGED (not escalated) — updateStatus:false advisory.
      expect(repo.requireSession("e2e-sevdiv").status).not.toBe("escalated");

      // A non-escalating advisory decision (NOT "escalate") carrying the
      // severityAudit packet was persisted exactly once.
      const advisoryRows = repo
        .listDecisions("e2e-sevdiv")
        .filter(
          (d) =>
            d.decision !== "escalate" &&
            d.recommendedNextAction?.decisionPacket?.severityAudit !== undefined,
        );
      expect(advisoryRows).toHaveLength(1);
      const packet = advisoryRows[0]!.recommendedNextAction!.decisionPacket!;
      expect(packet.packetVersion).toBe(2);
      expect(packet.decisionKinds).toContain("severity_audit");
      expect(packet.severityAudit?.status).toBe("diverged");
      expect(packet.severityAudit?.escalate).toBe(true);
      expect(packet.severityAudit?.harnessSeverity).toBe("P2");
      expect(packet.severityAudit?.juryConsensus).toBe("P0");

      // No escalate decision row was ever written by this advisory path.
      expect(
        repo.listDecisions("e2e-sevdiv").some((d) => d.decision === "escalate"),
      ).toBe(false);

      // The persisted advisory severity audit row records the divergence too.
      const auditRow = db
        .prepare(
          `SELECT audit_status, escalate_flag, jury_severity
           FROM jury_severity_audits WHERE finding_id = ?`,
        )
        .get(fid) as
        | {
            audit_status: string;
            escalate_flag: number;
            jury_severity: string | null;
          }
        | undefined;
      expect(auditRow?.audit_status).toBe("diverged");
      expect(auditRow?.escalate_flag).toBe(1);
      expect(auditRow?.jury_severity).toBe("P0");
    } finally {
      close();
    }
  });

  it("R6: a legacy packetVersion:1 row in recommended_next_action reads back without breaking", async () => {
    const h = makeHarness("e2e-v1");
    // A legacy escalate packet persisted by an OLDER harness version. The TS
    // `HitchDecisionPacket` type forbids packetVersion:1, so this models a
    // pre-existing DB row via raw insert. deliberation / evaluationAxes /
    // findings[].deliberationId are intentionally ABSENT.
    const legacyAction = {
      kind: "classify_findings",
      message: "manual classification required",
      findingIds: ["f-legacy"],
      decisionPacket: {
        packetVersion: 1,
        decisionKinds: ["classify_scope"],
        findings: [
          {
            findingId: "f-legacy",
            summary: "old scope dispute",
            // NOTE: NO deliberationId — v1 packets predate per-finding linkage.
          },
        ],
        recommendation: {
          action: "classify_manually",
          rationale: "legacy split",
        },
        // NOTE: NO `deliberation`, NO `evaluationAxes`, NO `severityAudit`.
      },
    };
    {
      const { db, close } = openManagedDb({ dbPath: h.dbPath });
      try {
        db.prepare(
          `INSERT INTO hitch_convergence_decisions (
               decision_id, hitch_id, cycle_id, attempt_id, decision, reason,
               metrics_json, recommended_next_action, created_at, created_by
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          "decision-legacy-v1",
          "e2e-v1",
          null,
          null,
          "escalate",
          "legacy escalate",
          JSON.stringify({}),
          JSON.stringify(legacyAction),
          "2026-06-16T00:00:00.000Z",
          "test",
        );
      } finally {
        close();
      }
    }

    // The real reader path (listDecisions → rowToDecision → JSON.parse) must not
    // throw on a v1 packet, and the v2-only sub-fields are simply absent.
    const { db, close } = openManagedDb({ dbPath: h.dbPath });
    try {
      const decisions = new HitchRepository(db).listDecisions("e2e-v1");
      const legacy = decisions.find((d) => d.decisionId === "decision-legacy-v1");
      expect(legacy).toBeDefined();
      const packet = legacy?.recommendedNextAction?.decisionPacket as
        | (Record<string, unknown> & { packetVersion?: number })
        | undefined;
      expect(packet?.packetVersion).toBe(1);
      // v2-only sub-fields are undefined (optional-chaining access never throws).
      expect(packet?.deliberation).toBeUndefined();
      expect(packet?.evaluationAxes).toBeUndefined();
      const findings = packet?.findings as Array<Record<string, unknown>>;
      expect(findings[0]?.deliberationId).toBeUndefined();
      // Round-trip: the legacy JSON survives read-back unchanged.
      expect(packet).toEqual(legacyAction.decisionPacket);
    } finally {
      close();
    }
  });
});
