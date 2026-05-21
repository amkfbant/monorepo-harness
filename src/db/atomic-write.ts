import {
  writeFileSync,
  renameSync,
  mkdirSync,
  rmSync,
  existsSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * Atomic file write + export markers (Phase 7-2).
 *
 * A DB-first command commits to the DB, then exports files. The DB is
 * canonical; a torn file write must never leave a half-written artifact a
 * reader could mistake for the truth. So every exported file is written
 * to a temp path, fsync'd, and `rename`d onto the final path — `rename`
 * is atomic on the same filesystem.
 *
 * `.exporting` marks a run directory whose export is in progress (or
 * crashed mid-export): a not-yet-migrated file-first command can check it
 * and refuse to act on a run whose files may be inconsistent.
 */

const EXPORTING_MARKER = ".exporting";

/** Write `content` to `path` atomically (temp file + fsync + rename). */
export function atomicWriteFile(
  path: string,
  content: string | Buffer,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, content);
    // fsync the data before the rename so a crash cannot expose a renamed
    // but not-yet-flushed file. Best-effort: some filesystems no-op it.
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    // never leak the temp file when the write or rename fails.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the temp file may already be gone — nothing to clean up.
    }
    throw e;
  }
}

/** Mark a directory as having an export in progress. */
export function beginExporting(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, EXPORTING_MARKER),
    `${new Date().toISOString()}\n`,
    "utf8",
  );
}

/** Clear the in-progress marker after a successful export. */
export function endExporting(dir: string): void {
  rmSync(join(dir, EXPORTING_MARKER), { force: true });
}

/** True while an export is in progress (or crashed before it finished). */
export function isExporting(dir: string): boolean {
  return existsSync(join(dir, EXPORTING_MARKER));
}
