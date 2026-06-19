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
  "src/hitch/repository.ts": 2845,
  "src/hitch/orchestrator-runners.ts": 2536,
  "src/mcp/tools/mutation-tools.ts": 2157,
  "src/cli/hitch.ts": 2136,
  "src/core/workflow-runner.ts": 1919,
  "src/mcp/tools/read-tools.ts": 1632,
  "src/db/repositories/runs.ts": 1264,
  "src/dashboard/server/server.ts": 1254,
  "src/mcp/tools/dry-run-tools.ts": 1226,
  "src/cli/db.ts": 1144,
  "src/mcp/tools/hitch-tools.ts": 1067,
  "src/core/reviewer-agent.ts": 990,
  "src/core/review-processor.ts": 961,
  "src/core/review-rule.ts": 958,
  "src/hitch/convergence.ts": 937,
  "src/cli/course.ts": 928,
  "src/cli/knowledge.ts": 813,
  "src/roadmap/course-orchestrator.ts": 809,
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
