import { describe, expect, it } from "vitest";
import { parseIsoInstantMs } from "../../../src/cli/hitch/iso-instant.js";

describe("parseIsoInstantMs — strict ISO-8601 UTC instant parser (#84 Stage B)", () => {
  // ── accepted inputs ───────────────────────────────────────────────────────

  it("accepts UTC instant with Z designator", () => {
    expect(parseIsoInstantMs("2026-06-01T00:00:00Z")).not.toBeNull();
  });

  it("accepts UTC instant with milliseconds and Z designator", () => {
    expect(parseIsoInstantMs("2026-06-01T00:00:00.000Z")).not.toBeNull();
  });

  it("accepts positive numeric offset +09:00 and returns the same epoch-ms as its UTC equivalent", () => {
    const withOffset = parseIsoInstantMs("2026-06-01T00:00:00+09:00");
    const utcEquivalent = parseIsoInstantMs("2026-05-31T15:00:00Z");
    expect(withOffset).not.toBeNull();
    expect(utcEquivalent).not.toBeNull();
    expect(withOffset).toBe(utcEquivalent);
  });

  // ── rejected inputs (→ null) ──────────────────────────────────────────────

  it("rejects prose date: 'June 1, 2026'", () => {
    expect(parseIsoInstantMs("June 1, 2026")).toBeNull();
  });

  it("rejects offset-less local time: '2026-06-01T00:00:00'", () => {
    expect(parseIsoInstantMs("2026-06-01T00:00:00")).toBeNull();
  });

  it("rejects impossible day: Feb 31 '2026-02-31T00:00:00.000Z'", () => {
    expect(parseIsoInstantMs("2026-02-31T00:00:00.000Z")).toBeNull();
  });

  it("rejects impossible month: '2026-13-01T00:00:00Z'", () => {
    expect(parseIsoInstantMs("2026-13-01T00:00:00Z")).toBeNull();
  });

  it("rejects impossible hour: '2026-06-01T25:00:00Z'", () => {
    expect(parseIsoInstantMs("2026-06-01T25:00:00Z")).toBeNull();
  });

  it("rejects bare number: '1'", () => {
    expect(parseIsoInstantMs("1")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseIsoInstantMs("")).toBeNull();
  });

  it("rejects date-only (no time component): '2026-06-01'", () => {
    expect(parseIsoInstantMs("2026-06-01")).toBeNull();
  });

  it("rejects impossible offset: '2026-06-01T00:00:00+99:00'", () => {
    expect(parseIsoInstantMs("2026-06-01T00:00:00+99:00")).toBeNull();
  });
});
