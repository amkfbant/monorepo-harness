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
  // Collapse any whitespace run that CONTAINS a line break to a single space
  // (a note must stay on one Markdown line); newline-free whitespace runs are
  // left intact, exactly as before. Scanning maximal `\s+` runs with a callback
  // is linear — it avoids the catastrophic backtracking of `\s*[\r\n]+\s*`,
  // whose `\s*` overlaps `[\r\n]+` and degrades to O(n^2) on a long newline-free
  // whitespace run (now reachable via unbounded finding text in #84).
  return note
    .replace(/\s+/g, (run) => (/[\r\n]/.test(run) ? " " : run))
    .trim();
}
