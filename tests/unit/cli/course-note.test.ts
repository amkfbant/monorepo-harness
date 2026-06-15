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
});
