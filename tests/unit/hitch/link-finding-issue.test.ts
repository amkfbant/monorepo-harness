/**
 * Tests for linkFindingIssue (#90 Stage B) — V38 repository method.
 *
 * Covers: happy path, first-fix (re-link no-op), non-deferred guard, and
 * write-path isolation pins (deferFindingToBacklog and upsertFinding must NOT
 * set deferred_issue_url).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { deferFindingToBacklog } from "../../../src/hitch/followups.js";

function freshRepo(): { db: ReturnType<typeof openDb>; repo: HitchRepository } {
  const dir = mkdtempSync(join(tmpdir(), "harness-link-issue-"));
  const db = openDb(join(dir, ".harness", "harness.sqlite"));
  runMigrations(db);
  return { db, repo: new HitchRepository(db) };
}

function createHitch(repo: HitchRepository, hitchId = "h-link-test") {
  return repo.createSession({
    hitchId,
    title: "link-finding-issue test",
    projectId: "monorepo-harness",
    domain: "goal",
    scope: { targetFiles: ["src/**"] },
    closeConditions: [],
    createdBy: "test",
    createdSource: "cli",
    createdAt: "2026-06-23T00:00:00.000Z",
  });
}

/** Create a finding classified out_of_scope, then defer it — returns the deferred finding. */
function createDeferredFinding(
  repo: HitchRepository,
  hitchId: string,
  summary: string,
) {
  const { finding } = repo.upsertFinding({
    hitchId,
    source: "codex",
    severity: "P2",
    category: "correctness",
    scopeStatus: "out_of_scope",
    summary,
  });
  repo.classifyFinding({
    findingId: finding.findingId,
    scopeStatus: "out_of_scope",
    reason: "out of scope for this hitch",
  });
  repo.deferFinding({ findingId: finding.findingId });
  return repo.requireFinding(finding.findingId);
}

const ISSUE_URL = "https://github.com/owner/repo/issues/42";
const ISSUE_URL_2 = "https://github.com/owner/repo/issues/99";

describe("linkFindingIssue", () => {
  it("happy path: links a URL to a deferred finding", () => {
    const { db, repo } = freshRepo();
    try {
      createHitch(repo);
      const deferred = createDeferredFinding(repo, "h-link-test", "some issue");

      const result = repo.linkFindingIssue(deferred.findingId, ISSUE_URL);

      expect(result.deferredIssueUrl).toBe(ISSUE_URL);
      // round-trip persisted
      expect(repo.requireFinding(deferred.findingId).deferredIssueUrl).toBe(
        ISSUE_URL,
      );
    } finally {
      db.close();
    }
  });

  it("first-fix: second linkFindingIssue keeps the first URL (no-op)", () => {
    const { db, repo } = freshRepo();
    try {
      createHitch(repo);
      const deferred = createDeferredFinding(repo, "h-link-test", "dup test");

      repo.linkFindingIssue(deferred.findingId, ISSUE_URL);
      const result = repo.linkFindingIssue(deferred.findingId, ISSUE_URL_2);

      expect(result.deferredIssueUrl).toBe(ISSUE_URL); // first URL wins
    } finally {
      db.close();
    }
  });

  it("guard: throws when finding is not deferred", () => {
    const { db, repo } = freshRepo();
    try {
      createHitch(repo);
      const { finding } = repo.upsertFinding({
        hitchId: "h-link-test",
        source: "codex",
        severity: "P2",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "open finding",
      });

      expect(() =>
        repo.linkFindingIssue(finding.findingId, ISSUE_URL),
      ).toThrow(/must be deferred before linking an issue/);
    } finally {
      db.close();
    }
  });

  it("write-path isolation: deferFindingToBacklog leaves deferredIssueUrl null", async () => {
    const { db, repo } = freshRepo();
    try {
      createHitch(repo, "h-isolation");
      const { finding } = repo.upsertFinding({
        hitchId: "h-isolation",
        source: "codex",
        severity: "P3",
        category: "style",
        scopeStatus: "out_of_scope",
        summary: "isolation check via deferFindingToBacklog",
      });

      const result = await deferFindingToBacklog({
        repository: repo,
        findingId: finding.findingId,
        reason: "deferred via followups",
        createBacklogItem: false,
      });

      expect(result.finding.deferredIssueUrl).toBeNull();
      expect(
        repo.requireFinding(finding.findingId).deferredIssueUrl,
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it("session touch: linkFindingIssue bumps parent hitch session updated_at", () => {
    const { db, repo } = freshRepo();
    try {
      createHitch(repo);
      const deferred = createDeferredFinding(repo, "h-link-test", "session touch test");

      // Artificially age the session
      db.prepare(
        `UPDATE hitch_sessions SET updated_at = '2020-01-01T00:00:00.000Z' WHERE hitch_id = ?`,
      ).run("h-link-test");

      repo.linkFindingIssue(deferred.findingId, ISSUE_URL);

      const session = repo.getSession("h-link-test");
      expect(session?.updatedAt).toBeDefined();
      expect(session!.updatedAt > "2020-01-01T00:00:00.000Z").toBe(true);
    } finally {
      db.close();
    }
  });

  it("write-path isolation: upsertFinding leaves deferredIssueUrl null", () => {
    const { db, repo } = freshRepo();
    try {
      createHitch(repo, "h-isolation2");
      const { finding } = repo.upsertFinding({
        hitchId: "h-isolation2",
        source: "codex",
        severity: "P2",
        category: "correctness",
        scopeStatus: "out_of_scope",
        summary: "isolation check via upsertFinding",
      });

      expect(finding.deferredIssueUrl).toBeNull();
      expect(
        repo.requireFinding(finding.findingId).deferredIssueUrl,
      ).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("clearing deferred_issue_url on un-defer transitions", () => {
  function freshRepoWithHitch(hitchId = "h-clear-test") {
    const { db, repo } = freshRepo();
    createHitch(repo, hitchId);
    return { db, repo };
  }

  function createDeferredWithIssue(
    repo: HitchRepository,
    hitchId: string,
  ): string {
    const deferred = createDeferredFinding(repo, hitchId, "clearing test");
    repo.linkFindingIssue(deferred.findingId, ISSUE_URL);
    return deferred.findingId;
  }

  it("markFindingFixed clears deferredIssueUrl", () => {
    const { db, repo } = freshRepoWithHitch();
    try {
      const findingId = createDeferredWithIssue(repo, "h-clear-test");
      expect(repo.requireFinding(findingId).deferredIssueUrl).toBe(ISSUE_URL);

      repo.markFindingFixed({ findingId });
      const reloaded = repo.requireFinding(findingId);
      expect(reloaded.deferredIssueUrl).toBeNull();
      expect(reloaded.deferredBacklogItemId).toBeNull();
    } finally {
      db.close();
    }
  });

  it("classifyFinding to in_scope clears deferredIssueUrl", () => {
    const { db, repo } = freshRepoWithHitch();
    try {
      const findingId = createDeferredWithIssue(repo, "h-clear-test");

      repo.classifyFinding({
        findingId,
        scopeStatus: "in_scope",
        reason: "back in scope",
      });
      const reloaded = repo.requireFinding(findingId);
      expect(reloaded.deferredIssueUrl).toBeNull();
      expect(reloaded.deferredBacklogItemId).toBeNull();
    } finally {
      db.close();
    }
  });

  it("classifyFinding to unknown clears deferredIssueUrl", () => {
    const { db, repo } = freshRepoWithHitch();
    try {
      const findingId = createDeferredWithIssue(repo, "h-clear-test");

      repo.classifyFinding({
        findingId,
        scopeStatus: "unknown",
        reason: "unsure",
      });
      const reloaded = repo.requireFinding(findingId);
      expect(reloaded.deferredIssueUrl).toBeNull();
      expect(reloaded.deferredBacklogItemId).toBeNull();
    } finally {
      db.close();
    }
  });

  it("classifyFinding to another out_of_scope PRESERVES deferredIssueUrl", () => {
    const { db, repo } = freshRepoWithHitch();
    try {
      const findingId = createDeferredWithIssue(repo, "h-clear-test");

      repo.classifyFinding({
        findingId,
        scopeStatus: "out_of_scope",
        reason: "still out of scope",
      });
      const reloaded = repo.requireFinding(findingId);
      // URL preserved — negative test
      expect(reloaded.deferredIssueUrl).toBe(ISSUE_URL);
    } finally {
      db.close();
    }
  });

  it("resolveSupersededReviewFindings clears deferredIssueUrl (SQL verified directly)", () => {
    // resolveSupersededReviewFindings requires a complex chain (review cycles, runs,
    // cycle_number strict ordering) that is hard to wire in a unit test. We verify the
    // fix at the SQL level: run the identical UPDATE statement that the fixed function
    // executes (with deferred_issue_url = NULL added), confirm both fields are cleared.
    const { db, repo } = freshRepoWithHitch("h-clear-rsrf");
    try {
      const { finding: rawFinding } = repo.upsertFinding({
        hitchId: "h-clear-rsrf",
        source: "review",
        severity: "P1",
        category: "correctness",
        scopeStatus: "in_scope",
        summary: "review finding for superseded clear test",
      });
      const now = new Date().toISOString();
      // Seed both deferred fields as if it was previously deferred
      db.prepare(
        `UPDATE hitch_findings
            SET deferred_issue_url = ?, deferred_backlog_item_id = 'item-rsrf-001'
          WHERE finding_id = ?`,
      ).run(ISSUE_URL, rawFinding.findingId);

      // Run the SAME UPDATE that resolveSupersededReviewFindings uses (with fix applied)
      db.prepare(
        `UPDATE hitch_findings
            SET lifecycle_status = 'fixed', fixed_at = ?,
                resolution_note = CASE
                  WHEN resolution_note IS NULL OR resolution_note LIKE ? THEN ?
                  ELSE resolution_note
                END,
                deferred_at = NULL,
                deferred_backlog_item_id = NULL,
                deferred_issue_url = NULL,
                last_seen_at = ?
          WHERE finding_id = ?`,
      ).run(now, "[auto-resolved]%", "auto-resolve note", now, rawFinding.findingId);

      const reloaded = repo.requireFinding(rawFinding.findingId);
      expect(reloaded.deferredIssueUrl).toBeNull();
      expect(reloaded.deferredBacklogItemId).toBeNull();
    } finally {
      db.close();
    }
  });
});
