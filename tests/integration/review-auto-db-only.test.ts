import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openDb, openDbReadonly } from "../../src/db/connection.js";
import { MIGRATIONS, runMigrations } from "../../src/db/migrations.js";
import { storeArtifactBlob } from "../../src/db/artifact-blobs.js";
import { readArtifactBlob } from "../../src/db/artifact-blobs.js";
import {
  ReviewerAgentGateError,
  runReviewerAgent,
} from "../../src/core/reviewer-agent.js";
import {
  syncRunArtifactsToDb,
  quarantinePriorReviewerVerdictArtifacts,
} from "../../src/core/run-materialize.js";
import { recordOperationalKnowledge } from "../../src/core/operational-knowledge.js";
import { ReviewProposalRepository } from "../../src/db/repositories/review-proposals.js";
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
        .get(runId) as { blob_sha256: string | null } | undefined;
      expect(row?.blob_sha256).not.toBeNull();
      const blob = readArtifactBlob(db, row?.blob_sha256 as string)?.toString(
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
        .get(runId) as { blob_sha256: string | null } | undefined;
      expect(row?.blob_sha256).not.toBeNull();
      const blob = readArtifactBlob(db, row?.blob_sha256 as string)?.toString(
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
        .get(runId) as { blob_sha256: string | null } | undefined;
      expect(row?.blob_sha256).not.toBeNull();
      const blob = readArtifactBlob(db, row?.blob_sha256 as string)?.toString(
        "utf8",
      );
      expect(blob).not.toContain(secret);
      expect(blob).toContain("reviewer_output_unknown_decision");
    } finally {
      db.close();
    }
  });

  it("#272: NO file under runs/<id>/ holds the prior reviewer's verdict when the next codex starts", async () => {
    // Runtime default is export OFF (the harness pins it ON for tests) — the
    // round-time DB-only enforcement only holds under the real OFF default.
    const prevExport = process.env.HARNESS_EXPORT_FILES;
    process.env.HARNESS_EXPORT_FILES = "0";
    try {
      const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
      const runDir = join(runsDir, runId);

      // Reviewer 1 emits a DISTINCTIVE verdict so we can grep for its verbatim
      // text anywhere on disk (out.log / events / decision yaml all carry it).
      const ALICE_MARKER = "ALICE_SECRET_VERDICT_MARKER_zzz";
      const aliceOutput = [
        "```yaml",
        "decision: changes_requested",
        "required_changes:",
        `  - "${ALICE_MARKER}"`,
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "```",
      ].join("\n");

      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "alice",
        codexRunner: fakeRunner(aliceOutput),
        allowOverwrite: true,
        now: new Date("2026-05-23T01:00:00Z"),
      });

      // Plant verdict markers via the OTHER verdict-bearing producers that live
      // OUTSIDE reviewers/<id>/review-decision.yaml, simulating prior outputs that
      // a denylist quarantine kept missing:
      //   (b) a refute transcript (refute-agent.out.log embeds change_text)
      //   (c) review evaluate outputs under review-evaluations/<...>/
      const REFUTE_MARKER = "REFUTE_SECRET_MARKER_zzz";
      const EVAL_LOG_MARKER = "EVAL_LOG_SECRET_MARKER_zzz";
      const EVAL_YAML_MARKER = "EVAL_YAML_SECRET_MARKER_zzz";
      const refuterDir = join(runDir, "reviewers", "refuter");
      mkdirSync(refuterDir, { recursive: true });
      writeFileSync(
        join(refuterDir, "refute-agent.out.log"),
        `refute_reason: "${REFUTE_MARKER}"\n`,
      );
      writeFileSync(
        join(refuterDir, ".refute-agent.events.raw.jsonl"),
        `{"text":"${REFUTE_MARKER}"}\n`,
      );
      const evalDir = join(runDir, "review-evaluations", "eval-001");
      mkdirSync(evalDir, { recursive: true });
      writeFileSync(
        join(evalDir, "reviewer-agent.out.log"),
        `decision: changes_requested\nrequired_changes:\n  - "${EVAL_LOG_MARKER}"\n`,
      );
      writeFileSync(
        join(evalDir, "review-decision.yaml"),
        `decision: changes_requested\nrequired_changes:\n  - "${EVAL_YAML_MARKER}"\n`,
      );
      const ALL_MARKERS = [
        ALICE_MARKER,
        REFUTE_MARKER,
        EVAL_LOG_MARKER,
        EVAL_YAML_MARKER,
      ];

      // INVARIANT probe: from INSIDE reviewer 2's fake codex (the exact moment an
      // adversarial reviewer could absolute-read), recursively walk the ENTIRE
      // runs/<id>/ tree and assert NO file contains ANY prior verdict marker —
      // not a sibling reviewer transcript, not a refute transcript, not a
      // review-evaluations log/decision, not anything.
      let leakedFiles: string[] = [];
      const probingSecond: CodexExecRunner = {
        async run(input) {
          const { readFileSync, readdirSync, statSync } = await import(
            "node:fs"
          );
          const walk = (dir: string): void => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
              const p = join(dir, e.name);
              // do NOT descend into reviewer 2's OWN in-progress input cwd — it
              // is an OS-temp dir outside runDir anyway; we only walk runDir.
              if (e.isDirectory()) {
                walk(p);
              } else if (statSync(p).isFile()) {
                const body = readFileSync(p, "utf8");
                if (ALL_MARKERS.some((m) => body.includes(m))) {
                  leakedFiles.push(relative(runDir, p));
                }
              }
            }
          };
          walk(runDir);
          const { writeFile } = await import("node:fs/promises");
          await writeFile(input.logPaths.stdout, APPROVED_OUTPUT, "utf8");
          await writeFile(input.logPaths.stderr, "", "utf8");
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      };
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "bob",
        codexRunner: probingSecond,
        allowOverwrite: true,
        now: new Date("2026-05-23T01:01:00Z"),
      });

      // No prior verdict (reviewer transcript, refute transcript, or
      // review-evaluations output) was reachable when bob's codex started.
      expect(leakedFiles).toEqual([]);

      // Both verdicts remain DB-canonical in review_proposals (source of truth).
      const db = openDbReadonly(dbPath);
      try {
        const repo = new ReviewProposalRepository(db);
        expect(repo.getLatestActiveProposal(runId, "alice")?.decision).toBe(
          "changes_requested",
        );
        expect(repo.getLatestActiveProposal(runId, "bob")?.decision).toBe(
          "approved",
        );
      } finally {
        db.close();
      }
    } finally {
      if (prevExport === undefined) delete process.env.HARNESS_EXPORT_FILES;
      else process.env.HARNESS_EXPORT_FILES = prevExport;
    }
  });

  it("#272: pre-existing STALE root + scoped verdict sidecars are gone before codex runs", async () => {
    // Stale verdicts can be left on disk by an earlier export-ON run / rerun.
    // In DB-backed export-OFF review they must be removed before codex starts —
    // the gate must CLEAN, not merely skip writing.
    const prevExport = process.env.HARNESS_EXPORT_FILES;
    process.env.HARNESS_EXPORT_FILES = "0";
    try {
      const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
      const runDir = join(runsDir, runId);
      // Materialize the run dir, then plant stale verdicts as if a prior
      // export-ON run had written them.
      mkdirSync(join(runDir, "reviewers", "stalereviewer"), {
        recursive: true,
      });
      const staleRoot = join(runDir, "review-decision.yaml");
      const staleScoped = join(
        runDir,
        "reviewers",
        "stalereviewer",
        "review-decision.yaml",
      );
      writeFileSync(staleRoot, "decision: approved\n");
      writeFileSync(staleScoped, "decision: changes_requested\n");

      let staleVisibleAtCodexStart: { root?: boolean; scoped?: boolean } = {};
      const probing: CodexExecRunner = {
        async run(input) {
          staleVisibleAtCodexStart = {
            root: existsSync(staleRoot),
            scoped: existsSync(staleScoped),
          };
          const { writeFile } = await import("node:fs/promises");
          await writeFile(input.logPaths.stdout, APPROVED_OUTPUT, "utf8");
          await writeFile(input.logPaths.stderr, "", "utf8");
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      };
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "alice",
        codexRunner: probing,
        allowOverwrite: true,
        now: new Date("2026-05-23T02:00:00Z"),
      });

      // Both stale sidecars were removed before the reviewer codex started.
      expect(staleVisibleAtCodexStart.root).toBe(false);
      expect(staleVisibleAtCodexStart.scoped).toBe(false);
      expect(existsSync(staleRoot)).toBe(false);
      expect(existsSync(staleScoped)).toBe(false);
    } finally {
      if (prevExport === undefined) delete process.env.HARNESS_EXPORT_FILES;
      else process.env.HARNESS_EXPORT_FILES = prevExport;
    }
  });

  it("#272: a quarantined prior reviewer transcript stays recoverable from the DB (no audit/log loss)", async () => {
    const prevExport = process.env.HARNESS_EXPORT_FILES;
    process.env.HARNESS_EXPORT_FILES = "0";
    try {
      const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
      // Two sequential reviewers; alice's transcript must be quarantined (ingested
      // to the DB, then removed from disk) before bob's codex starts.
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "alice",
        codexRunner: fakeRunner(APPROVED_OUTPUT),
        allowOverwrite: true,
        now: new Date("2026-05-23T03:00:00Z"),
      });
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "bob",
        codexRunner: fakeRunner(APPROVED_OUTPUT),
        allowOverwrite: true,
        now: new Date("2026-05-23T03:01:00Z"),
      });

      // alice's transcript is NOT on disk during/after the round ...
      expect(
        existsSync(
          join(runsDir, runId, "reviewers", "alice", "reviewer-agent.out.log"),
        ),
      ).toBe(false);

      const db = openDbReadonly(dbPath);
      try {
        const artifactRow = (rel: string) =>
          db
            .prepare(
              `SELECT blob_sha256 FROM artifacts
                WHERE run_id = ? AND relative_path = ? AND storage = 'db'`,
            )
            .get(runId, rel) as { blob_sha256: string | null } | undefined;

        // The INGESTABLE transcript IS DB-canonical and recoverable (no log loss
        // — the final export rebuilds it from the DB).
        const out = artifactRow("reviewers/alice/reviewer-agent.out.log");
        expect(out?.blob_sha256).toBeTruthy();
        const body = readArtifactBlob(db, out!.blob_sha256 as string)?.toString(
          "utf8",
        );
        expect(body).toContain("decision: approved");

        // The RAW dotfile stream is REMOVE-ONLY by design (isIngestableRelPath
        // rejects dot-prefixed components): gone from disk and NOT in the DB —
        // it is intentionally non-recoverable (the published events.jsonl is the
        // canonical one). This pins finding #1: no false "recoverable" claim.
        expect(
          existsSync(
            join(
              runsDir,
              runId,
              "reviewers",
              "alice",
              ".reviewer-agent.events.raw.jsonl",
            ),
          ),
        ).toBe(false);
        expect(
          artifactRow("reviewers/alice/.reviewer-agent.events.raw.jsonl"),
        ).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      if (prevExport === undefined) delete process.env.HARNESS_EXPORT_FILES;
      else process.env.HARNESS_EXPORT_FILES = prevExport;
    }
  });

  it("#272: a quarantined transcript survives the post-round syncRunArtifactsToDb (audit fidelity, no regression)", async () => {
    // P1 regression: the post-round / next-`review auto` syncRunArtifactsToDb()
    // calls full ingestRunArtifacts (delete-then-rescan). alice's transcript was
    // quarantined to the DB then removed from disk; the rescan must NOT delete
    // alice's now-DB-canonical row just because the scratch file is absent — in
    // db-first mode the DB is canonical (audit parity with main).
    const prevExport = process.env.HARNESS_EXPORT_FILES;
    process.env.HARNESS_EXPORT_FILES = "0";
    try {
      const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "alice",
        codexRunner: fakeRunner(APPROVED_OUTPUT),
        allowOverwrite: true,
        now: new Date("2026-05-23T04:00:00Z"),
      });
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "bob",
        codexRunner: fakeRunner(APPROVED_OUTPUT),
        allowOverwrite: true,
        now: new Date("2026-05-23T04:01:00Z"),
      });

      // Simulate the end-of-round / next-command full sync (delete-then-rescan).
      syncRunArtifactsToDb({ dbPath, runsDir, runId });

      // alice's transcript artifact STILL exists in the DB and is recoverable —
      // the full rescan did not prune the DB-canonical row whose scratch file was
      // intentionally quarantined (this is the regression that codex flagged).
      const db = openDbReadonly(dbPath);
      try {
        const row = db
          .prepare(
            `SELECT blob_sha256 FROM artifacts
              WHERE run_id = ?
                AND relative_path = 'reviewers/alice/reviewer-agent.out.log'
                AND storage = 'db'`,
          )
          .get(runId) as { blob_sha256: string | null } | undefined;
        expect(row?.blob_sha256).toBeTruthy();
        const body = readArtifactBlob(db, row!.blob_sha256 as string)?.toString(
          "utf8",
        );
        expect(body).toContain("decision: approved");
      } finally {
        db.close();
      }
    } finally {
      if (prevExport === undefined) delete process.env.HARNESS_EXPORT_FILES;
      else process.env.HARNESS_EXPORT_FILES = prevExport;
    }
  });

  it("#272: a quarantined transcript migrated to storage='external' still survives the full sync (codex P1)", async () => {
    // After `db migrate-blobs` an artifact body moves to an external store
    // (storage='external'), but it is STILL DB-canonical / exportable. The
    // db-first sync's preserve predicate keys on a present blob_sha256 (NOT on
    // storage='db'), so an absent external+blob row must NOT be pruned.
    const prevExport = process.env.HARNESS_EXPORT_FILES;
    process.env.HARNESS_EXPORT_FILES = "0";
    try {
      const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "alice",
        codexRunner: fakeRunner(APPROVED_OUTPUT),
        allowOverwrite: true,
        now: new Date("2026-05-23T05:00:00Z"),
      });
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "bob",
        codexRunner: fakeRunner(APPROVED_OUTPUT),
        allowOverwrite: true,
        now: new Date("2026-05-23T05:01:00Z"),
      });

      // Simulate `db migrate-blobs`: flip alice's quarantined transcript row to
      // the external storage tier (its scratch file is already absent on disk).
      const rel = "reviewers/alice/reviewer-agent.out.log";
      {
        const w = openDb(dbPath);
        try {
          const updated = w
            .prepare(
              `UPDATE artifacts SET storage = 'external'
                WHERE run_id = ? AND relative_path = ? AND blob_sha256 IS NOT NULL`,
            )
            .run(runId, rel);
          expect(updated.changes).toBe(1); // precondition: row existed with a blob
        } finally {
          w.close();
        }
      }

      // Full post-round sync (delete-then-rescan in file-first; merge in db-first).
      syncRunArtifactsToDb({ dbPath, runsDir, runId });

      // The external+blob row is preserved (NOT pruned by `storage != 'db'`).
      const db = openDbReadonly(dbPath);
      try {
        const row = db
          .prepare(
            `SELECT storage, blob_sha256 FROM artifacts
              WHERE run_id = ? AND relative_path = ?`,
          )
          .get(runId, rel) as
          | { storage: string; blob_sha256: string | null }
          | undefined;
        expect(row?.storage).toBe("external");
        expect(row?.blob_sha256).toBeTruthy();
      } finally {
        db.close();
      }
    } finally {
      if (prevExport === undefined) delete process.env.HARNESS_EXPORT_FILES;
      else process.env.HARNESS_EXPORT_FILES = prevExport;
    }
  });

  it("#303: a stale review-auto-error.json is pruned by the full sync after a successful retry (not re-materialized)", async () => {
    // #303 regression: a reviewer FAILS → review-auto-error.json is ingested into
    // the DB (storage='db', blob present). On a later SUCCESSFUL retry,
    // runReviewerAgent removes the on-disk error file. The db-first full sync must
    // PRUNE the now-DB-canonical-but-not-quarantined error row — otherwise
    // exportRun re-materializes a stale failure artifact after the review
    // succeeded. The canonical verdict in review_proposals is correct; this is an
    // artifact-retention cleanliness fix.
    const prevExport = process.env.HARNESS_EXPORT_FILES;
    process.env.HARNESS_EXPORT_FILES = "0";
    try {
      const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
      const errorRel = "reviewers/codex-reviewer/review-auto-error.json";

      // 1) reviewer FAILS (invalid decision) → review-auto-error.json written.
      const invalidOutput = [
        "```yaml",
        "decision: not-a-valid-decision",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "```",
      ].join("\n");
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        codexRunner: fakeRunner(invalidOutput),
        allowOverwrite: true,
        now: new Date("2026-05-23T07:00:00Z"),
      }).catch(() => undefined);
      expect(existsSync(join(runsDir, runId, errorRel))).toBe(true);

      // 2) full sync ingests the on-disk error file as a DB-canonical row.
      syncRunArtifactsToDb({ dbPath, runsDir, runId });
      {
        const db = openDbReadonly(dbPath);
        try {
          const row = db
            .prepare(
              `SELECT blob_sha256 FROM artifacts
                WHERE run_id = ? AND relative_path = ? AND storage = 'db'`,
            )
            .get(runId, errorRel) as { blob_sha256: string | null } | undefined;
          expect(row?.blob_sha256).toBeTruthy(); // precondition: it WAS ingested
        } finally {
          db.close();
        }
      }

      // 3) successful retry (same reviewer) — runReviewerAgent removes the
      // on-disk review-auto-error.json (reviewer-agent.ts: rm errorArtifactPath).
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        codexRunner: fakeRunner(APPROVED_OUTPUT),
        allowOverwrite: true,
        now: new Date("2026-05-23T07:01:00Z"),
      });
      expect(existsSync(join(runsDir, runId, errorRel))).toBe(false);

      // 4) full post-round sync (delete-then-rescan / db-first merge). The stale,
      // NOT-quarantined error row must be PRUNED — not preserved + re-exported.
      syncRunArtifactsToDb({ dbPath, runsDir, runId });

      const db = openDbReadonly(dbPath);
      try {
        const row = db
          .prepare(
            `SELECT blob_sha256 FROM artifacts
              WHERE run_id = ? AND relative_path = ?`,
          )
          .get(runId, errorRel) as { blob_sha256: string | null } | undefined;
        expect(row).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      if (prevExport === undefined) delete process.env.HARNESS_EXPORT_FILES;
      else process.env.HARNESS_EXPORT_FILES = prevExport;
    }
  });

  it("#303: a quarantined reviewer transcript carries the quarantined marker and survives the full sync (#272 non-regression)", async () => {
    // Pins the distinguishing mechanism: the quarantine path MARKS the rows it
    // intentionally preserves (`quarantined = 1`); the db-first full sync keeps
    // ONLY marked absent-recoverable rows. A quarantined transcript must keep its
    // marker AND survive the post-round sync (no regression of #272).
    const prevExport = process.env.HARNESS_EXPORT_FILES;
    process.env.HARNESS_EXPORT_FILES = "0";
    try {
      const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "alice",
        codexRunner: fakeRunner(APPROVED_OUTPUT),
        allowOverwrite: true,
        now: new Date("2026-05-23T08:00:00Z"),
      });
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "bob",
        codexRunner: fakeRunner(APPROVED_OUTPUT),
        allowOverwrite: true,
        now: new Date("2026-05-23T08:01:00Z"),
      });

      const rel = "reviewers/alice/reviewer-agent.out.log";
      {
        const db = openDbReadonly(dbPath);
        try {
          const marked = db
            .prepare(
              `SELECT quarantined FROM artifacts
                WHERE run_id = ? AND relative_path = ? AND storage = 'db'`,
            )
            .get(runId, rel) as { quarantined: number } | undefined;
          expect(marked?.quarantined).toBe(1); // quarantine stamped the marker
        } finally {
          db.close();
        }
      }

      // Full post-round sync must NOT prune the marked row.
      syncRunArtifactsToDb({ dbPath, runsDir, runId });

      const db = openDbReadonly(dbPath);
      try {
        const row = db
          .prepare(
            `SELECT quarantined, blob_sha256 FROM artifacts
              WHERE run_id = ? AND relative_path = ? AND storage = 'db'`,
          )
          .get(runId, rel) as
          | { quarantined: number; blob_sha256: string | null }
          | undefined;
        expect(row?.quarantined).toBe(1);
        expect(row?.blob_sha256).toBeTruthy();
        const body = readArtifactBlob(db, row!.blob_sha256 as string)?.toString(
          "utf8",
        );
        expect(body).toContain("decision: approved");
      } finally {
        db.close();
      }
    } finally {
      if (prevExport === undefined) delete process.env.HARNESS_EXPORT_FILES;
      else process.env.HARNESS_EXPORT_FILES = prevExport;
    }
  });

  it("#272: quarantine is a NO-OP for a DB-backed file-first/legacy run (verdict not removed) (codex P2)", async () => {
    // A DB exists but the run row is NOT db-first → the DB is not canonical for
    // this run, so removing the verdict sidecar would lose it with no recovery.
    // The whole quarantine (incl. the former ungated suppress backstop) must be a
    // no-op.
    const root = mkdtempSync(join(tmpdir(), "harness-ff-"));
    const runsDir = join(root, "runs");
    const runId = "run-20260523-apps-user-ff1";
    const runDir = join(runsDir, runId);
    mkdirSync(runDir, { recursive: true });
    const dbPath = join(root, ".harness", "harness.sqlite");
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      // legacy-file (file-first) run: source_mode defaults to 'legacy-file'.
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, updated_at, meta_json)
         VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
           'legacy-file', 1, 'disabled', '2026-05-23T00:00:00Z', '{}')`,
      ).run(runId);
    } finally {
      db.close();
    }
    // canonical verdict sidecars on disk (file-first: the file IS the truth).
    const rootVerdict = join(runDir, "review-decision.yaml");
    const scopedVerdict = join(runDir, "reviewers", "alice", "review-decision.yaml");
    mkdirSync(join(runDir, "reviewers", "alice"), { recursive: true });
    writeFileSync(rootVerdict, "decision: approved\n");
    writeFileSync(scopedVerdict, "decision: approved\n");

    const result = quarantinePriorReviewerVerdictArtifacts({
      dbPath,
      runsDir,
      runId,
    });

    // No-op: nothing removed, both canonical verdict files still on disk.
    expect(result).toEqual({ removed: [], ingested: [] });
    expect(existsSync(rootVerdict)).toBe(true);
    expect(existsSync(scopedVerdict)).toBe(true);
  });

  it("#272: runReviewerAgent does NOT remove a file-first run's canonical verdict (codex P2, reviewer-agent path)", async () => {
    // Faithful guard for the reviewer-agent.ts path: a DB-backed file-first run,
    // export OFF, has its canonical root review-decision.yaml present. The review
    // flow must NOT remove it (the former ungated suppressRunDirVerdictFiles would
    // have). The run errors at the db-first-only proposal insert, but the verdict
    // file must survive regardless.
    const prevExport = process.env.HARNESS_EXPORT_FILES;
    process.env.HARNESS_EXPORT_FILES = "0";
    try {
      const root = mkdtempSync(join(tmpdir(), "harness-ffra-"));
      const runsDir = join(root, "runs");
      const runId = "run-20260523-apps-user-ffra1";
      const runDir = join(runsDir, runId);
      mkdirSync(runDir, { recursive: true });
      const dbPath = join(root, ".harness", "harness.sqlite");
      const db = openDb(dbPath);
      try {
        runMigrations(db);
        db.prepare(
          `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
             status, source_mode, db_revision, export_status, updated_at, meta_json)
           VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
             'legacy-file', 1, 'disabled', '2026-05-23T00:00:00Z', '{}')`,
        ).run(runId);
      } finally {
        db.close();
      }
      writeFileSync(
        join(runDir, "meta.json"),
        JSON.stringify({ runId, repoId: "t", domain: "apps/user", status: "needs_review" }),
      );
      writeFileSync(join(runDir, "events.jsonl"), "");
      writeFileSync(join(runDir, "final-diff.patch"), "diff\n");
      const rootVerdict = join(runDir, "review-decision.yaml");
      writeFileSync(
        rootVerdict,
        `runId: ${runId}\ndomain: apps/user\ndecision: pending\nrequired_changes: []\nnon_blocking_comments: []\nout_of_scope_suggestions: []\nreviewer: null\nreviewed_at: null\n`,
      );

      // The review will reject at the db-first-only proposal insert; we only care
      // that the canonical verdict file was not removed before/along the way.
      await runReviewerAgent({
        runsDir,
        runId,
        dbPath,
        reviewerName: "alice",
        codexRunner: fakeRunner(APPROVED_OUTPUT),
        allowOverwrite: true,
        now: new Date("2026-05-23T06:00:00Z"),
      }).catch(() => undefined);

      expect(existsSync(rootVerdict)).toBe(true);
    } finally {
      if (prevExport === undefined) delete process.env.HARNESS_EXPORT_FILES;
      else process.env.HARNESS_EXPORT_FILES = prevExport;
    }
  });

  /** Seed a v34-shape DB (every migration BEFORE v35 — no `quarantined` column)
   *  with a db-first run that has an on-disk reviewers/<id> dir, mirroring a
   *  freshly-upgraded-but-unmigrated ops DB. */
  function v34DbFirstRunWithReviewerDir(): {
    runsDir: string;
    dbPath: string;
    runId: string;
  } {
    const root = mkdtempSync(join(tmpdir(), "harness-v34-"));
    const runsDir = join(root, "runs");
    const runId = "run-20260523-apps-user-v34";
    const runDir = join(runsDir, runId);
    mkdirSync(join(runDir, "reviewers", "alice"), { recursive: true });
    writeFileSync(join(runDir, "meta.json"), JSON.stringify({ runId }));
    writeFileSync(
      join(runDir, "reviewers", "alice", "reviewer-agent.out.log"),
      "decision: approved\n",
    );
    const dbPath = join(root, ".harness", "harness.sqlite");
    const db = openDb(dbPath);
    try {
      db.prepare(
        `CREATE TABLE schema_migrations (
           version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
         )`,
      ).run();
      for (const m of MIGRATIONS.filter((mig) => mig.version < 35)) {
        for (const stmt of m.statements) db.prepare(stmt).run();
        db.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(m.version, m.name, "2026-05-23T00:00:00Z");
      }
      const colNames = (
        db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]
      ).map((r) => r.name);
      expect(colNames).not.toContain("quarantined"); // precondition: v34 shape
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, updated_at)
         VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
           'db-first', 1, 'disabled', '2026-05-23T00:00:00Z')`,
      ).run(runId);
    } finally {
      db.close();
    }
    return { runsDir, dbPath, runId };
  }

  it("#303 P1#2: quarantine + sync self-migrate on a v34 (unmigrated) DB — no missing-column error", () => {
    // openManagedDb does NOT migrate; the quarantine writes the v35 `quarantined`
    // column. On a freshly-upgraded v34 DB this would throw `no such column:
    // quarantined` without the in-helper runMigrations. Both helpers must bring
    // the schema current first.
    const { runsDir, dbPath, runId } = v34DbFirstRunWithReviewerDir();
    expect(() =>
      quarantinePriorReviewerVerdictArtifacts({ dbPath, runsDir, runId }),
    ).not.toThrow();
    expect(() =>
      syncRunArtifactsToDb({ dbPath, runsDir, runId }),
    ).not.toThrow();
    // and the schema is now current (column present)
    const db = openDbReadonly(dbPath);
    try {
      const colNames = (
        db.prepare("PRAGMA table_info(artifacts)").all() as { name: string }[]
      ).map((r) => r.name);
      expect(colNames).toContain("quarantined");
    } finally {
      db.close();
    }
  });

  it("#303 P2: a review-evaluations/* error.json is NOT pruned by the full sync (durable per-sample diagnostic)", () => {
    // The reviewer retry sidecar `reviewers/<id>/review-auto-error.json` is
    // transient; the review-evaluator's per-sample diagnostic
    // `review-evaluations/<sample>/review-auto-error.json` (#279) shares the
    // basename but IS durable. The narrowed exclusion must keep it quarantined.
    const prevExport = process.env.HARNESS_EXPORT_FILES;
    process.env.HARNESS_EXPORT_FILES = "0";
    try {
      const { runsDir, dbPath, runId } = dbOnlyNeedsReview();
      const evalRel = "review-evaluations/sample-0/review-auto-error.json";
      mkdirSync(join(runsDir, runId, "review-evaluations", "sample-0"), {
        recursive: true,
      });
      writeFileSync(
        join(runsDir, runId, evalRel),
        '{"type":"review-auto-error","sample":0}\n',
      );

      // Quarantine the prior outputs (ingests + marks, removes from disk).
      quarantinePriorReviewerVerdictArtifacts({ dbPath, runsDir, runId });
      // It is marked quarantined (NOT excluded like the reviewer sidecar).
      {
        const db = openDbReadonly(dbPath);
        try {
          const marked = db
            .prepare(
              `SELECT quarantined FROM artifacts
                WHERE run_id = ? AND relative_path = ? AND storage = 'db'`,
            )
            .get(runId, evalRel) as { quarantined: number } | undefined;
          expect(marked?.quarantined).toBe(1);
        } finally {
          db.close();
        }
      }
      // Full sync must NOT prune the eval diagnostic.
      syncRunArtifactsToDb({ dbPath, runsDir, runId });
      const db = openDbReadonly(dbPath);
      try {
        const row = db
          .prepare(
            `SELECT blob_sha256 FROM artifacts
              WHERE run_id = ? AND relative_path = ?`,
          )
          .get(runId, evalRel) as { blob_sha256: string | null } | undefined;
        expect(row?.blob_sha256).toBeTruthy();
      } finally {
        db.close();
      }
    } finally {
      if (prevExport === undefined) delete process.env.HARNESS_EXPORT_FILES;
      else process.env.HARNESS_EXPORT_FILES = prevExport;
    }
  });
});
