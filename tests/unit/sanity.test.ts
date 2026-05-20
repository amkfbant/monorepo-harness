import { describe, it, expect } from "vitest";
import { HARNESS_NAME } from "../../src/index.js";

describe("sanity", () => {
  it("exposes harness name", () => {
    expect(HARNESS_NAME).toBe("monorepo-harness");
  });
});
