export class ReviewerAgentGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerAgentGateError";
  }
}
