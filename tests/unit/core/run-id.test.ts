import { describe, it, expect } from "vitest";
import { generateRunId } from "../../../src/core/run-id.js";

describe("generateRunId", () => {
  it("includes date, domain slug, and a random suffix", () => {
    const id = generateRunId({
      domain: "apps/user",
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(id).toMatch(/^run-20260520-apps-user-[a-z0-9]+$/);
  });

  it("produces unique ids on each call (collision-safe across domains)", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    const a = generateRunId({ domain: "apps/user", now });
    const b = generateRunId({ domain: "apps/user", now });
    expect(a).not.toBe(b);
  });

  it("slugifies domain with slashes and special characters", () => {
    const id = generateRunId({
      domain: "Apps/User Profile",
      now: new Date("2026-05-20T00:00:00Z"),
    });
    expect(id).toMatch(/^run-20260520-apps-user-profile-/);
  });
});
