import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../../src/db/connection.js";
import { runMigrations } from "../../../../src/db/migrations.js";
import { HitchRepository } from "../../../../src/hitch/repository.js";
import type { HitchNextAction } from "../../../../src/hitch/types.js";
import type { HitchDecisionPacket } from "../../../../src/hitch/jury/types.js";

/**
 * #230 Task D6 (design §0.1 R6): packetVersion-discriminated decision-packet
 * read-back robustness.
 *
 * STEP 1 finding (grep): NO production reader deserializes a stored
 * `recommended_next_action` row and then accesses decision-packet internals
 * (`deliberation` / `evidence` / `findings` / `deliberationId`). The single
 * reader path — `HitchRepository.listDecisions` → `rowToDecision` —
 * `JSON.parse(...)`s the whole `recommended_next_action` opaquely (it gets the
 * `decisionPacket` for free as part of `HitchNextAction` and never touches its
 * sub-fields). The CLI `status` command passes the parsed decisions straight to
 * JSON / `formatHitchStatusLine` (the latter reads neither
 * `recommendedNextAction` nor `decisionPacket`); the MCP / CLI run summaries
 * only read `recommendedNextAction.kind` (present in v1 and v2 alike, and from a
 * fresh `ConvergenceService.evaluate()`, not a stored row); the dashboard
 * snapshot / data-source reference neither field. The only code that reads
 * packet sub-fields is `orchestrator.ts` reading a FRESHLY-built v2 packet (a
 * write path), plus the jury packet builders themselves.
 *
 * Because every reader is packet-shape-agnostic, NO production change is needed
 * for backward compatibility. These tests lock that property in: a legacy
 * `packetVersion: 1` packet (deliberation / evidence / deliberationId ABSENT)
 * and a current `packetVersion: 2` packet both survive read-back through the
 * real reader path unchanged and WITHOUT throwing.
 */

let tmpDirs: string[] = [];

function freshRepo(): { db: ReturnType<typeof openDb>; repo: HitchRepository } {
  const dir = mkdtempSync(join(tmpdir(), "harness-d6-reader-"));
  tmpDirs = [...tmpDirs, dir];
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { db, repo: new HitchRepository(db) };
}

function createGoal(repo: HitchRepository): void {
  repo.createSession({
    hitchId: "goal-d6",
    title: "D6 reader compat",
    projectId: "monorepo-harness",
    domain: "goal",
    scope: {
      targetFiles: ["src/goal/**"],
      allowedFindingCategories: ["correctness"],
    },
    closeConditions: [
      {
        id: "typecheck",
        kind: "command",
        required: true,
        description: "typecheck passes",
      },
    ],
    createdBy: "test",
    createdSource: "cli",
    createdAt: "2026-06-16T00:00:00.000Z",
  });
}

/**
 * A current rich packet (design §5.2). Typed against the live
 * `HitchDecisionPacket` so the v2 shape stays anchored to the contract.
 */
function v2Packet(): HitchDecisionPacket {
  return {
    packetVersion: 2,
    decisionKinds: ["classify_scope"],
    findings: [
      {
        findingId: "f-1",
        summary: "scope dispute",
        detail: "lenses split on scope",
        filePath: "src/a.ts",
        severity: "P2",
        scopeStatus: "unknown",
        origin: "harness",
        deliberationId: "delib-abc",
      },
    ],
    recommendation: { action: "classify_manually", rationale: "split vote" },
    evaluationAxes: [
      {
        axis: "scope_fit",
        lensVotes: [
          {
            lens: "scope_fit",
            scope: "in_scope",
            proposalStatus: "complete",
            voteChanged: false,
          },
        ],
        consensus: "split",
      },
    ],
    deliberation: {
      critiqueRan: true,
      refuter: null,
      gateTrace: {
        scopeUnanimous: false,
        lensDistinct: true,
        noInconclusive: true,
        proximityOk: true,
        refuterUpheld: false,
      },
    },
    rejectedProposals: [],
    minorityView: null,
    riskFlags: [],
    unvalidatedAssumptions: [],
    nextActions: [
      {
        owner: "operator",
        action: "classify scope manually",
        verificationMethod: "inspect diff",
      },
    ],
  };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("#230 D6: packetVersion-discriminated decision-packet read-back", () => {
  it("reads a legacy packetVersion:1 packet (deliberation/evidence/deliberationId ABSENT) without throwing", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      // A legacy escalate packet persisted by an OLDER harness version. The TS
      // `HitchDecisionPacket` type forbids `packetVersion: 1`, so this models a
      // pre-existing DB row via raw insert. deliberation / evidence /
      // findings[].deliberationId are intentionally ABSENT.
      const legacyAction = {
        kind: "ask_human",
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
          // NOTE: NO `deliberation`, NO `evidence`, NO top-level deliberationId.
        },
      };
      db.prepare(
        `INSERT INTO hitch_convergence_decisions (
             decision_id, hitch_id, cycle_id, attempt_id, decision, reason,
             metrics_json, recommended_next_action, created_at, created_by
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "decision-legacy-v1",
          "goal-d6",
          null,
          null,
          "escalate",
          "legacy escalate",
          JSON.stringify({}),
          JSON.stringify(legacyAction),
          "2026-06-16T00:00:00.000Z",
          "test",
        );

      // The real reader path must not throw on a v1 packet.
      const decisions = repo.listDecisions("goal-d6");
      expect(decisions).toHaveLength(1);

      const action = decisions[0]?.recommendedNextAction as
        | (HitchNextAction & { decisionPacket?: Record<string, unknown> })
        | null;
      expect(action).not.toBeNull();
      const packet = action?.decisionPacket as
        | Record<string, unknown>
        | undefined;
      expect(packet?.packetVersion).toBe(1);

      // packetVersion-discriminated access: the v2-only sub-fields are simply
      // absent (undefined) — accessing them via optional chaining never throws.
      const deliberation = packet?.deliberation as unknown;
      expect(deliberation).toBeUndefined();
      const findings = packet?.findings as Array<Record<string, unknown>>;
      expect(findings[0]?.deliberationId).toBeUndefined();
      // No `evidence` anywhere in a v1 lens projection either.
      expect(packet?.evaluationAxes).toBeUndefined();

      // Round-trip: the legacy JSON survives read-back byte-for-byte.
      expect(packet).toEqual(legacyAction.decisionPacket);
    } finally {
      db.close();
    }
  });

  it("reads a current packetVersion:2 packet back unchanged (deliberation/findings[].deliberationId present)", () => {
    const { db, repo } = freshRepo();
    try {
      createGoal(repo);
      const packet = v2Packet();
      const action: HitchNextAction = {
        kind: "ask_human",
        message: "manual classification required",
        findingIds: ["f-1"],
        decisionPacket: packet,
      };
      repo.recordConvergenceDecision({
        decisionId: "decision-v2",
        hitchId: "goal-d6",
        decision: "escalate",
        reason: "jury split",
        metrics: {},
        recommendedNextAction: action,
        createdBy: "test",
        createdAt: "2026-06-16T00:00:01.000Z",
      });

      const decisions = repo.listDecisions("goal-d6");
      expect(decisions).toHaveLength(1);
      const readPacket =
        decisions[0]?.recommendedNextAction?.decisionPacket;
      expect(readPacket).toBeDefined();
      // packetVersion-discriminated: a v2 packet exposes the rich sub-fields.
      expect(readPacket?.packetVersion).toBe(2);
      expect(readPacket?.deliberation.critiqueRan).toBe(true);
      expect(readPacket?.findings[0]?.deliberationId).toBe("delib-abc");
      // Full round-trip equality.
      expect(readPacket).toEqual(packet);
    } finally {
      db.close();
    }
  });
});
