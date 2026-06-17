import { describe, expect, it } from "vitest";
import {
  compileProfileReviewRule,
  DEFAULT_REVIEW_RULE,
  resolveEffectiveRule,
  ReviewRuleCompileError,
  ruleSha256,
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
