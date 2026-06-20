// RunRepository の重量 write 2 method を担う sub-repository（#125 A15）。
// forceFailFinalize: lease-lost run の bypass finalize（assertActiveLease を経由しない）。
// applyReviewDecision: review verdict 適用（IMMEDIATE tx）。いずれも FROZEN—byte 不変で移設。
import type Database from "better-sqlite3";
import { DbError } from "../connection.js";
import { StateConflictError } from "../errors.js";
import { sha256 } from "../import/common.js";

import type { ApplyReviewDecisionInput } from "./runs-types.js";

export class RunFinalizeRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Force-finalize a run as `failed-internal-error` WITHOUT the active
   * lease guard (Phase 9 post-close second review P1-6).
   *
   * Why this exists: `RunLog.finalize` routes through `commitThenExport`,
   * which begins with `assertActiveLease`. When a run's lease has been
   * stolen (a peer process acquired the lease, the old fencing token is
   * no longer in `domain_locks.released_at IS NULL`), every subsequent
   * write — including the failure finalize — is rejected by that guard.
   * Without a bypass, a lease-lost run never transitions out of
   * `running` even though the orchestrator threw and exited; the row
   * would rot.
   *
   * This method:
   *   - Does NOT call `assertActiveLease` (this IS the recovery path)
   *   - Only flips a run that is still in a non-terminal status (other
   *     terminal writes win on a tie)
   *   - Appends a `lease_lost` or `internal_error` event for audit
   *   - Updates `meta_json` so file export round-trips the new status
   *   - Returns `changed: true` when the row was actually flipped
   */
  forceFailFinalize(input: {
    runId: string;
    finishedAt: string;
    reason: "lease_lost" | "internal_error";
    errorMessage: string;
    /**
     * Phase 10-0 post-review P1 / Phase 10-2: when this finalize is
     * recovering from a stolen lease, the caller passes the `lock_id`
     * of the lease that was lost. The UPDATE is then guarded by
     * `AND lease_lock_id = :lostLockId`, so a *new* attempt that
     * reacquired the same `run_id` under a fresh lease (e.g. a rerun)
     * is not accidentally flipped to `failed-internal-error`. Omitting
     * `lostLockId` preserves the Phase 9 unguarded behaviour for the
     * generic internal-error recovery path.
     *
     * Note: `runs.state_version` bump (design §3.E.E3) is **not** added
     * here because the column does not exist until schema v6 (Phase 10-3).
     * Phase 10-5 will fold this finalize into the unified state-version
     * CAS once the column lands.
     */
    lostLockId?: number;
  }): { changed: boolean } {
    const TERMINAL = new Set([
      "approved",
      "changes_requested",
      "rejected",
      "cleaned",
      "failed-internal-error",
      "failed-policy-violation",
      "failed-codex-timeout",
      "failed-budget-exceeded",
      "failed-command",
    ]);
    const txn = this.db.transaction((): { changed: boolean } => {
      const row = this.db
        .prepare(
          "SELECT status, meta_json, lease_lock_id FROM runs WHERE run_id = ?",
        )
        .get(input.runId) as
        | { status: string; meta_json: string | null; lease_lock_id: number | null }
        | undefined;
      if (row === undefined) return { changed: false };
      if (TERMINAL.has(row.status)) return { changed: false };
      // Phase 10-2: lostLockId guard — if the caller knows which lease was
      // lost, only finalize the row when it still carries that exact lease.
      // A re-acquired lease (different lock_id) means a new attempt is live
      // for the same run_id; we must not flip it.
      if (
        input.lostLockId !== undefined &&
        row.lease_lock_id !== input.lostLockId
      ) {
        return { changed: false };
      }
      const meta =
        row.meta_json !== null
          ? (JSON.parse(row.meta_json) as Record<string, unknown>)
          : {};
      const patchedMeta = {
        ...meta,
        status: "failed-internal-error",
        finishedAt: input.finishedAt,
      };
      const guarded = input.lostLockId !== undefined;
      // Phase 10-5: bump state_version on the lease-stolen finalize so
      // downstream observers (consensus / dashboard / doctor) see this
      // transition. The state_version column landed in schema v6.
      const sql = guarded
        ? `UPDATE runs
             SET status = 'failed-internal-error',
                 finished_at = ?,
                 meta_json = ?,
                 db_revision = db_revision + 1,
                 export_status = 'dirty',
                 last_export_error = NULL,
                 updated_at = ?,
                 state_version = state_version + 1
           WHERE run_id = ? AND lease_lock_id = ?`
        : `UPDATE runs
             SET status = 'failed-internal-error',
                 finished_at = ?,
                 meta_json = ?,
                 db_revision = db_revision + 1,
                 export_status = 'dirty',
                 last_export_error = NULL,
                 updated_at = ?,
                 state_version = state_version + 1
           WHERE run_id = ?`;
      const params = guarded
        ? [
            input.finishedAt,
            JSON.stringify(patchedMeta, null, 2),
            input.finishedAt,
            input.runId,
            input.lostLockId,
          ]
        : [
            input.finishedAt,
            JSON.stringify(patchedMeta, null, 2),
            input.finishedAt,
            input.runId,
          ];
      const info = this.db.prepare(sql).run(...params);
      if (info.changes === 0) {
        // guarded UPDATE matched zero rows → a re-acquired lease moved past
        // this finalize. Treat as a no-op (returning `changed: false`).
        return { changed: false };
      }
      const seq = (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events
             WHERE run_id = ?`,
          )
          .get(input.runId) as { next: number }
      ).next;
      this.db
        .prepare(
          `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          seq,
          input.reason,
          input.finishedAt,
          JSON.stringify({
            type: input.reason,
            runId: input.runId,
            reason: input.errorMessage,
          }),
        );
      return { changed: true };
    });
    return txn.immediate();
  }

  /**
   * Apply a review decision to a DB-first run (Phase 7-5).
   *
   * In one transaction: guards the run is still `needs_review` (a
   * concurrent reviewer that already moved it is a `StateConflictError`,
   * not a silent overwrite), moves it to `newStatus`, patches the
   * `meta_json` reviewer fields, appends a `review_processed` event, and
   * records the decision in `review_decisions` /
   * `review_required_changes`. Returns the prior status.
   */
  applyReviewDecision(input: ApplyReviewDecisionInput): {
    previousStatus: string;
  } {
    const txn = this.db.transaction((): { previousStatus: string } => {
      const row = this.db
        .prepare(
          "SELECT status, meta_json, state_version FROM runs WHERE run_id = ?",
        )
        .get(input.runId) as
        | { status: string; meta_json: string | null; state_version: number }
        | undefined;
      if (row === undefined) {
        throw new DbError(`applyReviewDecision: no run '${input.runId}'`);
      }
      if (row.status !== "needs_review") {
        throw new StateConflictError(
          input.runId,
          ["needs_review"],
          row.status,
        );
      }
      if (
        input.expectedStateVersion !== undefined &&
        row.state_version !== input.expectedStateVersion
      ) {
        throw new StateConflictError(
          input.runId,
          [`state_version=${input.expectedStateVersion}`],
          `state_version=${row.state_version}`,
        );
      }
      const meta =
        row.meta_json !== null
          ? (JSON.parse(row.meta_json) as Record<string, unknown>)
          : {};
      // the three decision values are also the target run statuses.
      const newStatus = input.decision;
      const patchedMeta = {
        ...meta,
        status: newStatus,
        reviewer: input.reviewer,
        reviewedAt: input.reviewedAt,
      };
      // Phase 10-5 (design §3.E E3): bump runs.state_version on every
      // review-process transition so future consensus / dashboard / db
      // doctor consumers can detect change. Phase 10 only bumps in
      // review-related transitions; other writers are tracked in the
      // close report as Phase 11 work.
      // Phase 10 post-close (whole-phase review P1 #1): if the caller
      // passed expectedStateVersion, the UPDATE adds the CAS predicate.
      const guarded = input.expectedStateVersion !== undefined;
      const sql = guarded
        ? `UPDATE runs
             SET status = ?, reviewer = ?, reviewed_at = ?, meta_json = ?,
                 db_revision = db_revision + 1, export_status = 'dirty',
                 last_export_error = NULL, updated_at = ?,
                 state_version = state_version + 1
           WHERE run_id = ? AND status = 'needs_review'
             AND state_version = ?`
        : `UPDATE runs
             SET status = ?, reviewer = ?, reviewed_at = ?, meta_json = ?,
                 db_revision = db_revision + 1, export_status = 'dirty',
                 last_export_error = NULL, updated_at = ?,
                 state_version = state_version + 1
           WHERE run_id = ? AND status = 'needs_review'`;
      const params = guarded
        ? [
            newStatus,
            input.reviewer,
            input.reviewedAt,
            JSON.stringify(patchedMeta, null, 2),
            input.reviewedAt,
            input.runId,
            input.expectedStateVersion,
          ]
        : [
            newStatus,
            input.reviewer,
            input.reviewedAt,
            JSON.stringify(patchedMeta, null, 2),
            input.reviewedAt,
            input.runId,
          ];
      const info = this.db.prepare(sql).run(...params);
      if (info.changes === 0) {
        throw new StateConflictError(
          input.runId,
          ["needs_review"],
          row.status,
        );
      }
      const seq = (
        this.db
          .prepare(
            `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events
             WHERE run_id = ?`,
          )
          .get(input.runId) as { next: number }
      ).next;
      this.db
        .prepare(
          `INSERT INTO run_events (run_id, seq, type, occurred_at, payload_json)
           VALUES (?, ?, 'review_processed', ?, ?)`,
        )
        .run(
          input.runId,
          seq,
          input.reviewedAt,
          JSON.stringify({
            type: "review_processed",
            runId: input.runId,
            decision: input.decision,
            previousStatus: row.status,
            newStatus,
            reviewer: input.reviewer,
            reviewedAt: input.reviewedAt,
          }),
        );
      // Phase 11 post-close P1 #2: include consensus_id +
      // proposals_summary_json so decision provenance is tied to the
      // consensus row + summary used to derive it (override 経路を含む).
      this.db
        .prepare(
          `INSERT INTO review_decisions (run_id, decision, reviewer, summary,
             reviewed_at, source_yaml, source_sha256, consensus_id,
             proposals_summary_json)
           VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)
           ON CONFLICT (run_id) DO UPDATE SET
             decision = excluded.decision, reviewer = excluded.reviewer,
             reviewed_at = excluded.reviewed_at,
             source_yaml = excluded.source_yaml,
             source_sha256 = excluded.source_sha256,
             consensus_id = excluded.consensus_id,
             proposals_summary_json = excluded.proposals_summary_json`,
        )
        .run(
          input.runId,
          input.decision,
          input.reviewer,
          input.reviewedAt,
          input.decisionYaml,
          sha256(input.decisionYaml),
          input.consensusId ?? null,
          input.proposalsSummaryJson ?? null,
        );
      this.db
        .prepare("DELETE FROM review_required_changes WHERE run_id = ?")
        .run(input.runId);
      const insChange = this.db.prepare(
        `INSERT INTO review_required_changes (run_id, idx, change_text)
         VALUES (?, ?, ?)`,
      );
      input.requiredChanges.forEach((c, i) => {
        insChange.run(input.runId, i, c);
      });
      // Phase 9 post-close P1 #1 fix — mark the source proposal processed
      // in the same transaction as the decision promotion. `processed_at
      // IS NULL` guard makes the UPDATE idempotent against a retry: a
      // proposal already processed by a prior crash-survived transaction
      // stays exactly as it was.
      //
      // Phase 9 post-close (second review) P1-4 fix — also require
      // `superseded_at IS NULL`. If the proposal was superseded by a
      // concurrent `review auto` between read and write, fail the whole
      // transaction with a StateConflictError so the caller can reload
      // the latest proposal rather than process a stale one.
      if (input.markProposalProcessed !== undefined) {
        const expSha = input.markProposalProcessed.expectedSourceSha256;
        // Phase 11-7: bump lifecycle_status to 'processed' alongside
        // processed_at, mirroring ReviewProposalRepository.markProcessed.
        const r =
          expSha === undefined
            ? this.db
                .prepare(
                  `UPDATE review_proposals
                      SET processed_at = ?, review_decision_id = ?,
                          lifecycle_status = 'processed'
                    WHERE proposal_id = ?
                      AND processed_at IS NULL
                      AND superseded_at IS NULL`,
                )
                .run(
                  input.reviewedAt,
                  input.markProposalProcessed.reviewDecisionId,
                  input.markProposalProcessed.proposalId,
                )
            : this.db
                .prepare(
                  `UPDATE review_proposals
                      SET processed_at = ?, review_decision_id = ?,
                          lifecycle_status = 'processed'
                    WHERE proposal_id = ?
                      AND processed_at IS NULL
                      AND superseded_at IS NULL
                      AND source_sha256 = ?`,
                )
                .run(
                  input.reviewedAt,
                  input.markProposalProcessed.reviewDecisionId,
                  input.markProposalProcessed.proposalId,
                  expSha,
                );
        if (r.changes === 0) {
          throw new StateConflictError(
            input.runId,
            ["needs_review"],
            `review_proposals(id=${input.markProposalProcessed.proposalId})` +
              ` superseded, sha mismatch, or already processed`,
          );
        }
      }
      // Phase 2: consensus promotion marks every aggregated proposal in this
      // same transaction. Any proposal that is no longer active aborts the
      // whole promotion (atomic), so the run is never promoted on a stale set.
      if (input.markProposalsProcessed !== undefined) {
        for (const proposalId of input.markProposalsProcessed) {
          const r = this.db
            .prepare(
              `UPDATE review_proposals
                  SET processed_at = ?, review_decision_id = ?,
                      lifecycle_status = 'processed'
                WHERE proposal_id = ?
                  AND processed_at IS NULL
                  AND superseded_at IS NULL`,
            )
            .run(input.reviewedAt, input.runId, proposalId);
          if (r.changes === 0) {
            throw new StateConflictError(
              input.runId,
              ["needs_review"],
              `review_proposals(id=${proposalId}) superseded or already processed`,
            );
          }
        }
      }
      return { previousStatus: row.status };
    });
    return txn.immediate();
  }
}
