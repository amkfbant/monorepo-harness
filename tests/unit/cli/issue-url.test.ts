import { describe, it, expect } from "vitest";
import { parseIssueUrl } from "../../../src/cli/hitch/issue-url.js";

describe("parseIssueUrl", () => {
  // ACCEPT cases
  it("accepts minimal canonical URL", () => {
    expect(parseIssueUrl("https://github.com/o/r/issues/1")).toBe(
      "https://github.com/o/r/issues/1"
    );
  });

  it("accepts URL with org/repo containing hyphens and dots", () => {
    expect(
      parseIssueUrl("https://github.com/my-org/my.repo/issues/4567")
    ).toBe("https://github.com/my-org/my.repo/issues/4567");
  });

  // REJECT cases
  it("rejects http (not https)", () => {
    expect(parseIssueUrl("http://github.com/o/r/issues/1")).toBeNull();
  });

  it("rejects pull URL (not issues)", () => {
    expect(parseIssueUrl("https://github.com/o/r/pull/1")).toBeNull();
  });

  it("rejects issue number zero", () => {
    expect(parseIssueUrl("https://github.com/o/r/issues/0")).toBeNull();
  });

  it("rejects issue number with leading zero", () => {
    expect(parseIssueUrl("https://github.com/o/r/issues/01")).toBeNull();
  });

  it("rejects query string", () => {
    expect(parseIssueUrl("https://github.com/o/r/issues/1?x=1")).toBeNull();
  });

  it("rejects fragment", () => {
    expect(parseIssueUrl("https://github.com/o/r/issues/1#c")).toBeNull();
  });

  it("rejects enterprise host", () => {
    expect(
      parseIssueUrl("https://gh.enterprise.com/o/r/issues/1")
    ).toBeNull();
  });

  it("rejects missing repo segment (only owner)", () => {
    expect(parseIssueUrl("https://github.com/o/issues/1")).toBeNull();
  });

  it("rejects trailing slash with no issue number", () => {
    expect(parseIssueUrl("https://github.com/o/r/issues/")).toBeNull();
  });

  it("rejects URL with embedded newline / control chars", () => {
    expect(
      parseIssueUrl("https://github.com/o/r/issues/1\n# Fake")
    ).toBeNull();
  });

  it("rejects unrelated tracker URL", () => {
    expect(parseIssueUrl("https://example.com/issue/1")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(parseIssueUrl("")).toBeNull();
  });

  it("rejects URL exceeding MAX_URL_LEN (3000 chars)", () => {
    const long = "https://github.com/o/r/issues/1" + "a".repeat(3000);
    expect(parseIssueUrl(long)).toBeNull();
  });
});
