import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMetrics,
  formatMetricsSummary,
  formatFailures,
} from "../../src/core/metrics.js";

let seq = 0;

interface Root {
  runsDir: string;
  workspacesDir: string;
  indexDbPath: string;
}

function harnessRoot(): Root {
  const root = mkdtempSync(join(tmpdir(), "harness-met-"));
  const r = {
    runsDir: join(root, "runs"),
    workspacesDir: join(root, "workspaces"),
    indexDbPath: join(root, ".harness", "index.sqlite"),
  };
  mkdirSync(r.runsDir, { recursive: true });
  mkdirSync(r.workspacesDir, { recursive: true });
  return r;
}

interface RunOpts {
  status: string;
  domain?: string;
  startedAt?: string;
  reviewer?: string;
  rootRunId?: string;
  rerunAttempt?: number;
  secretSuspectCount?: number;
  safetyStatus?: string;
  worktree?: boolean;
  /** when set, writes a workflow.json with this finalStatus */
  workflowFinalStatus?: string;
  runId?: string;
}

function writeRun(r: Root, o: RunOpts): string {
  const runId =
    o.runId ?? `run-20260521-apps-user-mt${String(seq++).padStart(2, "0")}`;
  mkdirSync(join(r.runsDir, runId), { recursive: true });
  writeFileSync(
    join(r.runsDir, runId, "meta.json"),
    JSON.stringify({
      runId,
      domain: o.domain ?? "apps/user",
      status: o.status,
      safetyStatus: o.safetyStatus ?? "allowed",
      startedAt: o.startedAt ?? "2026-05-21T00:00:00Z",
      ...(o.reviewer ? { reviewer: o.reviewer } : {}),
      ...(o.rootRunId ? { rootRunId: o.rootRunId } : {}),
      ...(o.rerunAttempt !== undefined ? { rerunAttempt: o.rerunAttempt } : {}),
      ...(o.secretSuspectCount !== undefined
        ? { secretSuspectCount: o.secretSuspectCount }
        : {}),
    }),
  );
  if (o.workflowFinalStatus !== undefined) {
    writeFileSync(
      join(r.runsDir, runId, "workflow.json"),
      JSON.stringify({ finalStatus: o.workflowFinalStatus }),
    );
  }
  if (o.worktree) {
    mkdirSync(join(r.workspacesDir, runId, "repo"), { recursive: true });
  }
  return runId;
}

describe("buildMetrics", () => {
  it("E4-6: counts runs by status and review outcomes", async () => {
    const r = harnessRoot();
    writeRun(r, { status: "approved", reviewer: "knkn" });
    writeRun(r, { status: "approved", reviewer: "knkn" });
    writeRun(r, { status: "changes_requested", reviewer: "knkn" });
    writeRun(r, { status: "needs_review" });
    const m = await buildMetrics(r);
    expect(m.runs.total).toBe(4);
    expect(m.runs.byStatus.approved).toBe(2);
    expect(m.review.approved).toBe(2);
    expect(m.review.changesRequested).toBe(1);
    expect(m.review.approvedRate).toBeCloseTo(2 / 3);
    expect(m.review.reviewers.knkn).toBe(3);
    expect(m.source).toBe("file-scan");
  });

  it("computes rerun convergence over chains", async () => {
    const r = harnessRoot();
    // chain A: a rerun that ended approved → converged
    writeRun(r, {
      status: "approved",
      rootRunId: "run-root-A",
      rerunAttempt: 1,
    });
    // chain B: a rerun still changes_requested → not converged
    writeRun(r, {
      status: "changes_requested",
      rootRunId: "run-root-B",
      rerunAttempt: 2,
    });
    const m = await buildMetrics(r);
    expect(m.retry.reruns).toBe(2);
    expect(m.retry.chains).toBe(2);
    expect(m.retry.convergedChains).toBe(1);
    expect(m.retry.convergenceRate).toBeCloseTo(0.5);
  });

  it("reconstructs a legacy chain root from parentRunId (no rootRunId)", async () => {
    const r = harnessRoot();
    // legacy chain: an original run, then a rerun that has parentRunId
    // but NO rootRunId — the chain root must still be reconstructed.
    writeRun(r, { runId: "run-legacy-root", status: "changes_requested" });
    // the child run dir is written by hand: parentRunId but no rootRunId
    mkdirSync(join(r.runsDir, "run-legacy-child"), { recursive: true });
    writeFileSync(
      join(r.runsDir, "run-legacy-child", "meta.json"),
      JSON.stringify({
        runId: "run-legacy-child",
        domain: "apps/user",
        status: "approved",
        safetyStatus: "allowed",
        startedAt: "2026-05-21T00:00:00Z",
        parentRunId: "run-legacy-root",
        rerunAttempt: 1,
      }),
    );
    const m = await buildMetrics(r);
    // the child walks back to run-legacy-root; the chain reached
    // approved → exactly 1 chain, converged (not under-counted)
    expect(m.retry.chains).toBe(1);
    expect(m.retry.convergedChains).toBe(1);
  });

  it("counts safety by safetyStatus (orthogonal to final status)", async () => {
    const r = harnessRoot();
    // a failed-codex run that ALSO wrote outside scope → still a violation
    writeRun(r, { status: "failed-codex", safetyStatus: "denied" });
    writeRun(r, { status: "failed-policy-violation", safetyStatus: "denied" });
    writeRun(r, { status: "needs_review", secretSuspectCount: 3 });
    writeRun(r, { status: "approved", worktree: true });
    const m = await buildMetrics(r);
    expect(m.safety.policyViolations).toBe(2); // both denied runs
    expect(m.safety.secretSuspects).toBe(3);
    expect(m.maintenance.cleanupPending).toBe(1);
  });

  it("convergence is not broken when --since drops a chain's approved run", async () => {
    const r = harnessRoot();
    // chain root: an old approved run (outside the window)
    writeRun(r, {
      runId: "run-root-old",
      status: "approved",
      startedAt: "2020-01-01T00:00:00Z",
    });
    // the rerun within the window, pointing at that root
    writeRun(r, {
      status: "changes_requested",
      rootRunId: "run-root-old",
      rerunAttempt: 1,
      startedAt: "2026-05-21T00:00:00Z",
    });
    const m = await buildMetrics({
      ...r,
      since: new Date("2026-05-01T00:00:00Z"),
    });
    // the chain IS converged — the approved run is found over all runs
    expect(m.retry.convergedChains).toBe(1);
  });

  it("counts not_converged workflows from workflow.json", async () => {
    const r = harnessRoot();
    writeRun(r, {
      status: "changes_requested",
      workflowFinalStatus: "not_converged",
    });
    writeRun(r, { status: "approved", workflowFinalStatus: "approved" });
    const m = await buildMetrics(r);
    expect(m.retry.notConverged).toBe(1);
  });

  it("E4-6: --domain filters", async () => {
    const r = harnessRoot();
    writeRun(r, { status: "approved", domain: "apps/orders" });
    writeRun(r, { status: "approved", domain: "apps/catalog" });
    const m = await buildMetrics({ ...r, domain: "apps/orders" });
    expect(m.runs.total).toBe(1);
  });

  it("E4-6: --since excludes older runs", async () => {
    const r = harnessRoot();
    writeRun(r, { status: "approved", startedAt: "2020-01-01T00:00:00Z" });
    writeRun(r, { status: "approved", startedAt: "2026-05-21T00:00:00Z" });
    const m = await buildMetrics({
      ...r,
      since: new Date("2026-05-01T00:00:00Z"),
    });
    expect(m.runs.total).toBe(1);
  });

  it("E4-6: failures breakdown", async () => {
    const r = harnessRoot();
    writeRun(r, { status: "failed-policy-violation" });
    writeRun(r, { status: "failed-codex" });
    writeRun(r, { status: "failed-codex" });
    writeRun(r, { status: "approved" });
    const m = await buildMetrics(r);
    const text = formatFailures(m);
    expect(text).toMatch(/failed-codex: 2/);
    expect(text).toMatch(/failed-policy-violation: 1/);
    expect(text).toMatch(/Total failed: 3/);
    expect(text).toMatch(/\[file-scan\]/); // source shown like the summary
  });

  it("formatMetricsSummary renders the summary", async () => {
    const r = harnessRoot();
    writeRun(r, { status: "approved", reviewer: "knkn" });
    const text = formatMetricsSummary(await buildMetrics(r));
    expect(text).toMatch(/Runs: 1/);
    expect(text).toMatch(/approved rate: 100%/);
  });
});
