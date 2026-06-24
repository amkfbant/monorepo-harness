import { lstat, readFile, readlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { basename as pathBasename, join } from "node:path";
import { scanForSecrets } from "./secret-scan.js";

const MAX_FILE_BYTES = 256 * 1024;

async function streamSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(8192, buf.length));
  if (sample.length === 0) return false;
  // NUL is the cheapest binary signal.
  if (sample.includes(0)) return true;
  // Otherwise: strict UTF-8 decode in stream mode. Random binary almost
  // always trips an invalid continuation byte within 8KB; valid UTF-8
  // text (including Japanese) decodes cleanly. stream:true tolerates a
  // multi-byte character truncated by the sample boundary.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, {
      stream: true,
    });
    return false;
  } catch {
    return true;
  }
}

export interface SecretSuspect {
  path: string;
  reasons: string[];
}

export interface UntrackedPatchResult {
  patch: string;
  /**
   * Paths whose content was redacted because filename or content matched
   * a secret heuristic, in addition to whatever the patch text records.
   * The workflow uses this to write a separate review artifact and to
   * surface a count in run meta.
   */
  secretSuspects: SecretSuspect[];
}

/**
 * Build a synthetic unified-diff for untracked files so review-request
 * surfaces actual content of new files. Files larger than MAX_FILE_BYTES,
 * binary, symlinks, or matched by a secret heuristic are recorded as
 * metadata only (size + sha256, never bytes).
 */
export async function buildUntrackedPatch(
  worktreePath: string,
  untrackedPaths: readonly string[],
): Promise<UntrackedPatchResult> {
  if (untrackedPaths.length === 0) {
    return { patch: "", secretSuspects: [] };
  }
  const out: string[] = [];
  const secretSuspects: SecretSuspect[] = [];

  for (const p of untrackedPaths) {
    const fullPath = join(worktreePath, p);
    const base = pathBasename(p);
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
        // Stream-hash, do not load into memory.
        const sha = await streamSha256(fullPath);
        const filenameScan = scanForSecrets(base, null);
        if (filenameScan.matched) {
          secretSuspects.push({ path: p, reasons: filenameScan.reasons });
          out.push(
            `@@ secret-suspect (${filenameScan.reasons.join(", ")}, size=${st.size}, sha256=${sha}) @@`,
          );
          out.push(
            "+# content omitted: matched secret heuristic and exceeds size limit",
          );
        } else {
          out.push(
            `@@ omitted (size=${st.size} bytes, sha256=${sha}) @@`,
          );
          out.push(
            `+# content omitted: exceeds ${MAX_FILE_BYTES} byte limit`,
          );
        }
      } else {
        const buf = await readFile(fullPath);
        const content = looksBinary(buf) ? null : buf.toString("utf8");
        const scan = scanForSecrets(base, content);
        if (scan.matched) {
          const sha = createHash("sha256").update(buf).digest("hex");
          secretSuspects.push({ path: p, reasons: scan.reasons });
          out.push(
            `@@ secret-suspect (${scan.reasons.join(", ")}, size=${st.size}, sha256=${sha}) @@`,
          );
          out.push("+# content omitted: matched secret heuristic");
        } else if (content === null) {
          const sha = createHash("sha256").update(buf).digest("hex");
          out.push(
            `@@ omitted (binary, size=${st.size} bytes, sha256=${sha}) @@`,
          );
          out.push("+# content omitted: detected as binary");
        } else {
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

  return { patch: out.join("\n"), secretSuspects };
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

/**
 * Render a secret-suspect list as a separate, easy-to-grep artifact.
 */
export function buildUntrackedSecretsReport(
  suspects: readonly SecretSuspect[],
): string {
  if (suspects.length === 0) return "";
  const lines: string[] = [];
  lines.push("# Untracked files matched a secret heuristic (content NOT saved)");
  lines.push("");
  for (const s of suspects) {
    lines.push(`- ${s.path}\treasons=${s.reasons.join(",")}`);
  }
  return `${lines.join("\n")}\n`;
}
