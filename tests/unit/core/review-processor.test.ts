import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { processReviewDecision } from "../../../src/core/review-processor.js";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { makeTmpDir } from "../../helpers/tmp.js";

/** Seed the DB with a `db-first` run row matching an on-disk meta.json. */
function seedDbFirstRun(
  dbPath: string,
  runsDir: string,
  runId: string,
): void {
  const meta = JSON.parse(
    readFileSync(join(runsDir, runId, "meta.json"), "utf8"),
  ) as Record<string, unknown>;
  const db = openDb(dbPath);
  runMigrations(db);
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch, status,
       started_at, updated_at, source_mode, db_revision, meta_json)
     VALUES (?, ?, ?, 'domain-coding', 'main', ?, ?, ?, 'db-first', 1, ?)`,
  ).run(
    runId,
    meta.repoId,
    meta.domain,
    meta.status,
    meta.startedAt,
    meta.startedAt,
    JSON.stringify(meta, null, 2),
  );
  db.close();
}

interface FakeMeta {
  runId: string;
  repoId: string;
  repoPath: string;
  domain: string;
  workflow: string;
  baseBranch: string;
  baseSha: string;
  runBranch: string;
  status: string;
  safetyStatus?: string;
  ignoredUntrackedCount?: number;
  secretSuspectCount?: number;
  startedAt: string;
  finishedAt?: string;
  reviewer?: string | null;
  reviewedAt?: string | null;
}

function writeFakeRun(
  runsDir: string,
  runId: string,
  meta: Partial<FakeMeta>,
  decisionFile: Record<string, unknown>,
): string {
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const fullMeta: FakeMeta = {
    runId,
    repoId: "mini-commerce",
    repoPath: "/tmp/mini",
    domain: "apps/user",
    workflow: "domain-coding",
    baseBranch: "main",
    baseSha: "abc",
    runBranch: "harness/x",
    status: "needs_review",
    startedAt: "2026-05-20T00:00:00Z",
    ...meta,
  };
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(fullMeta, null, 2));
  writeFileSync(join(runDir, "events.jsonl"), "");
  const decision = {
    runId,
    domain: fullMeta.domain,
    required_changes: [],
    non_blocking_comments: [],
    out_of_scope_suggestions: [],
    reviewer: null,
    reviewed_at: null,
    ...decisionFile,
  };
  const yamlLines = Object.entries(decision)
    .map(([k, v]) => {
      if (v === null) return `${k}: null`;
      if (Array.isArray(v))
        return v.length === 0
          ? `${k}: []`
          : `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}`;
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join("\n");
  writeFileSync(join(runDir, "review-decision.yaml"), yamlLines + "\n");
  return runDir;
}

describe("processReviewDecision", () => {
  it("transitions needs_review → approved when decision=approved + reviewer set", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    writeFakeRun(runsDir, "run-A", {}, {
      decision: "approved",
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    const r = await processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-A" });
    expect(r.previousStatus).toBe("needs_review");
    expect(r.newStatus).toBe("approved");
    expect(r.reviewer).toBe("alice");
    const meta = JSON.parse(
      readFileSync(join(runsDir, "run-A", "meta.json"), "utf8"),
    );
    expect(meta.status).toBe("approved");
    expect(meta.reviewer).toBe("alice");
    expect(meta.reviewedAt).toBe("2026-05-20T12:00:00Z");
  });

  it("transitions to changes_requested and rejected likewise", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    writeFakeRun(runsDir, "run-B", {}, {
      decision: "changes_requested",
      reviewer: "bob",
      reviewed_at: "2026-05-20T13:00:00Z",
    });
    const r = await processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-B" });
    expect(r.newStatus).toBe("changes_requested");

    writeFakeRun(runsDir, "run-C", {}, {
      decision: "rejected",
      reviewer: "carol",
      reviewed_at: "2026-05-20T14:00:00Z",
    });
    const r2 = await processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-C" });
    expect(r2.newStatus).toBe("rejected");
  });

  it("auto-fills reviewed_at when null and writes back to file", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    writeFakeRun(runsDir, "run-D", {}, {
      decision: "approved",
      reviewer: "alice",
      reviewed_at: null,
    });
    const before = new Date().getTime();
    const r = await processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-D" });
    const after = new Date().getTime();
    const ts = new Date(r.reviewedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    const raw = readFileSync(
      join(runsDir, "run-D", "review-decision.yaml"),
      "utf8",
    );
    expect(raw).not.toMatch(/reviewed_at: null/);
  });

  it("rejects when decision is still pending", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    writeFakeRun(runsDir, "run-E", {}, { decision: "pending" });
    await expect(
      processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-E" }),
    ).rejects.toThrow(/pending/);
  });

  it("rejects when current meta.status is not needs_review", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    writeFakeRun(runsDir, "run-F", { status: "approved" }, {
      decision: "approved",
      reviewer: "alice",
    });
    await expect(
      processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-F" }),
    ).rejects.toThrow(/status is "approved"/);
  });

  it("rejects when runId in file does not match dir name", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    writeFakeRun(runsDir, "run-G", {}, {
      runId: "run-different",
      decision: "approved",
      reviewer: "alice",
    });
    await expect(
      processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-G" }),
    ).rejects.toThrow(/runId/);
  });

  it("rejects when domain in file does not match meta.json", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    writeFakeRun(runsDir, "run-H", { domain: "apps/user" }, {
      domain: "apps/other",
      decision: "approved",
      reviewer: "alice",
    });
    await expect(
      processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-H" }),
    ).rejects.toThrow(/domain/);
  });

  it("appends a review_processed event", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    writeFakeRun(runsDir, "run-I", {}, {
      decision: "approved",
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    await processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-I" });
    const events = readFileSync(
      join(runsDir, "run-I", "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const ev = events.find((e) => e.type === "review_processed");
    expect(ev).toBeDefined();
    expect(ev?.decision).toBe("approved");
    expect(ev?.reviewer).toBe("alice");
  });

  it("rejects path-traversal runId (../)", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    await expect(
      processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "../escape" }),
    ).rejects.toThrow(/invalid runId/);
  });

  it("rejects malformed meta.json (not an object) as gate error", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    const runDir = join(runsDir, "run-bad-meta-001");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "meta.json"), '"just a string"');
    writeFileSync(join(runDir, "events.jsonl"), "");
    writeFileSync(
      join(runDir, "review-decision.yaml"),
      [
        "runId: run-bad-meta-001",
        "domain: apps/user",
        "decision: approved",
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: alice",
        "reviewed_at: 2026-05-21T00:00:00Z",
      ].join("\n"),
    );
    await expect(
      processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-bad-meta-001" }),
    ).rejects.toThrow(/not an object/);
  });

  it("returns a warning flag when reviewer is null", async () => {
    const runsDir = makeTmpDir("harness-rp-");
    writeFakeRun(runsDir, "run-J", {}, {
      decision: "approved",
      reviewer: null,
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    const r = await processReviewDecision({ runsDir, locksDir: runsDir, dbPath: join(runsDir, "harness.sqlite"), runId: "run-J" });
    expect(r.reviewer).toBeNull();
    expect(r.warnings).toContain("reviewer field is null");
  });

  // Phase 10-1: removed two tests that asserted file-domain-lock based
  // serialization between concurrent cleanup and review process. The file
  // domain lock has been retired; review process is now serialized by the
  // state guard (status / state_version CAS, see Phase 10-5) and the DB
  // lease-stealing integration test covers the live concurrency scenarios
  // (tests/integration/db-lock-only-serialization.test.ts in Phase 10-2).
});

describe("processReviewDecision — DB-first run (Phase 7-5)", () => {
  it("applies the decision through the DB and re-exports the files", async () => {
    const runsDir = makeTmpDir("harness-rp-dbf-");
    const dbPath = join(runsDir, "harness.sqlite");
    writeFakeRun(runsDir, "run-dbf", {}, {
      decision: "approved",
      reviewer: "alice",
      reviewed_at: "2026-05-20T12:00:00Z",
    });
    seedDbFirstRun(dbPath, runsDir, "run-dbf");

    const r = await processReviewDecision({
      runsDir,
      locksDir: runsDir,
      dbPath,
      runId: "run-dbf",
    });
    expect(r.newStatus).toBe("approved");

    const db = openDb(dbPath);
    try {
      const row = db
        .prepare("SELECT status, reviewer FROM runs WHERE run_id = 'run-dbf'")
        .get() as { status: string; reviewer: string };
      expect(row).toEqual({ status: "approved", reviewer: "alice" });
      const decision = db
        .prepare(
          "SELECT decision FROM review_decisions WHERE run_id = 'run-dbf'",
        )
        .get() as { decision: string };
      expect(decision.decision).toBe("approved");
    } finally {
      db.close();
    }
    // meta.json was re-exported from the DB
    const meta = JSON.parse(
      readFileSync(join(runsDir, "run-dbf", "meta.json"), "utf8"),
    ) as { status: string; reviewer: string };
    expect(meta.status).toBe("approved");
    expect(meta.reviewer).toBe("alice");
    // events.jsonl carries the review_processed event
    expect(
      readFileSync(join(runsDir, "run-dbf", "events.jsonl"), "utf8"),
    ).toMatch(/review_processed/);
  });

  it("rejects a run row with an unknown source_mode", async () => {
    const runsDir = makeTmpDir("harness-rp-dbf-");
    const dbPath = join(runsDir, "harness.sqlite");
    writeFakeRun(runsDir, "run-weird", {}, { decision: "approved" });
    const meta = JSON.parse(
      readFileSync(join(runsDir, "run-weird", "meta.json"), "utf8"),
    ) as Record<string, unknown>;
    const db = openDb(dbPath);
    runMigrations(db);
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, updated_at, source_mode)
       VALUES ('run-weird', ?, ?, 'domain-coding', 'main', 'needs_review',
         'x', 'bogus-mode')`,
    ).run(meta.repoId, meta.domain);
    db.close();
    await expect(
      processReviewDecision({
        runsDir,
        locksDir: runsDir,
        dbPath,
        runId: "run-weird",
      }),
    ).rejects.toThrow(/source-mode/);
  });

  it(
    "re-processing a run that already left needs_review is an idempotent " +
      "no-op (Phase 9 post-close P1 #1 + P2-2 file→proposal import)",
    async () => {
      const runsDir = makeTmpDir("harness-rp-dbf-");
      const dbPath = join(runsDir, "harness.sqlite");
      writeFakeRun(runsDir, "run-dbf2", {}, {
        decision: "approved",
        reviewer: "alice",
        reviewed_at: "2026-05-20T12:00:00Z",
      });
      seedDbFirstRun(dbPath, runsDir, "run-dbf2");
      const r1 = await processReviewDecision({
        runsDir,
        locksDir: runsDir,
        dbPath,
        runId: "run-dbf2",
      });
      expect(r1.newStatus).toBe("approved");
      // Phase 9 post-close changed the semantics: a second pass sees the
      // run is already promoted (DB row past needs_review + a processed
      // proposal recording the prior decision), so it returns an
      // idempotent no-op instead of failing the status gate.
      const r2 = await processReviewDecision({
        runsDir,
        locksDir: runsDir,
        dbPath,
        runId: "run-dbf2",
      });
      expect(r2.previousStatus).toBe("approved");
      expect(r2.newStatus).toBe("approved");
      expect(r2.warnings.some((w) => /idempotent/i.test(w))).toBe(true);
    },
  );
});
