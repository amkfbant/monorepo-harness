export class PrGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrGateError";
  }
}

/**
 * (#396 part 2) Thrown ONLY at the `git push` exit-code site of `createPullRequest`
 * (pr-creator.ts). It carries the raw git result so the close path can classify a
 * transient-vs-permanent failure deterministically. `instanceof PrGateError` stays
 * true, so every existing catch (which escalates) is unaffected; only the close
 * runner narrows on `PrPushError` to consider a bounded retry. The PR-safety gates
 * (single-commit / authentic-message / paths-subset) and the publish step keep
 * throwing the plain `PrGateError`, so they always escalate (fail-closed).
 */
export class PrPushError extends PrGateError {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string,
    readonly stdout: string,
  ) {
    super(message);
    this.name = "PrPushError";
  }
}
