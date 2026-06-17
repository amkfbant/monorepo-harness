import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, openDbReadonly } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrations.js";
import { storeArtifactBlob } from "../../src/db/artifact-blobs.js";
import { readArtifactBlob } from "../../src/db/artifact-blobs.js";
import {
  ReviewerAgentGateError,
  runReviewerAgent,
} from "../../src/core/reviewer-agent.js";
import { syncRunArtifactsToDb } from "../../src/core/run-materialize.js";
import { recordOperationalKnowledge } from "../../src/core/operational-knowledge.js";
import type { CodexExecRunner } from "../../src/codex/codex-exec-runner.js";

/**
 * Phase 8-13 — `review auto` in DB-only mode.
 *
 * A db-first run written with file export OFF has no run dir. The
 * reviewer agent materializes it from the DB before running, so review
 * works without the operator first re-exporting files.
 */

const APPROVED_OUTPUT = [
  "```yaml",
  "decision: approved",
  "required_changes: []",
  "non_blocking_comments: []",
  "out_of_scope_suggestions: []",
  "```",
].join("\n");

function fakeRunner(output: string): CodexExecRunner {
  return {
    async run(input) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.logPaths.stdout, output, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      return { exitCode: 0, timedOut: false, durationMs: 0 };
    },
  };
}

function fakeRunnerWithEvents(output: string, events: string): CodexExecRunner {
  return {
    async run(input) {
      const { writeFile } = await import("node:fs/promises");
      expect(input.logPaths.events.endsWith(".reviewer-agent.events.raw.jsonl")).toBe(
        true,
      );
      await writeFile(input.logPaths.stdout, output, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      await writeFile(input.logPaths.events, events, "utf8");
      return { exitCode: 0, timedOut: false, durationMs: 0 };
    },
  };
}

/** A fake runner that also records every prompt it is given. */
function capturingRunner(output: string): {
  runner: CodexExecRunner;
  prompts: string[];
} {
  const prompts: string[] = [];
  const runner: CodexExecRunner = {
    async run(input) {
      prompts.push(input.prompt);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.logPaths.stdout, output, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      return { exitCode: 0, timedOut: false, durationMs: 0 };
    },
  };
  return { runner, prompts };
}

interface Fixture {
  runsDir: string;
  dbPath: string;
  runId: string;
}

/** A db-first needs_review run that exists ONLY in the DB (no run dir). */
function dbOnlyNeedsReview(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "harness-radb-"));
  const runsDir = join(root, "runs");
  mkdirSync(runsDir, { recursive: true });
  const dbPath = join(root, ".harness", "harness.sqlite");
  const runId = "run-20260523-apps-user-radb1";
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    const meta = {
      runId,
      repoId: "t",
      repoPath: "/tmp/t",
      domain: "apps/user",
      workflow: "domain-coding",
      baseBranch: "main",
      baseSha: "abc",
      runBranch: "harness/x",
      status: "needs_review",
      safetyStatus: "allowed",
      startedAt: "2026-05-23T00:00:00Z",
    };
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at,
         meta_json)
       VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
         'db-first', 2, 'disabled', '2026-05-23T00:00:00Z', ?)`,
    ).run(runId, JSON.stringify(meta));
    // a db-stored artifact body so the materialized run dir has content
    const blob = storeArtifactBlob(db, Buffer.from("# summary\nlooks ok\n"));
    db.prepare(
      `INSERT INTO artifacts (artifact_id, run_id, kind, relative_path,
         content_type, bytes, sha256, storage, blob_sha256, body_status)
       VALUES (?, ?, 'summary', 'summary.md', 'text/markdown', ?, ?, 'db',
         ?, 'db_available')`,
    ).run(`${runId}:summary.md`, runId, blob.bytes, blob.sha256, blob.sha256);
  } finally {
    db.close();
  }
  return { runsDir, dbPath, runId };
}

describe("review auto — DB-only mode (Phase 8-13)", () => {
  it("materializes a fileless db-first run, then reviews it", async () => {
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
    // precondition: no run dir exists
    expect(existsSync(join(runsDir, runId, "meta.json"))).toBe(false);

    const r = await runReviewerAgent({
      runsDir,
      runId,
      dbPath,
      codexRunner: fakeRunner(APPROVED_OUTPUT),
      now: new Date("2026-05-23T01:00:00Z"),
    });

    expect(r.decision).toBe("approved");
    // the run was materialized from the DB so the reviewer could read it
    expect(existsSync(join(runsDir, runId, "meta.json"))).toBe(true);
    expect(existsSync(join(runsDir, runId, "summary.md"))).toBe(true);
    expect(existsSync(join(runsDir, runId, "review-decision.yaml"))).toBe(
      true,
    );
  });

  it("injects scoped operational knowledge into the reviewer prompt (issue #57)", async () => {
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
    const db = openDb(dbPath);
    try {
      recordOperationalKnowledge(db, { key: "repo-note", title: "Repo CI quirk", body: "spending limit fails fast", repoId: "t", actor: "op" });
      recordOperationalKnowledge(db, { key: "portable-note", title: "Portable env note", body: "ext4 only", actor: "op" });
      recordOperationalKnowledge(db, { key: "other-repo", title: "Other repo note", body: "irrelevant", repoId: "z", actor: "op" });
    } finally {
      db.close();
    }
    const { runner, prompts } = capturingRunner(APPROVED_OUTPUT);
    const r = await runReviewerAgent({ runsDir, runId, dbPath, codexRunner: runner });
    expect(r.decision).toBe("approved");
    expect(prompts).toHaveLength(1);
    const p = prompts[0] as string;
    expect(p).toContain("<operational-knowledge>");
    expect(p).toContain("Repo CI quirk"); // repo t — in scope
    expect(p).toContain("Portable env note"); // portable — in scope
    expect(p).not.toContain("Other repo note"); // repo z — out of scope
  });

  it("omits the operational-knowledge section when there is none in scope", async () => {
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
    const { runner, prompts } = capturingRunner(APPROVED_OUTPUT);
    await runReviewerAgent({ runsDir, runId, dbPath, codexRunner: runner });
    expect(prompts[0]).not.toContain("<operational-knowledge>");
  });

  it("without a dbPath a fileless run still fails (no silent fallback)", async () => {
    const { runsDir, runId } = dbOnlyNeedsReview();
    await expect(
      runReviewerAgent({
        runsDir,
        runId,
        codexRunner: fakeRunner(APPROVED_OUTPUT),
      }),
    ).rejects.toThrow();
  });

  it("syncRunArtifactsToDb captures the reviewer-agent logs into the DB", async () => {
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
    await runReviewerAgent({
      runsDir,
      runId,
      dbPath,
      codexRunner: fakeRunner(APPROVED_OUTPUT),
      now: new Date("2026-05-23T01:00:00Z"),
    });
    syncRunArtifactsToDb({ dbPath, runsDir, runId });

    const db = openDbReadonly(dbPath);
    try {
      const rows = db
        .prepare(
          "SELECT relative_path FROM artifacts WHERE run_id = ? AND storage = 'db'",
        )
        .all(runId) as { relative_path: string }[];
      const paths = rows.map((r) => r.relative_path);
      // the reviewer's own log is now a DB-canonical artifact
      expect(paths).toContain("reviewers/codex-reviewer/reviewer-agent.out.log");
    } finally {
      db.close();
    }
  });

  it("syncRunArtifactsToDb captures only redacted reviewer codex events", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
    await runReviewerAgent({
      runsDir,
      runId,
      dbPath,
      codexRunner: fakeRunnerWithEvents(
        APPROVED_OUTPUT,
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            aggregated_output: `leaked ${secret}\n`,
          },
        })}\n`,
      ),
      now: new Date("2026-05-23T01:00:00Z"),
    });
    const runDir = join(runsDir, runId);
    const reviewerDir = join(runDir, "reviewers", "codex-reviewer");
    const official = readFileSync(
      join(reviewerDir, "reviewer-agent.events.jsonl"),
      "utf8",
    );
    expect(official).not.toContain(secret);
    expect(official).toContain("[redacted: secret-suspect");
    expect(
      existsSync(join(reviewerDir, ".reviewer-agent.events.raw.jsonl")),
    ).toBe(false);

    syncRunArtifactsToDb({ dbPath, runsDir, runId });

    const db = openDbReadonly(dbPath);
    try {
      const rawArtifact = db
        .prepare(
          `SELECT count(*) AS n
             FROM artifacts
            WHERE run_id = ? AND relative_path = 'reviewers/codex-reviewer/.reviewer-agent.events.raw.jsonl'`,
        )
        .get(runId) as { n: number };
      expect(rawArtifact.n).toBe(0);
      const row = db
        .prepare(
          `SELECT blob_sha256
             FROM artifacts
            WHERE run_id = ? AND relative_path = 'reviewers/codex-reviewer/reviewer-agent.events.jsonl'`,
        )
        .get(runId) as { blob_sha256: string | null };
      expect(row.blob_sha256).not.toBeNull();
      const blob = readArtifactBlob(db, row.blob_sha256 as string).toString(
        "utf8",
      );
      expect(blob).not.toContain(secret);
      expect(blob).toContain("[redacted: secret-suspect");
    } finally {
      db.close();
    }
  });

  it("syncRunArtifactsToDb captures redacted reviewer agent message text after invalid decisions", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const output = [
      "```yaml",
      "decision: maybe",
      "required_changes: []",
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      "```",
    ].join("\n");
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();

    let reviewerEventsPublished = false;
    await expect(
      runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        codexRunner: fakeRunnerWithEvents(
          output,
          `${JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: `review details include ${secret}`,
            },
          })}\n`,
        ),
        now: new Date("2026-05-23T01:00:00Z"),
      }),
    ).rejects.toSatisfy((e: unknown) => {
      if (e instanceof ReviewerAgentGateError) {
        reviewerEventsPublished = e.reviewerEventsPublished;
        return true;
      }
      return false;
    });

    syncRunArtifactsToDb({
      dbPath,
      runsDir,
      runId,
      untrustedReviewerArtifacts: { reviewerEventsPublished },
    });

    const db = openDbReadonly(dbPath);
    try {
      const row = db
        .prepare(
          `SELECT blob_sha256
             FROM artifacts
            WHERE run_id = ? AND relative_path = 'reviewers/codex-reviewer/reviewer-agent.events.jsonl'`,
        )
        .get(runId) as { blob_sha256: string | null };
      expect(row.blob_sha256).not.toBeNull();
      const blob = readArtifactBlob(db, row.blob_sha256 as string).toString(
        "utf8",
      );
      expect(blob).not.toContain(secret);
      expect(blob).toContain("[redacted: secret-suspect");
    } finally {
      db.close();
    }
  });

  it("stores only a sanitized gate reason for invalid reviewer decisions", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const output = [
      "```yaml",
      `decision: ${secret}`,
      "required_changes: []",
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      "```",
    ].join("\n");
    const { runsDir, dbPath, runId } = dbOnlyNeedsReview();

    let reviewerEventsPublished = false;
    await expect(
      runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        codexRunner: fakeRunner(output),
        now: new Date("2026-05-23T01:00:00Z"),
      }),
    ).rejects.toSatisfy((e: unknown) => {
      if (e instanceof ReviewerAgentGateError) {
        reviewerEventsPublished = e.reviewerEventsPublished;
        return true;
      }
      return false;
    });

    const artifactPath = join(
      runsDir,
      runId,
      "reviewers",
      "codex-reviewer",
      "review-auto-error.json",
    );
    const fileText = readFileSync(artifactPath, "utf8");
    expect(fileText).not.toContain(secret);
    const fileArtifact = JSON.parse(fileText) as {
      reason?: {
        reasonCode?: string;
        field?: string;
        valueType?: string;
        valueLength?: number;
        valueSha256?: string;
      };
    };
    expect(fileArtifact.reason).toMatchObject({
      reasonCode: "reviewer_output_unknown_decision",
      field: "decision",
      valueType: "string",
      valueLength: secret.length,
    });
    expect(fileArtifact.reason?.valueSha256).toMatch(/^[a-f0-9]{64}$/);

    syncRunArtifactsToDb({
      dbPath,
      runsDir,
      runId,
      untrustedReviewerArtifacts: { reviewerEventsPublished },
    });

    const db = openDbReadonly(dbPath);
    try {
      const row = db
        .prepare(
          `SELECT blob_sha256
             FROM artifacts
            WHERE run_id = ? AND relative_path = 'reviewers/codex-reviewer/review-auto-error.json'`,
        )
        .get(runId) as { blob_sha256: string | null };
      expect(row.blob_sha256).not.toBeNull();
      const blob = readArtifactBlob(db, row.blob_sha256 as string).toString(
        "utf8",
      );
      expect(blob).not.toContain(secret);
      expect(blob).toContain("reviewer_output_unknown_decision");
    } finally {
      db.close();
    }
  });
});
