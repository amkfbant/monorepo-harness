import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, trackedSrcTsPaths, assertEnumerationSane } from "./_helpers.js";

/**
 * #206 G7 — agent-usage telemetry is WRITE-ONLY and must never feed a gate.
 *
 * Safety boundary (`CLAUDE.md` / `GOAL_RULES.md` §G): state transitions are
 * decided by deterministic harness logic, never by self-reported usage. The
 * convergence controller (`src/hitch/**`) and the phase-readiness rollup
 * (`src/roadmap/**`) decide close/converge from findings + convergence records
 * ONLY. `derivePhaseReadiness` takes `{hitchConvergences, derivedOpenP0/P1}` —
 * no token input; `rollup.tokenTotals` is a derived projection over the legacy
 * `run_usage`, not a gate input.
 *
 * This meta-test fails closed if a future edit pulls the new telemetry tables
 * (`agent_invocation` / `agent_usage_turn`) or the `agent-usage` writer into a
 * gating module — which would let usage data influence a decision.
 */
const root = repoRoot();
const paths = trackedSrcTsPaths(root);

const GATING_DIRS = ["src/hitch/", "src/roadmap/"];
const TELEMETRY_TABLES = /\bagent_(invocation|usage_turn)\b/;
const TELEMETRY_WRITER = /repositories\/agent-usage(\.js)?["']/;

function read(p: string): string {
  return readFileSync(join(root, p), "utf8");
}

describe("#206 G7: agent-usage telemetry never gates a decision", () => {
  assertEnumerationSane(paths);
  const gatingFiles = paths.filter((p) =>
    GATING_DIRS.some((d) => p.startsWith(d)),
  );

  it("enumerates the gating modules (tripwire: hitch + roadmap present)", () => {
    expect(gatingFiles.some((p) => p.startsWith("src/hitch/"))).toBe(true);
    expect(gatingFiles.some((p) => p.startsWith("src/roadmap/"))).toBe(true);
  });

  it("no gating module references the agent_invocation / agent_usage_turn tables", () => {
    expect(gatingFiles.filter((p) => TELEMETRY_TABLES.test(read(p)))).toEqual([]);
  });

  it("no gating module imports the agent-usage writer", () => {
    expect(gatingFiles.filter((p) => TELEMETRY_WRITER.test(read(p)))).toEqual([]);
  });

  it("agent-usage.ts is a leaf w.r.t. gating modules (no hitch/roadmap import)", () => {
    const src = read("src/db/repositories/agent-usage.ts");
    expect(/from\s+['"][^'"]*\/(hitch|roadmap)\//.test(src)).toBe(false);
  });
});
