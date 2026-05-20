import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildKnowledgeCandidates } from "../../../src/reporter/knowledge-candidates.js";

const BASE = {
  runId: "run-1",
  domain: "apps/user",
  violations: [],
  secretSuspectCount: 0,
  ignoredUntrackedCount: 0,
  changedFilesCount: 2,
  codexExitCode: 0,
  codexTimedOut: false,
} as const;

function parse(yaml: string): { candidates: Array<{ kind: string }> } {
  return parseYaml(yaml) as { candidates: Array<{ kind: string }> };
}

describe("buildKnowledgeCandidates", () => {
  it("emits an empty list when a clean run made changes", () => {
    const yaml = buildKnowledgeCandidates({
      ...BASE,
      status: "needs_review",
    });
    expect(parse(yaml)).toEqual({ candidates: [] });
  });

  it("emits policy_violation when violations exist", () => {
    const yaml = buildKnowledgeCandidates({
      ...BASE,
      status: "failed-policy-violation",
      violations: [{ path: "packages/shared/foo.ts", reason: "deny_write" }],
    });
    const p = parse(yaml);
    expect(p.candidates.map((c) => c.kind)).toContain("policy_violation");
  });

  it("emits secret_suspect when secret count > 0", () => {
    const yaml = buildKnowledgeCandidates({
      ...BASE,
      status: "needs_review",
      secretSuspectCount: 2,
    });
    expect(parse(yaml).candidates.map((c) => c.kind)).toContain(
      "secret_suspect",
    );
  });

  it("emits ignored_untracked_output when ignored count > 0", () => {
    const yaml = buildKnowledgeCandidates({
      ...BASE,
      status: "needs_review",
      ignoredUntrackedCount: 3,
    });
    expect(parse(yaml).candidates.map((c) => c.kind)).toContain(
      "ignored_untracked_output",
    );
  });

  it("emits codex_no_changes when exit=0 and no diff and no violations", () => {
    const yaml = buildKnowledgeCandidates({
      ...BASE,
      status: "needs_review",
      changedFilesCount: 0,
    });
    expect(parse(yaml).candidates.map((c) => c.kind)).toContain(
      "codex_no_changes",
    );
  });

  it("does NOT emit codex_no_changes when codex itself failed (exit != 0)", () => {
    const yaml = buildKnowledgeCandidates({
      ...BASE,
      status: "failed-codex",
      changedFilesCount: 0,
      codexExitCode: 1,
    });
    expect(parse(yaml).candidates.map((c) => c.kind)).not.toContain(
      "codex_no_changes",
    );
  });

  it("does NOT emit codex_no_changes when codex timed out", () => {
    const yaml = buildKnowledgeCandidates({
      ...BASE,
      status: "failed-codex-timeout",
      changedFilesCount: 0,
      codexTimedOut: true,
      codexExitCode: -1,
    });
    expect(parse(yaml).candidates.map((c) => c.kind)).not.toContain(
      "codex_no_changes",
    );
  });

  it("can stack multiple kinds in one run", () => {
    const yaml = buildKnowledgeCandidates({
      ...BASE,
      status: "needs_review",
      secretSuspectCount: 1,
      ignoredUntrackedCount: 1,
    });
    const kinds = parse(yaml).candidates.map((c) => c.kind);
    expect(kinds).toContain("secret_suspect");
    expect(kinds).toContain("ignored_untracked_output");
  });
});
