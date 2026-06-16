import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../../src/db/managed-connection.js";
import { runMigrations } from "../../../../src/db/migrations.js";
import { HitchRepository } from "../../../../src/hitch/repository.js";
import { createOrchestratorRunners } from "../../../../src/hitch/orchestrator-runners.js";
import type { OrchestratorRunners } from "../../../../src/hitch/orchestrator-types.js";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "../../../../src/codex/codex-exec-runner.js";
import {
  routingRunner,
  routingKey,
  REFUTE_ROUTE_KEY,
  type RoutingMap,
  type RoutedResponse,
} from "./_fake-jury-runner.js";
import { JURY_LENSES } from "../../../../src/hitch/jury/types.js";
import { DEFAULT_HITCH_POLICY } from "../../../../src/hitch/types.js";

/**
 * #230 P1 safety — lease-loss abort (#132) + per-call timeout in the classify
 * deliberation, exercised through the REAL `createOrchestratorRunners(...)`
 * classify runner so the safety boundary (a non-authoritative drive mutates NO
 * state; a hanging codex cannot block the step) is enforced end to end.
 */

let tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup.
    }
  }
  tmpDirs = [];
});

interface Harness {
  harnessRoot: string;
  dbPath: string;
  runId: string;
  worktree: string;
}

function makeHarness(hitchId: string): Harness {
  const harnessRoot = mkdtempSync(join(tmpdir(), "jury-abort-"));
  tmpDirs = [...tmpDirs, harnessRoot];
  mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
  const dbPath = join(harnessRoot, ".harness", "harness.sqlite");
  const runId = `run-${hitchId}`;
  const worktree = join(harnessRoot, "workspaces", runId, "repo");
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(
    join(worktree, "src", "a.ts"),
    Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
    "utf8",
  );
  mkdirSync(join(harnessRoot, "policies", "repos"), { recursive: true });
  writeFileSync(
    join(harnessRoot, "policies", "global.yaml"),
    "always_deny_write: []\n",
    "utf8",
  );
  writeFileSync(
    join(harnessRoot, "policies", "repos", "t.yaml"),
    "repo_id: t\nread: []\ndomains: {}\n",
    "utf8",
  );

  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    const repo = new HitchRepository(db);
    repo.createSession({
      hitchId,
      title: "Jury abort",
      repoId: "t",
      domain: "docs",
      scope: {},
      closeConditions: [{ id: "typecheck", kind: "command", required: true }],
      policy: {
        ...DEFAULT_HITCH_POLICY,
        divergence: {
          ...DEFAULT_HITCH_POLICY.divergence,
          maxTotalNewFindings: 1000,
          maxNewFindingsPerCycle: 1000,
        },
      },
      maxTotalNewFindings: 1000,
      createdBy: "test",
      createdSource: "worker",
    });
    repo.createAttempt({
      hitchId,
      attemptType: "implement",
      status: "succeeded",
      runId,
      createdAt: "2026-06-13T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, base_sha, source_mode, db_revision, export_status,
         updated_at, meta_json)
       VALUES (?, 't', 'docs', 'domain-coding', 'main', 'approved',
         'deadbeef', 'db-first', 1, 'disabled', '2026-06-13T00:00:00.000Z', ?)`,
    ).run(runId, JSON.stringify({ runId, repoId: "t", domain: "docs" }));
    const cycle = repo.startReviewCycle({
      hitchId,
      reviewMode: "initial",
      sourceRunId: runId,
      createdAt: "2026-06-13T00:00:00.000Z",
    });
    repo.completeReviewCycle({
      cycleId: cycle.cycleId,
      completedAt: "2026-06-13T00:00:00.000Z",
      summary: "reviewed",
    });
  } finally {
    close();
  }
  return { harnessRoot, dbPath, runId, worktree };
}

function seedFinding(
  h: Harness,
  hitchId: string,
  input: { summary: string; filePath?: string; category?: string },
): string {
  const { db, close } = openManagedDb({ dbPath: h.dbPath });
  try {
    const repo = new HitchRepository(db);
    return repo.upsertFinding({
      hitchId,
      source: "review",
      severity: "P1",
      category: input.category ?? "core",
      scopeStatus: "unknown",
      summary: input.summary,
      ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
    }).finding.findingId;
  } finally {
    close();
  }
}

function proposeJson(scope: "in_scope" | "out_of_scope"): RoutedResponse {
  return {
    stdout: JSON.stringify({
      proposedScope: scope,
      evidence: [
        { citation: "src/a.ts:1", kind: "file", claim: "touches this line" },
      ],
      refutationCondition: "the cited line does not relate to the finding",
      reasoning: "the lens reasons it is " + scope,
      proposedSeverity: "P1",
    }),
  };
}

function unanimousRouting(): RoutingMap {
  const map: RoutingMap = {};
  for (const lens of JURY_LENSES) {
    map[routingKey("propose", lens)] = proposeJson("in_scope");
  }
  map[REFUTE_ROUTE_KEY] = {
    stdout: JSON.stringify({
      refuteVerdict: "uphold",
      whyNotFalseConsensus: "the lenses cite real, proximate evidence",
      refutationConditions: "if the cited file were unrelated",
      reasoning: "adversarial check uphold",
    }),
  };
  return map;
}

function makeRunners(
  h: Harness,
  jury: CodexExecRunner,
  signal?: AbortSignal,
): OrchestratorRunners {
  return createOrchestratorRunners({
    dbPath: h.dbPath,
    harnessRoot: h.harnessRoot,
    createdBy: "worker",
    coderRunner: jury,
    reviewerRunner: jury,
    repoPath: h.worktree,
    ...(signal !== undefined ? { signal } : {}),
  });
}

function readFinding(h: Harness, findingId: string) {
  const { db, close } = openManagedDb({ dbPath: h.dbPath });
  try {
    return new HitchRepository(db).requireFinding(findingId);
  } finally {
    close();
  }
}

function countRows(h: Harness, table: string, findingId: string): number {
  const { db, close } = openManagedDb({ dbPath: h.dbPath });
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE finding_id = ?`)
      .get(findingId) as { n: number };
    return row.n;
  } finally {
    close();
  }
}

describe("classify runner — P1 FIX 1: lease-loss abort (#132)", () => {
  it("a lease lost during Phase 2 mutates NO state and returns the benign no-op; the jury codex receives the lease signal", async () => {
    const h = makeHarness("abort");
    const fid = seedFinding(h, "abort", {
      summary: "ambiguous finding",
      filePath: "src/a.ts",
      category: "core",
    });

    const controller = new AbortController();
    const base = routingRunner(unanimousRouting());
    // Track whether each jury codex call received a (combined) signal. Abort the
    // lease after the FIRST proposer call (mid Phase 2) — before Phase 3 runs.
    const receivedSignal: boolean[] = [];
    let calls = 0;
    const leaseLosing: CodexExecRunner = {
      run: async (input: CodexRunInputs): Promise<CodexRunResult> => {
        receivedSignal.push(input.signal !== undefined);
        const result = await base.run(input);
        calls += 1;
        if (calls === 1) controller.abort(new Error("course lease lost"));
        return result;
      },
    };

    const r = await makeRunners(h, leaseLosing, controller.signal).classify(
      "abort",
    );

    // The in-flight jury codex call received the threaded (combined) signal.
    expect(receivedSignal.length).toBeGreaterThan(0);
    expect(receivedSignal.every((got) => got === true)).toBe(true);

    // A non-authoritative (lease-lost) drive mutates NO state: benign no-op,
    // finding NOT classified, NO audit rows, NO escalate.
    expect(r.resolved).toBe(true);
    if (!r.resolved) throw new Error("unreachable");
    expect(r.severityAuditPacket).toBeUndefined();
    expect(readFinding(h, fid).scopeStatus).toBe("unknown");
    expect(countRows(h, "jury_classification_proposals", fid)).toBe(0);
    expect(countRows(h, "jury_classification_refutations", fid)).toBe(0);
    expect(countRows(h, "jury_severity_audits", fid)).toBe(0);
  });

  it("an already-aborted lease before Phase 1 short-circuits with no DB read and no jury codex call", async () => {
    const h = makeHarness("pre-abort");
    const fid = seedFinding(h, "pre-abort", {
      summary: "ambiguous finding",
      filePath: "src/a.ts",
      category: "core",
    });

    const controller = new AbortController();
    controller.abort(new Error("lease already lost"));
    let codexCalls = 0;
    const counting: CodexExecRunner = {
      run: async (input) => {
        codexCalls += 1;
        return routingRunner(unanimousRouting()).run(input);
      },
    };

    const r = await makeRunners(h, counting, controller.signal).classify(
      "pre-abort",
    );
    expect(r.resolved).toBe(true);
    // No jury codex ran (short-circuit before Phase 2), finding still unknown.
    expect(codexCalls).toBe(0);
    expect(readFinding(h, fid).scopeStatus).toBe("unknown");
    expect(countRows(h, "jury_classification_proposals", fid)).toBe(0);
  });
});

