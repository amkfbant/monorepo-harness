import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  ReviewerRepository,
  UnknownReviewerError,
  DuplicateReviewerError,
  InvalidReviewerIdError,
} from "../../../src/db/repositories/reviewers.js";

function freshDb() {
  const root = mkdtempSync(join(tmpdir(), "harness-reviewers-"));
  mkdirSync(join(root, ".harness"), { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const db = openDb(dbPath);
  runMigrations(db);
  return db;
}

describe("ReviewerRepository (Phase 11-2)", () => {
  it("Phase 11-1 migration seeds 4 default reviewers (human / codex / codex-security / system)", () => {
    const db = freshDb();
    try {
      const repo = new ReviewerRepository(db);
      const ids = repo.list().map((r) => r.reviewerId).sort();
      expect(ids).toEqual(["codex", "codex-security", "human", "system"]);
      expect(repo.findById("codex")?.reviewerType).toBe("codex");
      expect(repo.findById("codex-security")?.trustLevel).toBe("required");
      expect(repo.findById("system")?.reviewerType).toBe("system");
    } finally {
      db.close();
    }
  });

  it("resolveOrThrow throws UnknownReviewerError for an unregistered id", () => {
    const db = freshDb();
    try {
      const repo = new ReviewerRepository(db);
      expect(() => repo.resolveOrThrow("does-not-exist")).toThrow(
        UnknownReviewerError,
      );
    } finally {
      db.close();
    }
  });

  it("add inserts a new reviewer with all metadata persisted", () => {
    const db = freshDb();
    try {
      const repo = new ReviewerRepository(db);
      const r = repo.add({
        reviewerId: "alice",
        reviewerType: "human",
        displayName: "Alice Reviewer",
        groupId: "humans",
        trustLevel: "required",
        metadata: { email: "alice@example.com" },
        now: new Date("2026-05-24T10:00:00Z"),
      });
      expect(r.reviewerId).toBe("alice");
      expect(r.displayName).toBe("Alice Reviewer");
      expect(r.trustLevel).toBe("required");
      const md = JSON.parse(r.metadataJson) as Record<string, string>;
      expect(md.email).toBe("alice@example.com");
    } finally {
      db.close();
    }
  });

  it("add throws DuplicateReviewerError when reviewer_id collides with default seed", () => {
    const db = freshDb();
    try {
      const repo = new ReviewerRepository(db);
      expect(() =>
        repo.add({
          reviewerId: "codex",
          reviewerType: "codex",
          displayName: "duplicate",
        }),
      ).toThrow(DuplicateReviewerError);
    } finally {
      db.close();
    }
  });

  it("listByGroup returns reviewers in reviewer_id order and returns [] for an empty group", () => {
    const db = freshDb();
    try {
      const repo = new ReviewerRepository(db);
      repo.add({
        reviewerId: "bob",
        reviewerType: "human",
        displayName: "Bob",
        groupId: "reviewers",
      });
      repo.add({
        reviewerId: "alice",
        reviewerType: "human",
        displayName: "Alice",
        groupId: "reviewers",
      });
      repo.add({
        reviewerId: "charlie",
        reviewerType: "human",
        displayName: "Charlie",
        groupId: "reviewers",
      });
      repo.add({
        reviewerId: "z-system",
        reviewerType: "system",
        displayName: "System",
        groupId: "other",
      });

      expect(repo.listByGroup("reviewers").map((r) => r.reviewerId)).toEqual([
        "alice",
        "bob",
        "charlie",
      ]);
      expect(repo.listByGroup("")).toEqual([]);
      expect(repo.listByGroup("missing")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rejects reviewer ids that cannot be used as a path component", () => {
    const db = freshDb();
    try {
      const repo = new ReviewerRepository(db);
      for (const reviewerId of ["../alice", "team/alice", "alice..bob", "."]) {
        expect(() =>
          repo.add({
            reviewerId,
            reviewerType: "human",
            displayName: "bad",
          }),
        ).toThrow(InvalidReviewerIdError);
      }
    } finally {
      db.close();
    }
  });

  it("idempotent migration — re-running runMigrations on a v7 DB does not duplicate default seed", () => {
    const db = freshDb();
    try {
      runMigrations(db); // second time, no-op
      const ids = new ReviewerRepository(db).list().map((r) => r.reviewerId);
      expect(ids.filter((i) => i === "codex")).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
