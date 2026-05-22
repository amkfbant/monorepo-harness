import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanAllRuns, type ReviewListEntry } from "./review-lister.js";

/**
 * The rerun-chain root of a run. Prefers the explicit `rootRunId`; for a
 * legacy run that has `parentRunId` but no `rootRunId`, walks the parent
 * links (cycle-guarded) to reconstruct the root — so chain convergence
 * is not under-counted for pre-Phase-2-7 runs.
 */
function chainRoot(
  entry: ReviewListEntry,
  byId: Map<string, ReviewListEntry>,
): string {
  if (entry.rootRunId) return entry.rootRunId;
  let cur = entry;
  const seen = new Set<string>([cur.runId]);
  while (cur.parentRunId && byId.has(cur.parentRunId)) {
    if (seen.has(cur.parentRunId)) break; // cycle guard
    seen.add(cur.parentRunId);
    cur = byId.get(cur.parentRunId) as ReviewListEntry;
    if (cur.rootRunId) return cur.rootRunId;
  }
  return cur.runId;
}

export interface MetricsSummary {
  since: string | null;
  domain: string | null;
  runs: {
    total: number;
    byStatus: Record<string, number>;
  };
  review: {
    approved: number;
    changesRequested: number;
    rejected: number;
    /** approved / (approved + changes_requested + rejected) */
    approvedRate: number | null;
    /** review counts per reviewer handle */
    reviewers: Record<string, number>;
  };
  retry: {
    /** runs that are themselves a rerun (rerunAttempt >= 1) */
    reruns: number;
    /** distinct rerun chains (by rootRunId) */
    chains: number;
    /** chains that reached an approved run */
    convergedChains: number;
    /** convergedChains / chains */
    convergenceRate: number | null;
    /** reviewed-run workflows that ended `not_converged` (workflow.json) */
    notConverged: number;
  };
  safety: {
    policyViolations: number;
    secretSuspects: number;
  };
  maintenance: {
    /** approved/rejected runs whose worktree still exists */
    cleanupPending: number;
  };
}

export interface MetricsOpts {
  runsDir: string;
  workspacesDir: string;
  since?: Date;
  domain?: string;
}

/** Aggregate run / review / retry / safety metrics over a window. */
export async function buildMetrics(
  opts: MetricsOpts,
): Promise<MetricsSummary> {
  const result = await scanAllRuns(opts.runsDir);
  const allRuns = result.valid;
  const sinceMs = opts.since ? opts.since.getTime() : null;
  const runs = allRuns.filter((r) => {
    if (opts.domain !== undefined && r.domain !== opts.domain) return false;
    if (sinceMs !== null) {
      if (!r.startedAt) return false;
      const t = new Date(r.startedAt).getTime();
      if (Number.isNaN(t) || t < sinceMs) return false;
    }
    return true;
  });

  // chain-approved is computed over ALL runs, not the filtered subset —
  // a chain's approved run must not be missed because `--since` / `--domain`
  // dropped it. The chain root is reconstructed via parentRunId for legacy
  // runs that lack rootRunId.
  const byId = new Map<string, ReviewListEntry>();
  for (const r of allRuns) byId.set(r.runId, r);
  const chainApproved = new Map<string, boolean>();
  for (const r of allRuns) {
    const root = chainRoot(r, byId);
    chainApproved.set(
      root,
      (chainApproved.get(root) ?? false) || r.status === "approved",
    );
  }

  const byStatus: Record<string, number> = {};
  const reviewers: Record<string, number> = {};
  let approved = 0;
  let changesRequested = 0;
  let rejected = 0;
  let reruns = 0;
  let policyViolations = 0;
  let secretSuspects = 0;
  let cleanupPending = 0;
  let notConverged = 0;
  const rerunChainRoots = new Set<string>();

  for (const r of runs) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === "approved") approved += 1;
    else if (r.status === "changes_requested") changesRequested += 1;
    else if (r.status === "rejected") rejected += 1;
    // safetyStatus is orthogonal to the final status: a run can be
    // failed-codex AND have written outside scope. Count by safetyStatus.
    if (r.safetyStatus === "denied") policyViolations += 1;
    secretSuspects += r.secretSuspectCount ?? 0;
    if (r.reviewer) {
      reviewers[r.reviewer] = (reviewers[r.reviewer] ?? 0) + 1;
    }
    if (typeof r.rerunAttempt === "number" && r.rerunAttempt >= 1) {
      reruns += 1;
      rerunChainRoots.add(chainRoot(r, byId));
    }
    if (
      (r.status === "approved" || r.status === "rejected") &&
      existsSync(join(opts.workspacesDir, r.runId, "repo"))
    ) {
      cleanupPending += 1;
    }
    // reviewed-run workflows that gave up: workflow.json lives in the
    // root run dir and records the workflow's finalStatus.
    if (
      (await readWorkflowFinalStatus(opts.runsDir, r.runId)) ===
      "not_converged"
    ) {
      notConverged += 1;
    }
  }

  let convergedChains = 0;
  for (const root of rerunChainRoots) {
    if (chainApproved.get(root)) convergedChains += 1;
  }

  const reviewedTotal = approved + changesRequested + rejected;
  return {
    since: opts.since ? opts.since.toISOString() : null,
    domain: opts.domain ?? null,
    runs: { total: runs.length, byStatus },
    review: {
      approved,
      changesRequested,
      rejected,
      approvedRate: reviewedTotal > 0 ? approved / reviewedTotal : null,
      reviewers,
    },
    retry: {
      reruns,
      chains: rerunChainRoots.size,
      convergedChains,
      convergenceRate:
        rerunChainRoots.size > 0
          ? convergedChains / rerunChainRoots.size
          : null,
      notConverged,
    },
    safety: { policyViolations, secretSuspects },
    maintenance: { cleanupPending },
  };
}

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(0)}%`;
}

/** finalStatus from a root run's workflow.json, or null if there is none. */
async function readWorkflowFinalStatus(
  runsDir: string,
  runId: string,
): Promise<string | null> {
  const path = join(runsDir, runId, "workflow.json");
  if (!existsSync(path)) return null;
  try {
    const doc = JSON.parse(await readFile(path, "utf8")) as {
      finalStatus?: unknown;
    };
    return typeof doc.finalStatus === "string" ? doc.finalStatus : null;
  } catch {
    return null;
  }
}

export function formatMetricsSummary(m: MetricsSummary): string {
  const window = m.since ? `since ${m.since}` : "all time";
  const lines: string[] = [
    `Metrics: ${window}${m.domain ? ` (domain ${m.domain})` : ""}`,
    "",
    `Runs: ${m.runs.total}`,
  ];
  for (const s of Object.keys(m.runs.byStatus).sort()) {
    lines.push(`  ${s}: ${m.runs.byStatus[s]}`);
  }
  lines.push(
    "",
    "Review:",
    `  approved: ${m.review.approved}  changes_requested: ${m.review.changesRequested}  rejected: ${m.review.rejected}`,
    `  approved rate: ${pct(m.review.approvedRate)}`,
  );
  const reviewers = Object.keys(m.review.reviewers).sort();
  if (reviewers.length > 0) {
    lines.push(
      `  reviewers: ${reviewers.map((r) => `${r}=${m.review.reviewers[r]}`).join(", ")}`,
    );
  }
  lines.push(
    "",
    "Retry:",
    `  reruns: ${m.retry.reruns}  chains: ${m.retry.chains}  converged: ${m.retry.convergedChains}`,
    `  convergence rate: ${pct(m.retry.convergenceRate)}`,
    `  not_converged workflows: ${m.retry.notConverged}`,
    "",
    "Safety:",
    `  policy violations: ${m.safety.policyViolations}`,
    `  secret suspects: ${m.safety.secretSuspects}`,
    "",
    "Maintenance:",
    `  cleanup pending: ${m.maintenance.cleanupPending}`,
    "",
  );
  return lines.join("\n");
}

/** A breakdown of failed-* runs by status, with the domains affected. */
export function formatFailures(m: MetricsSummary): string {
  const failed = Object.keys(m.runs.byStatus)
    .filter((s) => s.startsWith("failed-"))
    .sort();
  const lines: string[] = [
    `Failures: ${m.since ? `since ${m.since}` : "all time"}${m.domain ? ` (domain ${m.domain})` : ""}`,
    "",
  ];
  if (failed.length === 0) {
    lines.push("No failed runs in this window.", "");
    return lines.join("\n");
  }
  let total = 0;
  for (const s of failed) {
    const n = m.runs.byStatus[s] ?? 0;
    total += n;
    lines.push(`  ${s}: ${n}`);
  }
  lines.push("", `Total failed: ${total}`, "");
  return lines.join("\n");
}
