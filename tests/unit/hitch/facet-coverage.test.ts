import { describe, expect, it } from "vitest";
import {
  evaluateFacetRedCoverage,
  parseFacetRule,
  type FacetRedEvidence,
} from "../../../src/hitch/facet-coverage.js";

const RUN = "run-close";

function evidence(overrides: Partial<FacetRedEvidence> = {}): FacetRedEvidence {
  return {
    facetId: "auth-login",
    redTestPath: "tests/auth/login.test.ts",
    redDemonstrated: true,
    runId: RUN,
    ...overrides,
  };
}

describe("parseFacetRule", () => {
  it("parses a well-formed facets[] contract", () => {
    const parsed = parseFacetRule({
      facets: [
        {
          id: "auth-login",
          testGlobs: ["tests/auth/**"],
          changedFileGlobs: ["src/auth/**"],
        },
      ],
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.facets).toHaveLength(1);
    expect(parsed.facets[0]?.id).toBe("auth-login");
    expect(parsed.facets[0]?.testGlobs).toEqual(["tests/auth/**"]);
    expect(parsed.facets[0]?.changedFileGlobs).toEqual(["src/auth/**"]);
  });

  it("fail-closed: undefined rule yields an error (never silently empty)", () => {
    const parsed = parseFacetRule(undefined);
    expect(parsed.facets).toEqual([]);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("fail-closed: rule.facets not an array yields an error", () => {
    const parsed = parseFacetRule({ facets: "tests/**" });
    expect(parsed.facets).toEqual([]);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("fail-closed: facet missing id is an error (never dropped silently)", () => {
    const parsed = parseFacetRule({
      facets: [{ testGlobs: ["tests/auth/**"] }],
    });
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("fail-closed: facet with empty testGlobs is an error", () => {
    const parsed = parseFacetRule({
      facets: [{ id: "auth-login", testGlobs: [] }],
    });
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("fail-closed: facet with non-string test glob is an error", () => {
    const parsed = parseFacetRule({
      facets: [{ id: "auth-login", testGlobs: [42] }],
    });
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  it("fail-closed: duplicate facet ids is an error", () => {
    const parsed = parseFacetRule({
      facets: [
        { id: "auth-login", testGlobs: ["tests/auth/**"] },
        { id: "auth-login", testGlobs: ["tests/auth/other.test.ts"] },
      ],
    });
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

describe("evaluateFacetRedCoverage", () => {
  it("passes: changed test matches testGlobs AND RED evidence from the close run", () => {
    const result = evaluateFacetRedCoverage({
      facets: [
        { id: "auth-login", testGlobs: ["tests/auth/**"], changedFileGlobs: ["src/auth/**"] },
      ],
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      evidence: [evidence()],
      runId: RUN,
    });
    expect(result.status).toBe("passed");
    expect(result.perFacet[0]?.status).toBe("passed");
  });

  it("FAILS (fail-open shape): production surface changed but NO covering test changed", () => {
    const result = evaluateFacetRedCoverage({
      facets: [
        { id: "auth-login", testGlobs: ["tests/auth/**"], changedFileGlobs: ["src/auth/**"] },
      ],
      changedPaths: ["src/auth/login.ts"],
      evidence: [],
      runId: RUN,
    });
    expect(result.status).toBe("failed");
    expect(result.perFacet[0]?.status).toBe("failed");
    expect(result.perFacet[0]?.reason).toMatch(/no covering test/i);
  });

  it("FAILS: matching test path present but NO RED demonstration recorded for this run", () => {
    const result = evaluateFacetRedCoverage({
      facets: [
        { id: "auth-login", testGlobs: ["tests/auth/**"], changedFileGlobs: ["src/auth/**"] },
      ],
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      evidence: [],
      runId: RUN,
    });
    expect(result.status).toBe("failed");
    expect(result.perFacet[0]?.reason).toMatch(/RED not demonstrated/i);
  });

  it("FAILS (stale): RED evidence from a different (prior approved) run does NOT count", () => {
    const result = evaluateFacetRedCoverage({
      facets: [
        { id: "auth-login", testGlobs: ["tests/auth/**"], changedFileGlobs: ["src/auth/**"] },
      ],
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      evidence: [evidence({ runId: "run-prior-approved" })],
      runId: RUN,
    });
    expect(result.status).toBe("failed");
  });

  it("FAILS: redDemonstrated:false evidence is not counted", () => {
    const result = evaluateFacetRedCoverage({
      facets: [
        { id: "auth-login", testGlobs: ["tests/auth/**"], changedFileGlobs: ["src/auth/**"] },
      ],
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      evidence: [evidence({ redDemonstrated: false })],
      runId: RUN,
    });
    expect(result.status).toBe("failed");
  });

  it("FAILS: evidence redTestPath does not match a changed test path", () => {
    const result = evaluateFacetRedCoverage({
      facets: [
        { id: "auth-login", testGlobs: ["tests/auth/**"], changedFileGlobs: ["src/auth/**"] },
      ],
      changedPaths: ["src/auth/login.ts", "tests/auth/login.test.ts"],
      evidence: [evidence({ redTestPath: "tests/auth/NOT-changed.test.ts" })],
      runId: RUN,
    });
    expect(result.status).toBe("failed");
  });

  it("pending: empty facets[] (nothing contracted) is never passed", () => {
    const result = evaluateFacetRedCoverage({
      facets: [],
      changedPaths: ["src/auth/login.ts"],
      evidence: [],
      runId: RUN,
    });
    expect(result.status).toBe("pending");
  });

  it("multiple facets: one failing makes the condition fail", () => {
    const result = evaluateFacetRedCoverage({
      facets: [
        { id: "auth-login", testGlobs: ["tests/auth/**"], changedFileGlobs: ["src/auth/**"] },
        { id: "auth-logout", testGlobs: ["tests/logout/**"], changedFileGlobs: ["src/logout/**"] },
      ],
      changedPaths: [
        "src/auth/login.ts",
        "tests/auth/login.test.ts",
        "src/logout/logout.ts",
      ],
      evidence: [evidence()],
      runId: RUN,
    });
    expect(result.status).toBe("failed");
  });

  it("multiple facets: all passing makes the condition pass", () => {
    const result = evaluateFacetRedCoverage({
      facets: [
        { id: "auth-login", testGlobs: ["tests/auth/**"], changedFileGlobs: ["src/auth/**"] },
        { id: "auth-logout", testGlobs: ["tests/logout/**"], changedFileGlobs: ["src/logout/**"] },
      ],
      changedPaths: [
        "src/auth/login.ts",
        "tests/auth/login.test.ts",
        "src/logout/logout.ts",
        "tests/logout/logout.test.ts",
      ],
      evidence: [
        evidence(),
        evidence({
          facetId: "auth-logout",
          redTestPath: "tests/logout/logout.test.ts",
        }),
      ],
      runId: RUN,
    });
    expect(result.status).toBe("passed");
  });

  it("glob is root-anchored (minimatch): tests/** does NOT match nested src/auth/tests", () => {
    const result = evaluateFacetRedCoverage({
      facets: [{ id: "x", testGlobs: ["tests/**"], changedFileGlobs: ["src/**"] }],
      // a test file NOT under the root tests/ dir must not satisfy the contract
      changedPaths: ["src/auth/login.ts", "src/auth/tests/login.test.ts"],
      evidence: [
        evidence({
          facetId: "x",
          redTestPath: "src/auth/tests/login.test.ts",
        }),
      ],
      runId: RUN,
    });
    expect(result.status).toBe("failed");
    expect(result.perFacet[0]?.reason).toMatch(/no covering test/i);
  });

  it("facet without changedFileGlobs: no production-touch claim, pending until test+RED", () => {
    const result = evaluateFacetRedCoverage({
      facets: [{ id: "x", testGlobs: ["tests/x/**"] }],
      changedPaths: ["src/x/x.ts"],
      evidence: [],
      runId: RUN,
    });
    // production-touch unknown (no changedFileGlobs) and no test => pending, not failed
    expect(result.status).toBe("pending");
  });

  it("exposes a deterministic reasonCode discriminator per facet", () => {
    const failOpen = evaluateFacetRedCoverage({
      facets: [{ id: "x", testGlobs: ["tests/x/**"], changedFileGlobs: ["src/x/**"] }],
      changedPaths: ["src/x/x.ts"],
      evidence: [],
      runId: RUN,
    });
    expect(failOpen.perFacet[0]?.reasonCode).toBe("fail_open_shape");

    const noRed = evaluateFacetRedCoverage({
      facets: [{ id: "x", testGlobs: ["tests/x/**"], changedFileGlobs: ["src/x/**"] }],
      changedPaths: ["src/x/x.ts", "tests/x/x.test.ts"],
      evidence: [],
      runId: RUN,
    });
    expect(noRed.perFacet[0]?.reasonCode).toBe("red_not_demonstrated");
  });
});
