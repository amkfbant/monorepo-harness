import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/db/migrations.js";
import {
  ReviewRefuteVotesRepository,
  type ReviewRefuteVoteInput,
} from "../../../src/db/repositories/review-refute-votes.js";

const NOW = "2026-06-17T00:00:00.000Z";

function dbWithFinding(hitchId: string, findingId: string): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(
    `INSERT INTO hitch_sessions
       (hitch_id, title, status, scope_json, close_conditions_json,
        policy_json, max_iterations, max_review_cycles, max_reruns,
        max_total_new_findings, created_by, created_source,
        created_at, updated_at)
     VALUES (?, ?, 'open', '{}', '[]', '{}', 10, 5, 3, 100,
             'tester', 'cli', ?, ?)`,
  ).run(hitchId, `session ${hitchId}`, NOW, NOW);
  db.prepare(
    `INSERT INTO hitch_findings
       (finding_id, hitch_id, stable_key, source, severity, category,
        scope_status, lifecycle_status, summary, file_path,
        first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 'review', 'P1', 'core', 'unknown', 'open',
             'a finding', 'src/a.ts', ?, ?)`,
  ).run(findingId, hitchId, `key-${findingId}`, NOW, NOW);
  return db;
}

function seedRunAndUsage(db: Database.Database, runId: string): void {
  db.prepare(
    `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
       status, updated_at)
     VALUES (?, 'demo', 'self', 'domain-coding', 'main',
       'needs_review', ?)`,
  ).run(runId, NOW);
  db.prepare(
    `INSERT INTO run_usage
       (run_id, kind, seq, model, input_tokens, output_tokens, total_tokens,
        usage_source, created_at)
     VALUES (?, 'reviewer', 2, 'gpt-test', 10, 5, 15, 'exact', ?)`,
  ).run(runId, NOW);
}

function passedInput(
  overrides: Partial<ReviewRefuteVoteInput> = {},
): ReviewRefuteVoteInput {
  return {
    runId: "run-1",
    hitchId: "h1",
    targetChangeHash: "precomputed-hash",
    targetChangeIdx: 3,
    findingId: "f1",
    reviewerId: "reviewer-a",
    refuteVerdict: "uphold",
    confidence: 0.75,
    reasoning: "looks sound",
    model: "gpt-test",
    promptSha256: "prompt-a",
    promptProvenance: { template: "refute-vote", version: 1 },
    usageKind: "reviewer",
    usageSeq: 2,
    sourceYaml: "verdict: uphold\n",
    sourceSha256: "source-a",
    validationStatus: "passed",
    createdAt: NOW,
    ...overrides,
  };
}

function rejectedInput(
  overrides: Partial<ReviewRefuteVoteInput> = {},
): ReviewRefuteVoteInput {
  return {
    ...passedInput({
      refuteVerdict: undefined,
      confidence: undefined,
      reasoning: undefined,
      promptProvenance: undefined,
      validationStatus: "rejected",
      rejectReason: "schema parse failed",
      sourceYaml: "not: valid\n",
      sourceSha256: "bad-source-a",
      ...overrides,
    }),
  };
}

describe("ReviewRefuteVotesRepository", () => {
  it("appends a precomputed target_change_hash and lists by run and target", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new ReviewRefuteVotesRepository(db);

    const first = repo.insert(passedInput({ targetChangeHash: "hash-one" }));
    const second = repo.insert(
      passedInput({
        targetChangeHash: "hash-two",
        promptSha256: "prompt-b",
        sourceSha256: "source-b",
        createdAt: "2026-06-17T00:00:01.000Z",
      }),
    );

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(first.row.targetChangeHash).toBe("hash-one");
    expect(first.row.targetChangeIdx).toBe(3);
    expect(first.row.promptProvenanceJson).toBe(
      JSON.stringify({ template: "refute-vote", version: 1 }),
    );
    expect(repo.listByRun("run-1").map((row) => row.refuteId)).toEqual([
      first.row.refuteId,
      second.row.refuteId,
    ]);
    expect(
      repo.listByTarget("run-1", "hash-one").map((row) => row.refuteId),
    ).toEqual([first.row.refuteId]);
  });

  it("preserves the run_usage correlation footprint without a foreign key", () => {
    const db = dbWithFinding("h1", "f1");
    seedRunAndUsage(db, "run-usage");
    const repo = new ReviewRefuteVotesRepository(db);

    const { row } = repo.insert(
      passedInput({ runId: "run-usage", usageKind: "reviewer", usageSeq: 2 }),
    );

    expect(row.usageKind).toBe("reviewer");
    expect(row.usageSeq).toBe(2);
    const joined = db
      .prepare(
        `SELECT u.model
           FROM review_refute_votes v
           JOIN run_usage u
             ON u.run_id = v.run_id
            AND u.kind = v.usage_kind
            AND u.seq = v.usage_seq
          WHERE v.refute_id = ?`,
      )
      .get(row.refuteId) as { model: string };
    expect(joined.model).toBe("gpt-test");
  });

  it("dedupes duplicate passed participant votes by the v32 partial unique key", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new ReviewRefuteVotesRepository(db);

    const first = repo.insert(passedInput());
    const duplicate = repo.insert(
      passedInput({
        sourceYaml: "verdict: refute\n",
        sourceSha256: "different-source",
        reasoning: "retry output changed",
      }),
    );

    expect(duplicate.inserted).toBe(false);
    expect(duplicate.row.refuteId).toBe(first.row.refuteId);
    expect(repo.listByRun("run-1")).toHaveLength(1);
  });

  it("allows inconclusive then uphold/refute and rejected retries with distinct source hashes", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new ReviewRefuteVotesRepository(db);

    repo.insert(
      passedInput({
        refuteVerdict: "inconclusive",
        sourceSha256: "source-inconclusive",
      }),
    );
    repo.insert(
      passedInput({
        refuteVerdict: "uphold",
        sourceSha256: "source-uphold",
      }),
    );
    repo.insert(rejectedInput({ sourceSha256: "rejected-a" }));
    repo.insert(rejectedInput({ sourceSha256: "rejected-b" }));
    const rejectedDup = repo.insert(
      rejectedInput({ sourceSha256: "rejected-b" }),
    );

    expect(rejectedDup.inserted).toBe(false);
    expect(repo.listByRun("run-1").map((row) => row.sourceSha256)).toEqual([
      "source-inconclusive",
      "source-uphold",
      "rejected-a",
      "rejected-b",
    ]);
  });

  it("hard rejects a vote whose finding_id does not exist", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new ReviewRefuteVotesRepository(db);

    expect(() => repo.insert(passedInput({ findingId: "ghost" }))).toThrow(
      /finding_id ghost not found/i,
    );
    expect(repo.listByRun("run-1")).toHaveLength(0);
  });

  it("hard rejects a vote whose hitch_id disagrees with the finding", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new ReviewRefuteVotesRepository(db);

    expect(() =>
      repo.insert(passedInput({ hitchId: "wrong-hitch" })),
    ).toThrow(/hitch_id mismatch/i);
    expect(repo.listByRun("run-1")).toHaveLength(0);
  });

  it("does not swallow non-unique CHECK failures while deduping", () => {
    const db = dbWithFinding("h1", "f1");
    const repo = new ReviewRefuteVotesRepository(db);

    expect(() =>
      repo.insert(
        passedInput({
          refuteVerdict: "refute",
          refuteReason: undefined,
          counterEvidenceKind: undefined,
          counterEvidenceRef: undefined,
          refuteCondition: undefined,
          retractCondition: undefined,
        }),
      ),
    ).toThrow(/CHECK/i);
    expect(repo.listByRun("run-1")).toHaveLength(0);
  });
});
