import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateReviewer,
  compareDecisions,
} from "../../src/core/review-evaluator.js";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "../../src/codex/codex-exec-runner.js";
import { openDb } from "../../src/db/connection.js";
import { runMigrations, MIGRATIONS } from "../../src/db/migrations.js";
import { recordOperationalKnowledge } from "../../src/core/operational-knowledge.js";

interface SetupOpts {
  safetyStatus?: string;
  secretSuspectCount?: number;
}

function setupRun(opts: SetupOpts = {}): {
  runsDir: string;
  runId: string;
} {
  const root = mkdtempSync(join(tmpdir(), "harness-reval-"));
  const runsDir = join(root, "runs");
  const runId = "run-20260521-apps-user-eval1";
  const runDir = join(runsDir, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      runId,
      domain: "apps/user",
      status: "needs_review",
      safetyStatus: opts.safetyStatus ?? "allowed",
      secretSuspectCount: opts.secretSuspectCount ?? 0,
      startedAt: "2026-05-21T00:00:00Z",
    }),
  );
  writeFileSync(join(runDir, "summary.md"), "# summary\n");
  return { runsDir, runId };
}

function yamlBlock(decision: string, required: string[] = []): string {
  const list =
    required.length === 0
      ? " []"
      : "\n" + required.map((r) => `  - ${JSON.stringify(r)}`).join("\n");
  return [
    "```yaml",
    `decision: ${decision}`,
    `required_changes:${list}`,
    "non_blocking_comments: []",
    "out_of_scope_suggestions: []",
    "```",
  ].join("\n");
}

/** Reviewer runner that emits a different output per call. */
function sequenced(outputs: string[]): CodexExecRunner {
  let i = 0;
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      const out = outputs[Math.min(i, outputs.length - 1)] ?? "";
      i += 1;
      await writeFile(input.logPaths.stdout, out, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      return { exitCode: 0, timedOut: false, durationMs: 0 };
    },
  };
}

function sequencedWithEvents(outputs: string[], events: string): CodexExecRunner {
  let i = 0;
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      const out = outputs[Math.min(i, outputs.length - 1)] ?? "";
      i += 1;
      await writeFile(input.logPaths.stdout, out, "utf8");
      await writeFile(input.logPaths.stderr, "", "utf8");
      await writeFile(input.logPaths.events, events, "utf8");
      return { exitCode: 0, timedOut: false, durationMs: 0 };
    },
  };
}

describe("evaluateReviewer operational-knowledge injection (issue #57)", () => {
  it("samples the same operational-knowledge prompt the production reviewer uses", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-reval-ops-"));
    const runsDir = join(root, "runs");
    const runId = "run-20260521-apps-user-evalops";
    const runDir = join(runsDir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "meta.json"),
      JSON.stringify({
        runId, repoId: "t", domain: "apps/user", status: "needs_review",
        safetyStatus: "allowed", startedAt: "2026-05-21T00:00:00Z",
      }),
    );
    writeFileSync(join(runDir, "summary.md"), "# summary\n");
    const dbPath = join(root, ".harness", "harness.sqlite");
    const db = openDb(dbPath);
    try {
      runMigrations(db);
      recordOperationalKnowledge(db, { key: "repo-note", title: "Repo CI quirk", body: "x", repoId: "t", actor: "op" });
    } finally {
      db.close();
    }
    const prompts: string[] = [];
    const runner: CodexExecRunner = {
      async run(input: CodexRunInputs): Promise<CodexRunResult> {
        prompts.push(input.prompt);
        await writeFile(input.logPaths.stdout, yamlBlock("approved"), "utf8");
        await writeFile(input.logPaths.stderr, "", "utf8");
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      },
    };
    await evaluateReviewer({ runsDir, runId, samples: 2, dbPath, codexRunner: runner });
    expect(prompts).toHaveLength(2);
    for (const p of prompts) {
      expect(p).toContain("<operational-knowledge>");
      expect(p).toContain("Repo CI quirk");
    }
  });
});

describe("evaluateReviewer", () => {
  it("runs N samples and saves each under review-evaluations/eval-NNN/", async () => {
    const { runsDir, runId } = setupRun();
    const r = await evaluateReviewer({
      runsDir,
      runId,
      samples: 3,
      codexRunner: sequenced([yamlBlock("approved")]),
    });
    expect(r.samples).toHaveLength(3);
    const evalRoot = join(runsDir, runId, "review-evaluations");
    for (const n of ["eval-001", "eval-002", "eval-003"]) {
      expect(existsSync(join(evalRoot, n, "review-decision.yaml"))).toBe(true);
      expect(existsSync(join(evalRoot, n, "reviewer-agent.out.log"))).toBe(true);
    }
    expect(existsSync(join(evalRoot, "evaluation-summary.md"))).toBe(true);
  });

  it("redacts per-sample reviewer codex events before publishing them", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP";
    const { runsDir, runId } = setupRun();
    await evaluateReviewer({
      runsDir,
      runId,
      samples: 1,
      codexRunner: sequencedWithEvents(
        [yamlBlock("approved")],
        `${JSON.stringify({
          type: "item.completed",
          item: {
            type: "command_execution",
            aggregated_output: `leaked ${secret}\n`,
          },
        })}\n`,
      ),
    });

    const evalDir = join(
      runsDir,
      runId,
      "review-evaluations",
      "eval-001",
    );
    const official = readFileSync(
      join(evalDir, "reviewer-agent.events.jsonl"),
      "utf8",
    );
    expect(official).not.toContain(secret);
    expect(official).toContain("[redacted: secret-suspect");
    expect(existsSync(join(evalDir, ".reviewer-agent.events.raw.jsonl"))).toBe(
      false,
    );
  });

  it("surfaces decision instability across samples", async () => {
    const { runsDir, runId } = setupRun();
    const r = await evaluateReviewer({
      runsDir,
      runId,
      samples: 3,
      codexRunner: sequenced([
        yamlBlock("approved"),
        yamlBlock("changes_requested", ["fix it"]),
        yamlBlock("approved"),
      ]),
    });
    expect(r.decisionCounts.approved).toBe(2);
    expect(r.decisionCounts.changes_requested).toBe(1);
    const summary = readFileSync(
      join(runsDir, runId, "review-evaluations", "evaluation-summary.md"),
      "utf8",
    );
    expect(summary).toMatch(/UNSTABLE/);
  });

  it("records an invalid sample without aborting the rest", async () => {
    const { runsDir, runId } = setupRun();
    const r = await evaluateReviewer({
      runsDir,
      runId,
      samples: 2,
      codexRunner: sequenced([
        "not a yaml block at all",
        yamlBlock("approved"),
      ]),
    });
    expect(r.samples[0]?.decision).toBe("invalid");
    expect(r.samples[1]?.decision).toBe("approved");
    expect(
      existsSync(
        join(
          runsDir,
          runId,
          "review-evaluations",
          "eval-001",
          "review-auto-error.json",
        ),
      ),
    ).toBe(true);
  });

  it("stores only a sanitized reason for malformed YAML samples", async () => {
    const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
    const { runsDir, runId } = setupRun();
    await evaluateReviewer({
      runsDir,
      runId,
      samples: 1,
      codexRunner: sequenced([
        ["```yaml", "decision: approved", `  ${secret}: leaked`, "```"].join(
          "\n",
        ),
      ]),
    });

    const text = readFileSync(
      join(
        runsDir,
        runId,
        "review-evaluations",
        "eval-001",
        "review-auto-error.json",
      ),
      "utf8",
    );
    expect(text).not.toContain(secret);
    expect(text).not.toContain("leaked");
    const artifact = JSON.parse(text) as {
      reason?: {
        reasonCode?: string;
        field?: string;
        valueType?: string;
        valueLength?: number;
        valueSha256?: string;
      };
    };
    expect(artifact.reason).toMatchObject({
      reasonCode: "reviewer_output_unparseable_yaml",
      field: "reviewer_output",
      valueType: "string",
    });
    expect(artifact.reason?.valueLength).toBeGreaterThan(secret.length);
    expect(artifact.reason?.valueSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("flags a sample that approved a safetyStatus=denied run", async () => {
    const { runsDir, runId } = setupRun({ safetyStatus: "denied" });
    const r = await evaluateReviewer({
      runsDir,
      runId,
      samples: 1,
      codexRunner: sequenced([yamlBlock("approved")]),
    });
    expect(r.dangerFlags.some((f) => /safetyStatus is "denied"/.test(f))).toBe(
      true,
    );
  });

  it("flags approved samples on a secret-suspect run", async () => {
    const { runsDir, runId } = setupRun({ secretSuspectCount: 2 });
    const r = await evaluateReviewer({
      runsDir,
      runId,
      samples: 1,
      codexRunner: sequenced([yamlBlock("approved")]),
    });
    expect(r.dangerFlags.some((f) => /secretSuspectCount=2/.test(f))).toBe(true);
  });

  it("rejects a non-positive samples count", async () => {
    const { runsDir, runId } = setupRun();
    await expect(
      evaluateReviewer({
        runsDir,
        runId,
        samples: 0,
        codexRunner: sequenced([yamlBlock("approved")]),
      }),
    ).rejects.toThrow(/samples must be a positive integer/);
  });

  it("does not touch the run's own review-decision.yaml", async () => {
    const { runsDir, runId } = setupRun();
    const ownDecision = join(runsDir, runId, "review-decision.yaml");
    writeFileSync(ownDecision, "decision: pending\n");
    await evaluateReviewer({
      runsDir,
      runId,
      samples: 2,
      codexRunner: sequenced([yamlBlock("approved")]),
    });
    expect(readFileSync(ownDecision, "utf8")).toBe("decision: pending\n");
  });

  it("detects a codex runner that mutates a run artifact (tamper)", async () => {
    const { runsDir, runId } = setupRun();
    // a runner that writes a normal review output BUT also tampers with
    // meta.json — observation must not allow that.
    const tampering: CodexExecRunner = {
      async run(input: CodexRunInputs): Promise<CodexRunResult> {
        writeFileSync(
          join(runsDir, runId, "meta.json"),
          '{"runId":"x","tampered":true}',
        );
        await writeFile(input.logPaths.stdout, yamlBlock("approved"), "utf8");
        await writeFile(input.logPaths.stderr, "", "utf8");
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      },
    };
    await expect(
      evaluateReviewer({ runsDir, runId, samples: 1, codexRunner: tampering }),
    ).rejects.toThrow(/must not modify the run/);
  });

  it("re-evaluation clears stale per-sample artifacts (valid then invalid)", async () => {
    const { runsDir, runId } = setupRun();
    const evalDir = join(runsDir, runId, "review-evaluations", "eval-001");
    // first: valid → review-decision.yaml
    await evaluateReviewer({
      runsDir,
      runId,
      samples: 1,
      codexRunner: sequenced([yamlBlock("approved")]),
    });
    expect(existsSync(join(evalDir, "review-decision.yaml"))).toBe(true);
    // second: invalid → review-auto-error.json, and the stale decision is gone
    await evaluateReviewer({
      runsDir,
      runId,
      samples: 1,
      codexRunner: sequenced(["garbage, not yaml"]),
    });
    expect(existsSync(join(evalDir, "review-auto-error.json"))).toBe(true);
    expect(existsSync(join(evalDir, "review-decision.yaml"))).toBe(false);
  });
});

describe("compareDecisions", () => {
  function writeDecision(path: string, decision: string): void {
    writeFileSync(
      path,
      [
        "runId: run-x",
        "domain: apps/user",
        `decision: ${decision}`,
        "required_changes: []",
        "non_blocking_comments: []",
        "out_of_scope_suggestions: []",
        "reviewer: someone",
        "reviewed_at: 2026-05-21T00:00:00Z",
        "",
      ].join("\n"),
    );
  }

  it("reports a decision match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cmp-"));
    writeDecision(join(dir, "human.yaml"), "approved");
    writeDecision(join(dir, "agent.yaml"), "approved");
    const r = await compareDecisions({
      humanPath: join(dir, "human.yaml"),
      agentPath: join(dir, "agent.yaml"),
    });
    expect(r.decisionMatch).toBe(true);
    expect(r.report).toMatch(/decision match: YES/);
  });

  it("reports a decision mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cmp-"));
    writeDecision(join(dir, "human.yaml"), "changes_requested");
    writeDecision(join(dir, "agent.yaml"), "approved");
    const r = await compareDecisions({
      humanPath: join(dir, "human.yaml"),
      agentPath: join(dir, "agent.yaml"),
    });
    expect(r.decisionMatch).toBe(false);
    expect(r.report).toMatch(/decision match: NO/);
  });

  it("errors when a file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-cmp-"));
    writeDecision(join(dir, "human.yaml"), "approved");
    await expect(
      compareDecisions({
        humanPath: join(dir, "human.yaml"),
        agentPath: join(dir, "missing.yaml"),
      }),
    ).rejects.toThrow(/not found/);
  });
});

const EVAL_USAGE_EVENT =
  JSON.stringify({
    type: "turn.completed",
    usage: {
      input_tokens: 8,
      cached_input_tokens: 1,
      output_tokens: 3,
      reasoning_output_tokens: 1,
      total_tokens: 11,
    },
  }) + "\n";

/** A migrated DB plus the runs row needed for the run_usage FK. */
function setupEvalDb(runId: string): string {
  const dbPath = join(
    mkdtempSync(join(tmpdir(), "harness-reval-db-")),
    ".harness",
    "harness.sqlite",
  );
  const db = openDb(dbPath);
  try {
    runMigrations(db);
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, updated_at, meta_json)
       VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
         'db-first', 1, 'disabled', '2026-05-21T00:00:00Z', '{}')`,
    ).run(runId);
  } finally {
    db.close();
  }
  return dbPath;
}

function readEvaluatorUsage(
  dbPath: string,
  runId: string,
): Array<Record<string, unknown>> {
  const db = openDb(dbPath);
  try {
    return db
      .prepare(
        `SELECT kind, seq, total_tokens, usage_source
           FROM run_usage
          WHERE run_id = ? AND kind = 'evaluator'
          ORDER BY seq`,
      )
      .all(runId) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("evaluator codex usage telemetry (token-usage G2)", () => {
  it("records one evaluator run_usage row per sample when a dbPath is supplied", async () => {
    const { runsDir, runId } = setupRun();
    const dbPath = setupEvalDb(runId);
    await evaluateReviewer({
      runsDir,
      runId,
      samples: 2,
      dbPath,
      codexRunner: sequencedWithEvents([yamlBlock("approved")], EVAL_USAGE_EVENT),
    });
    const rows = readEvaluatorUsage(dbPath, runId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: "evaluator",
        usage_source: "exact",
        total_tokens: 11,
      });
    }
  });

  it("records no evaluator usage when no dbPath is supplied", async () => {
    const { runsDir, runId } = setupRun();
    // No dbPath → the recording path stays unavailable; evaluation still runs.
    const r = await evaluateReviewer({
      runsDir,
      runId,
      samples: 2,
      codexRunner: sequencedWithEvents([yamlBlock("approved")], EVAL_USAGE_EVENT),
    });
    expect(r.samples).toHaveLength(2);
  });

  it("is fail-open: a telemetry write failure does not break evaluation", async () => {
    const { runsDir, runId } = setupRun();
    const dbPath = setupEvalDb(runId);
    const broken = openDb(dbPath);
    try {
      broken.prepare("DROP TABLE run_usage").run();
    } finally {
      broken.close();
    }
    const r = await evaluateReviewer({
      runsDir,
      runId,
      samples: 1,
      dbPath,
      codexRunner: sequencedWithEvents([yamlBlock("approved")], EVAL_USAGE_EVENT),
    });
    expect(r.samples).toHaveLength(1);
  });

  it("migrates a pre-v30 DB so evaluator usage is recorded (not lost on the old schema)", async () => {
    const { runsDir, runId } = setupRun();
    const dir = mkdtempSync(join(tmpdir(), "harness-reval-v29-"));
    mkdirSync(join(dir, ".harness"), { recursive: true });
    const dbPath = join(dir, ".harness", "harness.sqlite");
    const db = openDb(dbPath);
    try {
      db.prepare(
        `CREATE TABLE schema_migrations
           (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`,
      ).run();
      for (const m of MIGRATIONS.filter((mig) => mig.version < 30)) {
        for (const stmt of m.statements) db.prepare(stmt).run();
        db.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(m.version, m.name, "2026-06-13T00:00:00Z");
      }
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, updated_at, meta_json)
         VALUES (?, 't', 'apps/user', 'domain-coding', 'main', 'needs_review',
           'db-first', 1, 'disabled', '2026-05-21T00:00:00Z', '{}')`,
      ).run(runId);
    } finally {
      db.close();
    }
    await evaluateReviewer({
      runsDir,
      runId,
      samples: 1,
      dbPath,
      codexRunner: sequencedWithEvents([yamlBlock("approved")], EVAL_USAGE_EVENT),
    });
    const rows = readEvaluatorUsage(dbPath, runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "evaluator", usage_source: "exact" });
  });
});
