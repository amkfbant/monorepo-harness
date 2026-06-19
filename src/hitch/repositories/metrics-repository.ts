import type Database from "better-sqlite3";
import { phaseSpecApprovalStatusForSpec } from "../../roadmap/phase-repository.js";
import {
  ADVISORY_REVIEW_FINDING_CATEGORIES,
  HARNESS_ORIGIN_FINDING_SOURCES,
  type HitchAttemptType,
  type HitchHarnessOriginDivergenceMetrics,
} from "../types.js";
import { placeholders } from "./shared.js";

/**
 * #125 Track C (C7) — the metrics/read concern extracted from the frozen
 * `HitchRepository` by composition delegation. Read-only derivations over
 * findings / review-cycles / linked-phase specs / coding-run lineage that the
 * convergence + close-gate layers consume:
 *
 *   - {@link harnessOriginDivergenceMetrics}: harness-origin churn counters
 *     (#196/#280/#283) — total / max-reopen / per-completed-cycle new findings,
 *     advisory categories excluded.
 *   - {@link linkedPhaseSpecApprovalDrifts}: phases whose ratified spec hash has
 *     drifted from their current spec hash (#231).
 *   - {@link latestCodingRunChangedPaths}: the NEWEST coding attempt's run id +
 *     its allowed changed paths, the fail-closed input to the facet_red_test
 *     close gate (#279).
 *
 * Holds the FACADE's `db` handle and opens NO transaction (pure reads). The
 * private `newestCodingAttemptRunId` re-derives the newest implement/rerun
 * attempt's run_id from `hitch_attempts` directly (same ordering as
 * `AttemptRepository.listAttempts`), deliberately distinct from the lenient
 * shared `latestCodingRunId`. Behaviour-identical to the former `HitchRepository`
 * metrics methods.
 */
export interface LinkedPhaseSpecApprovalDrift {
  phaseId: string;
  approvedSpecHash: string;
  currentSpecHash: string;
}

interface HitchDivergenceCycleFindingRow {
  cycle_id: string;
  cycle_number: number;
  findings_new: number;
}

interface LinkedPhaseSpecRow {
  phase_id: string;
  scope_json: string | null;
  close_conditions_json: string | null;
  review_state_json: string | null;
}

interface CodingAttemptRow {
  run_id: string | null;
  attempt_type: HitchAttemptType;
}

/** Implement/rerun attempt types whose `run_id` is a coding run. Local mirror of
 * the former module-private `CODING_RUN_ATTEMPT_TYPES`. */
const CODING_RUN_ATTEMPT_TYPES: ReadonlySet<HitchAttemptType> =
  new Set<HitchAttemptType>(["implement", "rerun"]);

function parseNullableJson(text: string | null): unknown {
  return text === null ? null : (JSON.parse(text) as unknown);
}

export class MetricsRepository {
  constructor(private readonly db: Database.Database) {}

  harnessOriginDivergenceMetrics(
    hitchId: string,
  ): HitchHarnessOriginDivergenceMetrics {
    const sourcePlaceholders = placeholders(
      HARNESS_ORIGIN_FINDING_SOURCES.length,
    );
    // #283: non-actionable advisory review categories (assigned deterministically
    // by the harness, NOT self-reported by the LLM) are RECORDED as findings but
    // EXCLUDED from the divergence churn counter — otherwise an approval/positive
    // advisory comment could inflate findingsNew and trip a FALSE `diverging` on
    // reopen. The blocking categories (review-required-change /
    // review-negative-decision) are deliberately NOT in this set, so real blockers
    // still drive divergence (and still block close) — fail-closed.
    const advisoryPlaceholders = placeholders(
      ADVISORY_REVIEW_FINDING_CATEGORIES.length,
    );
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(MAX(reopen_count), 0) AS maxReopen
           FROM hitch_findings
          WHERE hitch_id = ?
            AND duplicate_of IS NULL
            AND source IN (${sourcePlaceholders})
            AND category NOT IN (${advisoryPlaceholders})`,
      )
      .get(
        hitchId,
        ...HARNESS_ORIGIN_FINDING_SOURCES,
        ...ADVISORY_REVIEW_FINDING_CATEGORIES,
      ) as {
      total: number;
      maxReopen: number;
    };
    const cycleRows = this.db
      .prepare(
        `SELECT
            c.cycle_id,
            c.cycle_number,
            COUNT(f.finding_id) AS findings_new
           FROM hitch_review_cycles c
           LEFT JOIN hitch_findings f
             ON f.hitch_id = c.hitch_id
            AND f.source_cycle_id = c.cycle_id
            AND f.duplicate_of IS NULL
            AND f.source IN (${sourcePlaceholders})
            AND f.category NOT IN (${advisoryPlaceholders})
          WHERE c.hitch_id = ?
            -- only COMPLETED cycles are review evidence (#164): a
            -- started-but-incomplete cycle has 0 imported findings and would
            -- otherwise look like a "clean" cycle, prematurely clearing a
            -- non-decreasing divergence before any review evidence exists.
            AND c.completed_at IS NOT NULL
          GROUP BY c.cycle_id, c.cycle_number, c.created_at
          ORDER BY c.cycle_number ASC, c.created_at ASC, c.cycle_id ASC`,
      )
      // Positional binds (#283): JOIN-clause params bind BEFORE the WHERE
      // `c.hitch_id = ?` param — sources, then advisory categories (both in the
      // ON clause), THEN hitchId. Reordering would silently corrupt the counts.
      .all(
        ...HARNESS_ORIGIN_FINDING_SOURCES,
        ...ADVISORY_REVIEW_FINDING_CATEGORIES,
        hitchId,
      ) as HitchDivergenceCycleFindingRow[];
    return {
      harnessOriginNewFindings: totals.total,
      harnessOriginMaxReopenCount: totals.maxReopen,
      harnessOriginNewFindingsByCycle: cycleRows.map((row) => ({
        cycleId: row.cycle_id,
        cycleNumber: row.cycle_number,
        findingsNew: row.findings_new,
      })),
    };
  }

  linkedPhaseSpecApprovalDrifts(
    hitchId: string,
  ): LinkedPhaseSpecApprovalDrift[] {
    const rows = this.db
      .prepare(
        `SELECT p.phase_id, p.scope_json, p.close_conditions_json, p.review_state_json
           FROM phase_hitches ph
           JOIN phases p ON p.phase_id = ph.phase_id
          WHERE ph.hitch_id = ?
          ORDER BY p.phase_id ASC`,
      )
      .all(hitchId) as LinkedPhaseSpecRow[];
    const drifts: LinkedPhaseSpecApprovalDrift[] = [];
    for (const row of rows) {
      const status = phaseSpecApprovalStatusForSpec({
        scope: parseNullableJson(row.scope_json),
        closeConditions: parseNullableJson(row.close_conditions_json),
        reviewState: parseNullableJson(row.review_state_json),
      });
      if (!status.drifted || status.approvedSpecHash === null) continue;
      drifts.push({
        phaseId: row.phase_id,
        approvedSpecHash: status.approvedSpecHash,
        currentSpecHash: status.currentSpecHash,
      });
    }
    return drifts;
  }

  /**
   * The latest coding run id + the paths that run changed (run_changed_files),
   * deterministic inputs for the facet_red_test close gate (#279). Fail-closed:
   * when no run is resolvable, `runId` is null and `paths` is empty so the gate
   * can never pass. Mirrors `changedPathsForRun` (allowed, non-ignored rows,
   * with the reviewed.meta_json fallback) so the gate sees the same surface the
   * post-hoc policy diff verified.
   *
   * STRICT on the NEWEST coding attempt (not the shared `latestCodingRunId`,
   * which is intentionally lenient — it skips a newer run-less attempt and falls
   * back to an older run, a semantics #278's auto-resolve guard relies on). For
   * the facet gate that lenient fallback is unsafe: if the newest implement/rerun
   * attempt has no resolvable run_id (a coding pass is in flight / failed before
   * recording a run), evaluating an OLDER run's changedPaths AND accepting fresh
   * evidence bound to that older run would let a hitch reach close_ready on stale
   * data. So we look ONLY at the newest coding attempt: no resolvable run_id =>
   * `{ runId: null, paths: [] }` (gate goes pending, never passes on the older
   * run). Only when the newest coding attempt HAS a run_id do we use it.
   */
  latestCodingRunChangedPaths(hitchId: string): {
    runId: string | null;
    paths: string[];
  } {
    const runId = this.newestCodingAttemptRunId(hitchId);
    if (runId === null) return { runId: null, paths: [] };
    return { runId, paths: this.changedPathsForRun(runId) };
  }

  /**
   * The run_id of the NEWEST implement/rerun attempt, or null when that newest
   * coding attempt has no run_id (does NOT fall back to an older attempt). This
   * is the fail-closed resolution the facet_red_test gate requires; it is
   * deliberately distinct from the lenient shared `latestCodingRunId`. Reads
   * `hitch_attempts` directly with the same ordering as
   * `AttemptRepository.listAttempts` (iteration ASC, created_at ASC), then walks
   * from the newest.
   */
  private newestCodingAttemptRunId(hitchId: string): string | null {
    const rows = this.db
      .prepare(
        `SELECT run_id, attempt_type FROM hitch_attempts
          WHERE hitch_id = ?
          ORDER BY iteration ASC, created_at ASC`,
      )
      .all(hitchId) as CodingAttemptRow[];
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row === undefined) continue;
      if (!CODING_RUN_ATTEMPT_TYPES.has(row.attempt_type)) continue;
      // Newest coding attempt found — its run_id (or null) is authoritative.
      return row.run_id !== null && row.run_id !== "" ? row.run_id : null;
    }
    return null;
  }

  private changedPathsForRun(runId: string): string[] {
    const rows = this.db
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

    const row = this.db
      .prepare("SELECT meta_json FROM runs WHERE run_id = ?")
      .get(runId) as { meta_json: string | null } | undefined;
    if (row?.meta_json === undefined || row.meta_json === null) return [];
    try {
      const meta = JSON.parse(row.meta_json) as {
        reviewed?: { paths?: unknown };
      };
      const reviewedPaths = meta.reviewed?.paths;
      if (!Array.isArray(reviewedPaths)) return [];
      return reviewedPaths.filter(
        (p): p is string => typeof p === "string" && p !== "",
      );
    } catch {
      return [];
    }
  }
}
