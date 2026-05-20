import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildKnowledgeCandidates } from "../../../src/reporter/knowledge-candidates.js";

describe("buildKnowledgeCandidates", () => {
  it("emits an empty 'candidates' list on a clean success run", () => {
    const yaml = buildKnowledgeCandidates({
      runId: "run-1",
      domain: "apps/user",
      status: "success",
      violations: [],
    });
    expect(parseYaml(yaml)).toEqual({ candidates: [] });
  });

  it("includes a policy_improvement candidate when violations exist", () => {
    const yaml = buildKnowledgeCandidates({
      runId: "run-2",
      domain: "apps/user",
      status: "failed-policy-violation",
      violations: [{ path: "packages/shared/foo.ts", reason: "deny_write" }],
    });
    const parsed = parseYaml(yaml) as { candidates: Array<{ kind: string }> };
    expect(parsed.candidates.length).toBeGreaterThan(0);
    expect(parsed.candidates[0]?.kind).toBe("policy_improvement");
  });
});
