/**
 * Errors raised by the project-abstraction layer (Phase 5).
 *
 * `ProjectError` and its subclasses are operator-fixable conditions —
 * bad profile YAML, missing files, schema violations. CLI commands map
 * them to exit code 1 (vs. 2 for unexpected exceptions), matching the
 * convention used by `ReviewGateError` / `CleanupGateError`.
 */
export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

/** A project profile failed to load, parse, or validate. */
export class ProjectProfileError extends ProjectError {
  constructor(message: string) {
    super(message);
    this.name = "ProjectProfileError";
  }
}

/** A project profile was requested by id but does not exist. */
export class ProjectNotFoundError extends ProjectError {
  constructor(message: string) {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

/** A template / preset catalog entry failed to load, parse, or validate. */
export class ProjectTemplateError extends ProjectError {
  constructor(message: string) {
    super(message);
    this.name = "ProjectTemplateError";
  }
}
