import type Database from "better-sqlite3";
import {
  RunRepository,
  type RunFilter,
  type DashboardRunSummary,
  type RunDetail,
  type RunTimelineEvent,
  type RerunChainNode,
  type CommandResultRow,
  type ReviewDecisionRow,
} from "../db/repositories/runs.js";

/**
 * Dashboard data-source seam (Phase 6-5).
 *
 * The dashboard reads through this interface, never the DB directly, so
 * it is not welded to the DB read model — a future backend (a live
 * server, a different store) can implement `DashboardDataSource` without
 * touching the views. The interface grows in 6-6 (metrics / inbox) and
 * 6-7 (the full snapshot).
 */
export interface DashboardDataSource {
  listRuns(filter?: RunFilter): DashboardRunSummary[];
  countRuns(filter?: RunFilter): number;
  getRun(runId: string): RunDetail | null;
  getTimeline(runId: string): RunTimelineEvent[];
  getRerunChain(runId: string): RerunChainNode[];
  getCommandResults(runId: string): CommandResultRow[];
  getReviewDecision(runId: string): ReviewDecisionRow | null;
}

/** The DB-backed `DashboardDataSource` — the only Phase 6 implementation. */
export class DbDashboardDataSource implements DashboardDataSource {
  private readonly runs: RunRepository;

  constructor(db: Database.Database) {
    this.runs = new RunRepository(db);
  }

  listRuns(filter?: RunFilter): DashboardRunSummary[] {
    return this.runs.listRuns(filter);
  }
  countRuns(filter?: RunFilter): number {
    return this.runs.countRuns(filter);
  }
  getRun(runId: string): RunDetail | null {
    return this.runs.getRun(runId);
  }
  getTimeline(runId: string): RunTimelineEvent[] {
    return this.runs.getTimeline(runId);
  }
  getRerunChain(runId: string): RerunChainNode[] {
    return this.runs.getRerunChain(runId);
  }
  getCommandResults(runId: string): CommandResultRow[] {
    return this.runs.getCommandResults(runId);
  }
  getReviewDecision(runId: string): ReviewDecisionRow | null {
    return this.runs.getReviewDecision(runId);
  }
}
