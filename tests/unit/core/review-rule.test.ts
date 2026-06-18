import { describe, expect, it } from "vitest";
import {
  compileProfileReviewRule,
  DEFAULT_REVIEW_RULE,
  dispatchRequirementsForRule,
  frozenReviewerIdsForRule,
  parseReviewRuleSnapshot,
  resolveEffectiveRule,
  ReviewRuleCompileError,
  ReviewRuleSnapshotError,
  ruleSha256,
  type ReviewRule,
} from "../../../src/core/review-rule.js";
import { ProjectProfileSchema } from "../../../src/project/schema.js";

function profile(review?: unknown) {
  return ProjectProfileSchema.parse({
    version: 1,
    project_id: "demo",
    repo: { id: "demo", path: "../demo" },
    policy: { template: "strict-monorepo-v1" },
    ...(review !== undefined ? { review } : {}),
    domains: [{ id: "apps/web", root: "apps/web", kind: "app" }],
  });
}

describe("compileProfileReviewRule", () => {
  it("returns the default rule when review is missing", () => {
    expect(compileProfileReviewRule(profile())).toEqual(DEFAULT_REVIEW_RULE);
  });

  it("throws a typed error instead of falling back for consensus without requirements", () => {
    expect(() =>
      compileProfileReviewRule(profile({ mode: "consensus" })),
    ).toThrow(ReviewRuleCompileError);
    expect(() =>
      compileProfileReviewRule(profile({ mode: "consensus" })),
    ).toThrow(/consensus mode requires at least one requirement/);
  });

  it("throws when requirements are declared but mode is not consensus (fail-closed, no silent gate drop)", () => {
    // mode omitted → defaults to latest-proposal; requirements would be
    // snapshotted then ignored at runtime, silently dropping the quorum gate.
    expect(() =>
      compileProfileReviewRule(
        profile({
          requirements: [
            {
              group: "reviewers",
              min_approvals: 2,
              blocking_decisions: ["changes_requested"],
              reviewer_ids: ["alice", "bob"],
              lens_axes: ["correctness", "scope_fit"],
            },
          ],
        }),
      ),
    ).toThrow(ReviewRuleCompileError);
    expect(() =>
      compileProfileReviewRule(
        profile({
          mode: "latest-proposal",
          requirements: [
            {
              group: "reviewers",
              min_approvals: 1,
              blocking_decisions: ["changes_requested"],
            },
          ],
        }),
      ),
    ).toThrow(/requirements is set but review\.mode is "latest-proposal"/);
  });

  it("throws a typed error for invalid semantic values passed directly", () => {
    expect(() =>
      compileProfileReviewRule({
        review: {
          mode: "consensus",
          requirements: [
            {
              group: "humans",
              min_approvals: 0,
              blocking_decisions: ["changes_requested"],
            },
          ],
        } as never,
      }),
    ).toThrow(ReviewRuleCompileError);
  });

  it("maps snake_case profile review fields to a camelCase ReviewRule", () => {
    const rule = compileProfileReviewRule(
      profile({
        mode: "consensus",
        max_reviewers: 3,
        requirements: [
          {
            group: "humans",
            min_approvals: 2,
            blocking_decisions: ["changes_requested", "rejected"],
            quorum: { min_participants: 2 },
            reviewer_ids: ["alice", "bob"],
            lens_axes: ["correctness", "security"],
            max_reviewers: 2,
          },
        ],
        overrides: { allowed_reviewers: ["lead"], require_reason: false },
        stale_proposal: { reject_superseded: false, max_age_hours: 12 },
      }),
    );

    expect(rule).toEqual({
      mode: "consensus",
      maxReviewers: 3,
      requirements: [
        {
          group: "humans",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "security"],
          maxReviewers: 2,
        },
      ],
      overrides: { allowedReviewers: ["lead"], requireReason: false },
      staleProposal: { rejectSuperseded: false, maxAgeHours: 12 },
    });
  });

  it("rejects a multi-reviewer requirement without frozen reviewers and lenses", () => {
    expect(() =>
      compileProfileReviewRule(
        profile({
          mode: "consensus",
          requirements: [
            {
              group: "humans",
              min_approvals: 1,
              blocking_decisions: ["changes_requested"],
              quorum: { min_participants: 2 },
            },
          ],
        }),
      ),
    ).toThrow(/reviewer_ids is required/);
  });

  it("rejects a consensus rule that mixes a frozen and a non-frozen requirement (fail-open)", () => {
    // SP-12 fail-open: the consensus promote gate filters active proposals by
    // the *union* of all frozen reviewerIds. With a frozen requirement (req0)
    // AND a non-frozen requirement (req1, single-reviewer so compile would
    // otherwise accept it), a blocking proposal from req1's group member (who
    // is NOT in the frozen union) is dropped by that global filter, letting the
    // frozen approvals alone reach `approved`. Such a mix has no coherent
    // dispatch/eval model, so it MUST be rejected fail-closed at compile time.
    expect(() =>
      compileProfileReviewRule(
        profile({
          mode: "consensus",
          requirements: [
            {
              group: "frozen-group",
              min_approvals: 2,
              blocking_decisions: ["changes_requested", "rejected"],
              quorum: { min_participants: 2 },
              reviewer_ids: ["alice", "bob"],
              lens_axes: ["correctness", "scope_fit"],
            },
            {
              group: "open-group",
              min_approvals: 1,
              blocking_decisions: ["changes_requested", "rejected"],
            },
          ],
        }),
      ),
    ).toThrow(ReviewRuleCompileError);
    expect(() =>
      compileProfileReviewRule(
        profile({
          mode: "consensus",
          requirements: [
            {
              group: "frozen-group",
              min_approvals: 2,
              blocking_decisions: ["changes_requested", "rejected"],
              quorum: { min_participants: 2 },
              reviewer_ids: ["alice", "bob"],
              lens_axes: ["correctness", "scope_fit"],
            },
            {
              group: "open-group",
              min_approvals: 1,
              blocking_decisions: ["changes_requested", "rejected"],
            },
          ],
        }),
      ),
    ).toThrow(/all requirements must declare reviewer_ids \(frozen\) or none/);
  });

  it("still accepts a consensus rule whose requirements are all frozen (multi-frozen, not mixed)", () => {
    // Guard: the mixed-rule invariant must NOT regress a legitimate rule with
    // several requirements that ALL declare a frozen reviewer set.
    expect(() =>
      compileProfileReviewRule(
        profile({
          mode: "consensus",
          requirements: [
            {
              group: "g1",
              min_approvals: 2,
              blocking_decisions: ["changes_requested", "rejected"],
              quorum: { min_participants: 2 },
              reviewer_ids: ["alice", "bob"],
              lens_axes: ["correctness", "scope_fit"],
            },
            {
              group: "g2",
              min_approvals: 2,
              blocking_decisions: ["changes_requested", "rejected"],
              quorum: { min_participants: 2 },
              reviewer_ids: ["carol", "dave"],
              lens_axes: ["security", "perf"],
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("still accepts a consensus rule whose requirements are all non-frozen (group-membership, not mixed)", () => {
    // Guard: a rule whose requirements are uniformly non-frozen
    // (group-membership quorum, no reviewer_ids) is coherent — every group
    // resolves reviewers the same way. Single-reviewer non-frozen requirements
    // compile fine (the frozen-set rule only fires for multi-reviewer).
    expect(() =>
      compileProfileReviewRule(
        profile({
          mode: "consensus",
          requirements: [
            {
              group: "g1",
              min_approvals: 1,
              blocking_decisions: ["changes_requested", "rejected"],
            },
            {
              group: "g2",
              min_approvals: 1,
              blocking_decisions: ["changes_requested", "rejected"],
            },
          ],
        }),
      ),
    ).not.toThrow();
  });
});

describe("resolveEffectiveRule", () => {
  it("returns a default resolution without profile.review", () => {
    const resolved = resolveEffectiveRule({ profile: profile() });
    expect(resolved).toEqual({
      rule: DEFAULT_REVIEW_RULE,
      source: "default",
      ruleSha256: ruleSha256(DEFAULT_REVIEW_RULE),
    });
  });

  it("returns a project-profile resolution with a stable sha for profile.review", () => {
    const p = profile({
      mode: "consensus",
      requirements: [
        {
          group: "humans",
          min_approvals: 1,
          blocking_decisions: ["changes_requested", "rejected"],
        },
      ],
    });
    const a = resolveEffectiveRule({ projectId: "demo", profile: p });
    const b = resolveEffectiveRule({ projectId: "demo", profile: p });
    expect(a.source).toBe("project-profile");
    expect(a.rule.mode).toBe("consensus");
    expect(a.ruleSha256).toBe(ruleSha256(a.rule));
    expect(a.ruleSha256).toBe(b.ruleSha256);
  });
});

describe("parseReviewRuleSnapshot", () => {
  const latestProposal: ReviewRule = {
    mode: "latest-proposal",
    requirements: [],
    overrides: { allowedReviewers: [], requireReason: true },
    staleProposal: { rejectSuperseded: true },
  };
  const consensusRule: ReviewRule = {
    mode: "consensus",
    requirements: [
      {
        group: "reviewers",
        minApprovals: 2,
        blockingDecisions: ["changes_requested", "rejected"],
        quorum: { minParticipants: 2 },
        reviewerIds: ["alice", "bob"],
        lensAxes: ["correctness", "scope_fit"],
      },
    ],
    overrides: { allowedReviewers: [], requireReason: true },
    staleProposal: { rejectSuperseded: true },
  };

  it("round-trips a well-formed latest-proposal snapshot to an equivalent rule", () => {
    expect(parseReviewRuleSnapshot(JSON.stringify(latestProposal))).toEqual(
      latestProposal,
    );
  });

  it("round-trips a well-formed consensus snapshot to an equivalent rule", () => {
    expect(parseReviewRuleSnapshot(JSON.stringify(consensusRule))).toEqual(
      consensusRule,
    );
  });

  it("throws a typed snapshot error (not raw SyntaxError) on invalid JSON", () => {
    expect(() => parseReviewRuleSnapshot("{not json")).toThrow(
      ReviewRuleSnapshotError,
    );
    // fail-closed: the typed error is a member of the ReviewRuleCompileError
    // family so existing fail-closed catch sites still trap it.
    expect(() => parseReviewRuleSnapshot("{not json")).toThrow(
      ReviewRuleCompileError,
    );
  });

  it("rejects a non-object top-level snapshot", () => {
    expect(() => parseReviewRuleSnapshot('"latest-proposal"')).toThrow(
      ReviewRuleSnapshotError,
    );
    expect(() => parseReviewRuleSnapshot("null")).toThrow(
      ReviewRuleSnapshotError,
    );
    expect(() => parseReviewRuleSnapshot("[]")).toThrow(ReviewRuleSnapshotError);
  });

  it("rejects an unknown / missing mode", () => {
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({ ...latestProposal, mode: "unknown" }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          requirements: [],
          overrides: { allowedReviewers: [], requireReason: true },
          staleProposal: { rejectSuperseded: true },
        }),
      ),
    ).toThrow(/mode/);
  });

  it("rejects a non-array requirements field", () => {
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({ ...latestProposal, requirements: {} }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
  });

  it("rejects the latent fail-open shape {mode:'consensus', requirements:[]}", () => {
    // This is the exact shape that would silently approve with zero gating —
    // a consensus rule with no requirements MUST be rejected fail-closed.
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          mode: "consensus",
          requirements: [],
          overrides: { allowedReviewers: [], requireReason: true },
          staleProposal: { rejectSuperseded: true },
        }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          mode: "consensus",
          requirements: [],
          overrides: { allowedReviewers: [], requireReason: true },
          staleProposal: { rejectSuperseded: true },
        }),
      ),
    ).toThrow(/requirement/);
  });

  it("rejects the sibling fail-open shape {mode:'latest-proposal', requirements:[…]}", () => {
    // Mirror of compileProfileReviewRule's symmetric invariant: a snapshot that
    // declares requirements but leaves mode at latest-proposal would silently
    // drop the quorum/multi-reviewer gate at runtime. MUST be rejected fail-closed.
    // The wording now flows from the shared assertion (compile-derived) since the
    // snapshot boundary delegates this invariant to assertCompiledReviewRuleInvariants.
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({ ...consensusRule, mode: "latest-proposal" }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({ ...consensusRule, mode: "latest-proposal" }),
      ),
    ).toThrow(/review\.requirements is set but review\.mode/);
  });

  it("rejects a non-array reviewerIds on a requirement", () => {
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          ...consensusRule,
          requirements: [
            { ...consensusRule.requirements[0], reviewerIds: "alice" },
          ],
        }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
  });

  it("rejects an empty reviewerIds entry on a requirement", () => {
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          ...consensusRule,
          requirements: [
            { ...consensusRule.requirements[0], reviewerIds: ["alice", ""] },
          ],
        }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
  });

  it("rejects duplicate reviewerIds on a requirement", () => {
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          ...consensusRule,
          requirements: [
            {
              ...consensusRule.requirements[0],
              reviewerIds: ["alice", "alice"],
            },
          ],
        }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
  });

  it("rejects a non-path-safe reviewer id (would escape reviewers/<id>/)", () => {
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          ...consensusRule,
          requirements: [
            {
              ...consensusRule.requirements[0],
              reviewerIds: ["alice", "../bob"],
            },
          ],
        }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
  });

  it("rejects a requirement missing a positive minApprovals", () => {
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          ...consensusRule,
          requirements: [
            { ...consensusRule.requirements[0], minApprovals: 0 },
          ],
        }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
  });

  it("rejects a requirement with an unsupported blocking decision", () => {
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          ...consensusRule,
          requirements: [
            {
              ...consensusRule.requirements[0],
              blockingDecisions: ["approved"],
            },
          ],
        }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
  });

  it("rejects a malformed overrides / staleProposal shape", () => {
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({ ...latestProposal, overrides: null }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({ ...latestProposal, staleProposal: "yes" }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          ...latestProposal,
          overrides: { allowedReviewers: "alice", requireReason: true },
        }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
  });

  // The following mirror compileProfileReviewRule's fail-open / unsatisfiable
  // *semantic* invariants (value-vs-value consistency on an assembled rule) —
  // not just structural shape. A snapshot that parses structurally but violates
  // one of these can never gate correctly, so reading it back must fail closed
  // too. The single authoring-only invariant (a multi-reviewer requirement must
  // declare a frozen reviewerIds/lensAxes set) is intentionally NOT enforced
  // here: a non-frozen group-membership quorum is a legitimate runtime shape.

  it("round-trips a non-frozen multi-reviewer consensus snapshot (group-membership quorum, no reviewerIds)", () => {
    // Regression guard: a consensus requirement with quorum.minParticipants>1 but
    // no frozen reviewerIds/lensAxes resolves reviewers from group membership at
    // dispatch time. compileProfileReviewRule rejects this authoring shape, but
    // the runtime fully supports it, so the snapshot boundary MUST accept it.
    const nonFrozenGroupQuorum: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "humans",
          minApprovals: 1,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    expect(
      parseReviewRuleSnapshot(JSON.stringify(nonFrozenGroupQuorum)),
    ).toEqual(nonFrozenGroupQuorum);
  });

  it("rejects a snapshot that mixes a frozen and a non-frozen requirement (fail-open)", () => {
    // SP-12 fail-open: the consensus promote gate filters by the union of all
    // frozen reviewerIds, silently dropping a blocking proposal from the
    // non-frozen requirement's group. A persisted snapshot in this shape can
    // never gate coherently, so the read-back boundary MUST fail closed too.
    const mixedRule = {
      mode: "consensus",
      requirements: [
        {
          group: "frozen-group",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "scope_fit"],
        },
        {
          group: "open-group",
          minApprovals: 1,
          blockingDecisions: ["changes_requested", "rejected"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    expect(() => parseReviewRuleSnapshot(JSON.stringify(mixedRule))).toThrow(
      ReviewRuleSnapshotError,
    );
    expect(() => parseReviewRuleSnapshot(JSON.stringify(mixedRule))).toThrow(
      /all requirements must declare reviewer_ids \(frozen\) or none/,
    );
  });

  it("round-trips a multi-frozen consensus snapshot (all requirements frozen, not mixed)", () => {
    // Guard: the mixed-rule invariant must accept a snapshot whose
    // requirements ALL declare a frozen reviewer set.
    const multiFrozen: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "g1",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "scope_fit"],
        },
        {
          group: "g2",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["carol", "dave"],
          lensAxes: ["security", "perf"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    expect(parseReviewRuleSnapshot(JSON.stringify(multiFrozen))).toEqual(
      multiFrozen,
    );
  });

  it("rejects a snapshot whose reviewerIds count is below the required participants", () => {
    // minApprovals=2 / quorum.minParticipants=2 require 2 reviewers, but only 1
    // frozen id is present → the gate could never be satisfied; reject fail-closed.
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          ...consensusRule,
          requirements: [
            {
              ...consensusRule.requirements[0],
              reviewerIds: ["alice"],
            },
          ],
        }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
  });

  it("rejects a snapshot whose reviewerIds count exceeds maxReviewers", () => {
    // maxReviewers=2 but 3 frozen ids → compile rejects (over the dispatch cap).
    expect(() =>
      parseReviewRuleSnapshot(
        JSON.stringify({
          ...consensusRule,
          requirements: [
            {
              ...consensusRule.requirements[0],
              maxReviewers: 2,
              reviewerIds: ["alice", "bob", "carol"],
            },
          ],
        }),
      ),
    ).toThrow(ReviewRuleSnapshotError);
  });

  it("round-trips a snapshot with a fractional staleProposal.maxAgeHours (compile accepts floats)", () => {
    // Regression guard: compile permits a positive *float* max_age_hours (schema
    // is z.number().positive(), not .int()). The parse boundary must accept the
    // same values so it never fail-closed rejects a legitimate compiled snapshot.
    const rule: ReviewRule = {
      ...latestProposal,
      staleProposal: { rejectSuperseded: true, maxAgeHours: 0.5 },
    };
    expect(parseReviewRuleSnapshot(JSON.stringify(rule))).toEqual(rule);
  });
});

describe("frozen reviewer dispatch ordering (facet2 determinism)", () => {
  function reverseOrderRule(): ReviewRule {
    return {
      mode: "consensus",
      requirements: [
        {
          // reviewer ids intentionally in DESCENDING order on input.
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["codex-b", "codex-a"],
          lensAxes: ["correctness", "scope_fit"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
  }

  it("frozenReviewerIdsForRule normalizes reverse-order ids to ASC", () => {
    expect(frozenReviewerIdsForRule(reverseOrderRule())).toEqual([
      "codex-a",
      "codex-b",
    ]);
  });

  it("dispatchRequirementsForRule emits reviewer ids in ASC order regardless of input order", () => {
    const dispatch = dispatchRequirementsForRule(reverseOrderRule());
    expect(dispatch).toEqual([
      {
        group: "reviewers",
        requiredReviewers: 2,
        reviewerIds: ["codex-a", "codex-b"],
      },
    ]);
  });

  it("frozenReviewerIdsForRule dedupes + sorts ids merged across requirements", () => {
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "g2",
          minApprovals: 1,
          blockingDecisions: [],
          reviewerIds: ["delta", "bravo"],
        },
        {
          group: "g1",
          minApprovals: 1,
          blockingDecisions: [],
          reviewerIds: ["charlie", "bravo", "alpha"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    expect(frozenReviewerIdsForRule(rule)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
  });

  it("dispatchRequirementsForRule is empty for non-consensus mode", () => {
    expect(dispatchRequirementsForRule(DEFAULT_REVIEW_RULE)).toEqual([]);
  });
});
