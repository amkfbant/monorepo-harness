/**
 * DB-first write path errors (Phase 7).
 *
 * `DbError` (connection.ts) covers connection / schema failures. These two
 * are the write-path guard failures every DB-first command can hit:
 *
 *  - `StateConflictError` — an optimistic-concurrency guard tripped: the
 *    row's current status was not in the caller's `expectedStatuses`, so
 *    the transition was refused rather than overwriting another writer's
 *    decision.
 *  - `SourceModeError` — the migration invariant tripped: a file-first
 *    (not-yet-migrated) command tried to mutate a `db-first` row, or a
 *    DB-first command was handed a `legacy-file` row it must not own.
 */

export class StateConflictError extends Error {
  readonly scopeId: string;
  readonly expected: readonly string[];
  readonly actual: string;

  constructor(scopeId: string, expected: readonly string[], actual: string) {
    super(
      `state conflict on ${scopeId}: expected status ` +
        `${expected.join(" | ")}, found ${actual}`,
    );
    this.name = "StateConflictError";
    this.scopeId = scopeId;
    this.expected = expected;
    this.actual = actual;
  }
}

export class SourceModeError extends Error {
  readonly scopeId: string;
  readonly sourceMode: string;
  readonly expectedMode: string;

  constructor(scopeId: string, sourceMode: string, expectedMode: string) {
    super(
      `source-mode conflict on ${scopeId}: row is ${sourceMode}, ` +
        `this command path requires ${expectedMode}`,
    );
    this.name = "SourceModeError";
    this.scopeId = scopeId;
    this.sourceMode = sourceMode;
    this.expectedMode = expectedMode;
  }
}
