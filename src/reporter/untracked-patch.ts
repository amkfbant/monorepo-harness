import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_FILE_BYTES = 256 * 1024;

/**
 * Build a synthetic unified-diff for untracked files so review-request
 * surfaces the actual content of new files (final-diff.patch only covers
 * tracked changes). Output is git-apply friendly for tiny new files.
 */
export async function buildUntrackedPatch(
  worktreePath: string,
  untrackedPaths: readonly string[],
): Promise<string> {
  if (untrackedPaths.length === 0) return "";
  const out: string[] = [];
  for (const p of untrackedPaths) {
    out.push(`diff --git a/${p} b/${p}`);
    out.push("new file mode 100644");
    out.push("--- /dev/null");
    out.push(`+++ b/${p}`);
    try {
      const buf = await readFile(join(worktreePath, p));
      if (buf.length > MAX_FILE_BYTES) {
        out.push(`@@ truncated (${buf.length} bytes) @@`);
        out.push("+# (content omitted: exceeds 256KB harness limit)");
      } else {
        const content = buf.toString("utf8");
        const lines = content.split("\n");
        // Trailing newline manifests as a trailing empty segment; drop it for
        // a cleaner hunk header but keep the +-line so reviewers see the EOF.
        const hasTrailingNewline =
          lines.length > 0 && lines[lines.length - 1] === "";
        const body = hasTrailingNewline ? lines.slice(0, -1) : lines;
        out.push(`@@ -0,0 +1,${body.length} @@`);
        for (const line of body) out.push(`+${line}`);
        if (!hasTrailingNewline) {
          out.push("\\ No newline at end of file");
        }
      }
    } catch (e) {
      out.push("@@ unreadable @@");
      out.push(`+# could not read: ${(e as Error).message}`);
    }
    out.push("");
  }
  return out.join("\n");
}
