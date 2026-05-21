import { createHash } from "node:crypto";
import { readFile, lstat, readlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * A content fingerprint over a run's reviewed paths. Recorded at run time
 * in meta.reviewed; `harness pr create` recomputes it and refuses if the
 * worktree drifted after the run was approved.
 *
 * Each path is classified with `lstat` and **symlinks are never
 * followed** — matching the harness's symlink-safe artifact handling.
 * This makes the fingerprint sensitive to type changes too: a reviewed
 * delete replaced by a directory / broken symlink, a regular file
 * swapped for a symlink with identical bytes, or a mode-only (chmod)
 * change all flip the fingerprint.
 */
export async function computeReviewedFingerprint(
  worktree: string,
  paths: string[],
): Promise<string> {
  const parts: string[] = [];
  for (const p of [...paths].sort()) {
    parts.push(JSON.stringify([p, await classifyPath(join(worktree, p))]));
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

/** A type-tagged digest of a single path — symlinks never followed. */
async function classifyPath(full: string): Promise<unknown[]> {
  let st;
  try {
    st = await lstat(full);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? ["absent"]
      : ["error", (e as Error).message];
  }
  if (st.isSymbolicLink()) {
    return ["symlink", await readlink(full)];
  }
  if (st.isFile()) {
    // safe: lstat confirmed a regular file, so readFile does not traverse
    // a symlink. The executable bit is part of the fingerprint.
    const bytes = await readFile(full);
    const exec = (st.mode & 0o111) !== 0;
    return ["file", createHash("sha256").update(bytes).digest("hex"), exec];
  }
  if (st.isDirectory()) return ["dir"];
  return ["other"];
}
