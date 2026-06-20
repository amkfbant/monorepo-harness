import { describe, it, expect } from "vitest";
import { listTrackedSrcSizes } from "./_helpers.js";

/**
 * src ファイルサイズの cap（#125 RP2: cohesion-first + 800 行 HARD cap）。
 *
 * - 800 行超は分割を強制する HARD cap（review/diff 粒度が破綻するため）。
 * - 既に 800 超のファイルは grandfather として現サイズを baseline 化し ratchet
 *   （増やさない・縮めると締まる）。新規・縮小済は 800 以下。
 * - schema.ts / tool-registry.ts は append-only の宣言的台帳ゆえ構造的恒久例外。
 */

const HARD_CAP = 800;

const STRUCTURAL_EXEMPT = new Set<string>([
  "src/db/schema.ts",
  "src/mcp/registry/tool-registry.ts",
]);

const GRANDFATHER: Record<string, number> = {
  // src/hitch/repository.ts removed from the ratchet: #125 Track C (C0-C7) split
  // the frozen 2845-line core into per-concern sub-repos under
  // src/hitch/repositories/, shrinking the facade to a thin delegator well under
  // the 800 HARD cap. Per this test's own rule (≤800 ⇒ drop the grandfather), it
  // is now held to the cap like any other file.
  "src/hitch/orchestrator-runners.ts": 2536,
  "src/mcp/tools/mutation-tools.ts": 2157,
  // src/cli/hitch.ts removed from the ratchet: #125 A15 split the command group
  // into 5 sub-registrars under src/cli/hitch/ (lifecycle / attempt / finding /
  // review / convergence) + a shared hitch/helpers.ts, leaving the registrar a
  // thin orchestrator under the 800 cap.
  "src/core/workflow-runner.ts": 1919,
  // src/mcp/tools/read-tools.ts removed from the ratchet: #125 A15 split the
  // 1632-line read MCP tool module into a barrel re-exporting per-domain modules
  // (read-{project,run,catalog,system}-tools.ts + read-resolve.ts) over a shared
  // leaf (read-types.ts) and an internal helper layer (read-helpers.ts), leaving
  // each well under the 800 cap.
  // src/db/repositories/runs.ts removed from the ratchet: #125 A15 extracted the
  // DTO types (runs-types.ts, cycle-breaking leaf) and the two heaviest FROZEN
  // write methods — forceFailFinalize (lease-guard bypass) and applyReviewDecision
  // (IMMEDIATE tx) — into RunFinalizeRepository (runs-finalize-repository.ts), to
  // which the RunRepository facade delegates, leaving the class under the 800 cap.
  // src/dashboard/server/server.ts removed from the ratchet: #125 A15 split the
  // 1254-line dashboard server. The 820-line defaultRoutes() route table is split
  // by domain into server-routes-data.ts (operations/assets/storage/runs) and
  // server-routes-review.ts (review/artifacts/db/locks/snapshot), composed in order;
  // shared types → server-types.ts (leaf), route matching + JSON helpers →
  // server-routing.ts, the auth gate → server-auth.ts. server.ts keeps
  // defaultRoutes()/buildListener/createDashboardServer under the 800 cap.
  // src/mcp/tools/dry-run-tools.ts removed from the ratchet: #125 A15 split the
  // 1226-line dry-run/preview MCP tool module into a barrel re-exporting per-domain
  // modules (dry-run-{project,run,db}-tools.ts) over a shared leaf (dry-run-types.ts),
  // an internal helper layer (dry-run-helpers.ts), and the doctor-finding→project
  // resolver (dry-run-doctor-projects.ts, re-exported for mutation-tools), leaving
  // each well under the 800 cap.
  // src/cli/db.ts removed from the ratchet: #125 A15 split the 1144-line command
  // group into per-concern sub-modules under src/cli/db/ (schema / maintenance /
  // archive / doctor / blob + shared/blob-helpers), shrinking the registrar to a
  // thin orchestrator well under the 800 cap. Per this test's own rule (≤800 ⇒
  // drop the grandfather), it is now held to the cap like any other file.
  // src/mcp/tools/hitch-tools.ts removed from the ratchet: #125 A15 split the
  // 1067-line hitch MCP tool module into a barrel re-exporting per-concern modules
  // (hitch-tools-read / hitch-tools-mutation [the db.transaction().immediate()
  // atomic seam]) over a shared leaf (hitch-tools-types) and an internal helper
  // layer (hitch-tools-helpers), leaving each well under the 800 cap.
  // src/core/reviewer-agent.ts removed from the ratchet: #125 A15 extracted the
  // public API types (reviewer-agent-types.ts, the cycle-breaking leaf), the
  // prompt construction incl. the sha256-pinned PROMPT_PREAMBLE
  // (reviewer-agent-prompt.ts), the codex-output → ReviewDecisionFile boundary
  // (reviewer-agent-decision.ts), and the token-usage telemetry
  // (reviewer-agent-usage.ts), leaving runReviewerAgent + consensus re-eval
  // under the 800 cap.
  // src/core/review-processor.ts removed from the ratchet: #125 A15 extracted the
  // shared error/result types (review-processor-types.ts) and the override/consensus
  // path implementations (review-processor-paths.ts), leaving the orchestration
  // entrypoints under the 800 cap.
  // src/core/review-rule.ts removed from the ratchet: #125 A15 extracted the
  // types/errors/DEFAULT + the shared assertCompiledReviewRuleInvariants
  // (review-rule-types.ts, the cycle-breaking leaf) and the snapshot read-back
  // boundary (review-rule-snapshot.ts), leaving compile/serialise/accessors under
  // the 800 cap.
  "src/hitch/convergence.ts": 937,
  // src/cli/course.ts removed from the ratchet: #125 A15 split the command group
  // into per-concern sub-modules under src/cli/course/ (course / phase commands +
  // shared helpers), leaving the registrar a thin orchestrator under the 800 cap.
  // src/cli/knowledge.ts removed from the ratchet: #125 A15 split the command
  // group into per-concern sub-modules under src/cli/knowledge/ (entry / ops /
  // digest), leaving the registrar a thin orchestrator under the 800 cap.
  // src/roadmap/course-orchestrator.ts removed from the ratchet: #125 A15 extracted
  // the shared types/error + free helpers into course-orchestrator-types.ts /
  // course-orchestrator-helpers.ts, leaving the class file under the 800 cap.
};

describe("src file-size cap (#125 RP2)", () => {
  const sizes = listTrackedSrcSizes();

  it("新規・非 grandfather ファイルは 800 行以下", () => {
    const over = sizes
      .filter(
        (s) =>
          s.loc > HARD_CAP &&
          !STRUCTURAL_EXEMPT.has(s.path) &&
          !(s.path in GRANDFATHER),
      )
      .map((s) => `${s.path}:${s.loc}`);
    expect(over).toEqual([]);
  });

  it("grandfather ファイルは baseline を超えない（ratchet）", () => {
    const grown = sizes
      .filter((s) => s.path in GRANDFATHER && s.loc > GRANDFATHER[s.path])
      .map((s) => `${s.path}:${s.loc}>${GRANDFATHER[s.path]}`);
    expect(grown).toEqual([]);
  });

  it("baseline が陳腐化していない（800 以下に縮めたら grandfather から外す）", () => {
    const shrunkToCap = sizes
      .filter((s) => s.path in GRANDFATHER && s.loc <= HARD_CAP)
      .map((s) => s.path);
    expect(shrunkToCap).toEqual([]);
  });
});
