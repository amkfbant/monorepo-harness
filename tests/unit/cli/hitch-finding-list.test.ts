import { describe, expect, it } from "vitest";
import { formatHitchFindingList } from "../../../src/cli/hitch/helpers.js";
import type { HitchFinding } from "../../../src/hitch/types.js";

// Minimal HitchFinding fixture — only the fields required by the type.
function makeFinding(over: Partial<HitchFinding> = {}): HitchFinding {
  return {
    findingId: "f-001",
    hitchId: "h-1",
    stableKey: "sk-001",
    duplicateOf: null,
    source: "review",
    sourceRef: null,
    sourceAttemptId: null,
    sourceCycleId: null,
    severity: "P1",
    category: "correctness",
    scopeStatus: "in_scope",
    lifecycleStatus: "open",
    summary: "off-by-one in pagination",
    detail: null,
    filePath: null,
    symbol: null,
    suggestedFix: null,
    firstSeenAt: "2026-06-20T00:00:00.000Z",
    lastSeenAt: "2026-06-20T00:00:00.000Z",
    fixedAt: null,
    deferredAt: null,
    escalatedAt: null,
    reopenCount: 0,
    deferredBacklogItemId: null,
    classificationReason: null,
    resolutionNote: null,
    ...over,
  };
}

describe("formatHitchFindingList — #90 Stage A: deferred_backlog display", () => {
  it("non-deferred finding line is byte-identical to 6 tab-separated fields", () => {
    const f = makeFinding();
    const output = formatHitchFindingList([f]);
    const expected =
      [
        f.findingId,
        f.severity,
        f.lifecycleStatus,
        f.scopeStatus,
        f.category,
        f.summary,
      ].join("\t") + "\n";
    expect(output).toBe(expected);
    // must NOT contain deferred_backlog token
    expect(output).not.toContain("deferred_backlog");
  });

  it("deferred finding line ends with \\tdeferred_backlog=<id>", () => {
    const f = makeFinding({ deferredBacklogItemId: "bk-item-0042" });
    const output = formatHitchFindingList([f]);
    const expectedLine =
      [
        f.findingId,
        f.severity,
        f.lifecycleStatus,
        f.scopeStatus,
        f.category,
        f.summary,
        "deferred_backlog=bk-item-0042",
      ].join("\t") + "\n";
    expect(output).toBe(expectedLine);
  });

  it("mixed list: deferred finding gets extra token, non-deferred does not", () => {
    const fOpen = makeFinding({ findingId: "f-open", deferredBacklogItemId: null });
    const fDeferred = makeFinding({
      findingId: "f-deferred",
      lifecycleStatus: "deferred",
      deferredBacklogItemId: "bk-99",
    });
    const lines = formatHitchFindingList([fOpen, fDeferred]).split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toContain("deferred_backlog");
    expect(lines[1]).toContain("\tdeferred_backlog=bk-99");
  });

  it("empty list returns empty string", () => {
    expect(formatHitchFindingList([])).toBe("");
  });
});
