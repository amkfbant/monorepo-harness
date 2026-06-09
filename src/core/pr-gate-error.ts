export class PrGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrGateError";
  }
}
