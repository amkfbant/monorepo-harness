import { homedir } from "node:os";
import { join } from "node:path";

/** Claude stores transcripts under ~/.claude/projects/<dash-encoded LITERAL launch cwd>. */
export function encodeClaudeProjectPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface ResolveClaudeProjectDirOptions {
  harnessRoot: string;
  override?: string;
  homeDir?: string;
}

/**
 * Resolve the Claude transcript project directory for a given harnessRoot.
 *
 * Encodes the LITERAL harnessRoot — Claude encodes the launch cwd, not its
 * realpath. Existence check + realpath fallback + warn live in the ingest
 * (Task 4).
 */
export function resolveClaudeProjectDir(
  opts: ResolveClaudeProjectDirOptions,
): string {
  if (opts.override) return opts.override;
  const home = opts.homeDir ?? homedir();
  return join(home, ".claude", "projects", encodeClaudeProjectPath(opts.harnessRoot));
}
