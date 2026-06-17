export class CourseUserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CourseUserError";
  }
}

export class ReviewStateConflictError extends CourseUserError {
  readonly phaseId: string;
  readonly attempts: number;
  readonly latestVersion: number | null;

  constructor(phaseId: string, attempts: number, latestVersion: number | null) {
    super(
      `review_state conflict on ${phaseId}: CAS retry budget exhausted ` +
        `after ${attempts} attempt${attempts === 1 ? "" : "s"}` +
        (latestVersion === null ? "" : ` (latest version ${latestVersion})`),
    );
    this.name = "ReviewStateConflictError";
    this.phaseId = phaseId;
    this.attempts = attempts;
    this.latestVersion = latestVersion;
  }
}
