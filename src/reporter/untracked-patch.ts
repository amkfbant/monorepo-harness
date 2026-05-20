import { lstat, readFile, readlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";

const MAX_FILE_BYTES = 256 * 1024;

async function streamSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function looksBinary(buf: Buffer): boolean {
  // NUL anywhere in the first 8KB is a reliable enough binary signal for
  // review purposes. Avoids decoding 100MB of raw bytes into UTF-8.
  const sample = buf.subarray(0, Math.min(8192, buf.length));
  return sample.includes(0);
}

/**
 * Build a synthetic unified-diff for untracked files so review-request
 * surfaces actual content of new files. Files larger than MAX_FILE_BYTES
 * or detected as binary are recorded as size+sha256 metadata only, so
 * a runaway codex run can't blow up harness memory by writing a giant
 * file into the worktree.
 *
 * Symlinks are never followed — only the link target string is recorded.
 * This stops codex from exfiltrating files outside the worktree by
 * placing a symlink at an in-scope path.
 */
export async function buildUntrackedPatch(
  worktreePath: string,
  untrackedPaths: readonly string[],
): Promise<string> {
  if (untrackedPaths.length === 0) return "";
  const out: string[] = [];
  for (const p of untrackedPaths) {
    const fullPath = join(worktreePath, p);
    out.push(`diff --git a/${p} b/${p}`);
    out.push("new file mode 100644");
    out.push("--- /dev/null");
    out.push(`+++ b/${p}`);
    try {
      const st = await lstat(fullPath);
      if (st.isSymbolicLink()) {
        const target = await readlink(fullPath);
        out.push("@@ symlink @@");
        out.push(`+# symlink target: ${target}`);
        out.push("+# content not read (symlinks are never followed)");
      } else if (!st.isFile()) {
        out.push("@@ non-file @@");
        out.push("+# entry is not a regular file; content omitted");
      } else if (st.size > MAX_FILE_BYTES) {
        const sha = await streamSha256(fullPath);
        out.push(
          `@@ omitted (size=${st.size} bytes, sha256=${sha}) @@`,
        );
        out.push(`+# content omitted: exceeds ${MAX_FILE_BYTES} byte limit`);
      } else {
        const buf = await readFile(fullPath);
        if (looksBinary(buf)) {
          const sha = createHash("sha256").update(buf).digest("hex");
          out.push(
            `@@ omitted (binary, size=${st.size} bytes, sha256=${sha}) @@`,
          );
          out.push("+# content omitted: detected as binary");
        } else {
          const content = buf.toString("utf8");
          const lines = content.split("\n");
          const hasTrailingNewline =
            lines.length > 0 && lines[lines.length - 1] === "";
          const body = hasTrailingNewline ? lines.slice(0, -1) : lines;
          out.push(`@@ -0,0 +1,${body.length} @@`);
          for (const line of body) out.push(`+${line}`);
          if (!hasTrailingNewline) {
            out.push("\\ No newline at end of file");
          }
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

/**
 * Build a metadata-only report for untracked files that violate policy.
 *
 * Content is intentionally NOT recorded — these paths are out of scope,
 * could be secrets, and shouldn't end up in the run's artifacts even
 * though we still want reviewers to know what was there.
 */
export async function buildUntrackedDeniedReport(
  worktreePath: string,
  paths: readonly string[],
): Promise<string> {
  if (paths.length === 0) return "";
  const out: string[] = [];
  out.push("# Untracked files denied by policy (content NOT saved)");
  out.push("");
  for (const p of paths) {
    const fullPath = join(worktreePath, p);
    try {
      const st = await lstat(fullPath);
      if (st.isSymbolicLink()) {
        const target = await readlink(fullPath);
        out.push(`- ${p}\tsymlink -> ${target}`);
        continue;
      }
      if (!st.isFile()) {
        out.push(`- ${p}\tnon-file`);
        continue;
      }
      const sha = await streamSha256(fullPath);
      out.push(`- ${p}\tsize=${st.size}\tsha256=${sha}`);
    } catch (e) {
      out.push(`- ${p}\tunreadable: ${(e as Error).message}`);
    }
  }
  return `${out.join("\n")}\n`;
}
