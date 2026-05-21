import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A content fingerprint over a run's reviewed paths — a sha256 over each
 * path's worktree bytes. Recorded at run time in meta.reviewed; `harness
 * pr create` recomputes it and refuses if the worktree drifted after the
 * run was approved (a reviewed file edited post-review must not slip
 * silently into the PR).
 *
 * A path that no longer exists (e.g. a reviewed delete) hashes to a fixed
 * "absent" marker so it still participates in the digest deterministically.
 */
export async function computeReviewedFingerprint(
  worktree: string,
  paths: string[],
): Promise<string> {
  const parts: string[] = [];
  for (const p of [...paths].sort()) {
    let hash: string;
    try {
      hash = createHash("sha256")
        .update(await readFile(join(worktree, p)))
        .digest("hex");
    } catch {
      hash = "absent";
    }
    // JSON.stringify keeps path/hash boundaries unambiguous (no separator
    // char a git path could contain).
    parts.push(JSON.stringify([p, hash]));
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
