import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openManagedDb } from "../../../src/db/managed-connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { ConvergenceService } from "../../../src/hitch/convergence.js";
import { collectDiff } from "../../../src/git/diff.js";
import { computeReviewedFingerprint } from "../../../src/core/reviewed-fingerprint.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import type { HitchCloseCondition } from "../../../src/hitch/types.js";
import {
  createOrchestratorRunners,
  latestRunId,
  selectProcessedProposalForReviewImport,
  tryShortCircuitApprovedDecidedReview,
  ConsensusReviewPreflightError,
  HitchHasAdoptedPrError,
  type HitchRunContext,
} from "../../../src/hitch/orchestrator-runners.js";
import { ReviewProposalRepository } from "../../../src/db/repositories/review-proposals.js";
import { ReviewConsensusRepository } from "../../../src/db/repositories/review-consensus.js";
import { ReviewRulesRepository } from "../../../src/db/repositories/review-rules.js";
import { ReviewerRepository } from "../../../src/db/repositories/reviewers.js";
import { ReviewRefuteVotesRepository } from "../../../src/db/repositories/review-refute-votes.js";
import { createCodexCliRunner } from "../../../src/codex/codex-cli-runner.js";
import { importReviewProposalToHitch } from "../../../src/hitch/review-integration.js";
import { REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS } from "../../../src/core/review-consensus.js";
import { ReviewerAgentGateError } from "../../../src/core/reviewer-agent-errors.js";
import { sanitizeGateReason } from "../../../src/core/gate-reason.js";
import type { ReviewRule } from "../../../src/core/review-rule.js";
import { targetChangeHash } from "../../../src/core/refute-binding.js";
import type {
  PrPublisher,
  PrPublishInputs,
} from "../../../src/core/pr-creator.js";
import {
  acquireDomainLock,
  DomainLockBusyError,
  LeaseGuardFailedError,
  LeaseLostError,
} from "../../../src/workspace/db-domain-lock.js";

function createRunnerTestDb(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "harness.sqlite");
}

function createBasicHitch(repo: HitchRepository, hitchId: string): void {
  repo.createSession({
    hitchId,
    title: "Fix scoped files",
    projectId: "demo",
    // repoId/domain so the #230 classify runner can resolve the run context
    // (it needs a worktree for the jury). Findings here are heuristic-resolvable
    // (src/** targetFiles), so the jury never actually runs.
    repoId: "t",
    domain: "docs",
    scope: { targetFiles: ["src/**"] },
    closeConditions: [{ id: "typecheck", kind: "command", required: true }],
    createdBy: "test",
    createdSource: "worker",
  });
}

function createRunners(dbPath: string) {
  return createOrchestratorRunners({
    dbPath,
    harnessRoot: dbPath,
    createdBy: "worker",
    coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
    reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
    // repoPath so the classify runner can resolve a run context. Heuristic
    // classification does not touch the worktree, so any path suffices here.
    repoPath: dbPath,
  });
}

function createHarnessRoot(prefix: string): { harnessRoot: string; dbPath: string } {
  const harnessRoot = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
  return { harnessRoot, dbPath: join(harnessRoot, ".harness", "harness.sqlite") };
}

function writeExecutableScript(dir: string, body: string): string {
  const path = join(dir, "fake-codex.js");
  writeFileSync(path, `#!/usr/bin/env node\n${body}`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function decisionYaml(
  runId: string,
  decision: string,
  domain = "docs",
): string {
  return [
    `runId: ${runId}`,
    `domain: ${domain}`,
    `decision: ${decision}`,
    "required_changes: []",
    "non_blocking_comments: []",
    "out_of_scope_suggestions: []",
    "reviewer: codex-reviewer",
    "reviewed_at: 2026-06-13T00:00:00.000Z",
    "",
  ].join("\n");
}

function insertApprovedRunWithProcessedProposal(input: {
  dbPath: string;
  hitchId: string;
  // The decided status the run + processed proposal carry. Defaults to the
  // happy path ("approved"); pass "changes_requested" / "rejected" to pin that
  // a non-approved decided run is NOT short-circuited.
  decision?: string;
  // Whether a prior review cycle exists for the run (the normal idempotent
  // re-drive). false models a crash between processReviewDecision and the
  // proposal import, so the short-circuit must complete the import.
  priorCycle?: boolean;
  closeConditions?: Parameters<HitchRepository["createSession"]>[0]["closeConditions"];
}): string {
  const decision = input.decision ?? "approved";
  const priorCycle = input.priorCycle ?? true;
  const runId = `run-${input.hitchId}`;
  const sourceYaml = decisionYaml(runId, decision);
  const sourceSha = createHash("sha256").update(sourceYaml).digest("hex");
  const { db, close } = openManagedDb({ dbPath: input.dbPath });
  try {
    runMigrations(db);
    const repo = new HitchRepository(db);
    repo.createSession({
      hitchId: input.hitchId,
      title: "Approved decided run",
      repoId: "t",
      domain: "docs",
      closeConditions:
        input.closeConditions ?? [
          { id: "review-ok", kind: "review_consensus", required: true },
        ],
      createdBy: "test",
      createdSource: "worker",
    });
    repo.createAttempt({
      hitchId: input.hitchId,
      attemptType: "implement",
      status: "succeeded",
      runId,
      createdAt: "2026-06-13T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, reviewer, reviewed_at, source_mode, db_revision,
         export_status, updated_at, meta_json)
       VALUES (?, 't', 'docs', 'domain-coding', 'main', ?,
         'codex-reviewer', '2026-06-13T00:00:00.000Z', 'db-first', 1,
         'disabled', '2026-06-13T00:00:00.000Z', ?)`,
    ).run(
      runId,
      decision,
      JSON.stringify({
        runId,
        repoId: "t",
        domain: "docs",
        status: decision,
      }),
    );
    db.prepare(
      `INSERT INTO review_proposals (
         run_id, reviewer, decision, required_changes_json,
         non_blocking_comments_json, out_of_scope_suggestions_json,
         reviewed_at, source_yaml, source_sha256, created_at, processed_at,
         review_decision_id, lifecycle_status
       )
       VALUES (?, 'codex-reviewer', ?, '[]', '[]', '[]',
         '2026-06-13T00:00:00.000Z', ?, ?, '2026-06-13T00:00:00.000Z',
         '2026-06-13T00:00:00.000Z', ?, 'processed')`,
    ).run(runId, decision, sourceYaml, sourceSha, runId);
    // The DB-canonical run decision (the short-circuit gates on this, not the
    // latest individual proposal).
    db.prepare(
      `INSERT INTO review_decisions (run_id, decision, reviewer, reviewed_at,
         source_yaml, source_sha256)
       VALUES (?, ?, 'codex-reviewer', '2026-06-13T00:00:00.000Z', ?, ?)`,
    ).run(runId, decision, sourceYaml, sourceSha);
    if (priorCycle) {
      // Model a completed prior import (a review cycle for this run already
      // exists) so the short-circuit treats this as an idempotent re-drive.
      // Timestamp the prior cycle at the run's review time so it predates any
      // later close-check refresh (otherwise the refreshed check reads stale).
      const cycle = repo.startReviewCycle({
        hitchId: input.hitchId,
        reviewMode: "close",
        sourceRunId: runId,
        createdAt: "2026-06-13T00:00:00.000Z",
      });
      repo.completeReviewCycle({
        cycleId: cycle.cycleId,
        completedAt: "2026-06-13T00:00:00.000Z",
        summary: "prior import",
      });
    }
    return runId;
  } finally {
    close();
  }
}

function insertProcessedProposal(input: {
  db: ReturnType<typeof openManagedDb>["db"];
  runId: string;
  reviewer: string;
  decision: "approved" | "changes_requested" | "rejected";
  requiredChanges?: string[];
  reviewedAt: string;
  reviewDecisionId: string;
}): number {
  const sourceYaml = decisionYaml(input.runId, input.decision);
  const sourceSha = createHash("sha256").update(sourceYaml).digest("hex");
  const info = input.db
    .prepare(
      `INSERT INTO review_proposals (
         run_id, reviewer, decision, required_changes_json,
         non_blocking_comments_json, out_of_scope_suggestions_json,
         reviewed_at, source_yaml, source_sha256, created_at, processed_at,
         review_decision_id, lifecycle_status
       )
       VALUES (?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?, ?, 'processed')`,
    )
    .run(
      input.runId,
      input.reviewer,
      input.decision,
      JSON.stringify(input.requiredChanges ?? []),
      input.reviewedAt,
      sourceYaml,
      sourceSha,
      input.reviewedAt,
      input.reviewedAt,
      input.reviewDecisionId,
    );
  return Number(info.lastInsertRowid);
}

function reviewerOutput(input: {
  decision: "approved" | "changes_requested" | "rejected";
  requiredChanges?: string[];
}): string {
  const requiredChanges = input.requiredChanges ?? [];
  return [
    "```yaml",
    `decision: ${input.decision}`,
    ...(requiredChanges.length === 0
      ? ["required_changes: []"]
      : [
          "required_changes:",
          ...requiredChanges.map((change) => `  - ${JSON.stringify(change)}`),
        ]),
    "non_blocking_comments: []",
    "out_of_scope_suggestions: []",
    "```",
    "",
  ].join("\n");
}

function reviewerIdFromStdoutPath(stdoutPath: string): string {
  const normalized = stdoutPath.replaceAll("\\", "/");
  const match = normalized.match(/\/reviewers\/([^/]+)\/reviewer-agent\.out\.log$/);
  return match?.[1] ?? "codex-reviewer";
}

function agentFromStdoutPath(stdoutPath: string): {
  reviewerId: string;
  agent: "reviewer" | "refute";
} {
  const normalized = stdoutPath.replaceAll("\\", "/");
  const match = normalized.match(
    /\/reviewers\/([^/]+)\/(reviewer-agent|refute-agent)\.out\.log$/,
  );
  return {
    reviewerId: match?.[1] ?? "codex-reviewer",
    agent: match?.[2] === "refute-agent" ? "refute" : "reviewer",
  };
}

function multiReviewerRunner(
  outputs: Record<string, string | Error>,
) {
  return {
    run: vi.fn(async (input: { logPaths: { stdout: string; stderr: string } }) => {
      const reviewerId = reviewerIdFromStdoutPath(input.logPaths.stdout);
      const output = outputs[reviewerId];
      writeFileSync(input.logPaths.stderr, "", "utf8");
      if (output instanceof Error) throw output;
      writeFileSync(input.logPaths.stdout, output ?? "", "utf8");
      return { exitCode: 0, timedOut: false, durationMs: 0 };
    }),
  };
}

const SP18_REFUTE_REVIEWER_IDS = [
  "refute-a",
  "refute-b",
  "refute-c",
] as const;

function sp18RefuteRule(input?: {
  refuteReviewerIds?: readonly string[];
  minParticipants?: number;
}): ReviewRule {
  return {
    mode: "consensus",
    refute: {
      group: "refuters",
      reviewerIds: [
        ...(input?.refuteReviewerIds ?? SP18_REFUTE_REVIEWER_IDS),
      ],
      minParticipants: input?.minParticipants ?? 2,
    },
    requirements: [
      {
        group: "reviewers",
        minApprovals: 1,
        blockingDecisions: ["changes_requested", "rejected"],
        quorum: { minParticipants: 2 },
        reviewerIds: ["alice", "bob"],
        lensAxes: ["correctness", "maintainability"],
      },
    ],
    overrides: { allowedReviewers: [], requireReason: true },
    staleProposal: { rejectSuperseded: true },
  };
}

function addRefuteReviewers(
  dbPath: string,
  reviewers: readonly { reviewerId: string; groupId?: string }[] =
    SP18_REFUTE_REVIEWER_IDS.map((reviewerId) => ({ reviewerId })),
): void {
  const { db, close } = openManagedDb({ dbPath });
  try {
    const repo = new ReviewerRepository(db);
    for (const reviewer of reviewers) {
      repo.add({
        reviewerId: reviewer.reviewerId,
        reviewerType: "codex",
        displayName: reviewer.reviewerId,
        groupId: reviewer.groupId ?? "refuters",
      });
    }
  } finally {
    close();
  }
}

function refuteOutput(input: {
  target: string;
  verdict: "refute" | "uphold" | "inconclusive";
}): string {
  return [
    "```yaml",
    `target_change_hash: ${JSON.stringify(targetChangeHash(input.target))}`,
    `refute_verdict: ${input.verdict}`,
    ...(input.verdict === "refute"
      ? [
          'refute_reason: "diff evidence covers the blocker"',
          "counter_evidence:",
          "  kind: diff",
          '  ref: "final-diff.patch"',
          'refute_condition: "diff still covers the blocker"',
          'retract_condition: "diff evidence is removed"',
        ]
      : []),
    "```",
    "",
  ].join("\n");
}

function createFrozenConsensusReviewHarness(input: {
  prefix: string;
  hitchId: string;
  rule: ReviewRule;
  closeConditions?: Parameters<HitchRepository["createSession"]>[0]["closeConditions"];
  reviewerMetadata?: Record<string, Record<string, unknown>>;
}): { harnessRoot: string; dbPath: string; runId: string } {
  const { harnessRoot, dbPath } = createHarnessRoot(input.prefix);
  const runId = `run-${input.hitchId}`;
  const runDir = join(harnessRoot, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({
      runId,
      repoId: "t",
      domain: "docs",
      status: "needs_review",
    }),
  );
  writeFileSync(join(runDir, "events.jsonl"), "", "utf8");
  writeFileSync(join(runDir, "summary.md"), "summary\n", "utf8");
  writeFileSync(join(runDir, "review-request.md"), "review\n", "utf8");
  writeFileSync(join(runDir, "final-diff.patch"), "", "utf8");
  writeFileSync(
    join(runDir, "review-decision.yaml"),
    [
      `runId: ${runId}`,
      "domain: docs",
      "decision: pending",
      "required_changes: []",
      "non_blocking_comments: []",
      "out_of_scope_suggestions: []",
      "reviewer: null",
      "reviewed_at: null",
      "",
    ].join("\n"),
    "utf8",
  );
  const { db, close } = openManagedDb({ dbPath });
  try {
    runMigrations(db);
    const repo = new HitchRepository(db);
    repo.createSession({
      hitchId: input.hitchId,
      title: "Frozen consensus",
      repoId: "t",
      domain: "docs",
      closeConditions:
        input.closeConditions ?? [
          { id: "review-ok", kind: "review_consensus", required: true },
        ],
      createdBy: "test",
      createdSource: "worker",
    });
    repo.createAttempt({
      hitchId: input.hitchId,
      attemptType: "implement",
      status: "succeeded",
      runId,
      createdAt: "2026-06-13T00:00:00.000Z",
    });
    db.prepare(
      `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
         status, source_mode, db_revision, export_status, started_at,
         updated_at, meta_json)
       VALUES (?, 't', 'docs', 'domain-coding', 'main', 'needs_review',
         'db-first', 1, 'disabled', '2026-06-13T00:00:00.000Z',
         '2026-06-13T00:00:00.000Z', ?)`,
    ).run(
      runId,
      JSON.stringify({
        runId,
        repoId: "t",
        domain: "docs",
        status: "needs_review",
      }),
    );
    const reviewers = new ReviewerRepository(db);
    const defaultLensAxes =
      input.rule.requirements[0]?.lensAxes ?? ["correctness", "maintainability"];
    reviewers.add({
      reviewerId: "alice",
      reviewerType: "codex",
      displayName: "Alice",
      groupId: "reviewers",
      metadata:
        input.reviewerMetadata?.alice ??
        (defaultLensAxes[0] !== undefined
          ? { lens: defaultLensAxes[0], lens_prompt: "Review for correctness." }
          : undefined),
    });
    reviewers.add({
      reviewerId: "bob",
      reviewerType: "codex",
      displayName: "Bob",
      groupId: "reviewers",
      metadata:
        input.reviewerMetadata?.bob ??
        (defaultLensAxes[1] !== undefined
          ? { lens: defaultLensAxes[1], lens_prompt: "Review for maintainability." }
          : undefined),
    });
    const template = new ReviewRulesRepository(db).upsertRuleTemplate({
      source: "manual",
      rule: input.rule,
    });
    new ReviewRulesRepository(db).snapshotForRun({ runId, template });
  } finally {
    close();
  }
  return { harnessRoot, dbPath, runId };
}

describe("createOrchestratorRunners.projectRuntime", () => {
  it("rejects incomplete project runtime deps atomically", () => {
    expect(() =>
      createOrchestratorRunners({
        dbPath: "/tmp/harness.sqlite",
        harnessRoot: "/tmp/harness-root",
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        projectRuntime: { project: {} } as never,
      }),
    ).toThrow(/atomically.*compiledPolicy and project/);
  });

  it("rejects a null compiledPolicy (would silently fall back to raw policy)", () => {
    expect(() =>
      createOrchestratorRunners({
        dbPath: "/tmp/harness.sqlite",
        harnessRoot: "/tmp/harness-root",
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        projectRuntime: { compiledPolicy: null, project: {} } as never,
      }),
    ).toThrow(/atomically.*compiledPolicy and project/);
  });

  it("rejects a compiledPolicy missing global/repo", () => {
    expect(() =>
      createOrchestratorRunners({
        dbPath: "/tmp/harness.sqlite",
        harnessRoot: "/tmp/harness-root",
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        projectRuntime: { compiledPolicy: { global: {} }, project: {} } as never,
      }),
    ).toThrow(/compiledPolicy must contain both global and repo/);
  });

  it("rejects project runtime deps without a reviewRuleResolution", () => {
    expect(() =>
      createOrchestratorRunners({
        dbPath: "/tmp/harness.sqlite",
        harnessRoot: "/tmp/harness-root",
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        projectRuntime: {
          compiledPolicy: {
            global: { always_deny_write: [], ignore_untracked: [] },
            repo: { repo_id: "r", read: [], domains: {} },
          },
          project: {},
        } as never,
      }),
    ).toThrow(/reviewRuleResolution/);
  });
});

describe("createOrchestratorRunners.review decided run re-drive", () => {
  it("returns the processed consensus status instead of the last reviewer decision", async () => {
    const hitchId = "g-consensus-return";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 1,
          blockingDecisions: [],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "maintainability"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-return-",
      hitchId,
      rule,
    });
    const reviewerRunner = multiReviewerRunner({
      alice: reviewerOutput({ decision: "approved" }),
      bob: reviewerOutput({
        decision: "changes_requested",
        requiredChanges: ["Bob would like a follow-up, but it is non-blocking."],
      }),
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    const result = await runners.review(hitchId);

    expect(result).toEqual({ runId, decision: "approved" });
    expect(reviewerRunner.run).toHaveBeenCalledTimes(2);
    const { db, close } = openManagedDb({ dbPath });
    try {
      const run = db
        .prepare("SELECT status, reviewer FROM runs WHERE run_id = ?")
        .get(runId) as { status: string; reviewer: string };
      expect(run).toEqual({ status: "approved", reviewer: "consensus" });
      expect(
        new ReviewConsensusRepository(db).findActive(runId)?.status,
      ).toBe("approved");
      expect(new HitchRepository(db).listCloseChecks(hitchId)[0]).toMatchObject({
        conditionId: "review-ok",
        status: "passed",
        evidence: { decision: "approved", processStatus: "approved" },
      });
    } finally {
      close();
    }
  });

  it("SP-18: dispatches frozen refute reviewers before processing consensus and reflects the advisory votes", async () => {
    const hitchId = "g-consensus-refute-dispatch";
    const target = "fix the auth check";
    const rule: ReviewRule = {
      mode: "consensus",
      refute: {
        group: "refuters",
        reviewerIds: ["refute-a", "refute-b", "refute-c"],
        minParticipants: 2,
      },
      requirements: [
        {
          group: "reviewers",
          minApprovals: 1,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "maintainability"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-refute-dispatch-",
      hitchId,
      rule,
    });
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        const reviewers = new ReviewerRepository(db);
        for (const reviewerId of ["refute-a", "refute-b", "refute-c"]) {
          reviewers.add({
            reviewerId,
            reviewerType: "codex",
            displayName: reviewerId,
            groupId: "refuters",
          });
        }
      } finally {
        close();
      }
    }

    const calls: string[] = [];
    const reviewerRunner = {
      run: vi.fn(async (input: {
        logPaths: { stdout: string; stderr: string };
      }) => {
        const { reviewerId, agent } = agentFromStdoutPath(
          input.logPaths.stdout,
        );
        calls.push(`${agent}:${reviewerId}`);
        writeFileSync(input.logPaths.stderr, "", "utf8");
        if (agent === "refute") {
          const verdict = reviewerId === "refute-c" ? "uphold" : "refute";
          writeFileSync(
            input.logPaths.stdout,
            [
              "```yaml",
              `target_change_hash: ${JSON.stringify(targetChangeHash(target))}`,
              `refute_verdict: ${verdict}`,
              ...(verdict === "refute"
                ? [
                    'refute_reason: "diff evidence covers the blocker"',
                    "counter_evidence:",
                    "  kind: diff",
                    '  ref: "final-diff.patch"',
                    'refute_condition: "diff still covers the blocker"',
                    'retract_condition: "diff evidence is removed"',
                  ]
                : []),
              "```",
              "",
            ].join("\n"),
            "utf8",
          );
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        }
        writeFileSync(
          input.logPaths.stdout,
          reviewerId === "alice"
            ? reviewerOutput({
                decision: "changes_requested",
                requiredChanges: [target],
              })
            : reviewerOutput({ decision: "approved" }),
          "utf8",
        );
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      }),
    };
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).resolves.toEqual({
      runId,
      decision: "approved",
    });

    expect(calls).toEqual([
      "reviewer:alice",
      "reviewer:bob",
      "refute:refute-a",
      "refute:refute-b",
      "refute:refute-c",
    ]);
    const { db, close } = openManagedDb({ dbPath });
    try {
      expect(
        new ReviewRefuteVotesRepository(db)
          .listByRun(runId)
          .map((row) => ({
            reviewerId: row.reviewerId,
            verdict: row.refuteVerdict,
            status: row.validationStatus,
            target: row.targetChangeHash,
          })),
      ).toEqual([
        {
          reviewerId: "refute-a",
          verdict: "refute",
          status: "passed",
          target: targetChangeHash(target),
        },
        {
          reviewerId: "refute-b",
          verdict: "refute",
          status: "passed",
          target: targetChangeHash(target),
        },
        {
          reviewerId: "refute-c",
          verdict: "uphold",
          status: "passed",
          target: targetChangeHash(target),
        },
      ]);
      const run = db
        .prepare("SELECT status, reviewer FROM runs WHERE run_id = ?")
        .get(runId) as { status: string; reviewer: string };
      expect(run).toEqual({ status: "approved", reviewer: "consensus" });
      const consensus = new ReviewConsensusRepository(db).findActive(runId);
      expect(consensus?.status).toBe("approved");
      const summary = JSON.parse(consensus!.summaryJson) as {
        refute?: { refutedTargetChangeHashes?: string[] };
      };
      expect(summary.refute?.refutedTargetChangeHashes).toEqual([
        targetChangeHash(target),
      ]);
      expect(
        db
          .prepare(
            "SELECT change_text FROM review_required_changes WHERE run_id = ?",
          )
          .all(runId),
      ).toEqual([]);
      expect(new HitchRepository(db).listCloseChecks(hitchId)[0]).toMatchObject({
        conditionId: "review-ok",
        status: "passed",
        evidence: { decision: "approved", processStatus: "approved" },
      });
    } finally {
      close();
    }
  });

  it("SP-18: keeps blocking changes_requested when refutes are below strict majority", async () => {
    const hitchId = "g-consensus-refute-sub-majority";
    const target = "fix the auth check";
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-refute-sub-majority-",
      hitchId,
      rule: sp18RefuteRule(),
    });
    addRefuteReviewers(dbPath);

    const reviewerRunner = {
      run: vi.fn(async (input: {
        logPaths: { stdout: string; stderr: string };
      }) => {
        const { reviewerId, agent } = agentFromStdoutPath(
          input.logPaths.stdout,
        );
        writeFileSync(input.logPaths.stderr, "", "utf8");
        if (agent === "refute") {
          writeFileSync(
            input.logPaths.stdout,
            refuteOutput({
              target,
              verdict: reviewerId === "refute-a" ? "refute" : "uphold",
            }),
            "utf8",
          );
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        }
        writeFileSync(
          input.logPaths.stdout,
          reviewerId === "alice"
            ? reviewerOutput({
                decision: "changes_requested",
                requiredChanges: [target],
              })
            : reviewerOutput({ decision: "approved" }),
          "utf8",
        );
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      }),
    };
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).resolves.toEqual({
      runId,
      decision: "changes_requested",
    });

    const { db, close } = openManagedDb({ dbPath });
    try {
      expect(new ReviewConsensusRepository(db).findActive(runId)?.status).toBe(
        "changes_requested",
      );
      expect(
        db
          .prepare(
            "SELECT change_text FROM review_required_changes WHERE run_id = ?",
          )
          .all(runId),
      ).toEqual([{ change_text: target }]);
      const summary = JSON.parse(
        new ReviewConsensusRepository(db).findActive(runId)!.summaryJson,
      ) as {
        refute?: {
          checks?: Array<{
            targetChangeHash: string;
            strictMajorityMet: boolean;
            duplicateReviewers: string[];
          }>;
        };
      };
      expect(summary.refute?.checks).toEqual([
        {
          targetChangeHash: targetChangeHash(target),
          expectedReviewers: 3,
          participants: 3,
          refutes: 1,
          upholds: 2,
          strictMajorityMet: false,
          duplicateReviewers: [],
        },
      ]);
    } finally {
      close();
    }
  });

  it("SP-18: rejected refute agent runs remain non-participants and keep blocking", async () => {
    const hitchId = "g-consensus-refute-codex-failed";
    const target = "fix the auth check";
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-refute-codex-failed-",
      hitchId,
      rule: sp18RefuteRule(),
    });
    addRefuteReviewers(dbPath);

    const reviewerRunner = {
      run: vi.fn(async (input: {
        logPaths: { stdout: string; stderr: string };
      }) => {
        const { reviewerId, agent } = agentFromStdoutPath(
          input.logPaths.stdout,
        );
        writeFileSync(input.logPaths.stderr, "", "utf8");
        if (agent === "refute") {
          writeFileSync(input.logPaths.stdout, "", "utf8");
          return { exitCode: 1, timedOut: false, durationMs: 0 };
        }
        writeFileSync(
          input.logPaths.stdout,
          reviewerId === "alice"
            ? reviewerOutput({
                decision: "changes_requested",
                requiredChanges: [target],
              })
            : reviewerOutput({ decision: "approved" }),
          "utf8",
        );
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      }),
    };
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).resolves.toEqual({
      runId,
      decision: "changes_requested",
    });

    const { db, close } = openManagedDb({ dbPath });
    try {
      expect(
        new ReviewRefuteVotesRepository(db).listByRun(runId).map((row) => ({
          reviewerId: row.reviewerId,
          status: row.validationStatus,
          rejectReason: row.rejectReason,
        })),
      ).toEqual([
        {
          reviewerId: "refute-a",
          status: "rejected",
          rejectReason: "codex_failed",
        },
        {
          reviewerId: "refute-b",
          status: "rejected",
          rejectReason: "codex_failed",
        },
        {
          reviewerId: "refute-c",
          status: "rejected",
          rejectReason: "codex_failed",
        },
      ]);
      expect(new ReviewConsensusRepository(db).findActive(runId)?.status).toBe(
        "changes_requested",
      );
      expect(
        db
          .prepare(
            "SELECT change_text FROM review_required_changes WHERE run_id = ?",
          )
          .all(runId),
      ).toEqual([{ change_text: target }]);
    } finally {
      close();
    }
  });

  for (const scenario of [
    {
      label: "unregistered",
      refuteReviewers: [
        { reviewerId: "refute-a" },
        { reviewerId: "refute-c" },
      ],
      expectedCause: "unregistered",
    },
    {
      label: "wrong group",
      refuteReviewers: SP18_REFUTE_REVIEWER_IDS.map((reviewerId) => ({
        reviewerId,
        groupId: "other-refuters",
      })),
      expectedCause: "wrong_group",
      expectedRegistered: 0,
    },
    {
      label: "under quorum",
      refuteReviewers: [
        { reviewerId: "refute-a" },
        { reviewerId: "refute-b", groupId: "other-refuters" },
        { reviewerId: "refute-c", groupId: "other-refuters" },
      ],
      expectedCause: "under_quorum",
      expectedRegistered: 1,
    },
  ] as const) {
    it(`SP-18: refute preflight rejects ${scenario.label} reviewer sets before refute dispatch`, async () => {
      const hitchId = `g-consensus-refute-preflight-${scenario.expectedCause}`;
      const target = "fix the auth check";
      const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
        prefix: `harness-orch-review-refute-preflight-${scenario.expectedCause}-`,
        hitchId,
        rule: sp18RefuteRule(),
      });
      addRefuteReviewers(dbPath, scenario.refuteReviewers);

      const calls: string[] = [];
      const reviewerRunner = {
        run: vi.fn(async (input: {
          logPaths: { stdout: string; stderr: string };
        }) => {
          const { reviewerId, agent } = agentFromStdoutPath(
            input.logPaths.stdout,
          );
          calls.push(`${agent}:${reviewerId}`);
          writeFileSync(input.logPaths.stderr, "", "utf8");
          if (agent === "refute") {
            throw new Error("refute dispatch must not run after failed preflight");
          }
          writeFileSync(
            input.logPaths.stdout,
            reviewerId === "alice"
              ? reviewerOutput({
                  decision: "changes_requested",
                  requiredChanges: [target],
                })
              : reviewerOutput({ decision: "approved" }),
            "utf8",
          );
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        }),
      };
      const runners = createOrchestratorRunners({
        dbPath,
        harnessRoot,
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner,
      });

      const error = await runners.review(hitchId).then(
        () => null,
        (e) => e,
      );

      expect(error).toBeInstanceOf(ConsensusReviewPreflightError);
      expect((error as ConsensusReviewPreflightError).causeKind).toBe(
        scenario.expectedCause,
      );
      if (scenario.expectedRegistered !== undefined) {
        expect((error as ConsensusReviewPreflightError).group).toBe(
          "refuters",
        );
        expect((error as ConsensusReviewPreflightError).required).toBe(2);
        expect((error as ConsensusReviewPreflightError).registered).toBe(
          scenario.expectedRegistered,
        );
      }
      expect(calls).toEqual(["reviewer:alice", "reviewer:bob"]);
      const { db, close } = openManagedDb({ dbPath });
      try {
        expect(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId))
          .toMatchObject({ status: "needs_review" });
        expect(new ReviewRefuteVotesRepository(db).listByRun(runId)).toEqual([]);
        expect(new HitchRepository(db).listReviewCycles(hitchId)).toHaveLength(0);
      } finally {
        close();
      }
    });
  }

  it("SP-18: idempotent approved re-review does not dispatch or append refute votes again", async () => {
    const hitchId = "g-consensus-refute-idempotent-redrive";
    const target = "fix the auth check";
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-refute-idempotent-redrive-",
      hitchId,
      rule: sp18RefuteRule(),
    });
    addRefuteReviewers(dbPath);

    const reviewerRunner = {
      run: vi.fn(async (input: {
        logPaths: { stdout: string; stderr: string };
      }) => {
        const { reviewerId, agent } = agentFromStdoutPath(
          input.logPaths.stdout,
        );
        writeFileSync(input.logPaths.stderr, "", "utf8");
        if (agent === "refute") {
          writeFileSync(
            input.logPaths.stdout,
            refuteOutput({
              target,
              verdict: reviewerId === "refute-c" ? "uphold" : "refute",
            }),
            "utf8",
          );
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        }
        writeFileSync(
          input.logPaths.stdout,
          reviewerId === "alice"
            ? reviewerOutput({
                decision: "changes_requested",
                requiredChanges: [target],
              })
            : reviewerOutput({ decision: "approved" }),
          "utf8",
        );
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      }),
    };
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).resolves.toEqual({
      runId,
      decision: "approved",
    });
    const callsAfterFirstReview = reviewerRunner.run.mock.calls.length;
    let dbHandle = openManagedDb({ dbPath });
    let votesAfterFirstReview: number;
    let cyclesAfterFirstReview: number;
    try {
      votesAfterFirstReview = new ReviewRefuteVotesRepository(
        dbHandle.db,
      ).listByRun(runId).length;
      cyclesAfterFirstReview = new HitchRepository(
        dbHandle.db,
      ).listReviewCycles(hitchId).length;
      dbHandle.db
        .prepare("DELETE FROM hitch_close_checks WHERE hitch_id = ?")
        .run(hitchId);
    } finally {
      dbHandle.close();
    }

    await expect(runners.review(hitchId)).resolves.toEqual({
      runId,
      decision: "approved",
    });

    expect(reviewerRunner.run).toHaveBeenCalledTimes(callsAfterFirstReview);
    dbHandle = openManagedDb({ dbPath });
    try {
      expect(
        new ReviewRefuteVotesRepository(dbHandle.db).listByRun(runId),
      ).toHaveLength(votesAfterFirstReview);
      expect(new HitchRepository(dbHandle.db).listReviewCycles(hitchId)).toHaveLength(
        cyclesAfterFirstReview,
      );
    } finally {
      dbHandle.close();
    }
  });

  it("SP-18: keeps refute prompt identity stable when a prior refuted target drops out on re-drive", async () => {
    const hitchId = "g-consensus-refute-redrive-stable-prompt";
    const targetA = "remove the obsolete auth bypass";
    const targetB = "add a regression test for auth bypass";
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-refute-redrive-stable-prompt-",
      hitchId,
      rule: sp18RefuteRule(),
    });
    addRefuteReviewers(dbPath);

    let crashOnce = true;
    const targetBPromptsForRefuteA: string[] = [];
    const reviewerRunner = {
      run: vi.fn(async (input: {
        prompt: string;
        logPaths: { stdout: string; stderr: string };
      }) => {
        const { reviewerId, agent } = agentFromStdoutPath(
          input.logPaths.stdout,
        );
        writeFileSync(input.logPaths.stderr, "", "utf8");
        if (agent === "refute") {
          const target = input.prompt.includes(targetChangeHash(targetA))
            ? targetA
            : targetB;
          if (target === targetB && reviewerId === "refute-a") {
            targetBPromptsForRefuteA.push(input.prompt);
          }
          if (target === targetB && reviewerId === "refute-b" && crashOnce) {
            crashOnce = false;
            throw new Error("simulated crash before processing refute votes");
          }
          const verdict =
            reviewerId === "refute-a" || reviewerId === "refute-b"
              ? "refute"
              : "uphold";
          writeFileSync(
            input.logPaths.stdout,
            refuteOutput({ target, verdict }),
            "utf8",
          );
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        }
        writeFileSync(
          input.logPaths.stdout,
          reviewerId === "alice"
            ? reviewerOutput({
                decision: "changes_requested",
                requiredChanges: [targetA, targetB],
              })
            : reviewerOutput({ decision: "approved" }),
          "utf8",
        );
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      }),
    };
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).rejects.toThrow(
      "simulated crash before processing refute votes",
    );
    await expect(runners.review(hitchId)).resolves.toEqual({
      runId,
      decision: "approved",
    });

    expect(targetBPromptsForRefuteA).toHaveLength(2);
    expect(targetBPromptsForRefuteA[1]).toBe(targetBPromptsForRefuteA[0]);
    const { db, close } = openManagedDb({ dbPath });
    try {
      const targetBRows = new ReviewRefuteVotesRepository(db).listByTarget(
        runId,
        targetChangeHash(targetB),
      );
      expect(targetBRows.map((row) => row.reviewerId)).toEqual([
        "refute-a",
        "refute-b",
        "refute-c",
      ]);
      expect(
        targetBRows.filter((row) => row.reviewerId === "refute-a"),
      ).toHaveLength(1);
      const consensus = new ReviewConsensusRepository(db).findActive(runId);
      expect(consensus?.status).toBe("approved");
      const summary = JSON.parse(consensus!.summaryJson) as {
        refute?: { refutedTargetChangeHashes?: string[] };
      };
      expect(summary.refute?.refutedTargetChangeHashes).toEqual([
        targetChangeHash(targetA),
        targetChangeHash(targetB),
      ]);
    } finally {
      close();
    }
  });

  it("passes each frozen reviewer's lens prompt into review auto and records distinct prompt provenance", async () => {
    const hitchId = "g-consensus-lens-prompt";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "security"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-lens-prompt-",
      hitchId,
      rule,
      reviewerMetadata: {
        alice: { lens: "correctness", lens_prompt: "Check behavior." },
        bob: { lens: "security", lens_prompt: "Check auth boundaries." },
      },
    });
    const promptsByReviewer = new Map<string, string>();
    const reviewerRunner = {
      run: vi.fn(async (input: {
        prompt: string;
        logPaths: { stdout: string; stderr: string };
      }) => {
        const reviewerId = reviewerIdFromStdoutPath(input.logPaths.stdout);
        promptsByReviewer.set(reviewerId, input.prompt);
        writeFileSync(input.logPaths.stderr, "", "utf8");
        writeFileSync(
          input.logPaths.stdout,
          reviewerOutput({ decision: "approved" }),
          "utf8",
        );
        return { exitCode: 0, timedOut: false, durationMs: 0 };
      }),
    };
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).resolves.toEqual({
      runId,
      decision: "approved",
    });

    expect(promptsByReviewer.get("alice")).toContain("Lens: correctness");
    expect(promptsByReviewer.get("alice")).toContain("Check behavior.");
    expect(promptsByReviewer.get("bob")).toContain("Lens: security");
    expect(promptsByReviewer.get("bob")).toContain("Check auth boundaries.");
    const alicePrompt = promptsByReviewer.get("alice") ?? "";
    const bobPrompt = promptsByReviewer.get("bob") ?? "";
    expect(alicePrompt).not.toContain("Lens: security");
    expect(alicePrompt).not.toContain("Check auth boundaries.");
    expect(bobPrompt).not.toContain("Lens: correctness");
    expect(bobPrompt).not.toContain("Check behavior.");
    expect(alicePrompt).not.toBe(bobPrompt);

    const { db, close } = openManagedDb({ dbPath });
    try {
      const proposals = new ReviewProposalRepository(db)
        .listForRun(runId)
        .sort((a, b) => a.reviewer.localeCompare(b.reviewer));
      expect(
        proposals.map((p) => ({
          reviewer: p.reviewer,
          promptSha256: p.promptSha256,
          lens: JSON.parse(p.promptProvenanceJson ?? "{}").lens?.lens,
        })),
      ).toEqual([
        {
          reviewer: "alice",
          promptSha256: createHash("sha256")
            .update(promptsByReviewer.get("alice") ?? "")
            .digest("hex"),
          lens: "correctness",
        },
        {
          reviewer: "bob",
          promptSha256: createHash("sha256")
            .update(promptsByReviewer.get("bob") ?? "")
            .digest("hex"),
          lens: "security",
        },
      ]);
    } finally {
      close();
    }
  });

  it("SP-15: dispatches lens-injected reviewers through a read-only Codex sandbox", async () => {
    const hitchId = "g-consensus-lens-readonly-sandbox";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "security"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-lens-sandbox-",
      hitchId,
      rule,
      reviewerMetadata: {
        alice: { lens: "correctness", lens_prompt: "Check behavior." },
        bob: { lens: "security", lens_prompt: "Check auth boundaries." },
      },
    });
    const binRoot = mkdtempSync(join(tmpdir(), "harness-orch-codex-bin-"));
    const recordsPath = join(binRoot, "records.json");
    const approvedOutput = reviewerOutput({ decision: "approved" });
    const codexBin = writeExecutableScript(
      binRoot,
      [
        "const { existsSync, readFileSync, writeFileSync } = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const outputIndex = args.indexOf('-o');",
        "if (outputIndex < 0) throw new Error('missing -o');",
        "let prompt = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { prompt += chunk; });",
        "process.stdin.on('end', () => {",
        `  const recordsPath = ${JSON.stringify(recordsPath)};`,
        "  const records = existsSync(recordsPath) ? JSON.parse(readFileSync(recordsPath, 'utf8')) : [];",
        "  records.push({ args, prompt, stdout: args[outputIndex + 1] });",
        "  writeFileSync(recordsPath, JSON.stringify(records), 'utf8');",
        `  writeFileSync(args[outputIndex + 1], ${JSON.stringify(approvedOutput)}, 'utf8');`,
        "  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }) + '\\n', () => process.exit(0));",
        "});",
      ].join("\n"),
    );
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: createCodexCliRunner({
        codexBin,
        sandbox: "read-only",
        envAllowlist: ["PATH"],
      }),
    });

    await expect(runners.review(hitchId)).resolves.toEqual({
      runId,
      decision: "approved",
    });

    const records = JSON.parse(readFileSync(recordsPath, "utf8")) as {
      args: string[];
      prompt: string;
      stdout: string;
    }[];
    expect(records).toHaveLength(2);
    for (const record of records) {
      const sandboxIndex = record.args.indexOf("--sandbox");
      expect(sandboxIndex).toBeGreaterThanOrEqual(0);
      expect(record.args[sandboxIndex + 1]).toBe("read-only");
    }
    const byReviewer = new Map(
      records.map((record) => [reviewerIdFromStdoutPath(record.stdout), record]),
    );
    expect(byReviewer.get("alice")?.prompt).toContain("Lens: correctness");
    expect(byReviewer.get("alice")?.prompt).toContain("Check behavior.");
    expect(byReviewer.get("alice")?.prompt).not.toContain("Lens: security");
    expect(byReviewer.get("alice")?.prompt).not.toContain(
      "Check auth boundaries.",
    );
    expect(byReviewer.get("bob")?.prompt).toContain("Lens: security");
    expect(byReviewer.get("bob")?.prompt).toContain("Check auth boundaries.");
    expect(byReviewer.get("bob")?.prompt).not.toContain("Lens: correctness");
    expect(byReviewer.get("bob")?.prompt).not.toContain("Check behavior.");
  });

  it("records all-clean reviewer failures as pending consensus and escalates only through stall evaluation", async () => {
    const hitchId = "g-consensus-all-clean-fail";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "maintainability"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-clean-fail-",
      hitchId,
      rule,
    });
    const reviewerRunner = multiReviewerRunner({ alice: "", bob: "" });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).resolves.toEqual({
      runId,
      decision: "pending",
    });
    let dbHandle = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(dbHandle.db);
      expect(repo.requireSession(hitchId).status).not.toBe("escalated");
      expect(repo.listReviewCycles(hitchId)).toHaveLength(1);
      expect(
        new ReviewConsensusRepository(dbHandle.db).findActive(runId)?.status,
      ).toBe("pending");
      expect(new ReviewProposalRepository(dbHandle.db).listForRun(runId)).toEqual([]);
    } finally {
      dbHandle.close();
    }

    await runners.review(hitchId);
    await runners.review(hitchId);

    dbHandle = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(dbHandle.db);
      expect(repo.requireSession(hitchId).status).toBe("escalated");
      expect(repo.listReviewCycles(hitchId)).toHaveLength(3);
      expect(
        new ReviewConsensusRepository(dbHandle.db).listHistory(runId).map((r) => r.status),
      ).toEqual(["pending", "pending", "pending"]);
    } finally {
      dbHandle.close();
    }
    expect(reviewerRunner.run).toHaveBeenCalledTimes(6);
  });

  it("rethrows the lease-loss cause (does not demote to pending) when the orchestrator aborts mid-dispatch", async () => {
    // P1 — symmetry with the coder path: a course lease-loss aborts deps.signal
    // mid-drive, so codex returns aborted/exit -1 → reviewer-agent raises a
    // `reviewer_codex_*` gate error. That error must NOT be folded into a clean
    // per-reviewer failure (and then a pending-consensus demotion that writes a
    // review cycle + stall row and burns the stall budget under a lost lease).
    // It must rethrow the underlying lease error so the course layer finalizes
    // `lease_lost`, leaving the hitch untouched.
    const hitchId = "g-consensus-abort-rethrow";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "maintainability"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-abort-",
      hitchId,
      rule,
    });
    // Heartbeat-side lease loss: the controller is aborted with the lease error
    // as its reason (course-orchestrator runWithLeaseHeartbeat semantics).
    const controller = new AbortController();
    const leaseError = new LeaseLostError("t/docs", 7);
    // Mirror the real codex runner under abort: SIGKILL → aborted/exit -1, which
    // reviewer-agent turns into a `reviewer_codex_aborted` / nonzero-exit gate.
    const reviewerRunner = {
      run: vi.fn(
        async (input: {
          logPaths: { stdout: string; stderr: string };
          signal?: AbortSignal;
        }) => {
          writeFileSync(input.logPaths.stderr, "", "utf8");
          writeFileSync(input.logPaths.stdout, "", "utf8");
          // The lease heartbeat fires during the first reviewer's codex drive.
          if (!controller.signal.aborted) controller.abort(leaseError);
          return {
            exitCode: -1,
            timedOut: false,
            aborted: true,
            durationMs: 0,
          };
        },
      ),
    };
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      signal: controller.signal,
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).rejects.toBeInstanceOf(
      LeaseLostError,
    );

    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      // No pending-consensus demotion: no review cycle, no consensus row, and
      // the run stays needs_review (fail-closed — the lost lease drive is not
      // authoritative and must not advance the hitch or spend the stall budget).
      expect(repo.listReviewCycles(hitchId)).toHaveLength(0);
      expect(new ReviewConsensusRepository(db).findActive(runId)).toBeNull();
      expect(
        new ReviewConsensusRepository(db).listHistory(runId),
      ).toHaveLength(0);
      expect(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId))
        .toMatchObject({ status: "needs_review" });
      expect(repo.requireSession(hitchId).status).not.toBe("escalated");
    } finally {
      close();
    }
    // Fail-fast: rethrow on the FIRST aborted reviewer; the second is not driven.
    expect(reviewerRunner.run).toHaveBeenCalledTimes(1);
  });

  it("rethrows (does not demote to pending) when a frozen reviewer hits a non-clean tamper gate error", async () => {
    const hitchId = "g-consensus-tamper-rethrow";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "maintainability"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-tamper-",
      hitchId,
      rule,
    });
    // bob hits a non-clean gate error: a tamper detection
    // ("modified run artifact") carries NO sanitizedReason, so its reasonCode
    // is undefined and is NOT a member of CLEAN_REVIEWER_FAILURE_CODES. Unlike a
    // clean codex failure it MUST abort the whole review, not be folded into a
    // pending-consensus demotion.
    const tamperError = new ReviewerAgentGateError(
      `reviewer agent modified run artifact: ${runId}/final-diff.patch`,
    );
    const reviewerRunner = multiReviewerRunner({
      alice: reviewerOutput({ decision: "approved" }),
      bob: tamperError,
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).rejects.toBeInstanceOf(
      ReviewerAgentGateError,
    );

    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      // No review cycle recorded, no pending-consensus demotion, run stays
      // needs_review (fail-closed: a tamper abort does not advance the hitch).
      expect(repo.listReviewCycles(hitchId)).toHaveLength(0);
      expect(repo.requireSession(hitchId).status).not.toBe("escalated");
      expect(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId))
        .toMatchObject({ status: "needs_review" });
      // alice's clean approval may leave a `pending` consensus re-eval, but the
      // tamper abort must NEVER promote it to an approved/decided consensus.
      expect(
        new ReviewConsensusRepository(db).findActive(runId)?.status,
      ).not.toBe("approved");
    } finally {
      close();
    }
  });

  it("rethrows when a frozen reviewer gate error carries a non-clean reasonCode", async () => {
    const hitchId = "g-consensus-noncleancode-rethrow";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "maintainability"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-noncleancode-",
      hitchId,
      rule,
    });
    // A gate error whose reasonCode is present but is NOT in
    // CLEAN_REVIEWER_FAILURE_CODES (an unexpected-file tamper class) must also
    // abort rather than be tolerated as a clean per-reviewer failure.
    const nonCleanError = new ReviewerAgentGateError(
      "reviewer agent created unexpected file",
      {
        sanitizedReason: sanitizeGateReason({
          code: "reviewer_artifact_unexpected_file",
        }),
      },
    );
    const reviewerRunner = multiReviewerRunner({
      alice: reviewerOutput({ decision: "approved" }),
      bob: nonCleanError,
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).rejects.toBeInstanceOf(
      ReviewerAgentGateError,
    );

    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      expect(repo.listReviewCycles(hitchId)).toHaveLength(0);
      expect(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId))
        .toMatchObject({ status: "needs_review" });
    } finally {
      close();
    }
  });

  it("facet3: escalates (typed preflight error, no reviewer dispatch) on an unregistered frozen reviewer", async () => {
    const hitchId = "g-consensus-preflight-unregistered";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "dave"],
          lensAxes: ["correctness", "maintainability"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    // harness registers alice + bob; "dave" in the frozen set is unregistered.
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-preflight-unreg-",
      hitchId,
      rule,
    });
    const reviewerRunner = multiReviewerRunner({
      alice: reviewerOutput({ decision: "approved" }),
      dave: reviewerOutput({ decision: "approved" }),
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    const error = await runners.review(hitchId).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ConsensusReviewPreflightError);
    expect((error as ConsensusReviewPreflightError).causeKind).toBe(
      "unregistered",
    );
    // fail-closed BEFORE any reviewer dispatch — the registry gap must abort the
    // whole cycle, not run alice and demote to pending.
    expect(reviewerRunner.run).not.toHaveBeenCalled();

    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      expect(repo.listReviewCycles(hitchId)).toHaveLength(0);
      expect(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId))
        .toMatchObject({ status: "needs_review" });
      expect(new ReviewProposalRepository(db).listForRun(runId)).toEqual([]);
    } finally {
      close();
    }
  });

  it("SP-15: preflight rejects malformed frozen reviewer metadata_json before dispatch", async () => {
    const hitchId = "g-consensus-preflight-invalid-lens";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "security"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-invalid-lens-",
      hitchId,
      rule,
      reviewerMetadata: {
        alice: { lens: "correctness" },
        bob: { lens: "security" },
      },
    });
    const { db, close } = openManagedDb({ dbPath });
    try {
      db.prepare(
        "UPDATE reviewers SET metadata_json = ? WHERE reviewer_id = ?",
      ).run("{not json", "bob");
    } finally {
      close();
    }
    const reviewerRunner = multiReviewerRunner({
      alice: reviewerOutput({ decision: "approved" }),
      bob: reviewerOutput({ decision: "approved" }),
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    const error = await runners.review(hitchId).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ConsensusReviewPreflightError);
    expect((error as ConsensusReviewPreflightError).causeKind).toBe(
      "invalid_lens",
    );
    expect(reviewerRunner.run).not.toHaveBeenCalled();

    const handle = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(handle.db);
      expect(repo.listReviewCycles(hitchId)).toHaveLength(0);
      expect(
        handle.db.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId),
      ).toMatchObject({ status: "needs_review" });
      expect(new ReviewProposalRepository(handle.db).listForRun(runId)).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("facet3: escalates (typed preflight error, no reviewer dispatch) when a frozen reviewer is in the wrong group (under quorum)", async () => {
    const hitchId = "g-consensus-preflight-under-quorum";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "maintainability"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-preflight-quorum-",
      hitchId,
      rule,
    });
    // Move bob out of the "reviewers" group: now only alice is a registered
    // member of the required group → registered(1) < required(2).
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        db.prepare(
          "UPDATE reviewers SET group_id = 'security' WHERE reviewer_id = 'bob'",
        ).run();
      } finally {
        close();
      }
    }
    const reviewerRunner = multiReviewerRunner({
      alice: reviewerOutput({ decision: "approved" }),
      bob: reviewerOutput({ decision: "approved" }),
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    const error = await runners.review(hitchId).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ConsensusReviewPreflightError);
    expect((error as ConsensusReviewPreflightError).causeKind).toBe(
      "under_quorum",
    );
    expect((error as ConsensusReviewPreflightError).group).toBe("reviewers");
    expect((error as ConsensusReviewPreflightError).required).toBe(2);
    expect((error as ConsensusReviewPreflightError).registered).toBe(1);
    expect(reviewerRunner.run).not.toHaveBeenCalled();

    const { db, close } = openManagedDb({ dbPath });
    try {
      expect(new HitchRepository(db).listReviewCycles(hitchId)).toHaveLength(0);
      expect(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId))
        .toMatchObject({ status: "needs_review" });
    } finally {
      close();
    }
  });

  it("SP-15: preflight rejects a frozen multi-reviewer group with an empty reviewer lens before dispatch", async () => {
    const hitchId = "g-consensus-lens-empty";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "maintainability"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-lens-empty-",
      hitchId,
      rule,
      reviewerMetadata: {
        alice: { lens: "correctness" },
        bob: {},
      },
    });
    const reviewerRunner = multiReviewerRunner({
      alice: reviewerOutput({ decision: "approved" }),
      bob: reviewerOutput({ decision: "approved" }),
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    const error = await runners.review(hitchId).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ConsensusReviewPreflightError);
    expect((error as ConsensusReviewPreflightError).causeKind).toBe(
      "missing_lens",
    );
    expect(reviewerRunner.run).not.toHaveBeenCalled();
  });

  it("SP-15: preflight rejects missing declared lens axes before dispatch", async () => {
    const hitchId = "g-consensus-lens-missing-axis";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "security"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-lens-missing-axis-",
      hitchId,
      rule,
      reviewerMetadata: {
        alice: { lens: "correctness" },
        bob: { lens: "regression" },
      },
    });
    const reviewerRunner = multiReviewerRunner({
      alice: reviewerOutput({ decision: "approved" }),
      bob: reviewerOutput({ decision: "approved" }),
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    const error = await runners.review(hitchId).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ConsensusReviewPreflightError);
    expect((error as ConsensusReviewPreflightError).causeKind).toBe(
      "missing_axis",
    );
    expect((error as ConsensusReviewPreflightError).missingAxes).toEqual([
      "security",
    ]);
    expect(reviewerRunner.run).not.toHaveBeenCalled();
  });

  it("SP-15: preflight rejects duplicate reviewer lenses before dispatch", async () => {
    const hitchId = "g-consensus-lens-duplicate";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
          reviewerIds: ["alice", "bob"],
          lensAxes: ["correctness", "maintainability"],
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-lens-duplicate-",
      hitchId,
      rule,
      reviewerMetadata: {
        alice: { lens: "correctness" },
        bob: { lens: "correctness" },
      },
    });
    const reviewerRunner = multiReviewerRunner({
      alice: reviewerOutput({ decision: "approved" }),
      bob: reviewerOutput({ decision: "approved" }),
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    const error = await runners.review(hitchId).then(
      () => null,
      (e) => e,
    );
    expect(error).toBeInstanceOf(ConsensusReviewPreflightError);
    expect((error as ConsensusReviewPreflightError).causeKind).toBe(
      "duplicate_lens",
    );
    expect((error as ConsensusReviewPreflightError).duplicateAxes).toEqual([
      "correctness",
    ]);
    expect(reviewerRunner.run).not.toHaveBeenCalled();
  });

  it("SP-15: treats single-reviewer lens axes as advisory and dispatches", async () => {
    for (const scenario of [
      { hitchId: "g-consensus-single-lens-axes", lensAxes: ["security"] },
      { hitchId: "g-consensus-single-no-lens-axes" },
    ] as const) {
      const rule: ReviewRule = {
        mode: "consensus",
        requirements: [
          {
            group: "reviewers",
            minApprovals: 1,
            blockingDecisions: ["changes_requested", "rejected"],
            quorum: { minParticipants: 1 },
            reviewerIds: ["alice"],
            ...(scenario.lensAxes !== undefined
              ? { lensAxes: scenario.lensAxes }
              : {}),
          },
        ],
        overrides: { allowedReviewers: [], requireReason: true },
        staleProposal: { rejectSuperseded: true },
      };
      const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
        prefix: `harness-orch-review-${scenario.hitchId}-`,
        hitchId: scenario.hitchId,
        rule,
        reviewerMetadata: {
          alice: {},
          bob: {},
        },
      });
      const reviewerRunner = multiReviewerRunner({
        alice: reviewerOutput({ decision: "approved" }),
      });
      const runners = createOrchestratorRunners({
        dbPath,
        harnessRoot,
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner,
      });

      await expect(runners.review(scenario.hitchId)).resolves.toEqual({
        runId,
        decision: "approved",
      });
      expect(reviewerRunner.run).toHaveBeenCalledTimes(1);
    }
  });

  it("does not swallow non-frozen pending consensus gates", async () => {
    const hitchId = "g-consensus-non-frozen-pending";
    const rule: ReviewRule = {
      mode: "consensus",
      requirements: [
        {
          group: "reviewers",
          minApprovals: 2,
          blockingDecisions: ["changes_requested", "rejected"],
          quorum: { minParticipants: 2 },
        },
      ],
      overrides: { allowedReviewers: [], requireReason: true },
      staleProposal: { rejectSuperseded: true },
    };
    const { harnessRoot, dbPath, runId } = createFrozenConsensusReviewHarness({
      prefix: "harness-orch-review-consensus-non-frozen-pending-",
      hitchId,
      rule,
    });
    const reviewerRunner = multiReviewerRunner({
      "codex-reviewer": reviewerOutput({ decision: "approved" }),
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).rejects.toThrow(
      /consensus not yet satisfied/,
    );

    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      expect(repo.listReviewCycles(hitchId)).toHaveLength(0);
      expect(db.prepare("SELECT status FROM runs WHERE run_id = ?").get(runId))
        .toMatchObject({ status: "needs_review" });
      expect(new ReviewConsensusRepository(db).findActive(runId)?.status).toBe(
        "pending",
      );
    } finally {
      close();
    }
    expect(reviewerRunner.run).toHaveBeenCalledTimes(1);
  });

  it("selects the approving consensus member for normal review import traceability", () => {
    const { dbPath } = createHarnessRoot(
      "harness-orch-review-consensus-import-",
    );
    const hitchId = "g-consensus-import";
    const runId = `run-${hitchId}`;
    const reviewedAt = "2026-06-13T00:00:00.000Z";
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId,
        title: "Consensus import",
        repoId: "t",
        domain: "docs",
        closeConditions: [
          { id: "review-ok", kind: "review_consensus", required: true },
        ],
        createdBy: "test",
        createdSource: "worker",
      });
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, updated_at, meta_json)
         VALUES (?, 't', 'docs', 'domain-coding', 'main',
           'needs_review', 'db-first', 1, 'disabled', ?, ?)`,
      ).run(
        runId,
        reviewedAt,
        JSON.stringify({
          runId,
          repoId: "t",
          domain: "docs",
          status: "needs_review",
        }),
      );
      const approvingProposalId = insertProcessedProposal({
        db,
        runId,
        reviewer: "reviewer-a",
        decision: "approved",
        reviewedAt,
        reviewDecisionId: "decision-approved",
      });
      const nonApprovingProposalId = insertProcessedProposal({
        db,
        runId,
        reviewer: "reviewer-b",
        decision: "changes_requested",
        requiredChanges: [
          "This member proposal must not become a blocking consensus finding.",
        ],
        reviewedAt,
        reviewDecisionId: "decision-member-b",
      });
      expect(
        new ReviewProposalRepository(db).getLatestProcessedProposal(runId)
          ?.proposalId,
      ).toBe(nonApprovingProposalId);
      const aggregateYaml = decisionYaml(runId, "approved");
      db.prepare(
        `INSERT INTO review_decisions (run_id, decision, reviewer, reviewed_at,
           source_yaml, source_sha256)
         VALUES (?, 'approved', 'consensus', ?, ?, ?)`,
      ).run(
        runId,
        reviewedAt,
        aggregateYaml,
        createHash("sha256").update(aggregateYaml).digest("hex"),
      );
      const consensusSummary = {
        evaluatedAt: reviewedAt,
        ruleSha256: "rule-sha",
        semantics: REVIEW_CONSENSUS_STATIC_APPROVAL_SEMANTICS,
        proposals: [
          {
            proposalId: approvingProposalId,
            reviewerId: "reviewer-a",
            groupId: "codex",
            decision: "approved",
          },
          {
            proposalId: nonApprovingProposalId,
            reviewerId: "reviewer-b",
            groupId: "codex",
            decision: "changes_requested",
          },
        ],
        override: null,
        requirements: [],
        excludedProposals: [],
        decisionPath: "requirements-met",
      };
      db.prepare(
        `INSERT INTO review_consensus (
           run_id, rule_sha256, status, summary_json, evaluated_at,
           evaluated_by, source_proposals_json
         )
         VALUES (?, 'rule-sha', 'approved', ?, ?, 'review.process', ?)`,
      ).run(
        runId,
        JSON.stringify(consensusSummary),
        reviewedAt,
        JSON.stringify([approvingProposalId, nonApprovingProposalId]),
      );

      const selected = selectProcessedProposalForReviewImport({ db, runId });

      expect(selected?.proposalId).toBe(approvingProposalId);
      const imported = importReviewProposalToHitch({
        repository: repo,
        hitchId,
        proposal: selected!,
        processResult: {
          runId,
          previousStatus: "needs_review",
          newStatus: "approved",
          reviewer: "consensus",
          reviewedAt,
          warnings: [],
        },
        createdBy: "test",
      });
      expect(
        repo
          .listFindings({ hitchId, scopeStatus: "in_scope" })
          .filter(
            (f) =>
              f.category === "review-required-change" &&
              f.severity === "P1" &&
              (f.lifecycleStatus === "open" ||
                f.lifecycleStatus === "reopened"),
          ),
      ).toEqual([]);
      expect(imported.closeChecks[0]).toMatchObject({
        conditionId: "review-ok",
        status: "passed",
        evidence: {
          decision: "approved",
          proposalId: approvingProposalId,
          reviewDecisionId: "decision-approved",
        },
      });
      db.prepare(
        `UPDATE review_consensus
            SET status = 'changes_requested', summary_json = ?
          WHERE run_id = ? AND superseded_at IS NULL`,
      ).run(
        JSON.stringify({
          ...consensusSummary,
          decisionPath: "blocking",
        }),
        runId,
      );
      expect(selectProcessedProposalForReviewImport({ db, runId })?.proposalId).toBe(
        nonApprovingProposalId,
      );
    } finally {
      close();
    }
  });

  it("fails closed instead of falling back to latest processed when active consensus is malformed", () => {
    const { dbPath } = createHarnessRoot(
      "harness-orch-review-consensus-malformed-",
    );
    const runId = "run-consensus-malformed";
    const reviewedAt = "2026-06-13T00:00:00.000Z";
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, updated_at, meta_json)
         VALUES (?, 't', 'docs', 'domain-coding', 'main',
           'changes_requested', 'db-first', 1, 'disabled', ?, '{}')`,
      ).run(runId, reviewedAt);
      const latestProcessedId = insertProcessedProposal({
        db,
        runId,
        reviewer: "reviewer-latest",
        decision: "approved",
        reviewedAt,
        reviewDecisionId: "decision-latest",
      });
      expect(
        new ReviewProposalRepository(db).getLatestProcessedProposal(runId)
          ?.proposalId,
      ).toBe(latestProcessedId);
      db.prepare(
        `INSERT INTO review_consensus (
           run_id, rule_sha256, status, summary_json, evaluated_at,
           evaluated_by, source_proposals_json
         )
         VALUES (?, 'rule-sha', 'changes_requested', '{not-json', ?, 'review.process', '[]')`,
      ).run(runId, reviewedAt);

      expect(() => selectProcessedProposalForReviewImport({ db, runId })).toThrow(
        /refusing to import latest processed participant proposal/,
      );
    } finally {
      close();
    }
  });

  it("fails closed when active consensus status has no matching proposal trace", () => {
    const { dbPath } = createHarnessRoot(
      "harness-orch-review-consensus-inconsistent-",
    );
    const runId = "run-consensus-inconsistent";
    const reviewedAt = "2026-06-13T00:00:00.000Z";
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, updated_at, meta_json)
         VALUES (?, 't', 'docs', 'domain-coding', 'main',
           'changes_requested', 'db-first', 1, 'disabled', ?, '{}')`,
      ).run(runId, reviewedAt);
      const approvedProposalId = insertProcessedProposal({
        db,
        runId,
        reviewer: "reviewer-approved",
        decision: "approved",
        reviewedAt,
        reviewDecisionId: "decision-approved",
      });
      db.prepare(
        `INSERT INTO review_consensus (
           run_id, rule_sha256, status, summary_json, evaluated_at,
           evaluated_by, source_proposals_json
         )
         VALUES (?, 'rule-sha', 'changes_requested', ?, ?, 'review.process', ?)`,
      ).run(
        runId,
        JSON.stringify({
          proposals: [
            {
              proposalId: approvedProposalId,
              reviewerId: "reviewer-approved",
              groupId: "codex",
              decision: "approved",
            },
          ],
        }),
        reviewedAt,
        JSON.stringify([approvedProposalId]),
      );

      expect(() => selectProcessedProposalForReviewImport({ db, runId })).toThrow(
        /has no canonical proposal trace; refusing to import latest processed participant proposal/,
      );
    } finally {
      close();
    }
  });

  it("fails closed when active consensus points at a processed proposal from another run", () => {
    const { dbPath } = createHarnessRoot(
      "harness-orch-review-consensus-cross-run-",
    );
    const runId = "run-consensus-cross-run";
    const otherRunId = "run-consensus-other";
    const reviewedAt = "2026-06-13T00:00:00.000Z";
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      for (const id of [runId, otherRunId]) {
        db.prepare(
          `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
             status, source_mode, db_revision, export_status, updated_at,
             meta_json)
           VALUES (?, 't', 'docs', 'domain-coding', 'main',
             'changes_requested', 'db-first', 1, 'disabled', ?, '{}')`,
        ).run(id, reviewedAt);
      }
      const latestProcessedId = insertProcessedProposal({
        db,
        runId,
        reviewer: "reviewer-latest",
        decision: "approved",
        reviewedAt,
        reviewDecisionId: "decision-latest",
      });
      const otherProposalId = insertProcessedProposal({
        db,
        runId: otherRunId,
        reviewer: "reviewer-other",
        decision: "changes_requested",
        requiredChanges: ["Other run blocker must never be imported."],
        reviewedAt,
        reviewDecisionId: "decision-other",
      });
      expect(
        new ReviewProposalRepository(db).getLatestProcessedProposal(runId)
          ?.proposalId,
      ).toBe(latestProcessedId);
      db.prepare(
        `INSERT INTO review_consensus (
           run_id, rule_sha256, status, summary_json, evaluated_at,
           evaluated_by, source_proposals_json
         )
         VALUES (?, 'rule-sha', 'changes_requested', ?, ?, 'review.process', ?)`,
      ).run(
        runId,
        JSON.stringify({
          proposals: [
            {
              proposalId: otherProposalId,
              reviewerId: "reviewer-other",
              groupId: "codex",
              decision: "changes_requested",
            },
          ],
        }),
        reviewedAt,
        JSON.stringify([otherProposalId]),
      );

      expect(() => selectProcessedProposalForReviewImport({ db, runId })).toThrow(
        /from run-consensus-other; refusing to import latest processed participant proposal/,
      );
    } finally {
      close();
    }
  });

  it("fails closed when active consensus points at an unprocessed proposal", () => {
    const { dbPath } = createHarnessRoot(
      "harness-orch-review-consensus-unprocessed-",
    );
    const runId = "run-consensus-unprocessed";
    const reviewedAt = "2026-06-13T00:00:00.000Z";
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           status, source_mode, db_revision, export_status, updated_at,
           meta_json)
         VALUES (?, 't', 'docs', 'domain-coding', 'main',
           'changes_requested', 'db-first', 1, 'disabled', ?, '{}')`,
      ).run(runId, reviewedAt);
      const latestProcessedId = insertProcessedProposal({
        db,
        runId,
        reviewer: "reviewer-latest",
        decision: "approved",
        reviewedAt,
        reviewDecisionId: "decision-latest",
      });
      const sourceYaml = decisionYaml(runId, "changes_requested");
      const sourceSha = createHash("sha256").update(sourceYaml).digest("hex");
      const unprocessedProposalId = Number(
        db
          .prepare(
            `INSERT INTO review_proposals (
               run_id, reviewer, decision, required_changes_json,
               non_blocking_comments_json, out_of_scope_suggestions_json,
               reviewed_at, source_yaml, source_sha256, created_at,
               lifecycle_status
             )
             VALUES (?, 'reviewer-unprocessed', 'changes_requested',
               '["Target run unprocessed blocker must not be imported."]',
               '[]', '[]', ?, ?, ?, ?, 'active')`,
          )
          .run(runId, reviewedAt, sourceYaml, sourceSha, reviewedAt)
          .lastInsertRowid,
      );
      expect(
        new ReviewProposalRepository(db).getLatestProcessedProposal(runId)
          ?.proposalId,
      ).toBe(latestProcessedId);
      db.prepare(
        `INSERT INTO review_consensus (
           run_id, rule_sha256, status, summary_json, evaluated_at,
           evaluated_by, source_proposals_json
         )
         VALUES (?, 'rule-sha', 'changes_requested', ?, ?, 'review.process', ?)`,
      ).run(
        runId,
        JSON.stringify({
          proposals: [
            {
              proposalId: unprocessedProposalId,
              reviewerId: "reviewer-unprocessed",
              groupId: "codex",
              decision: "changes_requested",
            },
          ],
        }),
        reviewedAt,
        JSON.stringify([unprocessedProposalId]),
      );

      expect(() => selectProcessedProposalForReviewImport({ db, runId })).toThrow(
        /references unprocessed proposal .* refusing to import latest processed participant proposal/,
      );
    } finally {
      close();
    }
  });

  it("short-circuits an approved processed run without invoking the reviewer", async () => {
    const { harnessRoot, dbPath } = createHarnessRoot(
      "harness-orch-review-redrive-",
    );
    const hitchId = "g-approved-redrive";
    const runId = insertApprovedRunWithProcessedProposal({ dbPath, hitchId });
    const reviewerRunner = {
      run: vi.fn(async () => {
        throw new Error("reviewer must not run");
      }),
    };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T01:00:00.000Z"));
    try {
      const runners = createOrchestratorRunners({
        dbPath,
        harnessRoot,
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner,
      });

      const result = await runners.review(hitchId);

      expect(result).toEqual({ runId, decision: "approved" });
      expect(reviewerRunner.run).not.toHaveBeenCalled();
      const { db, close } = openManagedDb({ dbPath });
      try {
        const repo = new HitchRepository(db);
        // Idempotent re-drive: the prior import's cycle stays; NO new one.
        expect(repo.listReviewCycles(hitchId)).toHaveLength(1);
        const checks = repo.listCloseChecks(hitchId);
        expect(checks).toHaveLength(1);
        expect(checks[0]).toMatchObject({
          conditionId: "review-ok",
          status: "passed",
          checkedAt: "2026-06-13T01:00:00.000Z",
          checkedBy: "codex-reviewer",
        });
        expect(new ConvergenceService(repo).evaluate(hitchId).decision).toBe(
          "close_ready",
        );
      } finally {
        close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes review consensus and waits (no escalate) when a non-command required condition is pending", async () => {
    const { harnessRoot, dbPath } = createHarnessRoot(
      "harness-orch-review-pending-",
    );
    const hitchId = "g-approved-pending";
    const runId = insertApprovedRunWithProcessedProposal({
      dbPath,
      hitchId,
      closeConditions: [
        { id: "review-ok", kind: "review_consensus", required: true },
        { id: "manual-signoff", kind: "manual", required: true },
      ],
    });
    const reviewerRunner = {
      run: vi.fn(async () => {
        throw new Error("reviewer must not run");
      }),
    };
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    // #184: the short-circuit refreshes review_consensus and does NOT throw on a
    // remaining pending condition; convergence routes the non-command evidence
    // (manual) to an operator wait (ask_human), not an escalation.
    const result = await runners.review(hitchId);
    expect(result).toEqual({ runId, decision: "approved" });
    expect(reviewerRunner.run).not.toHaveBeenCalled();
    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      // Idempotent re-drive: only the prior import's cycle, no new one.
      expect(repo.listReviewCycles(hitchId)).toHaveLength(1);
      expect(repo.listCloseChecks(hitchId).map((c) => c.conditionId)).toEqual([
        "review-ok",
      ]);
      const convergence = new ConvergenceService(repo).evaluate(hitchId);
      expect(convergence.decision).toBe("continue");
      expect(convergence.recommendedNextAction.kind).toBe("ask_human");
      expect(convergence.recommendedNextAction.message).toMatch(/manual-signoff/);
    } finally {
      close();
    }
  });

  it("does not salvage a review branch when the latest run is already decided", async () => {
    const { harnessRoot, dbPath } = createHarnessRoot(
      "harness-orch-review-salvage-",
    );
    const hitchId = "g-approved-salvage";
    insertApprovedRunWithProcessedProposal({ dbPath, hitchId });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
    });

    await expect(runners.salvageReviewBranch?.(hitchId)).resolves.toBeNull();
  });

  it("fails closed (no silent close) when an approved run has no completed review import", async () => {
    // processReviewDecision ran (run approved) but no COMPLETED review cycle
    // exists — the import never ran, or crashed mid-way (cycle persisted before
    // findings). The short-circuit must NOT record a passed close-check (which
    // could close the hitch without its findings); it fails closed → escalate.
    const { harnessRoot, dbPath } = createHarnessRoot(
      "harness-orch-review-crash-",
    );
    const hitchId = "g-approved-crash";
    insertApprovedRunWithProcessedProposal({
      dbPath,
      hitchId,
      priorCycle: false,
    });
    const reviewerRunner = {
      run: vi.fn(async () => {
        throw new Error("reviewer must not run");
      }),
    };
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner,
    });

    await expect(runners.review(hitchId)).rejects.toThrow(
      /no completed review import/,
    );
    expect(reviewerRunner.run).not.toHaveBeenCalled();
    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      // No spurious close-check recorded over an unimported/partial review.
      expect(repo.listCloseChecks(hitchId)).toHaveLength(0);
    } finally {
      close();
    }
  });

  it("fails closed when only an INCOMPLETE review cycle exists (crash mid-import)", async () => {
    // A cycle row was persisted but its findings import crashed before
    // completeReviewCycle (completedAt stays null). Treating that as a finished
    // import would skip the findings; the short-circuit must reject it.
    const { harnessRoot, dbPath } = createHarnessRoot(
      "harness-orch-review-partial-",
    );
    const hitchId = "g-approved-partial";
    const runId = insertApprovedRunWithProcessedProposal({
      dbPath,
      hitchId,
      priorCycle: false,
    });
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        // An incomplete cycle: started, never completed.
        new HitchRepository(db).startReviewCycle({
          hitchId,
          reviewMode: "close",
          sourceRunId: runId,
        });
      } finally {
        close();
      }
    }
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
    });

    await expect(runners.review(hitchId)).rejects.toThrow(
      /no completed review import/,
    );
    const { db, close } = openManagedDb({ dbPath });
    try {
      expect(new HitchRepository(db).listCloseChecks(hitchId)).toHaveLength(0);
    } finally {
      close();
    }
  });

  // Safety boundary (#167): the short-circuit applies ONLY to an approved
  // decided run. A changes_requested / rejected decided run must fall through
  // to the normal reviewer path (which escalates via the already_decided gate)
  // and must NOT have a spurious `review_consensus` close-check recorded — a
  // close-check derived from a non-approval would be a state transition the
  // harness never authorized.
  for (const decision of ["changes_requested", "rejected"] as const) {
    it(`does not short-circuit a ${decision} decided run (no close-check)`, () => {
      const { dbPath } = createHarnessRoot(
        `harness-orch-review-${decision}-`,
      );
      const hitchId = `g-${decision}-redrive`;
      const runId = insertApprovedRunWithProcessedProposal({
        dbPath,
        hitchId,
        decision,
      });
      const { db, close } = openManagedDb({ dbPath });
      try {
        const result = tryShortCircuitApprovedDecidedReview({
          db,
          hitchId,
          runId,
          createdBy: "worker",
        });
        expect(result).toBeNull();
        const repo = new HitchRepository(db);
        expect(repo.listCloseChecks(hitchId)).toHaveLength(0);
      } finally {
        close();
      }
    });
  }
});

describe("createOrchestratorRunners.classify", () => {
  it("returns resolved=true when there are no unknown-scope findings", async () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "harness-orch-run-")),
      "harness.sqlite",
    );
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new HitchRepository(db).createSession({
        hitchId: "g-c",
        title: "C",
        projectId: "demo",
        closeConditions: [{ id: "typecheck", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
    } finally {
      close();
    }
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot: dbPath,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
    });
    const r = await runners.classify("g-c");
    expect(r.resolved).toBe(true);
  });

  it("drains more than one implicit finding page before reporting resolved", async () => {
    const dbPath = createRunnerTestDb("harness-orch-classify-many-");
    const total = 201;
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        createBasicHitch(repo, "g-classify-many");
        for (let i = 0; i < total; i += 1) {
          repo.upsertFinding({
            hitchId: "g-classify-many",
            source: "review",
            severity: "P1",
            category: "bug",
            scopeStatus: "unknown",
            summary: `bug in scoped file ${i}`,
            filePath: `src/file-${i}.ts`,
          });
        }
      } finally {
        close();
      }
    }

    const result = await createRunners(dbPath).classify("g-classify-many");

    expect(result).toEqual({ resolved: true });
    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      expect(
        repo.countFindings({
          hitchId: "g-classify-many",
          scopeStatus: "unknown",
          lifecycleStatusIn: ["open", "reopened", "escalated"],
        }),
      ).toBe(0);
      expect(
        repo.countFindings({
          hitchId: "g-classify-many",
          scopeStatus: "in_scope",
        }),
      ).toBe(total);
    } finally {
      close();
    }
  });

  it("escalates a harness-origin finding the heuristic AND jury cannot resolve (#230)", async () => {
    const dbPath = createRunnerTestDb("harness-orch-classify-unknown-");
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        createBasicHitch(repo, "g-classify-unknown");
        repo.upsertFinding({
          hitchId: "g-classify-unknown",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "unknown",
          summary: "ambiguous issue",
        });
      } finally {
        close();
      }
    }

    // The fake reviewerRunner returns exitCode 0 but writes no JSON, so every
    // jury lens parses to `parse_error` -> inconclusive -> the deterministic gate
    // escalates (it can NEVER auto_confirm without verified+unanimous proposals).
    const result = await createRunners(dbPath).classify("g-classify-unknown");

    expect(result.resolved).toBe(false);
    if (result.resolved) throw new Error("unreachable");
    expect(result.decision).toBe("escalate");
    expect(result.recommendedNextAction.decisionPacket).toBeDefined();
  });

  it("stops finitely when classification makes no count progress", async () => {
    const dbPath = createRunnerTestDb("harness-orch-classify-stuck-");
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        createBasicHitch(repo, "g-classify-stuck");
        repo.upsertFinding({
          hitchId: "g-classify-stuck",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "unknown",
          summary: "bug in scoped file",
          filePath: "src/file.ts",
        });
      } finally {
        close();
      }
    }
    const classifySpy = vi
      .spyOn(HitchRepository.prototype, "classifyFinding")
      .mockImplementation(function (
        this: HitchRepository,
        input: Parameters<HitchRepository["classifyFinding"]>[0],
      ) {
        return this.requireFinding(input.findingId);
      });
    try {
      const result = await createRunners(dbPath).classify("g-classify-stuck");
      expect(result.resolved).toBe(false);
      expect(result.escalateReason).toMatch(/no progress/i);
    } finally {
      classifySpy.mockRestore();
    }
  });

  it.each(["out_of_scope", "escalated"] as const)(
    "defer moves %s out-of-scope findings to the backlog",
    async (lifecycleStatus) => {
      const dbPath = join(
        mkdtempSync(join(tmpdir(), "harness-orch-defer-")),
        "harness.sqlite",
      );
      let findingId = "";
      {
        const { db, close } = openManagedDb({ dbPath });
        try {
          runMigrations(db);
          const repo = new HitchRepository(db);
          repo.createSession({
            hitchId: "g-defer",
            title: "Defer",
            projectId: "demo",
            closeConditions: [{ id: "typecheck", kind: "command", required: true }],
            createdBy: "test",
            createdSource: "worker",
          });
          const f = repo.upsertFinding({
            hitchId: "g-defer",
            source: "review",
            severity: "P2",
            category: "future-feature",
            scopeStatus: "out_of_scope",
            summary: "out of scope idea",
            ...(lifecycleStatus === "escalated" ? { lifecycleStatus } : {}),
          }).finding;
          findingId = f.findingId;
        } finally {
          close();
        }
      }
      const runners = createOrchestratorRunners({
        dbPath,
        harnessRoot: dbPath,
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      });
      const result = await runners.defer("g-defer");
      expect(result.deferred).toBe(1);
      const { db, close } = openManagedDb({ dbPath });
      try {
        expect(
          new HitchRepository(db).requireFinding(findingId).lifecycleStatus,
        ).toBe("deferred");
      } finally {
        close();
      }
    },
  );

  it("defers more than one implicit finding page and reports the real count", async () => {
    const dbPath = createRunnerTestDb("harness-orch-defer-many-");
    const total = 201;
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        createBasicHitch(repo, "g-defer-many");
        for (let i = 0; i < total; i += 1) {
          repo.upsertFinding({
            hitchId: "g-defer-many",
            source: "review",
            severity: "P2",
            category: "future-feature",
            scopeStatus: "out_of_scope",
            summary: `future follow-up ${i}`,
          });
        }
      } finally {
        close();
      }
    }

    const result = await createRunners(dbPath).defer("g-defer-many");

    expect(result.deferred).toBe(total);
    const { db, close } = openManagedDb({ dbPath });
    try {
      expect(
        new HitchRepository(db).countFindings({
          hitchId: "g-defer-many",
          scopeStatus: "out_of_scope",
          lifecycleStatusIn: ["open", "reopened", "out_of_scope", "escalated"],
        }),
      ).toBe(0);
    } finally {
      close();
    }
  });

  it("stops finitely when deferral makes no count progress", async () => {
    const dbPath = createRunnerTestDb("harness-orch-defer-stuck-");
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        createBasicHitch(repo, "g-defer-stuck");
        repo.upsertFinding({
          hitchId: "g-defer-stuck",
          source: "review",
          severity: "P2",
          category: "future-feature",
          scopeStatus: "out_of_scope",
          summary: "future follow-up",
        });
      } finally {
        close();
      }
    }
    const deferSpy = vi
      .spyOn(HitchRepository.prototype, "deferFinding")
      .mockImplementation(function (
        this: HitchRepository,
        input: Parameters<HitchRepository["deferFinding"]>[0],
      ) {
        return this.requireFinding(input.findingId);
      });
    try {
      const result = await createRunners(dbPath).defer("g-defer-stuck");
      expect(result.deferred).toBe(0);
    } finally {
      deferSpy.mockRestore();
    }
  });
});

describe("createOrchestratorRunners.closeCheck", () => {
  function setupCloseCheckHarness(
    commandYaml = [
      "    commands:",
      "      allow:",
      "        - id: typecheck",
      "          cmd: node",
      "          args: [\"-e\", \"console.log('close ok')\"]",
      "      defaults:",
      "        timeout_ms: 30000",
    ].join("\n"),
  ): { harnessRoot: string; dbPath: string; worktreePath: string } {
    const harnessRoot = mkdtempSync(join(tmpdir(), "harness-orch-close-check-"));
    mkdirSync(join(harnessRoot, "policies/repos"), { recursive: true });
    mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
    const worktreePath = join(harnessRoot, "workspaces", "run-close", "repo");
    mkdirSync(worktreePath, { recursive: true });
    // A real run worktree is a git repo checked out at the run's base, with the
    // coder's reviewed changes in the tree. The close-check runner verifies the
    // worktree still matches the run's reviewed surface before/after running.
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: worktreePath });
    execFileSync("git", ["config", "user.email", "t@example.com"], {
      cwd: worktreePath,
    });
    execFileSync("git", ["config", "user.name", "t"], { cwd: worktreePath });
    // Initial commit = the run base. Then a tracked edit standing in for the
    // coder's reviewed change, so the run has a non-empty reviewed surface.
    writeFileSync(join(worktreePath, "reviewed.txt"), "approved\n");
    execFileSync("git", ["add", "reviewed.txt"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: worktreePath });
    writeFileSync(join(worktreePath, "reviewed.txt"), "approved edit\n");
    writeFileSync(
      join(harnessRoot, "policies/global.yaml"),
      "always_deny_write: []\nignore_untracked: []\n",
    );
    writeFileSync(
      join(harnessRoot, "policies/repos/t.yaml"),
      [
        "repo_id: t",
        "read: []",
        "domains:",
        "  apps/user:",
        "    read: [apps/user/**]",
        "    write: [apps/user/**]",
        "    deny_write: []",
        commandYaml,
        "",
      ].join("\n"),
    );
    const dbPath = join(harnessRoot, ".harness", "harness.sqlite");
    return { harnessRoot, dbPath, worktreePath };
  }

  async function seedCloseCheckHitch(
    dbPath: string,
    worktreePath: string,
    closeConditions: HitchCloseCondition[] = [
      { id: "typecheck", kind: "command", required: true },
    ],
  ): Promise<void> {
    // The run's base SHA is the commit the worktree was created at (its current
    // HEAD); the reviewed surface is computed against it with the SAME functions
    // the runner uses, so the recorded meta.reviewed exactly matches the tree.
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: worktreePath,
    })
      .toString()
      .trim();
    const diff = await collectDiff({ repoPath: worktreePath, baseSha });
    const reviewedPaths = [
      ...diff.trackedChangedPaths,
      ...diff.untrackedPaths,
    ].sort();
    const fingerprint = await computeReviewedFingerprint(
      worktreePath,
      reviewedPaths,
    );
    const metaJson = JSON.stringify({ reviewed: { paths: reviewedPaths, fingerprint } });
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-close-check",
        title: "Close check",
        projectId: null,
        repoId: "t",
        domain: "apps/user",
        closeConditions,
        createdBy: "test",
        createdSource: "worker",
      });
      repo.createAttempt({
        hitchId: "g-close-check",
        attemptType: "implement",
        status: "succeeded",
        runId: "run-close",
      });
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           base_sha, status, source_mode, db_revision, export_status,
           updated_at, meta_json)
         VALUES (?, 't', 'apps/user', 'domain-coding', 'main', ?, 'approved',
           'db-first', 1, 'disabled', '2026-06-13T00:00:00.000Z', ?)`,
      ).run("run-close", baseSha, metaJson);
    } finally {
      close();
    }
  }

  it("runs pending command close checks from the domain policy allowlist", async () => {
    const { harnessRoot, dbPath, worktreePath } = setupCloseCheckHarness();
    await seedCloseCheckHitch(dbPath, worktreePath);
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      repoPath: worktreePath,
      baseBranch: "main",
    });

    const result = await runners.closeCheck("g-close-check");

    expect(result).toMatchObject({
      runId: "run-close",
      checked: 1,
      passed: 1,
      failed: 0,
    });
    const logPath = join(
      harnessRoot,
      "runs",
      "run-close",
      "close-checks",
      "typecheck.out.log",
    );
    expect(readFileSync(logPath, "utf8")).toContain("close ok");

    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      const check = repo.listCloseChecks("g-close-check").at(-1);
      expect(check?.status).toBe("passed");
      expect(check?.evidence).toMatchObject({
        runId: "run-close",
        conditionKind: "command",
        policyCommandId: "typecheck",
        exitCode: 0,
        timedOut: false,
      });
      expect(String(check?.evidence.stdoutPath)).toContain(
        join("runs", "run-close", "close-checks", "typecheck.out.log"),
      );
      const attempt = repo
        .listAttempts("g-close-check")
        .find((a) => a.attemptType === "close-check");
      expect(attempt).toMatchObject({
        status: "succeeded",
        runId: "run-close",
        iteration: 1,
      });
    } finally {
      close();
    }
  });

  it("fails fast without execution when a command close check is not allowlisted", async () => {
    const { harnessRoot, dbPath, worktreePath } =
      setupCloseCheckHarness("    commands:\n      allow: []");
    const marker = join(worktreePath, "must-not-exist.txt");
    await seedCloseCheckHitch(dbPath, worktreePath, [
      {
        id: "danger",
        kind: "command",
        required: true,
        command: `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`,
      },
    ]);
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      repoPath: worktreePath,
      baseBranch: "main",
    });

    await expect(runners.closeCheck("g-close-check")).rejects.toThrow(
      /not in the resolved domain policy allowlist/,
    );
    expect(existsSync(marker)).toBe(false);
    expect(
      existsSync(join(harnessRoot, "runs", "run-close", "close-checks")),
    ).toBe(false);

    const { db, close } = openManagedDb({ dbPath });
    try {
      const attempt = new HitchRepository(db)
        .listAttempts("g-close-check")
        .find((a) => a.attemptType === "close-check");
      expect(attempt?.status).toBe("failed");
      expect(attempt?.errorMessage).toMatch(/external evidence/);
    } finally {
      close();
    }
  });

  it("does not execute optional (non-required) command close conditions (#140 P1)", async () => {
    const { harnessRoot, dbPath, worktreePath } = setupCloseCheckHarness();
    // A required allowlisted condition plus an OPTIONAL condition whose command
    // is NOT allowlisted. The optional one must be ignored, not executed or
    // escalated — otherwise it would throw before the required evidence lands.
    await seedCloseCheckHitch(dbPath, worktreePath, [
      { id: "typecheck", kind: "command", required: true },
      {
        id: "advisory",
        kind: "command",
        required: false,
        command: "definitely-not-allowlisted",
      },
    ]);
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      repoPath: worktreePath,
      baseBranch: "main",
    });

    const result = await runners.closeCheck("g-close-check");
    expect(result).toMatchObject({ checked: 1, passed: 1, failed: 0 });
    const { db, close } = openManagedDb({ dbPath });
    try {
      const checks = new HitchRepository(db).listCloseChecks("g-close-check");
      expect(checks.map((c) => c.conditionId)).toEqual(["typecheck"]);
    } finally {
      close();
    }
  });

  it.each(["skipped", "unknown"] as const)(
    "re-runs a required command close check whose latest evidence is %s",
    async (status) => {
      const { harnessRoot, dbPath, worktreePath } = setupCloseCheckHarness();
      await seedCloseCheckHitch(dbPath, worktreePath);
      {
        const { db, close } = openManagedDb({ dbPath });
        try {
          new HitchRepository(db).recordCloseCheck({
            hitchId: "g-close-check",
            conditionId: "typecheck",
            status,
            checkedBy: "test",
            checkedAt: "2026-06-13T00:10:00.000Z",
          });
        } finally {
          close();
        }
      }
      const runners = createOrchestratorRunners({
        dbPath,
        harnessRoot,
        createdBy: "worker",
        coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
        repoPath: worktreePath,
        baseBranch: "main",
      });

      const result = await runners.closeCheck("g-close-check");

      expect(result).toMatchObject({ checked: 1, passed: 1, failed: 0 });
      const { db, close } = openManagedDb({ dbPath });
      try {
        const checks = new HitchRepository(db).listCloseChecks("g-close-check");
        expect(checks.map((c) => c.status)).toEqual([status, "passed"]);
      } finally {
        close();
      }
    },
  );

  it("fails closed when a command close check dirties the run worktree (#140 P1)", async () => {
    const { harnessRoot, dbPath, worktreePath } = setupCloseCheckHarness(
      [
        "    commands:",
        "      allow:",
        "        - id: typecheck",
        "          cmd: node",
        "          args: [\"-e\", \"require('fs').writeFileSync('side-effect.txt','x')\"]",
        "      defaults:",
        "        timeout_ms: 30000",
      ].join("\n"),
    );
    await seedCloseCheckHitch(dbPath, worktreePath);
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      repoPath: worktreePath,
      baseBranch: "main",
    });

    // A new untracked file is not in the reviewed surface → unreviewed path.
    await expect(runners.closeCheck("g-close-check")).rejects.toThrow(
      /unreviewed path/,
    );
    const { db, close } = openManagedDb({ dbPath });
    try {
      const attempt = new HitchRepository(db)
        .listAttempts("g-close-check")
        .find((a) => a.attemptType === "close-check");
      expect(attempt?.status).toBe("failed");
    } finally {
      close();
    }
  });

  it("fails closed when a command rewrites an already-dirty tracked file (#140 P0)", async () => {
    // The run worktree carries the coder's reviewed changes. A command that
    // REWRITES an already-dirty (reviewed) tracked file leaves the `git status`
    // porcelain line unchanged (` M tracked.txt`), so a status-line check would
    // miss it. The reviewed-content fingerprint must still fail-closed (drift).
    const { harnessRoot, dbPath, worktreePath } = setupCloseCheckHarness(
      [
        "    commands:",
        "      allow:",
        "        - id: typecheck",
        "          cmd: node",
        "          args: [\"-e\", \"require('fs').writeFileSync('tracked.txt','MUTATED')\"]",
        "      defaults:",
        "        timeout_ms: 30000",
      ].join("\n"),
    );
    // Commit a file, then dirty it — mirroring the coder's uncommitted edits.
    const tracked = join(worktreePath, "tracked.txt");
    writeFileSync(tracked, "committed\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: worktreePath });
    writeFileSync(tracked, "coder-edit\n");
    await seedCloseCheckHitch(dbPath, worktreePath);
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      repoPath: worktreePath,
      baseBranch: "main",
    });

    // tracked.txt is a reviewed path; rewriting its content drifts the run.
    await expect(runners.closeCheck("g-close-check")).rejects.toThrow(
      /drifted/,
    );
  });

  it("fails closed when a command leaves a staged-only index mutation", async () => {
    const script = [
      "const fs = require('fs')",
      "const cp = require('child_process')",
      "fs.writeFileSync('reviewed.txt', 'MUTATED\\n')",
      "cp.execFileSync('git', ['add', 'reviewed.txt'])",
      "fs.writeFileSync('reviewed.txt', 'approved edit\\n')",
    ].join(";");
    const { harnessRoot, dbPath, worktreePath } = setupCloseCheckHarness(
      [
        "    commands:",
        "      allow:",
        "        - id: typecheck",
        "          cmd: node",
        `          args: ["-e", ${JSON.stringify(script)}]`,
        "      defaults:",
        "        timeout_ms: 30000",
      ].join("\n"),
    );
    await seedCloseCheckHitch(dbPath, worktreePath);
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      repoPath: worktreePath,
      baseBranch: "main",
    });

    await expect(runners.closeCheck("g-close-check")).rejects.toThrow(
      /staged index/,
    );
  });

  it("fails closed when a command writes a .gitignored path not in policy ignore (#140 P0)", async () => {
    // `git status` hides .gitignore'd files, but the policy surface uses
    // `ls-files --others` WITHOUT --exclude-standard, then filters by
    // policy.ignoreUntracked (empty here). A command writing into a gitignored
    // dir therefore still pollutes the validated tree → must fail-closed.
    const { harnessRoot, dbPath, worktreePath } = setupCloseCheckHarness(
      [
        "    commands:",
        "      allow:",
        "        - id: typecheck",
        "          cmd: node",
        "          args: [\"-e\", \"const fs=require('fs');fs.mkdirSync('gen',{recursive:true});fs.writeFileSync('gen/out.txt','x')\"]",
        "      defaults:",
        "        timeout_ms: 30000",
      ].join("\n"),
    );
    writeFileSync(join(worktreePath, ".gitignore"), "gen/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: worktreePath });
    execFileSync("git", ["commit", "-q", "-m", "ignore gen"], {
      cwd: worktreePath,
    });
    await seedCloseCheckHitch(dbPath, worktreePath);
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      repoPath: worktreePath,
      baseBranch: "main",
    });

    // gen/out.txt is kept (policy ignore empty) but not reviewed → unreviewed path.
    await expect(runners.closeCheck("g-close-check")).rejects.toThrow(
      /unreviewed path/,
    );
  });

  it("fails closed when the worktree is polluted before the close-check (#140 P0)", async () => {
    // Baseline integrity: if the worktree drifted from the reviewed state
    // BETWEEN review and close-check (e.g. an out-of-band extra file), the
    // close-check must reject that polluted baseline — not adopt it and pass.
    const { harnessRoot, dbPath, worktreePath } = setupCloseCheckHarness();
    await seedCloseCheckHitch(dbPath, worktreePath);
    // Pollute AFTER the reviewed surface was recorded.
    writeFileSync(join(worktreePath, "snuck-in.txt"), "not reviewed\n");
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      repoPath: worktreePath,
      baseBranch: "main",
    });

    await expect(runners.closeCheck("g-close-check")).rejects.toThrow(
      /unreviewed path/,
    );
  });
});

describe("latestRunId", () => {
  it("selects the most recent coding run id, ignoring non-coding attempts", () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "harness-orch-latest-")),
      "harness.sqlite",
    );
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-latest",
        title: "L",
        projectId: "demo",
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      // older implement run
      repo.createAttempt({
        hitchId: "g-latest",
        attemptType: "implement",
        status: "succeeded",
        runId: "run-old-implement",
      });
      // a more recent rerun — this is the run review/PR should target
      repo.createAttempt({
        hitchId: "g-latest",
        attemptType: "rerun",
        status: "succeeded",
        runId: "run-new-rerun",
      });
      // a still-later NON-coding attempt carrying its own runId — must be
      // ignored so it can't be picked for review/PR.
      repo.createAttempt({
        hitchId: "g-latest",
        attemptType: "close-check",
        status: "succeeded",
        runId: "run-close-check",
      });
      expect(latestRunId(repo, "g-latest")).toBe("run-new-rerun");
    } finally {
      close();
    }
  });

  it("throws when the goal has no coding run yet", () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "harness-orch-latest-none-")),
      "harness.sqlite",
    );
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-none",
        title: "N",
        projectId: "demo",
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      // only a non-coding attempt with a runId — latestRunId must reject it.
      repo.createAttempt({
        hitchId: "g-none",
        attemptType: "close-check",
        status: "succeeded",
        runId: "run-close-check",
      });
      expect(() => latestRunId(repo, "g-none")).toThrow(/no recorded run/);
    } finally {
      close();
    }
  });
});

describe("createOrchestratorRunners.coder (failed run)", () => {
  function setupHarness(): { harnessRoot: string; dbPath: string; repoPath: string } {
    const harnessRoot = mkdtempSync(join(tmpdir(), "harness-orch-coder-"));
    mkdirSync(join(harnessRoot, "policies/repos"), { recursive: true });
    mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
    writeFileSync(
      join(harnessRoot, "policies/global.yaml"),
      "always_deny_write: []\nignore_untracked: []\n",
    );
    writeFileSync(
      join(harnessRoot, "policies/repos/t.yaml"),
      [
        "repo_id: t",
        "read: []",
        "domains:",
        "  apps/user:",
        "    read: [apps/user/**]",
        "    write: [apps/user/**]",
        "    deny_write: []",
        "",
      ].join("\n"),
    );
    const repoPath = mkdtempSync(join(tmpdir(), "harness-orch-coder-target-"));
    const g = (a: string[]) =>
      execFileSync("git", a, { cwd: repoPath, stdio: "ignore" });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@e.com"]);
    g(["config", "user.name", "T"]);
    mkdirSync(join(repoPath, "apps/user/src"), { recursive: true });
    writeFileSync(join(repoPath, "apps/user/src/profile.ts"), "export const x = 0;\n");
    g(["add", "."]);
    g(["commit", "-qm", "init"]);
    return { harnessRoot, dbPath: join(harnessRoot, ".harness", "harness.sqlite"), repoPath };
  }

  it("records a failed attempt carrying the runId when the run finalizes as failed", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      new HitchRepository(db).createSession({
        hitchId: "g-fail",
        title: "Fail",
        projectId: null,
        repoId: "t",
        domain: "apps/user",
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      // pre-seed a coding attempt so the gate sees needs_fix? No — a fresh
      // goal is `continue` and run.start is denied. Seed an open in-scope P1
      // finding so the goal is `needs_fix` and the gate permits run.start.
      const repo = new HitchRepository(db);
      repo.upsertFinding({
        hitchId: "g-fail",
        source: "review",
        severity: "P1",
        category: "bug",
        scopeStatus: "in_scope",
        summary: "fix the thing",
      });
    } finally {
      close();
    }

    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "fix the thing",
      baseBranch: "main",
    });
    // a codex runner that throws AFTER the run log is created → runDomainCoding
    // finalizes the run as failed-internal-error and rethrows RunFinalizedError
    // carrying the runId.
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async () => {
          throw new Error("codex exploded");
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });

    await expect(runners.coder("g-fail")).rejects.toThrow(/codex exploded/);

    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      const attempts = new HitchRepository(db2).listAttempts("g-fail");
      const failed = attempts.find((a) => a.status === "failed");
      expect(failed).toBeDefined();
      expect(failed?.attemptType).toBe("implement");
      // the failed attempt carries the finalized run's id (RunFinalizedError).
      expect(failed?.runId).toMatch(/^run-/);
      expect(failed?.errorMessage).toMatch(/codex exploded/);
    } finally {
      close2();
    }
  });

  it("does not consume an attempt when the domain lock is busy", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId: "g-lock-busy",
        title: "Busy",
        projectId: null,
        repoId: "t",
        domain: "apps/user",
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
      });
      repo.upsertFinding({
        hitchId: "g-lock-busy",
        source: "review",
        severity: "P1",
        category: "bug",
        scopeStatus: "in_scope",
        summary: "fix the thing",
      });
      acquireDomainLock(db, {
        domainKey: "t::apps/user",
        repoId: "t",
        domain: "apps/user",
        runId: "holder",
        pid: process.pid,
        hostname: "test-host",
      });
    } finally {
      close();
    }

    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "fix the thing",
      baseBranch: "main",
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });

    await expect(runners.coder("g-lock-busy")).rejects.toBeInstanceOf(
      DomainLockBusyError,
    );

    const { db: db2, close: close2 } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db2);
      expect(repo.listAttempts("g-lock-busy")).toEqual([]);
      expect(repo.requireSession("g-lock-busy").currentIteration).toBe(0);
    } finally {
      close2();
    }
  });

  it("does not consume an attempt when a finalized run has a nested lease guard cause", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        repo.createSession({
          hitchId: "g-lease-finalized",
          title: "Lease finalized",
          projectId: null,
          repoId: "t",
          domain: "apps/user",
          closeConditions: [{ id: "tc", kind: "command", required: true }],
          createdBy: "test",
          createdSource: "worker",
        });
        repo.upsertFinding({
          hitchId: "g-lease-finalized",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "in_scope",
          summary: "fix the thing",
        });
      } finally {
        close();
      }
    }

    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "fix the thing",
      baseBranch: "main",
    });
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async () => {
          throw new Error("outer wrapper", {
            cause: new LeaseGuardFailedError("run-stale"),
          });
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });

    await expect(runners.coder("g-lease-finalized")).rejects.toBeInstanceOf(
      LeaseGuardFailedError,
    );

    const { db, close } = openManagedDb({ dbPath });
    try {
      const repo = new HitchRepository(db);
      expect(repo.listAttempts("g-lease-finalized")).toEqual([]);
      expect(repo.requireSession("g-lease-finalized").currentIteration).toBe(0);
    } finally {
      close();
    }
  });

  it("injects open in-scope findings into the coder goal on a rerun", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        repo.createSession({
          hitchId: "g-inject",
          title: "Inject",
          projectId: null,
          repoId: "t",
          domain: "apps/user",
          closeConditions: [{ id: "tc", kind: "command", required: true }],
          createdBy: "test",
          createdSource: "worker",
        });
        // a prior coding attempt → this run is a "rerun"
        repo.createAttempt({
          hitchId: "g-inject",
          attemptType: "implement",
          status: "succeeded",
          runId: "run-prior",
        });
        // the prior attempt was reviewed (the finding below came from it) so
        // convergence stays needs_fix rather than routing to a pending review
        // (#104).
        const ic = repo.startReviewCycle({
          hitchId: "g-inject",
          cycleNumber: 1,
          reviewMode: "initial",
        });
        repo.completeReviewCycle({ cycleId: ic.cycleId, findingsNew: 1 });
        // an open in-scope finding the rerun must address (also makes the goal
        // needs_fix so the run.start gate permits the coder).
        repo.upsertFinding({
          hitchId: "g-inject",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "in_scope",
          summary: "missing null check in profile loader",
        });
      } finally {
        close();
      }
    }
    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "improve the profile feature",
      baseBranch: "main",
    });
    let captured = "";
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async (input) => {
          captured = input.prompt;
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });
    await runners.coder("g-inject");
    expect(captured).toContain("improve the profile feature");
    expect(captured).toContain("Open in-scope findings to address");
    expect(captured).toContain("missing null check in profile loader");
  });

  it("forwards deps.signal end-to-end to the coder codex run (#132 plumbing)", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        repo.createSession({
          hitchId: "g-signal",
          title: "Signal",
          projectId: null,
          repoId: "t",
          domain: "apps/user",
          closeConditions: [{ id: "tc", kind: "command", required: true }],
          createdBy: "test",
          createdSource: "worker",
        });
        repo.upsertFinding({
          hitchId: "g-signal",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "in_scope",
          summary: "permits the coder gate",
        });
      } finally {
        close();
      }
    }
    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "improve the profile feature",
      baseBranch: "main",
    });
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined | "absent" = "absent";
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      signal: controller.signal,
      coderRunner: {
        run: async (input) => {
          capturedSignal = input.signal;
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });
    await runners.coder("g-signal");
    // The exact run-scoped signal must reach codexRunner.run through
    // createOrchestratorRunners → runDomainCoding (a dropped/typo'd spread ships green otherwise).
    expect(capturedSignal).toBe(controller.signal);
  });

  it("does NOT inject the findings block on the first implement pass", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        repo.createSession({
          hitchId: "g-first",
          title: "First",
          projectId: null,
          repoId: "t",
          domain: "apps/user",
          closeConditions: [{ id: "tc", kind: "command", required: true }],
          createdBy: "test",
          createdSource: "worker",
        });
        // an open in-scope finding (so run.start is permitted) but NO prior
        // coding attempt → this is the first `implement` pass, no injection.
        repo.upsertFinding({
          hitchId: "g-first",
          source: "review",
          severity: "P1",
          category: "bug",
          scopeStatus: "in_scope",
          summary: "should not be injected on first pass",
        });
      } finally {
        close();
      }
    }
    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "improve the profile feature",
      baseBranch: "main",
    });
    let captured = "";
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async (input) => {
          captured = input.prompt;
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });
    await runners.coder("g-first");
    expect(captured).toContain("improve the profile feature");
    expect(captured).not.toContain("Open in-scope findings to address");
    expect(captured).not.toContain("should not be injected on first pass");
  });

  it("injects the previous run's failure status into the coder goal on a recovery rerun", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        repo.createSession({
          hitchId: "g-recover",
          title: "Recover",
          projectId: null,
          repoId: "t",
          domain: "apps/user",
          closeConditions: [{ id: "tc", kind: "command", required: true }],
          createdBy: "test",
          createdSource: "worker",
        });
        // a prior coding attempt that FAILED before review (failed-command) →
        // convergence routes to a rerun, and the coder injects the failure.
        const failed = repo.createAttempt({
          hitchId: "g-recover",
          attemptType: "implement",
          status: "running",
        });
        repo.completeAttempt({
          attemptId: failed.attemptId,
          status: "failed",
          runId: "run-failed-cmd",
          result: { runStatus: "failed-command" },
        });
      } finally {
        close();
      }
    }
    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "improve the profile feature",
      baseBranch: "main",
    });
    let captured = "";
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async (input) => {
          captured = input.prompt;
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });
    await runners.coder("g-recover");
    expect(captured).toContain("improve the profile feature");
    expect(captured).toContain("Previous attempt failed");
    expect(captured).toContain("failed-command");
  });

  it("injects failed close-check command output into the coder goal", async () => {
    const { harnessRoot, dbPath, repoPath } = setupHarness();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        runMigrations(db);
        const repo = new HitchRepository(db);
        repo.createSession({
          hitchId: "g-close-fail-context",
          title: "Close check context",
          projectId: null,
          repoId: "t",
          domain: "apps/user",
          closeConditions: [
            { id: "typecheck", kind: "command", required: true },
          ],
          createdBy: "test",
          createdSource: "worker",
        });
        repo.createAttempt({
          hitchId: "g-close-fail-context",
          attemptType: "implement",
          status: "succeeded",
          runId: "run-reviewed",
          createdAt: "2026-06-13T00:00:00.000Z",
        });
        const cycle = repo.startReviewCycle({
          hitchId: "g-close-fail-context",
          cycleNumber: 1,
          reviewMode: "initial",
          createdAt: "2026-06-13T00:01:00.000Z",
        });
        repo.completeReviewCycle({
          cycleId: cycle.cycleId,
          completedAt: "2026-06-13T00:01:10.000Z",
        });
        repo.recordCloseCheck({
          hitchId: "g-close-fail-context",
          conditionId: "typecheck",
          status: "failed",
          checkedBy: "worker",
          checkedAt: "2026-06-13T00:02:00.000Z",
          evidence: {
            conditionKind: "command",
            command: "npm run typecheck",
            exitCode: 2,
            timedOut: false,
            stdoutTail: "stdout from tsc",
            stderrTail: "stderr from tsc",
          },
          message: "command close-check failed",
        });
      } finally {
        close();
      }
    }
    const resolveRunContext = (): HitchRunContext => ({
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "improve the profile feature",
      baseBranch: "main",
    });
    let captured = "";
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: {
        run: async (input) => {
          captured = input.prompt;
          return { exitCode: 0, timedOut: false, durationMs: 0 };
        },
      },
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext,
    });

    await runners.coder("g-close-fail-context");

    expect(captured).toContain("Failed close-check evidence to address");
    expect(captured).toContain("typecheck");
    expect(captured).toContain("npm run typecheck");
    expect(captured).toContain("stdout from tsc");
    expect(captured).toContain("stderr from tsc");
  });
});

describe("createOrchestratorRunners.closeAndPr (adopted PR guard)", () => {
  function recordingPublisher(): PrPublisher & { calls: PrPublishInputs[] } {
    const calls: PrPublishInputs[] = [];
    return {
      calls,
      async publish(inputs: PrPublishInputs) {
        calls.push(inputs);
        return { url: "https://github.com/acme/repo/pull/99", number: 99 };
      },
    };
  }

  it("refuses closeAndPr (the shared auto-merge path) for a hitch with an adopted PR", async () => {
    const dbPath = createRunnerTestDb("orch-adopted-");
    const publisher = recordingPublisher();
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      createBasicHitch(repo, "goal-adopted");
      // operator takeover: adopt an external PR (audit/status-only)
      repo.adoptPr({
        hitchId: "goal-adopted",
        prNumber: 7,
        reason: "took over; replaced the orchestrate PR with a new one",
        createdBy: "operator",
      });
    } finally {
      close();
    }

    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot: dbPath,
      createdBy: "worker",
      coderRunner: {
        run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }),
      },
      reviewerRunner: {
        run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }),
      },
      publisher,
      autoMerge: { merger: { async merge() {
        throw new Error("merge must not be reached for an adopted-PR hitch");
      } } },
    });

    // the guard must fire before any PR create/merge side effect, regardless of
    // convergence state — adopted PRs are human-merge only.
    await expect(runners.closeAndPr("goal-adopted")).rejects.toBeInstanceOf(
      HitchHasAdoptedPrError,
    );
    expect(publisher.calls).toHaveLength(0);
  });
});

describe("createOrchestratorRunners.coder rerun continuation (#163)", () => {
  // A real target repo + harness root (the continuation reads the parent run's
  // worktree under workspaces/<id>/repo and the run policy from the files).
  function setupContinuationHarness(): {
    harnessRoot: string;
    dbPath: string;
    repoPath: string;
  } {
    const harnessRoot = mkdtempSync(join(tmpdir(), "harness-orch-cont-"));
    mkdirSync(join(harnessRoot, "policies/repos"), { recursive: true });
    mkdirSync(join(harnessRoot, ".harness"), { recursive: true });
    writeFileSync(
      join(harnessRoot, "policies/global.yaml"),
      "always_deny_write: []\nignore_untracked: []\n",
    );
    writeFileSync(
      join(harnessRoot, "policies/repos/t.yaml"),
      [
        "repo_id: t",
        "read: []",
        "domains:",
        "  apps/user:",
        "    read: [apps/user/**]",
        "    write: [apps/user/**]",
        "    deny_write: []",
        "",
      ].join("\n"),
    );
    const repoPath = mkdtempSync(join(tmpdir(), "harness-orch-cont-target-"));
    const g = (a: string[]) =>
      execFileSync("git", a, { cwd: repoPath, stdio: "ignore" });
    g(["init", "-q", "-b", "main"]);
    g(["config", "user.email", "t@e.com"]);
    g(["config", "user.name", "T"]);
    mkdirSync(join(repoPath, "apps/user/src"), { recursive: true });
    writeFileSync(
      join(repoPath, "apps/user/src/profile.ts"),
      "export const x = 0;\n",
    );
    g(["add", "."]);
    g(["commit", "-qm", "init"]);
    return {
      harnessRoot,
      dbPath: join(harnessRoot, ".harness", "harness.sqlite"),
      repoPath,
    };
  }

  // Seed a hitch with an open in-scope P1 finding (so convergence routes to
  // needs_fix → fix_findings, permitting the coder) and generous budgets so a
  // multi-rerun sequence is not stopped by budget_exhausted.
  function seedFixableHitch(dbPath: string, hitchId: string): void {
    const { db, close } = openManagedDb({ dbPath });
    try {
      runMigrations(db);
      const repo = new HitchRepository(db);
      repo.createSession({
        hitchId,
        title: "Continue parent work",
        projectId: null,
        repoId: "t",
        domain: "apps/user",
        closeConditions: [{ id: "tc", kind: "command", required: true }],
        createdBy: "test",
        createdSource: "worker",
        maxIterations: 20,
        maxReviewCycles: 20,
        maxReruns: 20,
      });
      repo.upsertFinding({
        hitchId,
        source: "review",
        severity: "P1",
        category: "bug",
        scopeStatus: "in_scope",
        summary: "keep fixing the profile",
      });
    } finally {
      close();
    }
  }

  // A codex runner that writes `file` with `content` into the worktree and then
  // EXITS NON-ZERO. A failed-codex run keeps its worktree (with the carried
  // parent work + this edit), and convergence routes the next pass to a coder
  // rerun (latestCodingFailed → needs_fix) — so we can drive R1→R2→R3 through
  // the real mutation gate without a review cycle between each.
  function failingEditRunner(
    edits: () => { file: string; content: string },
  ): { run: (input: { worktreePath: string; logPaths: { stdout: string; stderr: string; events: string } }) => Promise<{ exitCode: number; timedOut: boolean; durationMs: number }> } {
    return {
      run: async (input) => {
        const { file, content } = edits();
        writeFileSync(join(input.worktreePath, file), content);
        writeFileSync(input.logPaths.stdout, "", "utf8");
        writeFileSync(input.logPaths.stderr, "boom\n", "utf8");
        writeFileSync(input.logPaths.events, "", "utf8");
        return { exitCode: 1, timedOut: false, durationMs: 1 };
      },
    };
  }

  // A codex runner that writes an IN-SCOPE `file` with `content` and EXITS 0.
  // An exit-0 run whose changes pass policy validation finalizes as
  // `needs_review` — a POLICY-VALIDATED parent the continuation may carry (the
  // failed-codex runner above is NOT validated and is skipped by the gate).
  function succeedingEditRunner(
    edits: () => { file: string; content: string },
  ): { run: (input: { worktreePath: string; logPaths: { stdout: string; stderr: string; events: string } }) => Promise<{ exitCode: number; timedOut: boolean; durationMs: number }> } {
    return {
      run: async (input) => {
        const { file, content } = edits();
        writeFileSync(join(input.worktreePath, file), content);
        writeFileSync(input.logPaths.stdout, "done\n", "utf8");
        writeFileSync(input.logPaths.stderr, "", "utf8");
        writeFileSync(input.logPaths.events, "", "utf8");
        return { exitCode: 0, timedOut: false, durationMs: 1 };
      },
    };
  }

  function runContext(repoPath: string): HitchRunContext {
    return {
      repoPath,
      repoId: "t",
      domain: "apps/user",
      goal: "improve the profile feature",
      baseBranch: "main",
    };
  }

  function worktreeOf(harnessRoot: string, runId: string): string {
    return join(harnessRoot, "workspaces", runId, "repo");
  }

  function runRow(
    dbPath: string,
    runId: string,
  ): { rootRunId: string | null; rerunAttempt: number | null; parentRunId: string | null } {
    const { db, close } = openManagedDb({ dbPath });
    try {
      const r = db
        .prepare(
          "SELECT root_run_id, rerun_attempt, parent_run_id FROM runs WHERE run_id = ?",
        )
        .get(runId) as
        | { root_run_id: string | null; rerun_attempt: number | null; parent_run_id: string | null }
        | undefined;
      return {
        rootRunId: r?.root_run_id ?? null,
        rerunAttempt: r?.rerun_attempt ?? null,
        parentRunId: r?.parent_run_id ?? null,
      };
    } finally {
      close();
    }
  }

  it("SEQUENTIAL chain R1→R2→R3: a validated chain's CUMULATIVE work is carried into the live rerun + lineage (root stays R1, attempt increments), no escalation", async () => {
    // The convergence gate blocks a fresh coder run after a `needs_review` run
    // (review first), so a live R1→R2→R3 cannot be driven through the coder
    // alone. Instead seed a VALIDATED chain — R1 (`changes_requested`, root) ←
    // R2 (`changes_requested`, child of R1) — whose R2 worktree holds the
    // CUMULATIVE work (pass-1 + pass-2), then drive ONE live coder rerun (R3).
    // R3 must CONTINUE from the validated R2: carry the cumulative state + add
    // its own, with correct lineage and no escalation/dup-fence trip.
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-seq");
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .toString()
      .trim();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        const repo = new HitchRepository(db);
        const insertRun = (runId: string, parent: string | null, root: string | null, attempt: number | null) =>
          db
            .prepare(
              `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
                 base_sha, run_branch, status, source_mode, db_revision,
                 export_status, updated_at, parent_run_id, root_run_id,
                 rerun_attempt, meta_json)
               VALUES (?, 't', 'apps/user', 'domain-coding', 'main', ?, ?,
                 'changes_requested', 'db-first', 1, 'disabled',
                 '2026-06-13T00:00:00.000Z', ?, ?, ?, ?)`,
            )
            .run(
              runId,
              baseSha,
              `run/${runId}/apps-user`,
              parent,
              root,
              attempt,
              JSON.stringify({ runId, status: "changes_requested" }),
            );
        insertRun("run-R1", null, null, null); // root
        insertRun("run-R2", "run-R1", "run-R1", 1); // first rerun of R1
        repo.createAttempt({ hitchId: "g-seq", attemptType: "implement", status: "succeeded", runId: "run-R1" });
        // R2's ATTEMPT is marked failed so convergence routes to needs_fix (the
        // coder is permitted again) while R2's RUN-ROW status stays the VALIDATED
        // `changes_requested` — the continuation carries from the row status,
        // independent of the attempt's convergence routing.
        repo.createAttempt({ hitchId: "g-seq", attemptType: "rerun", status: "failed", runId: "run-R2" });
      } finally {
        close();
      }
    }
    // R2's worktree holds the CUMULATIVE work of the chain (pass-1 + pass-2).
    mkdirSync(join(harnessRoot, "workspaces", "run-R2"), { recursive: true });
    execFileSync(
      "git",
      ["worktree", "add", "-q", "--detach", worktreeOf(harnessRoot, "run-R2"), baseSha],
      { cwd: repoPath },
    );
    writeFileSync(join(worktreeOf(harnessRoot, "run-R2"), "apps/user/src/pass-1.ts"), "export const p = 1;\n");
    writeFileSync(join(worktreeOf(harnessRoot, "run-R2"), "apps/user/src/pass-2.ts"), "export const p = 2;\n");

    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: succeedingEditRunner(() => ({
        file: "apps/user/src/pass-3.ts",
        content: "export const p = 3;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    const r3 = await runners.coder("g-seq"); // live rerun, continues R2
    expect(r3.runId).toMatch(/^run-/); // no escalation / RerunGateError

    // Cumulative carry: the R3 worktree contains R1's AND R2's edits (carried
    // forward via R2's worktree as uncommitted state) plus R3's own edit.
    const wt3 = worktreeOf(harnessRoot, r3.runId);
    expect(readFileSync(join(wt3, "apps/user/src/pass-1.ts"), "utf8")).toBe("export const p = 1;\n");
    expect(readFileSync(join(wt3, "apps/user/src/pass-2.ts"), "utf8")).toBe("export const p = 2;\n");
    expect(readFileSync(join(wt3, "apps/user/src/pass-3.ts"), "utf8")).toBe("export const p = 3;\n");

    // Lineage: root stays R1; rerunAttempt increments (R2=1 → R3=2); parent=R2.
    const row3 = runRow(dbPath, r3.runId);
    expect(row3.rootRunId).toBe("run-R1");
    expect(row3.rerunAttempt).toBe(2);
    expect(row3.parentRunId).toBe("run-R2");

    // No new commit on the R3 run branch — its tip stayed at base.
    const { db, close } = openManagedDb({ dbPath });
    try {
      const branch = (
        db.prepare("SELECT run_branch FROM runs WHERE run_id = ?").get(r3.runId) as
          | { run_branch: string }
          | undefined
      )?.run_branch;
      expect(branch).toBeDefined();
      const tip = execFileSync("git", ["rev-parse", branch as string], {
        cwd: repoPath,
      })
        .toString()
        .trim();
      expect(tip).toBe(baseSha);
    } finally {
      close();
    }
  });

  it("LINEAGE legacy-root: a parent rerun row with parentRunId but no rootRunId → child rootRunId via chain-walk (not parent.runId)", async () => {
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-legacy");
    // Seed a legacy chain in the DB: original O ← legacy rerun L (parentRunId=O,
    // NO root_run_id). The next coder rerun's parent is L; its rootRunId must be
    // derived by walking L→O = O, NOT defaulted to L.runId.
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .toString()
      .trim();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        const repo = new HitchRepository(db);
        const insertRun = (runId: string, parent: string | null, attempt: number | null) =>
          db
            .prepare(
              `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
                 base_sha, run_branch, status, source_mode, db_revision,
                 export_status, updated_at, parent_run_id, root_run_id,
                 rerun_attempt, meta_json)
               VALUES (?, 't', 'apps/user', 'domain-coding', 'main', ?, ?,
                 'changes_requested', 'db-first', 1, 'disabled',
                 '2026-06-13T00:00:00.000Z', ?, NULL, ?, ?)`,
            )
            .run(
              runId,
              baseSha,
              `run/${runId}/apps-user`,
              parent,
              attempt,
              JSON.stringify({ runId, status: "changes_requested" }),
            );
        insertRun("run-O", null, null);
        // legacy rerun: has parent_run_id but NO root_run_id (NULL above).
        insertRun("run-L", "run-O", 1);
        repo.createAttempt({
          hitchId: "g-legacy",
          attemptType: "implement",
          status: "succeeded",
          runId: "run-O",
        });
        repo.createAttempt({
          hitchId: "g-legacy",
          attemptType: "rerun",
          status: "failed",
          runId: "run-L",
        });
      } finally {
        close();
      }
    }
    // Create L's worktree so the continuation can read it (base == fresh base).
    mkdirSync(join(harnessRoot, "workspaces", "run-L"), { recursive: true });
    execFileSync(
      "git",
      ["worktree", "add", "-q", "--detach", worktreeOf(harnessRoot, "run-L"), baseSha],
      { cwd: repoPath },
    );
    writeFileSync(
      join(worktreeOf(harnessRoot, "run-L"), "apps/user/src/legacy.ts"),
      "export const l = 1;\n",
    );

    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: failingEditRunner(() => ({
        file: "apps/user/src/child.ts",
        content: "export const c = 1;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    const child = await runners.coder("g-legacy");
    const row = runRow(dbPath, child.runId);
    // chain-walk: L→O ⇒ root is O, NOT L (the legacy parent's own runId).
    expect(row.rootRunId).toBe("run-O");
    expect(row.rerunAttempt).toBe(2); // (L.rerunAttempt=1) + 1
    // continuation carried L's uncommitted work into the child worktree.
    expect(
      readFileSync(join(worktreeOf(harnessRoot, child.runId), "apps/user/src/legacy.ts"), "utf8"),
    ).toBe("export const l = 1;\n");
  });

  it("FALLBACK base_advanced: the parent's base != fresh base → fresh-from-base + recorded reason, no throw, no carry", async () => {
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-advanced");
    // Seed a prior coding run pinned to a STALE base sha (not the repo HEAD),
    // with a worktree holding work that must NOT be carried once the base moved.
    const staleBase = "0".repeat(40);
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        const repo = new HitchRepository(db);
        db.prepare(
          `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
             base_sha, run_branch, status, source_mode, db_revision,
             export_status, updated_at, meta_json)
           VALUES ('run-stale', 't', 'apps/user', 'domain-coding', 'main', ?,
             'run/run-stale/apps-user', 'changes_requested', 'db-first', 1,
             'disabled', '2026-06-13T00:00:00.000Z', ?)`,
        ).run(staleBase, JSON.stringify({ runId: "run-stale", status: "changes_requested" }));
        repo.createAttempt({
          hitchId: "g-advanced",
          attemptType: "implement",
          status: "failed",
          runId: "run-stale",
        });
      } finally {
        close();
      }
    }
    // give run-stale a worktree (off the real HEAD) with carry-worthy work.
    const realBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .toString()
      .trim();
    mkdirSync(join(harnessRoot, "workspaces", "run-stale"), { recursive: true });
    execFileSync(
      "git",
      ["worktree", "add", "-q", "--detach", worktreeOf(harnessRoot, "run-stale"), realBase],
      { cwd: repoPath },
    );
    writeFileSync(
      join(worktreeOf(harnessRoot, "run-stale"), "apps/user/src/stale.ts"),
      "export const s = 1;\n",
    );

    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: failingEditRunner(() => ({
        file: "apps/user/src/fresh.ts",
        content: "export const f = 1;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    const child = await runners.coder("g-advanced");
    expect(child.runId).toMatch(/^run-/);
    const childWt = worktreeOf(harnessRoot, child.runId);
    // fresh-from-base: the parent's stale work is NOT carried.
    expect(existsSync(join(childWt, "apps/user/src/stale.ts"))).toBe(false);
    expect(readFileSync(join(childWt, "apps/user/src/fresh.ts"), "utf8")).toBe(
      "export const f = 1;\n",
    );
    // the skip reason is recorded as a continuation_skipped run event.
    const events = readFileSync(
      join(harnessRoot, "runs", child.runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; reason?: string });
    const skip = events.find((e) => e.type === "continuation_skipped");
    expect(skip?.reason).toBe("base_advanced");
  });

  it("FALLBACK parent_work_unavailable: the parent worktree was cleaned → fresh-from-base + recorded reason", async () => {
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-cleaned");
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .toString()
      .trim();
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        const repo = new HitchRepository(db);
        db.prepare(
          `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
             base_sha, run_branch, status, source_mode, db_revision,
             export_status, updated_at, meta_json)
           VALUES ('run-cleaned', 't', 'apps/user', 'domain-coding', 'main', ?,
             'run/run-cleaned/apps-user', 'changes_requested', 'db-first', 1,
             'disabled', '2026-06-13T00:00:00.000Z', ?)`,
        ).run(baseSha, JSON.stringify({ runId: "run-cleaned", status: "changes_requested" }));
        repo.createAttempt({
          hitchId: "g-cleaned",
          attemptType: "implement",
          status: "failed",
          runId: "run-cleaned",
        });
        // NOTE: no worktree created under workspaces/run-cleaned — simulating a
        // cleaned parent.
      } finally {
        close();
      }
    }
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: failingEditRunner(() => ({
        file: "apps/user/src/fresh.ts",
        content: "export const f = 1;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    const child = await runners.coder("g-cleaned");
    const events = readFileSync(
      join(harnessRoot, "runs", child.runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; reason?: string });
    const skip = events.find((e) => e.type === "continuation_skipped");
    expect(skip?.reason).toBe("parent_work_unavailable");
    expect(
      readFileSync(join(worktreeOf(harnessRoot, child.runId), "apps/user/src/fresh.ts"), "utf8"),
    ).toBe("export const f = 1;\n");
  });

  it("first implement pass does not attempt continuation (no skip / no materialize event)", async () => {
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-first-pass");
    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: failingEditRunner(() => ({
        file: "apps/user/src/first.ts",
        content: "export const f = 1;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    const r = await runners.coder("g-first-pass");
    const events = readFileSync(
      join(harnessRoot, "runs", r.runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    const types = events.map((e) => e.type);
    expect(types).not.toContain("continuation_materialized");
    expect(types).not.toContain("continuation_skipped");
  });

  // Seed a single parent coding run row + a failed coding attempt (so
  // convergence routes to needs_fix and the coder is permitted) + a worktree
  // holding carry-worthy work. `status` controls the validated-parent gate.
  function seedParentRun(opts: {
    dbPath: string;
    harnessRoot: string;
    repoPath: string;
    hitchId: string;
    runId: string;
    status: string;
    safetyStatus?: string | null;
    baseSha: string;
    work?: { file: string; content: string };
    parentRunId?: string | null;
    rootRunId?: string | null;
    rerunAttempt?: number | null;
  }): void {
    const { db, close } = openManagedDb({ dbPath: opts.dbPath });
    try {
      const repo = new HitchRepository(db);
      db.prepare(
        `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
           base_sha, run_branch, status, safety_status, source_mode, db_revision,
           export_status, updated_at, parent_run_id, root_run_id,
           rerun_attempt, meta_json)
         VALUES (?, 't', 'apps/user', 'domain-coding', 'main', ?, ?, ?, ?,
           'db-first', 1, 'disabled', '2026-06-13T00:00:00.000Z', ?, ?, ?, ?)`,
      ).run(
        opts.runId,
        opts.baseSha,
        `run/${opts.runId}/apps-user`,
        opts.status,
        opts.safetyStatus ?? null,
        opts.parentRunId ?? null,
        opts.rootRunId ?? null,
        opts.rerunAttempt ?? null,
        JSON.stringify({
          runId: opts.runId,
          status: opts.status,
          ...(opts.safetyStatus !== undefined
            ? { safetyStatus: opts.safetyStatus }
            : {}),
        }),
      );
      repo.createAttempt({
        hitchId: opts.hitchId,
        attemptType: "implement",
        status: "failed",
        runId: opts.runId,
      });
    } finally {
      close();
    }
    if (opts.work !== undefined) {
      mkdirSync(join(opts.harnessRoot, "workspaces", opts.runId), { recursive: true });
      execFileSync(
        "git",
        ["worktree", "add", "-q", "--detach", worktreeOf(opts.harnessRoot, opts.runId), opts.baseSha],
        { cwd: opts.repoPath },
      );
      writeFileSync(
        join(worktreeOf(opts.harnessRoot, opts.runId), opts.work.file),
        opts.work.content,
      );
    }
  }

  it("FALLBACK parent_not_validated (P1): a failed-policy-violation parent → fresh-from-base, its forbidden work is NOT carried + reason recorded", async () => {
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-notvalidated");
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .toString()
      .trim();
    // Parent FAILED policy: its worktree holds an out-of-scope file that a
    // fresh-from-base rerun would omit. The validated gate must NOT carry it.
    seedParentRun({
      dbPath,
      harnessRoot,
      repoPath,
      hitchId: "g-notvalidated",
      runId: "run-badpolicy",
      status: "failed-policy-violation",
      baseSha,
      work: { file: "apps/user/src/forbidden.ts", content: "export const bad = 1;\n" },
    });

    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: failingEditRunner(() => ({
        file: "apps/user/src/fresh.ts",
        content: "export const f = 1;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    const child = await runners.coder("g-notvalidated");
    expect(child.runId).toMatch(/^run-/); // no escalation
    const childWt = worktreeOf(harnessRoot, child.runId);
    // fresh-from-base: the parent's forbidden out-of-scope file is NOT carried.
    expect(existsSync(join(childWt, "apps/user/src/forbidden.ts"))).toBe(false);
    expect(readFileSync(join(childWt, "apps/user/src/fresh.ts"), "utf8")).toBe(
      "export const f = 1;\n",
    );
    // the skip reason is recorded.
    const events = readFileSync(
      join(harnessRoot, "runs", child.runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; reason?: string });
    expect(events.find((e) => e.type === "continuation_skipped")?.reason).toBe(
      "parent_not_validated",
    );
  });

  it("FAILED-COMMAND allowed parent: recovery rerun materializes the validated parent work", async () => {
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-failed-command-allowed");
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .toString()
      .trim();
    seedParentRun({
      dbPath,
      harnessRoot,
      repoPath,
      hitchId: "g-failed-command-allowed",
      runId: "run-command-failed",
      status: "failed-command",
      safetyStatus: "allowed",
      baseSha,
      work: { file: "apps/user/src/carry.ts", content: "export const c = 1;\n" },
    });

    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: succeedingEditRunner(() => ({
        file: "apps/user/src/fresh.ts",
        content: "export const f = 1;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    const child = await runners.coder("g-failed-command-allowed");
    const childWt = worktreeOf(harnessRoot, child.runId);
    expect(readFileSync(join(childWt, "apps/user/src/carry.ts"), "utf8")).toBe(
      "export const c = 1;\n",
    );
    expect(readFileSync(join(childWt, "apps/user/src/fresh.ts"), "utf8")).toBe(
      "export const f = 1;\n",
    );
    const events = readFileSync(
      join(harnessRoot, "runs", child.runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; paths?: string[] });
    expect(events.find((e) => e.type === "continuation_materialized")?.paths).toEqual(
      expect.arrayContaining(["apps/user/src/carry.ts"]),
    );
    expect(events.map((e) => e.type)).not.toContain("continuation_skipped");
  });

  it("FAILED-COMMAND without allowed safety status: recovery rerun skips parent work", async () => {
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-failed-command-unknown-safety");
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .toString()
      .trim();
    seedParentRun({
      dbPath,
      harnessRoot,
      repoPath,
      hitchId: "g-failed-command-unknown-safety",
      runId: "run-command-unknown-safety",
      status: "failed-command",
      baseSha,
      work: { file: "apps/user/src/carry.ts", content: "export const c = 1;\n" },
    });

    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: succeedingEditRunner(() => ({
        file: "apps/user/src/fresh.ts",
        content: "export const f = 1;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    const child = await runners.coder("g-failed-command-unknown-safety");
    const childWt = worktreeOf(harnessRoot, child.runId);
    expect(existsSync(join(childWt, "apps/user/src/carry.ts"))).toBe(false);
    expect(readFileSync(join(childWt, "apps/user/src/fresh.ts"), "utf8")).toBe(
      "export const f = 1;\n",
    );
    const events = readFileSync(
      join(harnessRoot, "runs", child.runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; reason?: string });
    expect(events.find((e) => e.type === "continuation_skipped")?.reason).toBe(
      "parent_not_validated",
    );
  });

  it("LINEAGE on SKIP (P2): a skipped continuation still records parent_run_id / root / attempt (never a new root)", async () => {
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-skip-lineage");
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .toString()
      .trim();
    // Validated parent (changes_requested) whose WORKTREE is absent → the
    // continuation is SKIPPED (parent_work_unavailable). Lineage must still be
    // recorded so the fresh-from-base child stays in the chain.
    seedParentRun({
      dbPath,
      harnessRoot,
      repoPath,
      hitchId: "g-skip-lineage",
      runId: "run-parent",
      status: "changes_requested",
      baseSha,
      rerunAttempt: 2,
      // NO `work` → no worktree → parent_work_unavailable skip.
    });

    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: failingEditRunner(() => ({
        file: "apps/user/src/fresh.ts",
        content: "export const f = 1;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    const child = await runners.coder("g-skip-lineage");
    const row = runRow(dbPath, child.runId);
    // Lineage recorded despite the skip: parent + chain root + incremented attempt.
    expect(row.parentRunId).toBe("run-parent");
    expect(row.rootRunId).toBe("run-parent"); // parent had no parentRunId → it is the root
    expect(row.rerunAttempt).toBe(3); // parent attempt 2 + 1
    // It was indeed a skip (fresh-from-base), not a materialized carry.
    const events = readFileSync(
      join(harnessRoot, "runs", child.runId, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; reason?: string });
    expect(events.find((e) => e.type === "continuation_skipped")?.reason).toBe(
      "parent_work_unavailable",
    );
  });

  it("DUP-FENCE (P2): a continuation parent that already has a child → the second rerun is fenced (RerunGateError), one child per parent", async () => {
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-dupfence");
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .toString()
      .trim();
    // Validated parent with a worktree (continuation would materialize).
    seedParentRun({
      dbPath,
      harnessRoot,
      repoPath,
      hitchId: "g-dupfence",
      runId: "run-dupparent",
      status: "changes_requested",
      baseSha,
      work: { file: "apps/user/src/carry.ts", content: "export const c = 1;\n" },
    });
    // Pre-existing child of run-dupparent (simulating a concurrent rerun that
    // already created the one allowed child) — its parent_run_id = run-dupparent.
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        db.prepare(
          `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
             base_sha, run_branch, status, source_mode, db_revision,
             export_status, updated_at, parent_run_id, root_run_id,
             rerun_attempt, meta_json)
           VALUES ('run-existingchild', 't', 'apps/user', 'domain-coding', 'main',
             ?, 'run/run-existingchild/apps-user', 'running', 'db-first', 1,
             'disabled', '2026-06-13T00:00:00.000Z', 'run-dupparent', 'run-dupparent',
             1, ?)`,
        ).run(baseSha, JSON.stringify({ runId: "run-existingchild" }));
      } finally {
        close();
      }
    }

    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: failingEditRunner(() => ({
        file: "apps/user/src/fresh.ts",
        content: "export const f = 1;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    // The continuation rerun resolves run-dupparent as its parent; the
    // under-lock dup-gate (now keyed on the continuation parent too) refuses the
    // SECOND child of the same parent.
    await expect(runners.coder("g-dupfence")).rejects.toThrow(
      /already has a rerun child/,
    );
  });

  it("LEGACY attempt depth (P3): a legacy parent with parent_run_id but NO rerun_attempt → child attempt is the real chain depth, not 0+1", async () => {
    const { harnessRoot, dbPath, repoPath } = setupContinuationHarness();
    seedFixableHitch(dbPath, "g-legacy-depth");
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath })
      .toString()
      .trim();
    // Legacy chain, NONE stamped with rerun_attempt: O (root) ← M ← L (parent).
    // L is the latest coding run. Child attempt must reflect depth (O=0, M=1,
    // L=2 → child=3), NOT collapse to 0+1 because L.rerun_attempt is NULL.
    {
      const { db, close } = openManagedDb({ dbPath });
      try {
        const repo = new HitchRepository(db);
        const insertRun = (runId: string, parent: string | null) =>
          db
            .prepare(
              `INSERT INTO runs (run_id, repo_id, domain, workflow, base_branch,
                 base_sha, run_branch, status, source_mode, db_revision,
                 export_status, updated_at, parent_run_id, root_run_id,
                 rerun_attempt, meta_json)
               VALUES (?, 't', 'apps/user', 'domain-coding', 'main', ?, ?,
                 'changes_requested', 'db-first', 1, 'disabled',
                 '2026-06-13T00:00:00.000Z', ?, NULL, NULL, ?)`,
            )
            .run(runId, baseSha, `run/${runId}/apps-user`, parent, JSON.stringify({ runId }));
        insertRun("run-legO", null);
        insertRun("run-legM", "run-legO");
        insertRun("run-legL", "run-legM");
        repo.createAttempt({ hitchId: "g-legacy-depth", attemptType: "implement", status: "succeeded", runId: "run-legO" });
        repo.createAttempt({ hitchId: "g-legacy-depth", attemptType: "rerun", status: "succeeded", runId: "run-legM" });
        repo.createAttempt({ hitchId: "g-legacy-depth", attemptType: "rerun", status: "failed", runId: "run-legL" });
      } finally {
        close();
      }
    }
    // L's worktree so the continuation can carry it.
    mkdirSync(join(harnessRoot, "workspaces", "run-legL"), { recursive: true });
    execFileSync(
      "git",
      ["worktree", "add", "-q", "--detach", worktreeOf(harnessRoot, "run-legL"), baseSha],
      { cwd: repoPath },
    );
    writeFileSync(
      join(worktreeOf(harnessRoot, "run-legL"), "apps/user/src/legacy.ts"),
      "export const l = 1;\n",
    );

    const runners = createOrchestratorRunners({
      dbPath,
      harnessRoot,
      createdBy: "worker",
      coderRunner: failingEditRunner(() => ({
        file: "apps/user/src/child.ts",
        content: "export const c = 1;\n",
      })),
      reviewerRunner: { run: async () => ({ exitCode: 0, timedOut: false, durationMs: 0 }) },
      resolveRunContext: () => runContext(repoPath),
    });

    const child = await runners.coder("g-legacy-depth");
    const row = runRow(dbPath, child.runId);
    // depth-aware: O=0, M=1, L=2 → child = 3 (NOT 1 from a naive 0+1).
    expect(row.rerunAttempt).toBe(3);
    expect(row.rootRunId).toBe("run-legO"); // chain-walk root
  });
});
