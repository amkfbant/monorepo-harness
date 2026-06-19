import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  findNearDuplicate,
  type NearDuplicateCandidate,
} from "../near-duplicate.js";
import type {
  HitchFinding,
  HitchFindingSeverity,
  HitchFindingSource,
  HitchLifecycleStatus,
  HitchScopeStatus,
} from "../types.js";
import {
  defaultLifecycleForScope,
  incomingCloseBlockerCandidate,
  isHarnessOriginFindingSource,
  isNearDuplicateClassificationReason,
  moreBlockingScope,
  moreSevere,
  nearDuplicateClassificationReason,
  rowToNearDuplicateCandidate,
  shouldReopenForIncoming,
  type HitchFindingIdentityRow,
  type UpsertHitchFindingInput,
  type UpsertHitchFindingResult,
} from "./finding-helpers.js";
import { requireHitchSession, touchHitchSession } from "./shared.js";

/**
 * #125 Track C (C6) — finding WRITE bodies extracted from `finding-repository.ts`
 * as free functions so both files stay under the 800-line cap. These hold NO
 * transaction and take the FACADE's `db` handle via {@link FindingWriteDeps}, so
 * they compose inside whatever transaction the caller already opened — the public
 * `upsertFinding` wrapper's own tx, or the atomic review-import's single outer
 * BEGIN (`HitchRepository.runAtomically`, #306). `upsertFindingWithin` is the
 * IDENTICAL write body of the former `HitchRepository.upsertFindingWithin`;
 * `promoteDuplicateCanonical` / `findNearDuplicateForInput` mirror their former
 * private methods. `requireFinding` is supplied as a dep so these stay decoupled
 * from the FindingRepository class while reading back the canonical row.
 */
export interface FindingWriteDeps {
  db: Database.Database;
  requireFinding(findingId: string): HitchFinding;
}

export function upsertFindingWithin(
  deps: FindingWriteDeps,
  input: UpsertHitchFindingInput,
  prepared: {
    now: string;
    stableKey: string;
    scopeStatus: HitchScopeStatus;
    explicitDuplicateOf: string | null;
  },
): UpsertHitchFindingResult {
  const { now, stableKey, scopeStatus, explicitDuplicateOf } = prepared;
  {
    const existing = deps.db
      .prepare(
        `SELECT finding_id, scope_status, lifecycle_status, severity,
                duplicate_of, classification_reason
           FROM hitch_findings
          WHERE hitch_id = ? AND stable_key = ?
          ORDER BY
            CASE WHEN duplicate_of IS NULL THEN 0 ELSE 1 END,
            first_seen_at ASC,
            finding_id ASC
          LIMIT 1`,
      )
      .get(input.hitchId, stableKey) as
      | {
          finding_id: string;
          scope_status: HitchScopeStatus;
          lifecycle_status: HitchLifecycleStatus;
          severity: HitchFindingSeverity;
          duplicate_of: string | null;
          classification_reason: string | null;
        }
      | undefined;
    if (existing !== undefined) {
      const duplicateCanonical = explicitDuplicateOf ?? existing.duplicate_of;
      const existingIsDuplicate = existing.duplicate_of !== null;
      let canonicalReopened = false;
      if (duplicateCanonical !== null) {
        canonicalReopened = promoteDuplicateCanonical(deps, 
          duplicateCanonical,
          input.severity,
          scopeStatus,
          input.lifecycleStatus ?? defaultLifecycleForScope(scopeStatus),
          input.summary,
          input.detail,
          input.source,
          now,
          {
            suppressFixedReopenCount: isNearDuplicateClassificationReason(
              existing.classification_reason,
            ),
          },
        );
      }
      const lifecycleStatus =
        input.lifecycleStatus ?? defaultLifecycleForScope(scopeStatus);
      const incomingCloseBlocker = incomingCloseBlockerCandidate(
        scopeStatus,
        lifecycleStatus,
        input.severity,
      );
      const scopeStatusToStore = existingIsDuplicate
        ? existing.scope_status
        : incomingCloseBlocker
          ? moreBlockingScope(existing.scope_status, scopeStatus)
          : existing.scope_status;
      const promoteLifecycleToReopened = existingIsDuplicate
        ? false
        : shouldReopenForIncoming(
            existing.lifecycle_status,
            scopeStatus,
            lifecycleStatus,
            input.severity,
          );
      const fixedReopen =
        !existingIsDuplicate &&
        existing.lifecycle_status === "fixed" &&
        incomingCloseBlocker;
      const promotesCanonical =
        !existingIsDuplicate &&
        (moreSevere(existing.severity, input.severity) !== existing.severity ||
          scopeStatusToStore !== existing.scope_status ||
          promoteLifecycleToReopened ||
          fixedReopen);
      const reopened = fixedReopen || promoteLifecycleToReopened || canonicalReopened;
      const severity = moreSevere(existing.severity, input.severity);
      const countReopen = isHarnessOriginFindingSource(input.source);
      deps.db
        .prepare(
          `UPDATE hitch_findings
              SET last_seen_at = ?, source_ref = ?,
                  source_attempt_id = ?,
                  severity = ?,
                  scope_status = ?,
                  summary = CASE
                    WHEN ? THEN ?
                    ELSE summary
                  END,
                  detail = CASE
                    WHEN ? THEN COALESCE(?, detail)
                    ELSE detail
                  END,
                  suggested_fix = COALESCE(?, suggested_fix),
                  lifecycle_status = CASE
                    WHEN (lifecycle_status = 'fixed' AND ?) OR ? THEN 'reopened'
                    ELSE lifecycle_status
                  END,
                  fixed_at = CASE
                    WHEN (lifecycle_status = 'fixed' AND ?) OR ? THEN NULL
                    ELSE fixed_at
                  END,
                  deferred_at = CASE
                    WHEN ? THEN NULL
                    ELSE deferred_at
                  END,
                  deferred_backlog_item_id = CASE
                    WHEN ? THEN NULL
                    ELSE deferred_backlog_item_id
                  END,
                  reopen_count = CASE
                    WHEN ((lifecycle_status = 'fixed' AND ?) OR ?) AND ?
                      THEN reopen_count + 1
                    ELSE reopen_count
                  END
            WHERE finding_id = ?`,
        )
        .run(
          now,
          input.sourceRef ?? null,
          input.sourceAttemptId ?? null,
          severity,
          scopeStatusToStore,
          promotesCanonical ? 1 : 0,
          input.summary,
          promotesCanonical ? 1 : 0,
          input.detail ?? null,
          input.suggestedFix ?? null,
          fixedReopen ? 1 : 0,
          promoteLifecycleToReopened ? 1 : 0,
          fixedReopen ? 1 : 0,
          promoteLifecycleToReopened ? 1 : 0,
          promoteLifecycleToReopened ? 1 : 0,
          promoteLifecycleToReopened ? 1 : 0,
          fixedReopen ? 1 : 0,
          promoteLifecycleToReopened ? 1 : 0,
          countReopen ? 1 : 0,
          existing.finding_id,
        );
      touchHitchSession(deps.db, input.hitchId, now);
      return {
        finding: deps.requireFinding(existing.finding_id),
        created: false,
        reopened,
      };
    }

    const nearDuplicate =
      explicitDuplicateOf === null &&
      input.stableKey === undefined &&
      scopeStatus !== "duplicate" &&
      requireHitchSession(deps.db, input.hitchId).policy.divergence.nearDuplicateDedup
        ? findNearDuplicateForInput(deps.db, input)
        : null;
    const insertScopeStatus =
      nearDuplicate === null ? scopeStatus : ("duplicate" as const);
    const insertDuplicateOf =
      nearDuplicate === null ? explicitDuplicateOf : nearDuplicate.findingId;
    const insertLifecycleStatus =
      nearDuplicate === null && input.lifecycleStatus !== undefined
        ? input.lifecycleStatus
        : defaultLifecycleForScope(insertScopeStatus);
    const insertClassificationReason =
      nearDuplicate === null
        ? input.classificationReason ?? null
        : nearDuplicateClassificationReason(
            nearDuplicate.findingId,
            input.classificationReason,
          );
    const reopened =
      insertDuplicateOf !== null
        ? promoteDuplicateCanonical(deps, 
            insertDuplicateOf,
            input.severity,
            scopeStatus,
            input.lifecycleStatus ?? defaultLifecycleForScope(scopeStatus),
            input.summary,
            input.detail,
            input.source,
            now,
            nearDuplicate === null ? {} : { suppressFixedReopenCount: true },
          )
        : false;
    const findingId = input.findingId ?? `finding-${randomUUID()}`;
    deps.db
      .prepare(
        `INSERT INTO hitch_findings (
           finding_id, hitch_id, stable_key, duplicate_of, source,
           source_ref, source_attempt_id, source_cycle_id, severity,
           category, scope_status, lifecycle_status, summary, detail,
           file_path, symbol, suggested_fix, first_seen_at, last_seen_at,
           classification_reason
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        findingId,
        input.hitchId,
        stableKey,
        insertDuplicateOf,
        input.source,
        input.sourceRef ?? null,
        input.sourceAttemptId ?? null,
        input.sourceCycleId ?? null,
        input.severity,
        input.category,
        insertScopeStatus,
        insertLifecycleStatus,
        input.summary,
        input.detail ?? null,
        input.filePath ?? null,
        input.symbol ?? null,
        input.suggestedFix ?? null,
        now,
        now,
        insertClassificationReason,
      );
    touchHitchSession(deps.db, input.hitchId, now);
    return {
      finding: deps.requireFinding(findingId),
      created: true,
      reopened,
    };
  }
}

export function promoteDuplicateCanonical(
  deps: FindingWriteDeps,
  canonicalFindingId: string,
  incomingSeverity: HitchFindingSeverity,
  incomingScopeStatus: HitchScopeStatus,
  incomingLifecycleStatus: HitchLifecycleStatus,
  incomingSummary: string,
  incomingDetail: string | undefined,
  incomingSource: HitchFindingSource,
  now: string,
  options: { suppressFixedReopenCount?: boolean } = {},
): boolean {
  const canonical = deps.requireFinding(canonicalFindingId);
  const severity = moreSevere(canonical.severity, incomingSeverity);
  const incomingCloseBlocker = incomingCloseBlockerCandidate(
    incomingScopeStatus,
    incomingLifecycleStatus,
    incomingSeverity,
  );
  const scopeStatus = incomingCloseBlocker
    ? moreBlockingScope(canonical.scopeStatus, incomingScopeStatus)
    : canonical.scopeStatus;
  const promoteLifecycleToReopened = shouldReopenForIncoming(
    canonical.lifecycleStatus,
    incomingScopeStatus,
    incomingLifecycleStatus,
    incomingSeverity,
  );
  const fixedReopen =
    canonical.lifecycleStatus === "fixed" && incomingCloseBlocker;
  const reopened = fixedReopen || promoteLifecycleToReopened;
  const promotesCanonical =
    severity !== canonical.severity ||
    scopeStatus !== canonical.scopeStatus ||
    reopened;
  const countReopen =
    isHarnessOriginFindingSource(incomingSource) &&
    (promoteLifecycleToReopened ||
      (fixedReopen && options.suppressFixedReopenCount !== true));
  deps.db
    .prepare(
      `UPDATE hitch_findings
          SET severity = ?,
              scope_status = ?,
              summary = CASE
                WHEN ? THEN ?
                ELSE summary
              END,
              detail = CASE
                WHEN ? THEN COALESCE(?, detail)
                ELSE detail
              END,
              lifecycle_status = CASE
                WHEN (lifecycle_status = 'fixed' AND ?) OR ? THEN 'reopened'
                ELSE lifecycle_status
              END,
              fixed_at = CASE
                WHEN (lifecycle_status = 'fixed' AND ?) OR ? THEN NULL
                ELSE fixed_at
              END,
              deferred_at = CASE
                WHEN ? THEN NULL
                ELSE deferred_at
              END,
              deferred_backlog_item_id = CASE
                WHEN ? THEN NULL
                ELSE deferred_backlog_item_id
              END,
              reopen_count = CASE
                WHEN ((lifecycle_status = 'fixed' AND ?) OR ?) AND ?
                  THEN reopen_count + 1
                ELSE reopen_count
              END,
              last_seen_at = ?
        WHERE finding_id = ?`,
    )
    .run(
      severity,
      scopeStatus,
      promotesCanonical ? 1 : 0,
      incomingSummary,
      promotesCanonical ? 1 : 0,
      incomingDetail ?? null,
      fixedReopen ? 1 : 0,
      promoteLifecycleToReopened ? 1 : 0,
      fixedReopen ? 1 : 0,
      promoteLifecycleToReopened ? 1 : 0,
      promoteLifecycleToReopened ? 1 : 0,
      promoteLifecycleToReopened ? 1 : 0,
      fixedReopen ? 1 : 0,
      promoteLifecycleToReopened ? 1 : 0,
      countReopen ? 1 : 0,
      now,
      canonicalFindingId,
    );
  return reopened;
}

export function findNearDuplicateForInput(
  db: Database.Database,
  input: UpsertHitchFindingInput,
): NearDuplicateCandidate | null {
  const rows = db
    .prepare(
      `SELECT finding_id, hitch_id, category, scope_status, summary,
              file_path, symbol
         FROM hitch_findings
        WHERE hitch_id = ?
          AND duplicate_of IS NULL
        ORDER BY first_seen_at ASC, finding_id ASC`,
    )
    .all(input.hitchId) as HitchFindingIdentityRow[];
  return findNearDuplicate({
    hitchId: input.hitchId,
    category: input.category,
    scopeStatus: input.scopeStatus ?? "unknown",
    summary: input.summary,
    filePath: input.filePath ?? null,
    symbol: input.symbol ?? null,
    candidates: rows.map(rowToNearDuplicateCandidate),
  });
}
