// orchestrator-runners の Phase-3 auto-merge 評価層（merge-gate + operation-audit）。
// closeAndPr runner から呼ばれる top-level helper 群。

import { randomUUID } from "node:crypto";

import { withManagedDb } from "../db/managed-connection.js";

import type { PrMergeMethod } from "../core/pr-creator.js";
import { evaluateMergeGate, quorumSatisfiedFromRequirements, type MergeGateConsensus } from "../core/merge-gate.js";
import { computeAutoMergeTier, type AutoMergeTier } from "../core/automerge-tiers.js";
import { loadAutoMergeSensitivityMap } from "../core/automerge-tiers-config.js";

import { ReviewConsensusRepository } from "../db/repositories/review-consensus.js";
import { ReviewOverridesRepository } from "../db/repositories/review-overrides.js";

import { startOperation, succeedOperation, failOperation } from "../db/repositories/operations.js";

import type { ConsensusSummary } from "../core/review-consensus.js";

import { HitchRepository } from "./repository.js";

import { ConvergenceService } from "./convergence.js";

import type { OrchestratorRunnerDeps } from "./orchestrator-runners-types.js";

/**
 * Phase 3: evaluate the merge gate for a freshly-created PR and, if it passes,
 * merge (recording an operation-audit row). A hard-blocked gate returns an
 * escalateReason (fail-closed: do NOT merge, do NOT close). CI-not-green
 * returns `{ merged: false }` so the caller closes the hitch and leaves the PR
 * open for a later merge.
 */
export async function runAutoMerge(
  deps: OrchestratorRunnerDeps,
  hitchId: string,
  runId: string,
  repoPath: string,
  prNumber: number,
  reviewedHeadSha: string | undefined,
): Promise<{ merged: boolean; escalateReason?: string; recheckable?: boolean }> {
  const autoMerge = deps.autoMerge!;
  // The merge is pinned to the REVIEWED commit (the SHA createPullRequest
  // committed + pushed after the fingerprint check), never the PR's later
  // head. Without it we cannot prove the merge target was reviewed → escalate.
  if (reviewedHeadSha === undefined) {
    return {
      merged: false,
      escalateReason: `auto-merge: reviewed head commit for PR #${prNumber} is unknown`,
    };
  }
  const expectedHeadSha = reviewedHeadSha;
  // Advisory ingestion of external review verdicts (opt-in). A
  // CHANGES_REQUESTED verdict becomes an unknown-scope finding, which makes the
  // close-readiness re-eval below fail → the gate escalates for the operator to
  // classify (fail-closed; external approvals are never trusted to merge).
  await ingestExternalReviewVerdicts(deps, hitchId, prNumber);
  const tier = withManagedDb({ dbPath: deps.dbPath }, (db) =>
    effectiveAutoMergeTier(db, runId, deps.harnessRoot),
  );
  const tierEligible = tier === 0;
  const ciGreen = tierEligible
    ? await autoMerge.ciStatus(prNumber, expectedHeadSha)
    : true;
  const gate = withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new HitchRepository(db);
    // Re-evaluate close-readiness at merge time from the DB facts — a finding
    // or close-check could have changed since the PR was created.
    const closeReady =
      new ConvergenceService(repo).evaluate(hitchId).decision === "close_ready";
    const { consensus, humanApproved } = gatherApproval(db, runId);
    return evaluateMergeGate({
      autoMergeEnabled: true,
      closeReady,
      consensus,
      humanApproved,
      ciGreen,
      tierEligible,
    });
  });
  if (gate.canMerge) {
    const method: PrMergeMethod = autoMerge.method ?? "squash";
    const operationId = `op-${randomUUID()}`;
    withManagedDb({ dbPath: deps.dbPath }, (db) => {
      startOperation(db, {
        operationId,
        operationType: "merge",
        targetType: "pr",
        targetId: String(prNumber),
        actor: deps.createdBy,
        dryRun: false,
        // Record the gate snapshot so an auditor can later verify which
        // reviewed commit was pinned and what the gate saw.
        input: {
          hitchId,
          runId,
          prNumber,
          method,
          expectedHeadSha,
          ciGreen,
          tier,
          gate,
        },
      });
    });
    try {
      const result = await autoMerge.merger.merge({
        repoDir: repoPath,
        prNumber,
        method,
        expectedHeadSha,
      });
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        succeedOperation(db, operationId, result);
      });
      return { merged: true };
    } catch (e) {
      withManagedDb({ dbPath: deps.dbPath }, (db) => {
        failOperation(db, operationId, "merge_failed", (e as Error).message);
      });
      throw e;
    }
  }
  if (gate.hardBlocked) {
    // fail-closed: a human-required blocker must not be auto-merged or silently
    // closed — escalate so a human resolves it.
    return {
      merged: false,
      escalateReason: `auto-merge gate hard-blocked: ${gate.blockers.join(", ")}`,
    };
  }
  // transient: leave the PR open for a later merge. `recheckable` is true only
  // for CI-not-green (a temporal blocker that a re-run can clear); a
  // tier_not_auto_eligible block is permanent (the path's tier never changes),
  // so the hitch closes for a human merge rather than waiting on a re-check.
  return { merged: false, recheckable: gate.blockers.includes("ci_not_green") };
}

/** Gather the consensus + human-override approval facts for the merge gate. */
export function gatherApproval(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
): { consensus: MergeGateConsensus | null; humanApproved: boolean } {
  const active = new ReviewConsensusRepository(db).findActive(runId);
  let consensus: MergeGateConsensus | null = null;
  if (active !== null) {
    const summary = JSON.parse(active.summaryJson) as ConsensusSummary;
    consensus = {
      status: active.status,
      quorumSatisfied: quorumSatisfiedFromRequirements(summary.requirements),
    };
  }
  const override = new ReviewOverridesRepository(db).findLatest(runId);
  return { consensus, humanApproved: override?.decision === "approved" };
}

export function changedPathsForRun(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT path
       FROM run_changed_files
       WHERE run_id = ? AND allowed = 1 AND status <> 'ignored'
       ORDER BY path`,
    )
    .all(runId) as { path: string }[];
  const dbPaths = rows
    .map((r) => r.path)
    .filter((p): p is string => typeof p === "string" && p !== "");
  if (dbPaths.length > 0) return dbPaths;

  const row = db
    .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
    .get(runId) as { meta_json: string | null } | undefined;
  if (row?.meta_json === undefined || row.meta_json === null) return [];
  const meta = JSON.parse(row.meta_json) as {
    reviewed?: { paths?: unknown };
  };
  const reviewedPaths = meta.reviewed?.paths;
  if (!Array.isArray(reviewedPaths)) return [];
  return reviewedPaths.filter(
    (p): p is string => typeof p === "string" && p !== "",
  );
}

/** Whether the run's captured diff weakened the test suite (run-time signal). */
export function runWeakensTests(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
): boolean {
  const row = db
    .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
    .get(runId) as { meta_json: string | null } | undefined;
  if (row?.meta_json === undefined || row.meta_json === null) return false;
  try {
    const meta = JSON.parse(row.meta_json) as {
      reviewed?: { weakensTests?: unknown };
    };
    return meta.reviewed?.weakensTests === true;
  } catch {
    return false;
  }
}

/**
 * Auto-merge tier for a run: the sensitivity-map tier, but a Tier-0
 * (tests/docs-only) change that WEAKENS tests (deletes a test file or adds a
 * skip/only marker) is downgraded to Tier-1 so it cannot auto-merge — coverage
 * must not be removed by an automatic merge. Fail-closed (only tightens).
 */
export function effectiveAutoMergeTier(
  db: Parameters<Parameters<typeof withManagedDb>[1]>[0],
  runId: string,
  harnessRoot: string,
): AutoMergeTier {
  const base = computeAutoMergeTier(
    changedPathsForRun(db, runId),
    loadAutoMergeSensitivityMap(harnessRoot),
  );
  return base === 0 && runWeakensTests(db, runId) ? 1 : base;
}

/**
 * Opt-in advisory ingestion of external PR review verdicts (codex GitHub App /
 * Copilot). Each `CHANGES_REQUESTED` verdict is recorded ONCE as an
 * unknown-scope hitch finding; the close-readiness re-eval in the merge gate
 * then fails, so the gate escalates for the operator to classify. External
 * approvals are NEVER ingested — an external "approve" cannot authorise a merge
 * (§0/§6: external output may only push fail-closed, never approve). Best
 * effort: a fetch failure is swallowed so it cannot break the merge path.
 */
export function defaultReviewSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch the PR's CHANGES_REQUESTED verdicts once; a fetch failure yields none. */
export async function fetchBlockingVerdicts(
  fetchVerdicts: (prNumber: number) => Promise<{ author: string; state: string }[]>,
  prNumber: number,
): Promise<{ author: string; state: string }[]> {
  try {
    const verdicts = await fetchVerdicts(prNumber);
    return verdicts.filter((v) => v.state.toUpperCase() === "CHANGES_REQUESTED");
  } catch {
    return [];
  }
}

export async function ingestExternalReviewVerdicts(
  deps: OrchestratorRunnerDeps,
  hitchId: string,
  prNumber: number,
): Promise<void> {
  const fetchVerdicts = deps.autoMerge?.reviewVerdicts;
  if (fetchVerdicts === undefined) return;
  let blocking = await fetchBlockingVerdicts(fetchVerdicts, prNumber);
  const awaitCfg = deps.autoMerge?.reviewAwait;
  if (blocking.length === 0 && awaitCfg !== undefined) {
    // Bounded await: give async external reviewers a window to weigh in before
    // the gate is evaluated. Stop on the first blocking verdict or budget spent.
    const now = awaitCfg.now ?? Date.now;
    const sleep = awaitCfg.sleep ?? defaultReviewSleep;
    const start = now();
    while (now() - start < awaitCfg.timeoutMs) {
      const remaining = awaitCfg.timeoutMs - (now() - start);
      await sleep(Math.min(awaitCfg.intervalMs, remaining));
      blocking = await fetchBlockingVerdicts(fetchVerdicts, prNumber);
      if (blocking.length > 0) break;
    }
  }
  if (blocking.length === 0) return;
  withManagedDb({ dbPath: deps.dbPath }, (db) => {
    const repo = new HitchRepository(db);
    const seen = new Set(
      repo.listFindings({ hitchId, limit: 10_000 }).map((f) => f.stableKey),
    );
    for (const v of blocking) {
      const stableKey = `external-review:${prNumber}:${v.author}`;
      if (seen.has(stableKey)) continue; // ingest each verdict once (no reopen loop)
      repo.upsertFinding({
        hitchId,
        source: "review",
        sourceRef: `external_review:${prNumber}:${v.author}`,
        severity: "P1",
        category: "external-review-changes-requested",
        scopeStatus: "unknown",
        summary: `External reviewer ${v.author} requested changes on PR #${prNumber}`,
        classificationReason:
          "external review verdict ingested as advisory; classify before acting",
        stableKey,
      });
    }
  });
}
