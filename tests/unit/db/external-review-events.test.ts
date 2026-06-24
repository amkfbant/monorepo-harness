import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  ExternalReviewEventRepository,
  type ExternalReviewEventInput,
} from "../../../src/db/repositories/external-review-events.js";
import { HitchRepository } from "../../../src/hitch/repository.js";

const NOW = "2026-06-25T00:00:00.000Z";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "harness-external-review-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return db;
}

function seedHitch(db: ReturnType<typeof openDb>, hitchId: string): void {
  new HitchRepository(db).createSession({
    hitchId,
    title: `External review ${hitchId}`,
    projectId: "proj",
    domain: "self",
    scope: { targetFiles: ["src/**"] },
    closeConditions: [],
    createdBy: "test",
    createdSource: "cli",
    createdAt: NOW,
  });
}

function eventInput(
  overrides: Partial<ExternalReviewEventInput> = {},
): ExternalReviewEventInput {
  return {
    eventId: "erev-1",
    hitchId: "hitch-a",
    runId: "run-a",
    repoId: "monorepo-harness",
    prNumber: 395,
    author: "codex[bot]",
    reviewerType: "codex_app",
    state: "changes_requested",
    githubReviewId: "gh-review-1",
    submittedAt: "2026-06-25T00:01:00.000Z",
    summary: "needs changes",
    redacted: false,
    createdAt: "2026-06-25T00:02:00.000Z",
    ...overrides,
  };
}

describe("ExternalReviewEventRepository", () => {
  it("appends multiple events for the same hitch without superseding", () => {
    const db = freshDb();
    try {
      seedHitch(db, "hitch-a");
      const repo = new ExternalReviewEventRepository(db);

      const first = repo.append(eventInput());
      const second = repo.append(
        eventInput({
          eventId: "erev-2",
          githubReviewId: "gh-review-2",
          author: "copilot-pull-request-reviewer",
          reviewerType: "copilot",
          state: "approved",
          createdAt: "2026-06-25T00:03:00.000Z",
        }),
      );

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(true);
      expect(repo.listForHitch("hitch-a").map((row) => row.eventId)).toEqual([
        "erev-1",
        "erev-2",
      ]);
    } finally {
      db.close();
    }
  });

  it("dedupes repeated GitHub review IDs with INSERT OR IGNORE", () => {
    const db = freshDb();
    try {
      seedHitch(db, "hitch-a");
      const repo = new ExternalReviewEventRepository(db);

      const first = repo.append(eventInput());
      const duplicate = repo.append(
        eventInput({
          eventId: "erev-duplicate",
          summary: "same review observed on a later poll",
          createdAt: "2026-06-25T00:10:00.000Z",
        }),
      );

      expect(first.inserted).toBe(true);
      expect(duplicate.inserted).toBe(false);
      expect(duplicate.row.eventId).toBe("erev-1");
      expect(repo.listForHitch("hitch-a")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("records a state change under the same github_review_id as a new verdict", () => {
    const db = freshDb();
    try {
      seedHitch(db, "hitch-a");
      const repo = new ExternalReviewEventRepository(db);

      // Same review id, but the verdict changes (changes_requested -> dismissed).
      // The (github_review_id, state) dedup keeps BOTH observations; only a
      // re-poll of the same state collapses.
      const changes = repo.append(
        eventInput({
          eventId: "rev-cr",
          githubReviewId: "gh-same",
          state: "changes_requested",
          createdAt: "2026-06-25T00:01:00.000Z",
        }),
      );
      const dismissed = repo.append(
        eventInput({
          eventId: "rev-dismissed",
          githubReviewId: "gh-same",
          state: "dismissed",
          createdAt: "2026-06-25T00:09:00.000Z",
        }),
      );
      const repoll = repo.append(
        eventInput({
          eventId: "rev-dismissed-repoll",
          githubReviewId: "gh-same",
          state: "dismissed",
          createdAt: "2026-06-25T00:20:00.000Z",
        }),
      );

      expect(changes.inserted).toBe(true);
      expect(dismissed.inserted).toBe(true);
      expect(repoll.inserted).toBe(false);
      expect(repoll.row.eventId).toBe("rev-dismissed");
      expect(repo.listForHitch("hitch-a")).toHaveLength(2);
      expect(repo.summarize({ hitchId: "hitch-a" }).lastVerdict?.state).toBe(
        "dismissed",
      );
    } finally {
      db.close();
    }
  });

  it("scopes listForPr / summarize by repo_id (PR numbers are per-repo)", () => {
    const db = freshDb();
    try {
      const repo = new ExternalReviewEventRepository(db);
      repo.append(
        eventInput({
          eventId: "repoA",
          hitchId: undefined,
          runId: undefined,
          repoId: "repo-a",
          githubReviewId: "gh-a",
          prNumber: 12,
          state: "approved",
        }),
      );
      repo.append(
        eventInput({
          eventId: "repoB",
          hitchId: undefined,
          runId: undefined,
          repoId: "repo-b",
          githubReviewId: "gh-b",
          prNumber: 12,
          state: "changes_requested",
        }),
      );

      expect(repo.listForPr(12, "repo-a").map((r) => r.eventId)).toEqual([
        "repoA",
      ]);
      expect(
        repo
          .listForPr(12)
          .map((r) => r.eventId)
          .sort(),
      ).toEqual(["repoA", "repoB"]);
      const scoped = repo.summarize({ repoId: "repo-b", prNumber: 12 });
      expect(scoped.total).toBe(1);
      expect(scoped.byState.changes_requested).toBe(1);
    } finally {
      db.close();
    }
  });

  it("lists by PR, preserving nullable hitch/run fields and boolean redaction", () => {
    const db = freshDb();
    try {
      const repo = new ExternalReviewEventRepository(db);

      repo.append(
        eventInput({
          eventId: "standalone",
          hitchId: undefined,
          runId: undefined,
          githubReviewId: undefined,
          author: "alice",
          reviewerType: "human",
          state: "commented",
          summary: null,
          redacted: true,
        }),
      );

      const [row] = repo.listForPr(395);
      expect(row).toMatchObject({
        eventId: "standalone",
        hitchId: null,
        runId: null,
        prNumber: 395,
        author: "alice",
        reviewerType: "human",
        state: "commented",
        githubReviewId: null,
        summary: null,
        redacted: true,
      });
    } finally {
      db.close();
    }
  });

  it("summarizes by state/reviewer and returns the latest verdict by created_at DESC", () => {
    const db = freshDb();
    try {
      seedHitch(db, "hitch-a");
      const repo = new ExternalReviewEventRepository(db);

      // Insert the later verdict first to prove summarize orders by created_at,
      // not insertion order or event_id.
      repo.append(
        eventInput({
          eventId: "later",
          githubReviewId: "gh-later",
          author: "alice",
          reviewerType: "human",
          state: "approved",
          createdAt: "2026-06-25T00:05:00.000Z",
        }),
      );
      repo.append(
        eventInput({
          eventId: "earlier",
          githubReviewId: "gh-earlier",
          author: "codex[bot]",
          reviewerType: "codex_app",
          state: "changes_requested",
          createdAt: "2026-06-25T00:01:00.000Z",
        }),
      );
      repo.append(
        eventInput({
          eventId: "middle",
          githubReviewId: "gh-middle",
          author: "codex[bot]",
          reviewerType: "codex_app",
          state: "commented",
          createdAt: "2026-06-25T00:03:00.000Z",
        }),
      );

      const summary = repo.summarize({ hitchId: "hitch-a" });
      expect(summary.total).toBe(3);
      expect(summary.byState).toEqual({
        approved: 1,
        changes_requested: 1,
        commented: 1,
        dismissed: 0,
        pending: 0,
      });
      expect(summary.byReviewer).toEqual({
        codex_app: 2,
        copilot: 0,
        human: 1,
        other: 0,
      });
      expect(summary.lastVerdict?.eventId).toBe("later");
      expect(summary.lastVerdict?.state).toBe("approved");
    } finally {
      db.close();
    }
  });

  it("returns zero summary for an empty hitch", () => {
    const db = freshDb();
    try {
      seedHitch(db, "hitch-empty");
      const repo = new ExternalReviewEventRepository(db);

      expect(repo.summarize({ hitchId: "hitch-empty" })).toEqual({
        total: 0,
        byState: {
          approved: 0,
          changes_requested: 0,
          commented: 0,
          dismissed: 0,
          pending: 0,
        },
        byReviewer: {
          codex_app: 0,
          copilot: 0,
          human: 0,
          other: 0,
        },
        lastVerdict: null,
      });
    } finally {
      db.close();
    }
  });

  it("does not swallow unknown state CHECK failures while deduping", () => {
    const db = freshDb();
    try {
      seedHitch(db, "hitch-a");
      const repo = new ExternalReviewEventRepository(db);

      expect(() =>
        repo.append(
          eventInput({
            eventId: "bad-state",
            githubReviewId: "gh-bad-state",
            state: "stale" as ExternalReviewEventInput["state"],
          }),
        ),
      ).toThrow(/CHECK/i);
      expect(repo.listForHitch("hitch-a")).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
