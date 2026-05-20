export class PolicyViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

export class CodexExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexExecutionError";
  }
}
