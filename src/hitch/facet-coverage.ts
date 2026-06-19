import { minimatch } from "minimatch";
import { UNTRACKED_MATCH_OPTS } from "../policy/untracked-filter.js";

/**
 * A contracted facet of the hitch's deliverable — a unit of behaviour that the
 * close-conditions require a RED test for. `testGlobs` declare where the
 * covering test must live; the optional `changedFileGlobs` anchor the production
 * surface (so a touched surface with no covering test is a deterministic
 * fail-open shape). Globs are matched with the harness-standard root-anchored
 * minimatch options (see docs/policy-semantics.md) — author them with a
 * leading globstar-slash for "anywhere in the repo".
 */
export interface FacetSpec {
  id: string;
  testGlobs: string[];
  changedFileGlobs?: string[];
  description?: string;
}

/**
 * Operator/runner-recorded proof that a facet's covering test demonstrated RED
 * (failed before the fix) in a SPECIFIC run. Bound to `runId` so a prior
 * approved run's evidence cannot satisfy a re-opened hitch.
 */
export interface FacetRedEvidence {
  facetId: string;
  redTestPath: string;
  redDemonstrated: boolean;
  runId: string;
  evidenceRef?: string;
}

export interface ParsedFacetRule {
  facets: FacetSpec[];
  errors: string[];
}

export type FacetCoverageStatus = "passed" | "failed" | "pending";

/**
 * Why a facet landed at its status. `fail_open_shape` (production surface
 * changed with no covering test) is a hard, evidence-independent FAIL — the
 * exact depth gap #279 closes. `red_not_demonstrated` means a covering test
 * changed but no corroborating RED evidence was found; this is only a hard FAIL
 * when an evidence row was expected (a recorded check exists), otherwise it is
 * recoverable (pending) until evidence is recorded.
 */
export type FacetReasonCode =
  | "passed"
  | "fail_open_shape"
  | "red_not_demonstrated"
  | "no_change";

export interface PerFacetCoverage {
  facetId: string;
  status: FacetCoverageStatus;
  reasonCode: FacetReasonCode;
  reason: string;
}

export interface FacetCoverageResult {
  status: FacetCoverageStatus;
  perFacet: PerFacetCoverage[];
  message: string;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((v) => typeof v === "string" && v !== "")
  );
}

/**
 * Fail-closed parse of `condition.rule.facets[]`. Any malformed entry yields an
 * error (never silently dropped) so a malformed contract can NEVER evaluate to
 * passed. Returns the well-formed facets it could parse alongside the errors;
 * callers must treat a non-empty `errors` as a hard failure.
 */
export function parseFacetRule(
  rule: Record<string, unknown> | undefined,
): ParsedFacetRule {
  const errors: string[] = [];
  if (rule === undefined || rule === null) {
    return { facets: [], errors: ["facet_red_test rule is missing"] };
  }
  const rawFacets = rule.facets;
  if (!Array.isArray(rawFacets)) {
    return {
      facets: [],
      errors: ["facet_red_test rule.facets must be a non-empty array"],
    };
  }
  if (rawFacets.length === 0) {
    return {
      facets: [],
      errors: ["facet_red_test rule.facets must declare at least one facet"],
    };
  }
  const facets: FacetSpec[] = [];
  const seen = new Set<string>();
  rawFacets.forEach((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      errors.push(`facet[${index}] must be an object`);
      return;
    }
    const entry = raw as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== "string" || id.trim() === "") {
      errors.push(`facet[${index}] is missing a non-empty string id`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`facet id ${id} is duplicated`);
      return;
    }
    seen.add(id);
    if (!isStringArray(entry.testGlobs) || entry.testGlobs.length === 0) {
      errors.push(`facet ${id} requires a non-empty testGlobs[] of strings`);
      return;
    }
    if (
      entry.changedFileGlobs !== undefined &&
      !isStringArray(entry.changedFileGlobs)
    ) {
      errors.push(`facet ${id} changedFileGlobs must be an array of strings`);
      return;
    }
    facets.push({
      id,
      testGlobs: [...entry.testGlobs],
      ...(entry.changedFileGlobs !== undefined
        ? { changedFileGlobs: [...entry.changedFileGlobs] }
        : {}),
      ...(typeof entry.description === "string"
        ? { description: entry.description }
        : {}),
    });
  });
  return { facets, errors };
}

function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => minimatch(path, g, UNTRACKED_MATCH_OPTS));
}

/**
 * Deterministic per-facet RED-coverage evaluation. NEVER consults LLM/reviewer
 * output: it reasons only over the run's changed paths (run_changed_files) and
 * the recorded RED evidence. Fail-closed at every junction — a facet only
 * PASSES when (a) a changed test path matches its testGlobs AND (b) recorded
 * RED evidence proves a RED demonstration for THAT facet, from THIS run, on a
 * changed test path. A facet FAILS when its production surface changed but no
 * covering test changed (the fail-open shape). Anything else (missing/partial
 * evidence, no production-touch claim and no test) is pending. Never passed on
 * missing inputs.
 */
export function evaluateFacetRedCoverage(input: {
  facets: readonly FacetSpec[];
  changedPaths: readonly string[];
  evidence: readonly FacetRedEvidence[];
  runId: string;
}): FacetCoverageResult {
  if (input.facets.length === 0) {
    return {
      status: "pending",
      perFacet: [],
      message: "no contracted facets declared",
    };
  }
  const perFacet = input.facets.map((facet) =>
    evaluateOneFacet(facet, input.changedPaths, input.evidence, input.runId),
  );
  const status: FacetCoverageStatus = perFacet.some((f) => f.status === "failed")
    ? "failed"
    : perFacet.some((f) => f.status === "pending")
      ? "pending"
      : "passed";
  return {
    status,
    perFacet,
    message: summarise(status, perFacet),
  };
}

function evaluateOneFacet(
  facet: FacetSpec,
  changedPaths: readonly string[],
  evidence: readonly FacetRedEvidence[],
  runId: string,
): PerFacetCoverage {
  const matchedTestPaths = changedPaths.filter((p) =>
    matchesAny(p, facet.testGlobs),
  );
  const productionTouched =
    facet.changedFileGlobs !== undefined &&
    changedPaths.some((p) => matchesAny(p, facet.changedFileGlobs ?? []));

  if (matchedTestPaths.length === 0) {
    // Fail-open shape: a production surface was touched with no covering test.
    if (productionTouched) {
      return {
        facetId: facet.id,
        status: "failed",
        reasonCode: "fail_open_shape",
        reason: "production surface changed, no covering test",
      };
    }
    return {
      facetId: facet.id,
      status: "pending",
      reasonCode: "no_change",
      reason: "no covering test changed and no production surface touched",
    };
  }

  const redEvidence = evidence.find(
    (e) =>
      e.facetId === facet.id &&
      e.redDemonstrated === true &&
      e.runId === runId &&
      matchedTestPaths.includes(e.redTestPath),
  );
  if (redEvidence === undefined) {
    return {
      facetId: facet.id,
      status: "failed",
      reasonCode: "red_not_demonstrated",
      reason: "covering test changed but RED not demonstrated for this run",
    };
  }
  return {
    facetId: facet.id,
    status: "passed",
    reasonCode: "passed",
    reason: "RED test demonstrated",
  };
}

function summarise(
  status: FacetCoverageStatus,
  perFacet: readonly PerFacetCoverage[],
): string {
  if (status === "passed") {
    return `all ${perFacet.length} contracted facet(s) have a demonstrated RED test`;
  }
  const offenders = perFacet
    .filter((f) => f.status !== "passed")
    .map((f) => `${f.facetId}: ${f.reason}`)
    .join("; ");
  return `${status}: ${offenders}`;
}
