import type Database from "better-sqlite3";
import { insertBacklogItemInTransaction } from "../../core/backlog-db.js";
import { DbError } from "../../db/connection.js";
import { hitchFindingStableKey } from "../stable-key.js";
import {
  REVIEW_BLOCKING_FINDING_CATEGORY_SET,
  type HitchFinding,
  type HitchScopeStatus,
} from "../types.js";
import {
  addFindingWhereClauses,
  AUTO_RESOLVE_NOTE_PREFIX,
  OPEN_FINDING_LIFECYCLE_SET,
  OPEN_FINDING_LIFECYCLES,
  rowToFinding,
  UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET,
  UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
  type ClassifyAndDeferHitchFindingInput,
  type ClassifyAndDeferHitchFindingResult,
  type ClassifyHitchFindingInput,
  type DeferHitchFindingInput,
  type HitchFindingFilter,
  type HitchFindingRow,
  type HitchFindingSummaryCounts,
  type HitchFindingSummaryRow,
  type MarkHitchFindingFixedInput,
  type ResolveSupersededReviewFindingsInput,
  type UpsertHitchFindingInput,
  type UpsertHitchFindingResult,
} from "./finding-helpers.js";
import {
  promoteDuplicateCanonical,
  upsertFindingWithin,
  type FindingWriteDeps,
} from "./finding-write.js";
import {
  latestCodingRunId,
  placeholders,
  touchHitchSession,
  whereSql,
} from "./shared.js";

/**
 * #125 Track C (C6) — the finding concern extracted from the frozen
 * `HitchRepository` by composition delegation. Owns the `hitch_findings`
 * lifecycle (upsert / classify / defer / fix / supersede-resolve) and the
 * finding reads (get / list / count / summary / churn reads).
 *
 * ATOMIC SEAM (#306 — do NOT change): the single-BEGIN primitive
 * (`runAtomically`) stays on the FACADE. This sub-repo exposes BOTH the public
 * transactional `upsertFinding` / `resolveSupersededReviewFindings` (which open
 * their OWN transaction) AND the non-transactional `upsertFindingCore` /
 * `resolveSupersededReviewFindingsCore` cores (which open NO transaction). The
 * facade forwards its `upsertFindingCore` / `resolveSupersededReviewFindingsCore`
 * here so they compose inside the facade's outer BEGIN on the SHARED `db` handle
 * (review-integration.ts calls `repo.upsertFindingCore` inside
 * `repo.runAtomically`). The public `upsertFinding` wrapper runs its pure prelude
 * (which may throw via `requireCanonicalDuplicateFinding`) BEFORE `db.transaction`
 * so a validation throw fails before any BEGIN, identical to pre-extraction.
 *
 * Holds the FACADE's `db` handle. `requireSession` / `latestCodingRunId` /
 * `touchHitchSession` come from the shared module so the session and finding
 * concerns read/write sessions identically. The heaviest write bodies
 * (`upsertFindingWithin` / `promoteDuplicateCanonical` / `findNearDuplicateForInput`)
 * live in `finding-write.ts` as free functions (file-size cap); they receive the
 * shared `db` + a `requireFinding` callback via {@link FindingWriteDeps}.
 */
export class FindingRepository {
  private readonly writeDeps: FindingWriteDeps;

  constructor(private readonly db: Database.Database) {
    this.writeDeps = {
      db,
      requireFinding: (findingId: string): HitchFinding =>
        this.requireFinding(findingId),
    };
  }

  upsertFinding(input: UpsertHitchFindingInput): UpsertHitchFindingResult {
    // #306 / P3: keep the public wrapper's transaction boundary identical to the
    // pre-refactor version — run the pure prelude (now / stable-key / scope /
    // duplicate-canonical validation, which may throw) OUTSIDE the transaction, so
    // a validation throw fails before any BEGIN exactly as on main. Only the write
    // body runs inside the (same `immediate` variant) transaction.
    const prepared = this.prepareUpsertFinding(input);
    return this.db
      .transaction(
        (): UpsertHitchFindingResult =>
          upsertFindingWithin(this.writeDeps, input, prepared),
      )
      .immediate();
  }

  /**
   * #306: non-transactional core of {@link upsertFinding} for the atomic review
   * import (via {@link runAtomically} in `importReviewProposalToHitch`). Runs the
   * IDENTICAL prelude + read + write logic but does NOT open its own transaction,
   * so it composes inside the single outer BEGIN. Effect-equivalent to the public
   * method; the public method only differs in opening its own tx.
   */
  upsertFindingCore(input: UpsertHitchFindingInput): UpsertHitchFindingResult {
    return upsertFindingWithin(this.writeDeps, input, this.prepareUpsertFinding(input));
  }

  // #306 / P3: pure prelude shared by the public wrapper and the atomic-import
  // core. May throw (requireCanonicalDuplicateFinding) — the public wrapper calls
  // this BEFORE opening a transaction so the throw boundary matches main.
  private prepareUpsertFinding(input: UpsertHitchFindingInput): {
    now: string;
    stableKey: string;
    scopeStatus: HitchScopeStatus;
    explicitDuplicateOf: string | null;
  } {
    const now = input.seenAt ?? new Date().toISOString();
    const stableKey =
      input.stableKey ??
      hitchFindingStableKey({
        filePath: input.filePath,
        symbol: input.symbol,
        category: input.category,
        summary: input.summary,
      });
    const scopeStatus = input.scopeStatus ?? "unknown";
    const explicitDuplicateOf =
      scopeStatus === "duplicate"
        ? this.requireCanonicalDuplicateFinding(
            input.hitchId,
            input.findingId,
            input.duplicateOf,
          )
        : null;
    return { now, stableKey, scopeStatus, explicitDuplicateOf };
  }

  // #306 / P3: the IDENTICAL write body of the former upsertFinding transaction —
  // no transaction is opened here, so it runs inside the caller's transaction (the
  // public wrapper's own tx, or the atomic import's outer BEGIN).

  classifyFinding(input: ClassifyHitchFindingInput): HitchFinding {
    const now = input.classifiedAt ?? new Date().toISOString();
    const current = this.requireFinding(input.findingId);
    const duplicateOf =
      input.scopeStatus === "duplicate"
        ? this.requireCanonicalDuplicateFinding(
            current.hitchId,
            current.findingId,
            input.duplicateOf,
          )
        : null;
    const lifecycleStatus =
      input.scopeStatus === "duplicate"
        ? "duplicate"
        : input.scopeStatus === "out_of_scope" &&
            current.lifecycleStatus !== "deferred"
          ? "out_of_scope"
          : input.scopeStatus === "unknown" &&
              current.lifecycleStatus !== "open" &&
              current.lifecycleStatus !== "reopened" &&
              current.lifecycleStatus !== "escalated"
            ? "open"
          : input.scopeStatus === "in_scope" &&
              (current.lifecycleStatus === "out_of_scope" ||
                current.lifecycleStatus === "duplicate" ||
                current.lifecycleStatus === "deferred")
            ? "open"
            : current.lifecycleStatus;
    this.db
      .prepare(
        `UPDATE hitch_findings
            SET scope_status = ?, lifecycle_status = ?, duplicate_of = ?,
                classification_reason = ?,
                deferred_at = CASE
                  WHEN ? IN ('in_scope', 'unknown') THEN NULL
                  ELSE deferred_at
                END,
                deferred_backlog_item_id = CASE
                  WHEN ? IN ('in_scope', 'unknown') THEN NULL
                  ELSE deferred_backlog_item_id
                END,
                fixed_at = CASE
                  WHEN ? IN ('in_scope', 'unknown') THEN NULL
                  ELSE fixed_at
                END,
                last_seen_at = ?
          WHERE finding_id = ?`,
      )
      .run(
        input.scopeStatus,
        lifecycleStatus,
        duplicateOf,
        input.reason,
        input.scopeStatus,
        input.scopeStatus,
        input.scopeStatus,
        now,
        input.findingId,
      );
    touchHitchSession(this.db, current.hitchId, now);
    if (duplicateOf !== null) {
      promoteDuplicateCanonical(this.writeDeps, 
        duplicateOf,
        current.severity,
        current.scopeStatus,
        current.lifecycleStatus,
        current.summary,
        current.detail ?? undefined,
        current.source,
        now,
      );
    }
    return this.requireFinding(input.findingId);
  }

  classifyAndDeferFinding(
    input: ClassifyAndDeferHitchFindingInput,
  ): ClassifyAndDeferHitchFindingResult {
    const nowDate = input.now ?? new Date();
    const now = nowDate.toISOString();
    const tx = this.db.transaction((): ClassifyAndDeferHitchFindingResult => {
      const current = this.requireFinding(input.findingId);
      this.classifyFinding({
        findingId: input.findingId,
        scopeStatus: "out_of_scope",
        reason: input.reason,
        classifiedAt: now,
      });
      const backlogItem =
        input.backlogItem === undefined
          ? null
          : insertBacklogItemInTransaction(
              this.db,
              input.backlogItem.input,
              nowDate,
              input.backlogItem.fsFloor,
            );
      const backlogItemId =
        backlogItem?.id ?? current.deferredBacklogItemId ?? undefined;
      const finding = this.deferFinding({
        findingId: input.findingId,
        note: input.reason,
        deferredAt: now,
        ...(backlogItemId !== undefined ? { backlogItemId } : {}),
      });
      return {
        finding,
        backlogItemId: finding.deferredBacklogItemId,
        ...(backlogItem !== null ? { backlogItem } : {}),
        createdBacklogItem: backlogItem !== null,
      };
    });
    return tx.immediate();
  }

  private requireCanonicalDuplicateFinding(
    hitchId: string,
    findingId: string | undefined,
    duplicateOf: string | undefined,
  ): string {
    if (duplicateOf === undefined) {
      throw new DbError("duplicate finding requires duplicateOf");
    }
    if (duplicateOf === findingId) {
      throw new DbError("duplicate finding cannot reference itself");
    }
    const canonical = this.requireFinding(duplicateOf);
    if (canonical.hitchId !== hitchId) {
      throw new DbError(
        `duplicate finding target belongs to a different hitch: ${duplicateOf}`,
      );
    }
    if (
      canonical.scopeStatus === "duplicate" ||
      canonical.lifecycleStatus === "duplicate" ||
      canonical.duplicateOf !== null
    ) {
      throw new DbError(
        `duplicate finding target is also a duplicate: ${duplicateOf}`,
      );
    }
    return canonical.findingId;
  }

  markFindingFixed(input: MarkHitchFindingFixedInput): HitchFinding {
    const now = input.fixedAt ?? new Date().toISOString();
    const current = this.requireFinding(input.findingId);
    this.db
      .prepare(
        `UPDATE hitch_findings
            SET lifecycle_status = 'fixed', fixed_at = ?,
                resolution_note = COALESCE(?, resolution_note),
                deferred_at = NULL,
                deferred_backlog_item_id = NULL,
                last_seen_at = ?
          WHERE finding_id = ?`,
      )
      .run(now, input.note ?? null, now, input.findingId);
    touchHitchSession(this.db, current.hitchId, now);
    return this.requireFinding(input.findingId);
  }

  /**
   * #278: deterministically retire prior cycles' review-origin review-blocking
   * findings once a later review cycle's canonical decision is APPROVED. This is
   * the harness-side equivalent of the operator running `hitch finding fixed` by
   * hand on every stale blocker after an approve — lifted into the harness and
   * bounded by a STRICT allowlist (fail-closed):
   *
   *   - source = 'review'                       (never human/mcp/test/doctor/codex/other)
   *   - category IN (caller allowlist)          (only review-blocking categories)
   *   - scope_status = 'in_scope'               (never out_of_scope/unknown/duplicate)
   *   - lifecycle_status IN ('open','reopened') (only still-open blockers)
   *   - severity <> 'P0'                         (defensive belt-and-suspenders)
   *   - duplicate_of IS NULL                    (never duplicate child rows)
   *   - source_cycle_id resolves to a SAME-hitch cycle with cycle_number STRICTLY
   *     LESS than the superseding cycle (proven-earlier; NULL/dangling/future/
   *     same-cycle ids are NOT proven-earlier and are left OPEN — fail-closed)
   *   - decisionRunId is the hitch's CURRENT review target (its latest coding run)
   *     when one exists — a stale/non-current run's approve retires nothing
   *     (fail-closed); see the current-review-target guard below
   *
   * Anything outside the allowlist is left OPEN (fail-closed). Only
   * `lifecycle_status` / `fixed_at` / `resolution_note` / `last_seen_at` change;
   * `source` and `source_cycle_id` are preserved, so the divergence audit ledger
   * (harnessOriginDivergenceMetrics, #196/#280) is unaffected. The trigger is
   * 100% harness-deterministic (canonical approve from the DB), never an LLM claim.
   * Returns the resolved findings (immutable snapshot), in first-seen order.
   */
  resolveSupersededReviewFindings(
    input: ResolveSupersededReviewFindingsInput,
  ): HitchFinding[] {
    // #306 / P3: keep the public wrapper's transaction boundary identical to the
    // pre-refactor version — run the pure prelude (allowlist filter + the
    // empty-category early-return) OUTSIDE the transaction, so the empty fast path
    // never opens a tx. Only the write core runs inside the (same `default` variant)
    // transaction.
    const prepared = this.prepareResolveSuperseded(input);
    if (prepared === null) return [];
    return this.db
      .transaction((): HitchFinding[] =>
        this.resolveSupersededReviewFindingsWithin(input, prepared),
      )
      .default();
  }

  /**
   * #306: non-transactional core of {@link resolveSupersededReviewFindings} for the
   * atomic review import (via {@link runAtomically} in
   * `importReviewProposalToHitch`). Runs the IDENTICAL prelude (allowlist filter +
   * empty-category short-circuit) and the IDENTICAL fail-closed allowlist +
   * current-target + strict-earlier-cycle write, but does NOT open its own
   * transaction so it composes inside the single outer BEGIN. Effect-equivalent to
   * the public method; the public method only differs in opening its own tx.
   */
  resolveSupersededReviewFindingsCore(
    input: ResolveSupersededReviewFindingsInput,
  ): HitchFinding[] {
    const prepared = this.prepareResolveSuperseded(input);
    if (prepared === null) return [];
    return this.resolveSupersededReviewFindingsWithin(input, prepared);
  }

  // #306 / P3: pure prelude shared by the public wrapper and the atomic-import
  // core. Returns null for the empty-category fast path (resolve nothing) so the
  // wrapper can short-circuit BEFORE opening a transaction (matching main).
  private prepareResolveSuperseded(
    input: ResolveSupersededReviewFindingsInput,
  ): { now: string; note: string; categories: string[]; categoryPlaceholders: string } | null {
    // Defense-in-depth (fail-closed): enforce the review-blocking allowlist
    // INSIDE the repository, not just at the caller. A caller can never widen the
    // set of auto-resolvable categories — any category outside
    // REVIEW_BLOCKING_FINDING_CATEGORIES is dropped here, so advisory / arbitrary
    // categories are never retired even if mistakenly passed in.
    const categories = input.categories.filter((category) =>
      REVIEW_BLOCKING_FINDING_CATEGORY_SET.has(category),
    );
    if (categories.length === 0) return null;
    const now = input.resolvedAt ?? new Date().toISOString();
    const note =
      `${AUTO_RESOLVE_NOTE_PREFIX} ` +
      `(run ${input.decisionRunId}, cycle ${input.supersedingCycleId})`;
    const categoryPlaceholders = placeholders(categories.length);
    return { now, note, categories, categoryPlaceholders };
  }

  // #306 / P3: the IDENTICAL write body of the former resolveSupersededReviewFindings
  // transaction — no transaction is opened here, so it runs inside the caller's
  // transaction (the public wrapper's own tx, or the atomic import's outer BEGIN).
  private resolveSupersededReviewFindingsWithin(
    input: ResolveSupersededReviewFindingsInput,
    prepared: { now: string; note: string; categories: string[]; categoryPlaceholders: string },
  ): HitchFinding[] {
    const { now, note, categories, categoryPlaceholders } = prepared;
    {
      // The superseding cycle must exist for this hitch; if it does not we cannot
      // prove any finding is from an EARLIER cycle, so resolve nothing (fail-closed).
      const supersedingCycle = this.db
        .prepare(
          `SELECT cycle_number FROM hitch_review_cycles
            WHERE cycle_id = ? AND hitch_id = ?`,
        )
        .get(input.supersedingCycleId, input.hitchId) as
        | { cycle_number: number }
        | undefined;
      if (supersedingCycle === undefined) return [];
      // CURRENT-REVIEW-TARGET guard (fail-closed): an approve only supersedes prior
      // blockers when it reviewed the hitch's CURRENT review target — the latest
      // coding run (newest implement/rerun attempt, ranked deterministically by
      // attempt iteration, NOT nullable runs.started_at). The earlier-cycle /
      // same-hitch predicate alone does NOT prove the approving run is current: the
      // MCP review.process path accepts any needs_review run linked by
      // project/repo/domain, so a manually-processed approve for a STALE/older run
      // could be imported as a later cycle and wrongly retire open blockers raised
      // against a DIFFERENT, NEWER run. If a coding-run target exists and the
      // approving run is not it, resolve nothing. When no coding run is recorded
      // (e.g. a direct primitive caller with no attempts) there is no target to
      // contradict, so the strict earlier-cycle predicate below governs alone.
      const currentTargetRunId = latestCodingRunId(this.db, input.hitchId);
      if (currentTargetRunId !== null && currentTargetRunId !== input.decisionRunId) {
        return [];
      }
      // STRICT earlier-cycle predicate (fail-closed): the finding's source_cycle_id
      // MUST reference a cycle of the SAME hitch whose cycle_number is strictly less
      // than the superseding cycle's. A NULL, dangling, future, or same source_cycle_id
      // is NOT proven-earlier and is left OPEN — the inner JOIN drops it. This is
      // tighter than `<> superseding` (which would admit null/future/foreign cycles)
      // and matches the documented "prior EARLIER cycle" semantics.
      const rows = this.db
        .prepare(
          `SELECT f.finding_id
             FROM hitch_findings f
             JOIN hitch_review_cycles c
               ON c.cycle_id = f.source_cycle_id
              AND c.hitch_id = f.hitch_id
            WHERE f.hitch_id = ?
              AND f.source = 'review'
              AND f.scope_status = 'in_scope'
              AND f.lifecycle_status IN ('open', 'reopened')
              AND f.severity <> 'P0'
              AND f.duplicate_of IS NULL
              AND f.category IN (${categoryPlaceholders})
              AND c.cycle_number < ?
            ORDER BY f.first_seen_at ASC, f.finding_id ASC`,
        )
        .all(input.hitchId, ...categories, supersedingCycle.cycle_number) as Array<{
        finding_id: string;
      }>;
      if (rows.length === 0) return [];
      // Reuse the SAME open->fixed lifecycle edge as markFindingFixed. The
      // resolution_note is written so the AUDIT record always names the CURRENT
      // superseding cycle (#278): set the fresh note when there is none OR when the
      // existing note is a prior harness auto-resolve note (which would otherwise
      // name a STALE older cycle after a reopen->approve), but PRESERVE a genuine
      // operator-authored note. The marker prefix carries no LIKE wildcards, and
      // `${prefix}%` is a bound parameter, so this stays injection-safe.
      const update = this.db.prepare(
        `UPDATE hitch_findings
            SET lifecycle_status = 'fixed', fixed_at = ?,
                resolution_note = CASE
                  WHEN resolution_note IS NULL OR resolution_note LIKE ? THEN ?
                  ELSE resolution_note
                END,
                deferred_at = NULL,
                deferred_backlog_item_id = NULL,
                last_seen_at = ?
          WHERE finding_id = ?`,
      );
      const autoNoteLikePattern = `${AUTO_RESOLVE_NOTE_PREFIX}%`;
      for (const row of rows) {
        update.run(now, autoNoteLikePattern, note, now, row.finding_id);
      }
      touchHitchSession(this.db, input.hitchId, now);
      return rows.map((row) => this.requireFinding(row.finding_id));
    }
  }

  deferFinding(input: DeferHitchFindingInput): HitchFinding {
    const now = input.deferredAt ?? new Date().toISOString();
    const current = this.requireFinding(input.findingId);
    if (current.scopeStatus !== "out_of_scope") {
      throw new DbError(
        `hitch finding ${input.findingId} cannot be deferred while scope is ${current.scopeStatus}; classify it out_of_scope first`,
      );
    }
    this.db
      .prepare(
        `UPDATE hitch_findings
            SET lifecycle_status = 'deferred', deferred_at = ?,
                deferred_backlog_item_id = COALESCE(?, deferred_backlog_item_id),
                resolution_note = COALESCE(?, resolution_note),
                fixed_at = NULL,
                last_seen_at = ?
          WHERE finding_id = ?`,
      )
      .run(
        now,
        input.backlogItemId ?? null,
        input.note ?? null,
        now,
        input.findingId,
      );
    touchHitchSession(this.db, current.hitchId, now);
    return this.requireFinding(input.findingId);
  }

  /**
   * Attach an external tracking issue URL to a DEFERRED finding (#90 Stage B).
   * SOLE writer of deferred_issue_url. Operator-only: called exclusively from
   * the CLI `finding defer --to-issue` action — never from ingest/MCP/orchestrator
   * (which keeps the issue link out of any LLM-reachable path). First-fix:
   * COALESCE(deferred_issue_url, ?) keeps the first linked URL (re-link is a
   * no-op), matching the backlog-id behaviour. `issueUrl` MUST already be a
   * validated canonical GitHub issue URL (parseIssueUrl).
   */
  linkFindingIssue(findingId: string, issueUrl: string): HitchFinding {
    const current = this.requireFinding(findingId);
    if (current.lifecycleStatus !== "deferred") {
      throw new DbError(
        `hitch finding ${findingId} must be deferred before linking an issue (lifecycle=${current.lifecycleStatus})`,
      );
    }
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE hitch_findings
            SET deferred_issue_url = COALESCE(deferred_issue_url, ?)
          WHERE finding_id = ?`,
      )
      .run(issueUrl, findingId);
    touchHitchSession(this.db, current.hitchId, now);
    return this.requireFinding(findingId);
  }

  getFinding(findingId: string): HitchFinding | null {
    const row = this.db
      .prepare("SELECT * FROM hitch_findings WHERE finding_id = ?")
      .get(findingId) as HitchFindingRow | undefined;
    return row === undefined ? null : rowToFinding(row);
  }

  requireFinding(findingId: string): HitchFinding {
    const finding = this.getFinding(findingId);
    if (finding === null) throw new DbError(`hitch finding not found: ${findingId}`);
    return finding;
  }

  listFindings(filter: HitchFindingFilter = {}): HitchFinding[] {
    const clauses: string[] = [];
    const args: unknown[] = [];
    addFindingWhereClauses(clauses, args, filter);
    const limit = filter.limit ?? 200;
    const offset = filter.offset ?? 0;
    const rows = this.db
      .prepare(
        "SELECT * FROM hitch_findings" +
          whereSql(clauses) +
          " ORDER BY first_seen_at ASC, finding_id ASC LIMIT ? OFFSET ?",
      )
      .all(...args, limit, offset) as HitchFindingRow[];
    return rows.map(rowToFinding);
  }

  countFindings(filter: HitchFindingFilter = {}): number {
    const clauses: string[] = [];
    const args: unknown[] = [];
    addFindingWhereClauses(clauses, args, filter);
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM hitch_findings" + whereSql(clauses),
      )
      .get(...args) as { n: number };
    return row.n;
  }

  countFindingSummary(hitchId: string): HitchFindingSummaryCounts {
    const activePlaceholders = placeholders(OPEN_FINDING_LIFECYCLES.length);
    const outOfScopePlaceholders = placeholders(
      UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES.length,
    );
    const rows = this.db
      .prepare(
        `SELECT scope_status, severity, lifecycle_status, COUNT(*) AS n
           FROM hitch_findings
          WHERE hitch_id = ?
            AND (
              lifecycle_status IN (${activePlaceholders})
              OR (
                scope_status = 'out_of_scope'
                AND lifecycle_status IN (${outOfScopePlaceholders})
              )
            )
          GROUP BY scope_status, severity, lifecycle_status`,
      )
      .all(
        hitchId,
        ...OPEN_FINDING_LIFECYCLES,
        ...UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLES,
      ) as HitchFindingSummaryRow[];

    const counts: HitchFindingSummaryCounts = {
      openInScopeP0: 0,
      openInScopeP1: 0,
      openInScopeP2: 0,
      openUnknownScope: 0,
      openOutOfScope: 0,
    };
    for (const row of rows) {
      if (row.scope_status === "out_of_scope") {
        if (
          UNRESOLVED_OUT_OF_SCOPE_FINDING_LIFECYCLE_SET.has(
            row.lifecycle_status,
          )
        ) {
          counts.openOutOfScope += row.n;
        }
        continue;
      }
      if (!OPEN_FINDING_LIFECYCLE_SET.has(row.lifecycle_status)) continue;
      if (row.scope_status === "unknown") {
        counts.openUnknownScope += row.n;
      } else if (row.scope_status === "in_scope") {
        if (row.severity === "P0") counts.openInScopeP0 += row.n;
        else if (row.severity === "P1") counts.openInScopeP1 += row.n;
        else if (row.severity === "P2") counts.openInScopeP2 += row.n;
      }
    }
    return counts;
  }

  maxFindingReopenCount(hitchId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(reopen_count), 0) AS n
           FROM hitch_findings
          WHERE hitch_id = ?`,
      )
      .get(hitchId) as { n: number };
    return row.n;
  }

  latestFindingMutationAt(hitchId: string): string | null {
    const row = this.db
      .prepare(
        `WITH finding_mutations(ts) AS (
           SELECT last_seen_at FROM hitch_findings WHERE hitch_id = ?
           UNION ALL
           SELECT fixed_at FROM hitch_findings
            WHERE hitch_id = ? AND fixed_at IS NOT NULL
           UNION ALL
           SELECT deferred_at FROM hitch_findings
            WHERE hitch_id = ? AND deferred_at IS NOT NULL
           UNION ALL
           SELECT escalated_at FROM hitch_findings
            WHERE hitch_id = ? AND escalated_at IS NOT NULL
         )
         SELECT MAX(ts) AS latest FROM finding_mutations`,
      )
      .get(hitchId, hitchId, hitchId, hitchId) as { latest: string | null };
    return row.latest;
  }

}
