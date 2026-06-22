/**
 * Render a free-text note onto a SINGLE Markdown line. Newlines (and the
 * whitespace around them) collapse to a single space so a stored note cannot
 * break out of its `- Label: …` line and inject extra Markdown blocks/headings
 * into an audit export (#171b). Inline markdown inside the line stays verbatim
 * (cosmetic, not structural).
 *
 * Pure (no DB / IO): lives in `reporter/` so the pure summary renderers can
 * share the canonical sanitizer without dragging the CLI/DB import graph in.
 * `src/cli/course/helpers.ts` re-exports it to preserve its public surface.
 */
export function noteForMarkdownLine(note: string): string {
  return note.replace(/\s*[\r\n]+\s*/g, " ").trim();
}
