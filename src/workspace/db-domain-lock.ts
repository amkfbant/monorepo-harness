import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * DB-backed domain lock (Phase 9-4).
 *
 * Replaces the file-only domain lock with a lease-based DB lock that
 * carries a fencing token (= `domain_locks.lock_id`) so a stolen lease
 * is detectable on the next write. Phase 9 runs this in DUAL mode with
 * the file lock (§A4 of the design); the file lock is removed in
 * Phase 10.
 *
 * Lease / heartbeat / busy timeouts are env-overridable to keep the
 * concurrency tests deterministic.
 */

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/** Lease duration. Override via `HARNESS_LOCK_LEASE_MS` (positive number). */
export function leaseDurationMs(): number {
  const raw = process.env.HARNESS_LOCK_LEASE_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_LEASE_DURATION_MS;
}

/** Heartbeat interval. Override via `HARNESS_LOCK_HEARTBEAT_MS`. */
export function heartbeatIntervalMs(): number {
  const raw = process.env.HARNESS_LOCK_HEARTBEAT_MS;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_HEARTBEAT_INTERVAL_MS;
}

export class DomainLockBusyError extends Error {
  constructor(
    public readonly domainKey: string,
    public readonly holder: {
      runId: string;
      pid: number;
      hostname: string;
      expiresAt: string;
    },
  ) {
    super(
      `domain lock busy: ${domainKey} held by ${holder.runId} ` +
        `(pid=${holder.pid}@${holder.hostname}, expires=${holder.expiresAt})`,
    );
    this.name = "DomainLockBusyError";
  }
}

/**
 * Thrown when a run-execution write detects that the run's recorded
 * domain lease is no longer the active lease (`assertActiveLease`).
 * Distinct from `LeaseLostError` (heartbeat-side) only by where it
 * surfaces — both mean "another process took this run's domain lock".
 */
export class LeaseGuardFailedError extends Error {
  constructor(public readonly runId: string) {
    super(
      `lease guard failed for run ${runId}: the active domain lease no ` +
        `longer matches the run's recorded lease (another process took it).`,
    );
    this.name = "LeaseGuardFailedError";
  }
}

export class LeaseLostError extends Error {
  constructor(
    public readonly domainKey: string,
    public readonly lockId: number,
  ) {
    super(
      `domain lease lost: ${domainKey} lock_id=${lockId} ` +
        `(another process took the lease — heartbeat / write rejected)`,
    );
    this.name = "LeaseLostError";
  }
}

export type TransientLeaseError =
  | DomainLockBusyError
  | LeaseLostError
  | LeaseGuardFailedError;

export function findTransientLeaseCause(
  err: unknown,
): TransientLeaseError | undefined {
  const visited = new Set<object>();
  let current: unknown = err;
  for (let depth = 0; depth < 16; depth++) {
    if (
      current instanceof DomainLockBusyError ||
      current instanceof LeaseLostError ||
      current instanceof LeaseGuardFailedError
    ) {
      return current;
    }
    if (current === null || typeof current !== "object") return undefined;
    if (visited.has(current)) return undefined;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isTransientLeaseError(err: unknown): boolean {
  return findTransientLeaseCause(err) !== undefined;
}

export interface AcquireDomainLockOpts {
  domainKey: string;
  repoId: string;
  domain: string;
  runId: string;
  pid: number;
  hostname: string;
  /** Clock injection — defaults to `new Date()`. */
  now?: Date;
}

export interface DomainLockHandle {
  readonly lockId: number;
  /** = lockId — global monotonic via AUTOINCREMENT (§A1 of the design). */
  readonly fencingToken: number;
  /**
   * Extend the lease — `expires_at = now + leaseDuration` AND record
   * `heartbeat_at`. Throws `LeaseLostError` if the lease row no longer
   * matches (released or replaced).
   */
  heartbeat(now?: Date): void;
  /**
   * Verify the lease is still held without extending it. Throws
   * `LeaseGuardFailedError` if the lease is released, expired, or replaced.
   */
  assertHeld(now?: Date): void;
  /** Soft-release the lease. Safe to call twice. */
  release(
    opts?: { reason?: string; releasedBy?: string },
    now?: Date,
  ): void;
}

interface ActiveLeaseRow {
  lock_id: number;
  holder_run_id: string;
  holder_pid: number;
  holder_hostname: string;
  expires_at: string;
}

function recordDomainLockContention(
  db: Database.Database,
  opts: AcquireDomainLockOpts,
  holder: ActiveLeaseRow,
  observedAt: string,
): void {
  try {
    db.prepare(
      `INSERT INTO domain_lock_contention
         (contention_id, domain_key, repo_id, domain, holder_run_id,
          contender_pid, contender_hostname, observed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `dlc-${randomUUID()}`,
      opts.domainKey,
      opts.repoId,
      opts.domain,
      holder.holder_run_id,
      opts.pid,
      opts.hostname,
      observedAt,
    );
  } catch {
    // Telemetry is fail-open: lock-busy semantics must not depend on recording.
  }
}

/**
 * Acquire a DB-backed domain lease, expiring stale rows in the same
 * transaction. The returned `lockId` is the fencing token.
 */
export function acquireDomainLock(
  db: Database.Database,
  opts: AcquireDomainLockOpts,
): DomainLockHandle {
  const now = opts.now ?? new Date();
  const nowISO = now.toISOString();
  const expiresISO = new Date(
    now.getTime() + leaseDurationMs(),
  ).toISOString();

  const tx = db.transaction(
    (): { lockId: number } | { busy: ActiveLeaseRow } => {
      const existing = db
        .prepare(
          `SELECT lock_id, holder_run_id, holder_pid, holder_hostname,
                  expires_at
             FROM domain_locks
            WHERE domain_key = ? AND released_at IS NULL`,
        )
        .get(opts.domainKey) as ActiveLeaseRow | undefined;
      if (existing) {
        if (existing.expires_at > nowISO) {
          recordDomainLockContention(db, opts, existing, nowISO);
          return { busy: existing };
        }
        // expired — soft-release first so the partial unique index lets
        // a new row in.
        db.prepare(
          `UPDATE domain_locks
              SET released_at = ?, release_reason = 'expired'
            WHERE lock_id = ?`,
        ).run(nowISO, existing.lock_id);
      }
      const info = db
        .prepare(
          `INSERT INTO domain_locks (domain_key, repo_id, domain,
             holder_run_id, holder_pid, holder_hostname, acquired_at,
             expires_at, heartbeat_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          opts.domainKey,
          opts.repoId,
          opts.domain,
          opts.runId,
          opts.pid,
          opts.hostname,
          nowISO,
          expiresISO,
          nowISO,
        );
      return { lockId: Number(info.lastInsertRowid) };
    },
  );
  const result = tx.immediate();
  if ("busy" in result) {
    throw new DomainLockBusyError(opts.domainKey, {
      runId: result.busy.holder_run_id,
      pid: result.busy.holder_pid,
      hostname: result.busy.holder_hostname,
      expiresAt: result.busy.expires_at,
    });
  }

  const lockId = result.lockId;
  let released = false;

  return {
    lockId,
    fencingToken: lockId,
    heartbeat(now2: Date = new Date()): void {
      if (released) return;
      const now2ISO = now2.toISOString();
      const exp = new Date(
        now2.getTime() + leaseDurationMs(),
      ).toISOString();
      const info = db
        .prepare(
          `UPDATE domain_locks
              SET expires_at = ?, heartbeat_at = ?
            WHERE lock_id = ? AND holder_run_id = ? AND released_at IS NULL`,
        )
        .run(exp, now2ISO, lockId, opts.runId);
      if (info.changes === 0) {
        throw new LeaseLostError(opts.domainKey, lockId);
      }
    },
    assertHeld(now2: Date = new Date()): void {
      const active = db
        .prepare(
          `SELECT 1 FROM domain_locks
            WHERE lock_id = ? AND holder_run_id = ? AND released_at IS NULL
              AND expires_at > ?`,
        )
        .get(lockId, opts.runId, now2.toISOString());
      if (active === undefined) throw new LeaseGuardFailedError(opts.runId);
    },
    release(
      rel: { reason?: string; releasedBy?: string } = {},
      now3: Date = new Date(),
    ): void {
      if (released) return;
      db.prepare(
        `UPDATE domain_locks
            SET released_at = ?, release_reason = ?, released_by = ?
          WHERE lock_id = ? AND released_at IS NULL`,
      ).run(
        now3.toISOString(),
        rel.reason ?? "normal",
        rel.releasedBy ?? null,
        lockId,
      );
      released = true;
    },
  };
}

export interface DomainLockRow {
  lockId: number;
  domainKey: string;
  repoId: string;
  domain: string;
  holderRunId: string;
  holderPid: number;
  holderHostname: string;
  acquiredAt: string;
  expiresAt: string;
  heartbeatAt: string;
  releasedAt: string | null;
  releaseReason: string | null;
  releasedBy: string | null;
}

/** All active leases (released_at IS NULL), newest first. */
export function listActiveDomainLocks(
  db: Database.Database,
): DomainLockRow[] {
  const rows = db
    .prepare(
      `SELECT lock_id, domain_key, repo_id, domain, holder_run_id,
              holder_pid, holder_hostname, acquired_at, expires_at,
              heartbeat_at, released_at, release_reason, released_by
         FROM domain_locks
        WHERE released_at IS NULL
        ORDER BY acquired_at DESC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => toDomainLockRow(r));
}

/** Find the active lease for a domain_key, or null. */
export function findActiveDomainLock(
  db: Database.Database,
  domainKey: string,
): DomainLockRow | null {
  const row = db
    .prepare(
      `SELECT lock_id, domain_key, repo_id, domain, holder_run_id,
              holder_pid, holder_hostname, acquired_at, expires_at,
              heartbeat_at, released_at, release_reason, released_by
         FROM domain_locks
        WHERE domain_key = ? AND released_at IS NULL`,
    )
    .get(domainKey) as Record<string, unknown> | undefined;
  return row === undefined ? null : toDomainLockRow(row);
}

export interface ReleaseLockByDomainOpts {
  domainKey: string;
  /** if set, only release when holder_run_id matches */
  runId?: string;
  /** allow releasing an active heartbeat without a runId match (force) */
  force?: boolean;
  reason?: string;
  releasedBy?: string;
  now?: Date;
}

/**
 * Release the active lease for a domain. Returns the released row, or
 * null when nothing was released. Without `--force`, a runId mismatch
 * refuses to release (the active holder may still be running).
 */
export function releaseDomainLockByDomain(
  db: Database.Database,
  opts: ReleaseLockByDomainOpts,
): DomainLockRow | null {
  const active = findActiveDomainLock(db, opts.domainKey);
  if (active === null) return null;
  if (
    opts.runId !== undefined &&
    active.holderRunId !== opts.runId &&
    opts.force !== true
  ) {
    return null;
  }
  const now = (opts.now ?? new Date()).toISOString();
  db.prepare(
    `UPDATE domain_locks
        SET released_at = ?, release_reason = ?, released_by = ?
      WHERE lock_id = ? AND released_at IS NULL`,
  ).run(
    now,
    opts.reason ?? (opts.force === true ? "force" : "normal"),
    opts.releasedBy ?? null,
    active.lockId,
  );
  return active;
}

/**
 * Verify the run still holds an active domain lease at write time
 * (Phase 9-6 fencing guard). A no-op for runs without a recorded lease
 * (legacy or pre-9-5 runs) — those continue to rely on the expected
 * status / operation_id guards.
 *
 * Throws `LeaseGuardFailedError` when the run was recorded under a
 * lease that is now released, expired, or no longer matches the
 * `domain_locks` row — i.e. someone else took the lock.
 */
export function assertActiveLease(
  db: Database.Database,
  runId: string,
  now: Date = new Date(),
): void {
  const row = db
    .prepare(
      `SELECT lease_lock_id AS lockId FROM runs WHERE run_id = ?`,
    )
    .get(runId) as { lockId: number | null } | undefined;
  // run absent (legacy file-only) or pre-9-5 (no lease recorded) →
  // nothing to verify here; concurrency is guarded by other means.
  if (row === undefined || row.lockId === null) return;
  const active = db
    .prepare(
      `SELECT 1 FROM domain_locks
        WHERE lock_id = ? AND holder_run_id = ? AND released_at IS NULL
          AND expires_at > ?`,
    )
    .get(row.lockId, runId, now.toISOString());
  if (active === undefined) throw new LeaseGuardFailedError(runId);
}

function toDomainLockRow(r: Record<string, unknown>): DomainLockRow {
  return {
    lockId: r.lock_id as number,
    domainKey: r.domain_key as string,
    repoId: r.repo_id as string,
    domain: r.domain as string,
    holderRunId: r.holder_run_id as string,
    holderPid: r.holder_pid as number,
    holderHostname: r.holder_hostname as string,
    acquiredAt: r.acquired_at as string,
    expiresAt: r.expires_at as string,
    heartbeatAt: r.heartbeat_at as string,
    releasedAt: (r.released_at as string | null) ?? null,
    releaseReason: (r.release_reason as string | null) ?? null,
    releasedBy: (r.released_by as string | null) ?? null,
  };
}
