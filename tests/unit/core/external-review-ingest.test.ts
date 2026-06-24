import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ExternalReviewEventRepository } from "../../../src/db/repositories/external-review-events.js";
import {
  externalReviewEventId,
  recordExternalReviewEvents,
  reviewerTypeForExternalReview,
} from "../../../src/core/external-review-ingest.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "harness-external-review-ingest-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

describe("external review event ingest", () => {
  it("records known states and dedupes repeated polls with deterministic event ids", () => {
    const db = freshDb();
    try {
      const first = recordExternalReviewEvents({
        db,
        repoId: "repo-a",
        prNumber: 395,
        createdAt: "2026-06-25T00:00:00.000Z",
        verdicts: [
          { author: "codex[bot]", state: "COMMENTED", githubReviewId: "R1" },
          {
            author: "anonymous",
            state: "COMMENTED",
            githubReviewId: null,
          },
        ],
      });
      const second = recordExternalReviewEvents({
        db,
        repoId: "repo-a",
        prNumber: 395,
        createdAt: "2026-06-25T00:01:00.000Z",
        verdicts: [
          { author: "codex[bot]", state: "APPROVED", githubReviewId: "R1" },
          {
            author: "anonymous",
            state: "COMMENTED",
            githubReviewId: null,
          },
        ],
      });

      expect(first.map((r) => r.inserted)).toEqual([true, true]);
      expect(second.map((r) => r.inserted)).toEqual([true, false]);
      expect(new ExternalReviewEventRepository(db).listForPr(395, "repo-a").map((e) => [
        e.author,
        e.state,
      ])).toEqual([
        ["codex[bot]", "commented"],
        ["anonymous", "commented"],
        ["codex[bot]", "approved"],
      ]);
    } finally {
      db.close();
    }
  });

  it("uses the review index only when GitHub does not provide a review id", () => {
    const withIndex0 = externalReviewEventId({
      repoId: "repo-a",
      prNumber: 395,
      author: "anonymous",
      state: "commented",
      githubReviewId: null,
      index: 0,
    });
    expect(withIndex0).toBe(
      externalReviewEventId({
        repoId: "repo-a",
        prNumber: 395,
        author: "anonymous",
        state: "commented",
        githubReviewId: null,
        index: 0,
      }),
    );
    expect(withIndex0).not.toBe(
      externalReviewEventId({
        repoId: "repo-a",
        prNumber: 395,
        author: "anonymous",
        state: "commented",
        githubReviewId: null,
        index: 1,
      }),
    );
    const withGithubIndex0 = externalReviewEventId({
      repoId: "repo-a",
      prNumber: 395,
      author: "anonymous",
      state: "commented",
      githubReviewId: "R1",
      index: 0,
    });
    expect(withGithubIndex0).toBe(
      externalReviewEventId({
        repoId: "repo-a",
        prNumber: 395,
        author: "anonymous",
        state: "commented",
        githubReviewId: "R1",
        index: 99,
      }),
    );
    expect(withGithubIndex0).not.toBe(withIndex0);
  });

  it("classifies reviewer type from the login (codex App / Copilot / bot / human)", () => {
    expect(reviewerTypeForExternalReview("chatgpt-codex-connector")).toBe(
      "codex_app",
    );
    expect(reviewerTypeForExternalReview("chatgpt-codex-connector[bot]")).toBe(
      "codex_app",
    );
    expect(reviewerTypeForExternalReview("copilot-pull-request-reviewer")).toBe(
      "copilot",
    );
    expect(reviewerTypeForExternalReview("some-tool[bot]")).toBe("other");
    expect(reviewerTypeForExternalReview("alice")).toBe("human");
  });

  it("redacts a secret-suspect review summary at the ingest boundary", () => {
    const db = freshDb();
    try {
      recordExternalReviewEvents({
        db,
        repoId: "repo-a",
        prNumber: 401,
        createdAt: "2026-06-25T00:00:00.000Z",
        verdicts: [
          {
            author: "alice",
            state: "COMMENTED",
            githubReviewId: "S1",
            summary: "looks fine, but api_key=abcd1234deadbeef is hardcoded",
          },
          {
            author: "bob",
            state: "COMMENTED",
            githubReviewId: "S2",
            summary: "please add a null check here",
          },
        ],
      });
      const rows = new ExternalReviewEventRepository(db).listForPr(401, "repo-a");
      const secret = rows.find((r) => r.githubReviewId === "S1");
      const clean = rows.find((r) => r.githubReviewId === "S2");
      // The secret-shaped body is withheld whole-field (never the raw token).
      expect(secret?.redacted).toBe(true);
      expect(secret?.summary).not.toContain("api_key");
      // A clean body passes through unredacted.
      expect(clean?.redacted).toBe(false);
      expect(clean?.summary).toBe("please add a null check here");
    } finally {
      db.close();
    }
  });
});
