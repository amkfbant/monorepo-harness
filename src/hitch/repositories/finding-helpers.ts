import type { BacklogItem } from "../../core/backlog.js";
import type { PreparedAddBacklogItemInput } from "../../core/backlog-db.js";
import type { NearDuplicateCandidate } from "../near-duplicate.js";
import {
  HARNESS_ORIGIN_FINDING_SOURCE_SET,
  type HitchFinding,
  type HitchFindingSeverity,
  type HitchFindingSource,
  type HitchLifecycleStatus,
  type HitchScopeStatus,
} from "../types.js";
import { addWhere, addWhereIn } from "./shared.js";

/**
 * #125 Track C (C6) — pure helpers / constants / row converters / input types
 * for the finding concern, split out of `finding-repository.ts` to keep both
 * files under the 800-line cap. No DB access here: only deterministic finding
 * lifecycle/severity/scope logic and `hitch_findings` row hydration. The
 * transactional writers and the atomic `*Core` seam live in
 * `finding-repository.ts`; the single-BEGIN primitive (`runAtomically`) stays on
 * the `HitchRepository` facade (#306).
 */

export interface UpsertHitchFindingInput {
  findingId?: string;
  hitchId: string;
  stableKey?: string;
  duplicateOf?: string;
  source: HitchFindingSource;
  sourceRef?: string;
  sourceAttemptId?: string;
  sourceCycleId?: string;
  severity: HitchFindingSeverity;
  category: string;
  scopeStatus?: HitchScopeStatus;
  lifecycleStatus?: HitchLifecycleStatus;
  summary: string;
  detail?: string;
  filePath?: string;
  symbol?: string;
  suggestedFix?: string;
  seenAt?: string;
  classificationReason?: string;
}

export interface UpsertHitchFindingResult {
  finding: HitchFinding;
  created: boolean;
  reopened: boolean;
}

export interface ClassifyHitchFindingInput {
  findingId: string;
  scopeStatus: HitchScopeStatus;
  reason: string;
  duplicateOf?: string;
  classifiedAt?: string;
}

export interface MarkHitchFindingFixedInput {
  findingId: string;
  note?: string;
  fixedAt?: string;
}

/**
 * #278: input for {@link FindingRepository.resolveSupersededReviewFindings}. A
 * later APPROVING review cycle deterministically retires the prior cycles'
 * review-origin review-blocking findings for the SAME hitch. The trigger
 * (canonical approve) is computed by the harness from event-sourced
 * review_decisions / review_consensus rows — never an LLM "I fixed it" self-report.
 */
export interface ResolveSupersededReviewFindingsInput {
  /** Hitch whose prior review blockers are being superseded. */
  hitchId: string;
  /** The approving cycle that supersedes earlier blockers (same-cycle rows skipped). */
  supersedingCycleId: string;
  /** Allowlist of review-blocking categories to retire (REVIEW_BLOCKING_FINDING_CATEGORIES). */
  categories: readonly string[];
  /** Run id whose canonical APPROVE decision drove the supersession (audit trail). */
  decisionRunId: string;
  /** Deterministic resolution timestamp (defaults to now). */
  resolvedAt?: string;
}

export interface DeferHitchFindingInput {
  findingId: string;
  note?: string;
  backlogItemId?: string;
  deferredAt?: string;
}

export interface ClassifyAndDeferHitchFindingInput {
  findingId: string;
  reason: string;
  now?: Date;
  backlogItem?: {
    input: PreparedAddBacklogItemInput;
    fsFloor: number;
  };
}

export interface ClassifyAndDeferHitchFindingResult {
  finding: HitchFinding;
  backlogItemId: string | null;
  backlogItem?: BacklogItem;
  createdBacklogItem: boolean;
}

export interface HitchFindingFilter {
  hitchId?: string;
  scopeStatus?: HitchScopeStatus;
  scopeStatusIn?: readonly HitchScopeStatus[];
  lifecycleStatus?: HitchLifecycleStatus;
  lifecycleStatusIn?: readonly HitchLifecycleStatus[];
  severity?: HitchFindingSeverity;
  severityIn?: readonly HitchFindingSeverity[];
  limit?: number;
  /**
   * Skip the first `offset` rows (paging). Used by the read-only classify Phase 1
   * snapshot to walk the whole unknown set deterministically without writes
   * shrinking it mid-pass (#230 round-2 FIX 1). Ignored when 0/undefined.
   */
  offset?: number;
}

export interface HitchFindingSummaryCounts {
  openInScopeP0: number;
  openInScopeP1: number;
  openInScopeP2: number;
  openUnknownScope: number;
  openOutOfScope: number;
}

export interface HitchFindingRow {
  finding_id: string;
  hitch_id: string;
  stable_key: string;
  duplicate_of: string | null;
  source: HitchFindingSource;
  source_ref: string | null;
  source_attempt_id: string | null;
  source_cycle_id: string | null;
  severity: HitchFindingSeverity;
  category: string;
  scope_status: HitchScopeStatus;
  lifecycle_status: HitchLifecycleStatus;
  summary: string;
  detail: string | null;
  file_path: string | null;
  symbol: string | null;
  suggested_fix: string | null;
  first_seen_at: string;
  last_seen_at: string;
  fixed_at: string | null;
  deferred_at: string | null;
  escalated_at: string | null;
  reopen_count: number;
  deferred_backlog_item_id: string | null;
  classification_reason: string | null;
  resolution_note: string | null;
}

export interface HitchFindingIdentityRow {
  finding_id: string;
  hitch_id: string;
  category: string;
  scope_status: HitchScopeStatus;
  summary: string;
  file_path: string | null;
  symbol: string | null;
}

export interface HitchFindingSummaryRow {
  scope_status: HitchScopeStatus;
  severity: HitchFindingSeverity;
  lifecycle_status: HitchLifecycleStatus;
  n: number;
}

export const OPEN_FINDING_LIFECYCLES = [
  "open",
  "reopened",
  "escalated",
] as const satisfies readonly HitchLifecycleStatus[];

/**
 * #278: marker prefix for the deterministic resolution_note written by
 * {@link FindingRepository.resolveSupersededReviewFindings}. The prefix lets the
 * re-resolve path distinguish a STALE prior harness auto-resolve note (which
 * names an older superseding cycle and is safe to refresh) from a genuine
 * operator-authored note (which is preserved). Changing this string would orphan
 * existing notes from the refresh path, so keep it stable.
 */
export const AUTO_RESOLVE_NOTE_PREFIX = "auto-resolved: superseded by approving review";

export const UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES = [
  "open",
  "reopened",
  "out_of_scope",
  "escalated",
] as const satisfies readonly HitchLifecycleStatus[];

export const OPEN_FINDING_LIFECYCLE_SET = new Set<HitchLifecycleStatus>(
  OPEN_FINDING_LIFECYCLES,
);
export const UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET =
  new Set<HitchLifecycleStatus>(UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES);

export function isHarnessOriginFindingSource(
  source: HitchFindingSource,
): boolean {
  return HARNESS_ORIGIN_FINDING_SOURCE_SET.has(source);
}

export function defaultLifecycleForScope(
  scopeStatus: HitchScopeStatus,
): HitchLifecycleStatus {
  if (scopeStatus === "out_of_scope") return "out_of_scope";
  if (scopeStatus === "duplicate") return "duplicate";
  return "open";
}

export function moreSevere(
  current: HitchFindingSeverity,
  incoming: HitchFindingSeverity,
): HitchFindingSeverity {
  const rank: Record<HitchFindingSeverity, number> = {
    P0: 0,
    P1: 1,
    P2: 2,
    P3: 3,
    info: 4,
  };
  return rank[incoming] < rank[current] ? incoming : current;
}

export function moreBlockingScope(
  current: HitchScopeStatus,
  incoming: HitchScopeStatus,
): HitchScopeStatus {
  const rank: Record<HitchScopeStatus, number> = {
    duplicate: -1,
    out_of_scope: 0,
    unknown: 1,
    in_scope: 2,
  };
  return rank[incoming] > rank[current] ? incoming : current;
}

const NON_BLOCKING_CANONICAL_LIFECYCLES = new Set<HitchLifecycleStatus>([
  "deferred",
  "accepted_risk",
  "out_of_scope",
]);

export function shouldReopenForIncoming(
  canonicalLifecycleStatus: HitchLifecycleStatus,
  incomingScopeStatus: HitchScopeStatus,
  incomingLifecycleStatus: HitchLifecycleStatus,
  incomingSeverity: HitchFindingSeverity,
): boolean {
  return (
    NON_BLOCKING_CANONICAL_LIFECYCLES.has(canonicalLifecycleStatus) &&
    incomingCloseBlockerCandidate(
      incomingScopeStatus,
      incomingLifecycleStatus,
      incomingSeverity,
    )
  );
}

export function incomingCloseBlockerCandidate(
  scopeStatus: HitchScopeStatus,
  lifecycleStatus: HitchLifecycleStatus,
  severity: HitchFindingSeverity,
): boolean {
  if (!OPEN_FINDING_LIFECYCLE_SET.has(lifecycleStatus)) return false;
  if (scopeStatus !== "in_scope" && scopeStatus !== "unknown") return false;
  return severity === "P0" || severity === "P1" || severity === "P2";
}

const NEAR_DUPLICATE_CLASSIFICATION_PREFIX = "near-duplicate of ";

export function nearDuplicateClassificationReason(
  canonicalFindingId: string,
  classificationReason: string | undefined,
): string {
  const suffix =
    classificationReason === undefined || classificationReason.trim() === ""
      ? ""
      : `; ${classificationReason.trim()}`;
  return `${NEAR_DUPLICATE_CLASSIFICATION_PREFIX}${canonicalFindingId}${suffix}`;
}

export function isNearDuplicateClassificationReason(
  reason: string | null,
): boolean {
  return reason?.startsWith(NEAR_DUPLICATE_CLASSIFICATION_PREFIX) ?? false;
}

export function rowToFinding(row: HitchFindingRow): HitchFinding {
  return {
    findingId: row.finding_id,
    hitchId: row.hitch_id,
    stableKey: row.stable_key,
    duplicateOf: row.duplicate_of,
    source: row.source,
    sourceRef: row.source_ref,
    sourceAttemptId: row.source_attempt_id,
    sourceCycleId: row.source_cycle_id,
    severity: row.severity,
    category: row.category,
    scopeStatus: row.scope_status,
    lifecycleStatus: row.lifecycle_status,
    summary: row.summary,
    detail: row.detail,
    filePath: row.file_path,
    symbol: row.symbol,
    suggestedFix: row.suggested_fix,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    fixedAt: row.fixed_at,
    deferredAt: row.deferred_at,
    escalatedAt: row.escalated_at,
    reopenCount: row.reopen_count,
    deferredBacklogItemId: row.deferred_backlog_item_id,
    classificationReason: row.classification_reason,
    resolutionNote: row.resolution_note,
  };
}

export function rowToNearDuplicateCandidate(
  row: HitchFindingIdentityRow,
): NearDuplicateCandidate {
  return {
    findingId: row.finding_id,
    hitchId: row.hitch_id,
    category: row.category,
    scopeStatus: row.scope_status,
    summary: row.summary,
    filePath: row.file_path,
    symbol: row.symbol,
  };
}

export function addFindingWhereClauses(
  clauses: string[],
  args: unknown[],
  filter: HitchFindingFilter,
): void {
  addWhere(clauses, args, "hitch_id", filter.hitchId);
  addWhere(clauses, args, "scope_status", filter.scopeStatus);
  addWhereIn(clauses, args, "scope_status", filter.scopeStatusIn);
  addWhere(clauses, args, "lifecycle_status", filter.lifecycleStatus);
  addWhereIn(clauses, args, "lifecycle_status", filter.lifecycleStatusIn);
  addWhere(clauses, args, "severity", filter.severity);
  addWhereIn(clauses, args, "severity", filter.severityIn);
}
