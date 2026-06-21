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
 *
 * GATING_DIRS also covers `src/core/` (#352): close/merge/consensus decisions
 * live in src/core/merge-gate.ts, review-consensus.ts and consensus-enrichment.ts
 * too, not only src/hitch + src/roadmap. They reference NO telemetry surface
 * today; this keeps it that way.
 */
const root = repoRoot();
const paths = trackedSrcTsPaths(root);

const GATING_DIRS = ["src/hitch/", "src/roadmap/", "src/core/"];
const TELEMETRY_TABLES = /\bagent_(invocation|usage_turn)\b/;
const TELEMETRY_WRITER = /repositories\/agent-usage(\.js)?["']/;

// Single consolidated telemetry surface (#352): tables + agent-usage writer +
// transcript parser + ingest + subagent-usage reader. A gating module must
// reference NONE of these. EXTEND this when adding any agent-usage read/write
// module so the tripwire keeps covering the whole surface.
const TELEMETRY_SURFACE =
  /\bagent_(invocation|usage_turn)\b|repositories\/(agent-usage|subagent-usage)|telemetry\/(claude-transcript-parser|ingest-claude-subagent-usage)/;

function read(p: string): string {
  return readFileSync(join(root, p), "utf8");
}

describe("#206 G7: agent-usage telemetry never gates a decision", () => {
  assertEnumerationSane(paths);
  const gatingFiles = paths.filter((p) =>
    GATING_DIRS.some((d) => p.startsWith(d)),
  );

  it("enumerates the gating modules (tripwire: hitch + roadmap + core present)", () => {
    expect(gatingFiles.some((p) => p.startsWith("src/hitch/"))).toBe(true);
    expect(gatingFiles.some((p) => p.startsWith("src/roadmap/"))).toBe(true);
    expect(gatingFiles.some((p) => p.startsWith("src/core/"))).toBe(true);
    // the specific decision modules must be in scope
    for (const f of [
      "src/core/merge-gate.ts",
      "src/core/review-consensus.ts",
      "src/core/consensus-enrichment.ts",
    ]) {
      expect(gatingFiles, `${f} must be a gating file`).toContain(f);
    }
  });

  it("no gating module references ANY telemetry surface (consolidated #352)", () => {
    expect(gatingFiles.filter((p) => TELEMETRY_SURFACE.test(read(p)))).toEqual([]);
  });

  it("no gating module references the agent_invocation / agent_usage_turn tables", () => {
    expect(gatingFiles.filter((p) => TELEMETRY_TABLES.test(read(p)))).toEqual([]);
  });

  it("no gating module imports the agent-usage writer", () => {
    expect(gatingFiles.filter((p) => TELEMETRY_WRITER.test(read(p)))).toEqual([]);
  });

  it("agent-usage.ts is a leaf w.r.t. gating modules (no hitch/roadmap/core import)", () => {
    const src = read("src/db/repositories/agent-usage.ts");
    expect(/from\s+['"][^'"]*\/(hitch|roadmap|core)\//.test(src)).toBe(false);
  });

  // #235 G7: Phase-3 subagent telemetry modules (parser/ingest/reader) must
  // also be kept out of gating dirs so post-hoc transcript ingestion never
  // influences convergence or phase-readiness decisions.
  const NEW_SUBAGENT_TELEMETRY =
    /telemetry\/(claude-transcript-parser|ingest-claude-subagent-usage)|repositories\/subagent-usage/;

  it("no gating module imports the new subagent telemetry (parser/ingest/reader) (#235 G7)", () => {
    expect(gatingFiles.filter((p) => NEW_SUBAGENT_TELEMETRY.test(read(p)))).toEqual([]);
  });
});
