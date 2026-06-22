import { describe, it, expect } from "vitest";
import { noteForMarkdownLine } from "../../../src/cli/course.js";

describe("noteForMarkdownLine (#171b export sanitization)", () => {
  it("collapses newlines so a note cannot inject extra Markdown blocks", () => {
    const note = "force-closed\n\n## Injected Heading\nmore";
    const rendered = noteForMarkdownLine(note);
    expect(rendered).toBe("force-closed ## Injected Heading more");
    expect(rendered).not.toContain("\n");
  });

  it("collapses CRLF and surrounding whitespace into a single space and trims", () => {
    expect(noteForMarkdownLine("  a \r\n\t b  ")).toBe("a b");
  });

  it("leaves a single-line note unchanged (inline markdown is cosmetic, not structural)", () => {
    expect(noteForMarkdownLine("PR #999 merged; **all** fixed")).toBe(
      "PR #999 merged; **all** fixed",
    );
  });

  it("collapses a whitespace run that spans a line break to a SINGLE space", () => {
    // a horizontal space between two newlines stays part of one run → one space
    expect(noteForMarkdownLine("a\n \nb")).toBe("a b");
    // a newline-free internal run is preserved (not a structural concern)
    expect(noteForMarkdownLine("a   b")).toBe("a   b");
  });

  it("handles a long newline-free whitespace run without catastrophic backtracking", () => {
    // the old `\s*[\r\n]+\s*` was O(n^2) here (~seconds for 100k) and would time
    // out; the linear `\s+`-scan returns instantly with the run preserved.
    const big = `a${" ".repeat(200_000)}b`;
    expect(noteForMarkdownLine(big)).toBe(big);
  });
});
