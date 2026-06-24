import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { Phase, PhaseNode, PhaseStatus } from "./types.js";
import { CourseUserError, ReviewStateConflictError } from "./errors.js";
import { LeaseGuardFailedError } from "../workspace/db-domain-lock.js";
import {
  parseHitchCloseConditions,
  parseHitchScope,
} from "../hitch/schemas.js";
import {
  closeConditionsLoosenGate,
  isScopeWidening,
} from "../hitch/spec-gates.js";
import { assertValidCloseConditions } from "../hitch/spec-validation.js";
import type { HitchCloseCondition, HitchScope } from "../hitch/types.js";

interface PhaseRow {
  phase_id: string; course_id: string; parent_phase_id: string | null;
  title: string; position: number; status: PhaseStatus;
  scope_json: string | null; close_conditions_json: string | null; review_state_json: string | null;
  created_by: string | null; created_source: string | null; created_at: string; updated_at: string;
}

interface PhaseReviewStateRow {
  review_state_json: string | null;
  review_state_version: number;
  scope_json: string | null;
  close_conditions_json: string | null;
}

function parse(text: string | null): unknown { return text === null ? null : JSON.parse(text); }

function reviewStateObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function phaseSpecHash(scope: unknown, closeConditions: unknown): string {
  // Hash a structured tuple, not concatenated scalars: `1`+`23` and `12`+`3`
  // would otherwise collide on "123" and let a spec drift slip past (codex SP-3).
  return createHash("sha256")
    .update(canonicalJson([scope, closeConditions]))
    .digest("hex");
}

export interface PhaseSpecApproval {
  approvedBy: string;
  approvedAt: string;
  reason: string;
  specHash: string;
}

export interface PhaseSpecApprovalStatus {
  approval: PhaseSpecApproval | null;
  currentSpecHash: string;
  approvedSpecHash: string | null;
  drifted: boolean;
}

export function phaseSpecApprovalFromReviewState(
  reviewState: unknown,
): PhaseSpecApproval | null {
  const rs = reviewState;
  if (rs === null || typeof rs !== "object" || Array.isArray(rs)) return null;
  const value = (rs as Record<string, unknown>).specApproval;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const approval = value as Record<string, unknown>;
  if (
    typeof approval.approvedBy !== "string" ||
    typeof approval.approvedAt !== "string" ||
    typeof approval.reason !== "string" ||
    typeof approval.specHash !== "string"
  ) {
    return null;
  }
  return {
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    reason: approval.reason,
    specHash: approval.specHash,
  };
}

export function phaseSpecApproval(phase: Phase): PhaseSpecApproval | null {
  return phaseSpecApprovalFromReviewState(phase.reviewState);
}

export function phaseSpecApprovalStatusForSpec(input: {
  scope: unknown;
  closeConditions: unknown;
  reviewState: unknown;
}): PhaseSpecApprovalStatus {
  const currentSpecHash = phaseSpecHash(input.scope, input.closeConditions);
  const approval = phaseSpecApprovalFromReviewState(input.reviewState);
  return {
    approval,
    currentSpecHash,
    approvedSpecHash: approval?.specHash ?? null,
    drifted: approval !== null && approval.specHash !== currentSpecHash,
  };
}

export function phaseSpecApprovalStatus(phase: Phase): PhaseSpecApprovalStatus {
  return phaseSpecApprovalStatusForSpec({
    scope: phase.scope,
    closeConditions: phase.closeConditions,
    reviewState: phase.reviewState,
  });
}

function mapPhase(r: PhaseRow): Phase {
  return {
    phaseId: r.phase_id, courseId: r.course_id, parentPhaseId: r.parent_phase_id,
    title: r.title, position: r.position, status: r.status,
    scope: parse(r.scope_json), closeConditions: parse(r.close_conditions_json), reviewState: parse(r.review_state_json),
    createdBy: r.created_by, createdSource: r.created_source, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/**
 * Operator audit note for a phase (#171b). Stored under the generic
 * `review_state_json` blob as `{ note }`, so it composes with any other
 * review-state keys. Returns null when absent or empty.
 */
export function phaseNote(phase: Phase): string | null {
  const rs = phase.reviewState;
  if (rs !== null && typeof rs === "object" && !Array.isArray(rs)) {
    const note = (rs as Record<string, unknown>).note;
    if (typeof note === "string" && note !== "") return note;
  }
  return null;
}

export interface PhaseLeaseGuard {
  lockId: number;
  holderRunId: string;
  nowMs: number;
}

export interface TransitionStatusOptions {
  now?: string;
  leaseGuard?: PhaseLeaseGuard;
}

export interface UpdateReviewStateContext {
  phaseId: string;
  reviewStateVersion: number;
  scope: unknown;
  closeConditions: unknown;
}

export type ReviewStateMutator = (
  state: Readonly<Record<string, unknown>>,
  context: UpdateReviewStateContext,
) => Record<string, unknown>;

export interface UpdateReviewStateOptions {
  now?: string;
  maxAttempts?: number;
}

export interface RecordSpecApprovalInput {
  approvedBy: string;
  reason?: string;
  now?: string;
  maxAttempts?: number;
}

export interface UpdatePhaseSpecInput {
  phaseId: string;
  scope?: unknown;
  closeConditions?: unknown;
  allowScopeWiden?: boolean;
  allowGateLoosen?: boolean;
  now?: string;
}

export interface UpdatePhaseInput extends UpdatePhaseSpecInput {
  status?: PhaseStatus;
  note?: string;
}

export interface LinkHitchOptions {
  now?: string;
  allowScopeWiden?: boolean;
  allowGateLoosen?: boolean;
}

export interface LinkHitchResult {
  phaseId: string;
  hitchId: string;
  warnings: string[];
  specApproval: PhaseSpecApprovalStatus;
}

const DEFAULT_REVIEW_STATE_CAS_ATTEMPTS = 3;

export class PhaseRepository {
  constructor(private readonly db: Database.Database) {}

  add(input: {
    courseId: string; parentPhaseId?: string; title: string; position?: number;
    scope?: unknown; closeConditions?: unknown;
    phaseId?: string;
    createdBy: string; createdSource: string; now?: string;
  }): Phase {
    const scope = normalizeOptionalPhaseScope(input.scope);
    const closeConditions = normalizeOptionalPhaseCloseConditions(
      input.closeConditions,
    );
    return this.db.transaction(() => {
      const course = this.db.prepare("SELECT 1 FROM courses WHERE course_id = ?").get(input.courseId) as { "1": number } | undefined;
      if (course === undefined) throw new CourseUserError(`course ${input.courseId} not found`);
      // integrity: parent must exist AND be in the same course
      if (input.parentPhaseId !== undefined) {
        const parent = this.db.prepare("SELECT course_id FROM phases WHERE phase_id = ?").get(input.parentPhaseId) as { course_id: string } | undefined;
        if (parent === undefined) throw new CourseUserError(`parent phase ${input.parentPhaseId} not found`);
        if (parent.course_id !== input.courseId) throw new CourseUserError(`parent phase ${input.parentPhaseId} is in a different course`);
      }
      const id = input.phaseId ?? `phase-${randomUUID()}`;
      const now = input.now ?? new Date().toISOString();
      const parentPhaseId = input.parentPhaseId ?? null;
      const position = input.position ?? (this.db.prepare(
        `SELECT COALESCE(MAX(position) + 1, 0) AS position
           FROM phases
          WHERE course_id = ? AND parent_phase_id IS ?`,
      ).get(input.courseId, parentPhaseId) as { position: number }).position;
      this.db.prepare(
        `INSERT INTO phases (phase_id, course_id, parent_phase_id, title, position, status, scope_json, close_conditions_json, created_by, created_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.courseId, parentPhaseId, input.title, position,
        scope === undefined ? null : JSON.stringify(scope),
        closeConditions === undefined ? null : JSON.stringify(closeConditions),
        input.createdBy, input.createdSource, now, now);
      return this.require(id);
    }).immediate();
  }

  get(phaseId: string): Phase | null {
    const r = this.db.prepare("SELECT * FROM phases WHERE phase_id = ?").get(phaseId) as PhaseRow | undefined;
    return r === undefined ? null : mapPhase(r);
  }
  require(phaseId: string): Phase {
    const p = this.get(phaseId);
    if (p === null) throw new CourseUserError(`phase ${phaseId} not found`);
    return p;
  }

  listForCourse(courseId: string): Phase[] {
    return (this.db.prepare(
      "SELECT * FROM phases WHERE course_id = ? ORDER BY position ASC, created_at ASC, phase_id ASC",
    ).all(courseId) as PhaseRow[]).map(mapPhase);
  }

  /** Build the phase forest for a course (deterministic: position, created_at, then phase_id). */
  tree(courseId: string): PhaseNode[] {
    const all = this.listForCourse(courseId);
    const byParent = new Map<string | null, Phase[]>();
    for (const p of all) {
      const k = p.parentPhaseId;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k)!.push(p);
    }
    const build = (parentId: string | null): PhaseNode[] =>
      (byParent.get(parentId) ?? []).map((phase) => ({ phase, children: build(phase.phaseId) }));
    return build(null);
  }

  setStatus(phaseId: string, status: PhaseStatus, now?: string): Phase {
    this.require(phaseId);
    this.db.prepare("UPDATE phases SET status = ?, updated_at = ? WHERE phase_id = ?")
      .run(status, now ?? new Date().toISOString(), phaseId);
    return this.require(phaseId);
  }

  updateSpec(input: UpdatePhaseSpecInput): Phase {
    if (input.scope === undefined && input.closeConditions === undefined) {
      throw new CourseUserError("updateSpec requires scope or closeConditions");
    }
    const nextScope = normalizeOptionalPhaseScope(input.scope);
    const nextCloseConditions = normalizeOptionalPhaseCloseConditions(
      input.closeConditions,
    );
    const ts = input.now ?? new Date().toISOString();
    return this.db.transaction(() => {
      const current = this.require(input.phaseId);
      if (
        nextScope !== undefined &&
        input.allowScopeWiden !== true &&
        isScopeWidening(phaseScope(current.scope), nextScope)
      ) {
        throw new CourseUserError(
          `phase ${input.phaseId} scope widen requires --allow-scope-widen`,
        );
      }
      if (
        nextCloseConditions !== undefined &&
        input.allowGateLoosen !== true &&
        closeConditionsLoosenGate(
          phaseCloseConditions(current.closeConditions),
          nextCloseConditions,
        )
      ) {
        throw new CourseUserError(
          `phase ${input.phaseId} gate loosen requires --allow-gate-loosen`,
        );
      }

      const sets: string[] = [];
      const args: unknown[] = [];
      if (nextScope !== undefined) {
        sets.push("scope_json = ?");
        args.push(JSON.stringify(nextScope));
      }
      if (nextCloseConditions !== undefined) {
        sets.push("close_conditions_json = ?");
        args.push(JSON.stringify(nextCloseConditions));
      }
      sets.push("updated_at = ?");
      args.push(ts, input.phaseId);
      const info = this.db
        .prepare(`UPDATE phases SET ${sets.join(", ")} WHERE phase_id = ?`)
        .run(...args);
      if (info.changes !== 1) {
        throw new CourseUserError(`phase ${input.phaseId} not found`);
      }
      return this.require(input.phaseId);
    }).immediate();
  }

  /**
   * Atomically applies the CLI phase update surface: spec replacement,
   * declared status, and operator note. Any failure rolls back the whole set.
   */
  update(input: UpdatePhaseInput): Phase {
    const hasSpecUpdate =
      input.scope !== undefined || input.closeConditions !== undefined;
    if (
      !hasSpecUpdate &&
      input.status === undefined &&
      input.note === undefined
    ) {
      return this.require(input.phaseId);
    }
    const ts = input.now ?? new Date().toISOString();
    return this.db
      .transaction(() => {
        if (hasSpecUpdate) {
          this.updateSpec({
            phaseId: input.phaseId,
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
            ...(input.closeConditions !== undefined
              ? { closeConditions: input.closeConditions }
              : {}),
            ...(input.allowScopeWiden !== undefined
              ? { allowScopeWiden: input.allowScopeWiden }
              : {}),
            ...(input.allowGateLoosen !== undefined
              ? { allowGateLoosen: input.allowGateLoosen }
              : {}),
            now: ts,
          });
        } else {
          this.require(input.phaseId);
        }
        if (input.status !== undefined) {
          this.setStatus(input.phaseId, input.status, ts);
        }
        if (input.note !== undefined) {
          this.setNote(input.phaseId, input.note, ts);
        }
        return this.require(input.phaseId);
      })
      .immediate();
  }

  /**
   * Set an operator audit note (#171b) — e.g. a force-close reason or PR ref —
   * making `phase update --status closed` symmetric with `hitch close --summary`
   * / `hitch cancel --reason`. Uses the versioned review-state CAS path so
   * unrelated keys survive.
   */
  setNote(phaseId: string, note: string, now?: string): Phase {
    return this.updateReviewState(
      phaseId,
      (state) => ({ ...state, note }),
      now === undefined ? undefined : { now },
    );
  }

  updateReviewState(
    phaseId: string,
    mutator: ReviewStateMutator,
    opts?: UpdateReviewStateOptions,
  ): Phase {
    const maxAttempts = normalizeReviewStateAttempts(opts?.maxAttempts);
    const ts = opts?.now ?? new Date().toISOString();
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let updated: Phase | null;
      try {
        updated = this.db
          .transaction(() => {
            const row = this.db
              .prepare(
                `SELECT review_state_json, review_state_version, scope_json, close_conditions_json
                   FROM phases
                  WHERE phase_id = ?`,
              )
              .get(phaseId) as PhaseReviewStateRow | undefined;
            if (row === undefined) throw new CourseUserError(`phase ${phaseId} not found`);
            const current = reviewStateObject(parse(row.review_state_json));
            const next = mutator(current, {
              phaseId,
              reviewStateVersion: row.review_state_version,
              scope: parse(row.scope_json),
              closeConditions: parse(row.close_conditions_json),
            });
            const info = this.db
              .prepare(
                `UPDATE phases
                    SET review_state_json = ?,
                        review_state_version = review_state_version + 1,
                        updated_at = ?
                  WHERE phase_id = ? AND review_state_version = ?`,
              )
              .run(JSON.stringify(next), ts, phaseId, row.review_state_version);
            return info.changes > 0 ? this.require(phaseId) : null;
          })
          .immediate();
      } catch (e) {
        // A concurrent writer holding the write lock surfaces (after
        // busy_timeout) as SQLITE_BUSY rather than a CAS miss. Fold it into
        // the same bounded retry budget so contention always resolves to a
        // typed ReviewStateConflictError (fail-closed), never a raw error.
        if (!isSqliteBusy(e)) throw e;
        updated = null;
      }
      if (updated !== null) return updated;
    }
    throw new ReviewStateConflictError(
      phaseId,
      maxAttempts,
      this.latestReviewStateVersion(phaseId),
    );
  }

  recordSpecApproval(
    phaseId: string,
    input: RecordSpecApprovalInput,
  ): Phase {
    const approvedBy = input.approvedBy.trim();
    if (approvedBy === "") {
      throw new CourseUserError("phase spec approval requires approvedBy");
    }
    const approvedAt = input.now ?? new Date().toISOString();
    return this.updateReviewState(
      phaseId,
      (state, context) => ({
        ...state,
        specApproval: {
          approvedBy,
          approvedAt,
          reason: input.reason ?? "",
          specHash: phaseSpecHash(context.scope, context.closeConditions),
        },
      }),
      {
        now: approvedAt,
        ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }),
      },
    );
  }

  /**
   * CAS 遷移: 現在 status が `from` のいずれかのときのみ `to` に更新する。
   * 遷移できたら true、現在値が `from` 外（または phase 不在）なら false（no-op）。
   * driver の自動 write が operator の宣言（blocked/closed）を後勝ちで上書きしない
   * ようにするための lost-update 防止。
   */
  transitionStatus(
    phaseId: string,
    from: PhaseStatus[],
    to: PhaseStatus,
    opts?: string | TransitionStatusOptions,
  ): boolean {
    if (from.length === 0) return false;
    const placeholders = from.map(() => "?").join(", ");
    const normalized = normalizeTransitionStatusOptions(opts);
    const ts = normalized.now ?? new Date().toISOString();
    const leaseGuard = normalized.leaseGuard;
    const leaseGuardSql =
      leaseGuard === undefined
        ? ""
        : ` AND EXISTS (
              SELECT 1 FROM domain_locks
               WHERE lock_id = ? AND holder_run_id = ? AND released_at IS NULL
                 AND expires_at > ?
            )`;
    const leaseGuardArgs =
      leaseGuard === undefined
        ? []
        : [
            leaseGuard.lockId,
            leaseGuard.holderRunId,
            leaseGuardNowIso(leaseGuard),
          ];
    const info = this.db
      .prepare(
        `UPDATE phases SET status = ?, updated_at = ?
          WHERE phase_id = ? AND status IN (${placeholders})${leaseGuardSql}`,
      )
      .run(to, ts, phaseId, ...from, ...leaseGuardArgs);
    if (info.changes > 0) return true;
    if (leaseGuard !== undefined) this.assertLeaseGuardHeld(leaseGuard);
    return false;
  }

  assertLeaseGuardHeld(leaseGuard: PhaseLeaseGuard): void {
    const active = this.db
      .prepare(
        `SELECT 1 FROM domain_locks
          WHERE lock_id = ? AND holder_run_id = ? AND released_at IS NULL
            AND expires_at > ?`,
      )
      .get(
        leaseGuard.lockId,
        leaseGuard.holderRunId,
        leaseGuardNowIso(leaseGuard),
      );
    if (active === undefined) {
      throw new LeaseGuardFailedError(leaseGuard.holderRunId);
    }
  }

  /**
   * Link a hitch to a phase. Rejects a project mismatch and a double-link (PK).
   * If the phase has been ratified, the hitch spec must match or tighten the
   * current phase spec unless the caller explicitly accepts a loosened gate.
   */
  linkHitch(
    phaseId: string,
    hitchId: string,
    opts?: string | LinkHitchOptions,
  ): LinkHitchResult {
    const options = normalizeLinkHitchOptions(opts);
    const phase = this.require(phaseId);
    const course = this.db
      .prepare("SELECT project_id FROM courses WHERE course_id = ?")
      .get(phase.courseId) as { project_id: string | null } | undefined;
    const hitch = this.db
      .prepare(
        `SELECT project_id, scope_json, close_conditions_json
           FROM hitch_sessions
          WHERE hitch_id = ?`,
      )
      .get(hitchId) as
      | {
          project_id: string | null;
          scope_json: string;
          close_conditions_json: string;
        }
      | undefined;
    if (hitch === undefined) {
      throw new CourseUserError(`hitch ${hitchId} not found`);
    }
    if (course?.project_id != null && hitch.project_id !== course.project_id) {
      throw new CourseUserError(
        `hitch ${hitchId} belongs to a different project than course ${phase.courseId}`,
      );
    }
    const specApproval = this.assertRatifiedSpecAllowsHitch(phase, hitchId, {
      scope: parseHitchScope(parse(hitch.scope_json) ?? {}),
      closeConditions: parseHitchCloseConditions(
        parse(hitch.close_conditions_json) ?? [],
      ),
      allowScopeWiden: options.allowScopeWiden === true,
      allowGateLoosen: options.allowGateLoosen === true,
    });
    try {
      this.db
        .prepare(
          "INSERT INTO phase_hitches (hitch_id, phase_id, linked_at) VALUES (?, ?, ?)",
        )
        .run(hitchId, phaseId, options.now ?? new Date().toISOString());
    } catch (e) {
      // only the PK violation means "already linked"; rethrow anything else.
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new CourseUserError(
          `hitch ${hitchId} is already linked to a phase`,
          { cause: e },
        );
      }
      throw e;
    }
    return {
      phaseId,
      hitchId,
      warnings: ratifiedSpecWarnings(phase, specApproval),
      specApproval,
    };
  }

  unlinkHitch(hitchId: string): boolean {
    const info = this.db
      .prepare("DELETE FROM phase_hitches WHERE hitch_id = ?")
      .run(hitchId);
    return info.changes > 0;
  }

  hitchIdsFor(phaseId: string): string[] {
    return (this.db.prepare("SELECT hitch_id FROM phase_hitches WHERE phase_id = ? ORDER BY linked_at ASC, hitch_id ASC").all(phaseId) as Array<{ hitch_id: string }>).map((r) => r.hitch_id);
  }

  private latestReviewStateVersion(phaseId: string): number | null {
    const row = this.db
      .prepare("SELECT review_state_version FROM phases WHERE phase_id = ?")
      .get(phaseId) as { review_state_version: number } | undefined;
    return row?.review_state_version ?? null;
  }

  private assertRatifiedSpecAllowsHitch(
    phase: Phase,
    hitchId: string,
    input: {
      scope: HitchScope;
      closeConditions: HitchCloseCondition[];
      allowScopeWiden: boolean;
      allowGateLoosen: boolean;
    },
  ): PhaseSpecApprovalStatus {
    const status = phaseSpecApprovalStatus(phase);
    if (status.approval === null) return status;
    const phaseScopeValue = phaseScope(phase.scope);
    const phaseCloseConditionsValue = phaseCloseConditions(
      phase.closeConditions,
    );
    if (
      !input.allowScopeWiden &&
      isScopeWidening(phaseScopeValue, input.scope)
    ) {
      throw new CourseUserError(
        `phase ${phase.phaseId} ratified spec forbids linking hitch ${hitchId}: scope widen requires --allow-scope-widen`,
      );
    }
    if (
      !input.allowGateLoosen &&
      closeConditionsLoosenGate(
        phaseCloseConditionsValue,
        input.closeConditions,
      )
    ) {
      throw new CourseUserError(
        `phase ${phase.phaseId} ratified spec forbids linking hitch ${hitchId}: gate loosen requires --allow-gate-loosen`,
      );
    }
    return status;
  }
}

function normalizeTransitionStatusOptions(
  opts: string | TransitionStatusOptions | undefined,
): TransitionStatusOptions {
  return typeof opts === "string" ? { now: opts } : opts ?? {};
}

function normalizeLinkHitchOptions(
  opts: string | LinkHitchOptions | undefined,
): LinkHitchOptions {
  return typeof opts === "string" ? { now: opts } : opts ?? {};
}

function leaseGuardNowIso(leaseGuard: PhaseLeaseGuard): string {
  return new Date(leaseGuard.nowMs).toISOString();
}

function normalizeReviewStateAttempts(value: number | undefined): number {
  const attempts = value ?? DEFAULT_REVIEW_STATE_CAS_ATTEMPTS;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new CourseUserError("review_state CAS maxAttempts must be a positive integer");
  }
  return attempts;
}

function normalizeOptionalPhaseScope(value: unknown | undefined): HitchScope | undefined {
  if (value === undefined) return undefined;
  try {
    return parseHitchScope(value);
  } catch (e) {
    throw new CourseUserError((e as Error).message, { cause: e });
  }
}

function normalizeOptionalPhaseCloseConditions(
  value: unknown | undefined,
): HitchCloseCondition[] | undefined {
  if (value === undefined) return undefined;
  try {
    const conditions = parseHitchCloseConditions(value);
    assertValidCloseConditions(conditions);
    return conditions;
  } catch (e) {
    throw new CourseUserError((e as Error).message, { cause: e });
  }
}

function phaseScope(value: unknown): HitchScope {
  try {
    return parseHitchScope(value ?? {});
  } catch (e) {
    throw new CourseUserError((e as Error).message, { cause: e });
  }
}

function phaseCloseConditions(value: unknown): HitchCloseCondition[] {
  try {
    return parseHitchCloseConditions(value ?? []);
  } catch (e) {
    throw new CourseUserError((e as Error).message, { cause: e });
  }
}

function isSqliteBusy(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT";
}

function ratifiedSpecWarnings(
  phase: Phase,
  status: PhaseSpecApprovalStatus,
): string[] {
  if (!status.drifted) return [];
  return [
    `phase ${phase.phaseId} spec approval hash drift: approved=${status.approvedSpecHash} current=${status.currentSpecHash}`,
  ];
}
