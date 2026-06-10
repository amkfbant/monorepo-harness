import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * (#68) Preflight for symlink-incapable filesystems (WSL 9p/drvfs on `/mnt/*`,
 * some network mounts). `git worktree` and per-worktree dependency installs
 * (uv venvs, node_modules/.bin) create POSIX symlinks; on such a FS the syscall
 * returns `EPERM` deep inside that work with a cryptic errno. Probing up front
 * lets us fail fast with the FS named and a clear remediation.
 *
 * The probe is injectable so it can be unit-tested without a real `/mnt` mount.
 */
export interface SymlinkProbeFs {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  symlinkSync(target: string, path: string): void;
  rmSync(path: string, opts: { recursive: boolean; force: boolean }): void;
}

const realFs: SymlinkProbeFs = { mkdirSync, symlinkSync, rmSync };

export class SymlinkUnsupportedError extends Error {
  constructor(readonly dir: string) {
    super(
      `workspace directory "${dir}" is on a filesystem that does not permit ` +
        `symlinks (e.g. a WSL 9p/drvfs mount under /mnt/*). git worktree and ` +
        `dependency installs there fail with EPERM. Run the harness from a ` +
        `Linux-native filesystem (e.g. ~/ops/...) instead.`,
    );
    this.name = "SymlinkUnsupportedError";
  }
}

function hasCode(e: unknown, code: string): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: unknown }).code === code
  );
}

/**
 * Can `dir` (the directory a worktree will be created in) hold a POSIX symlink?
 * Probes by creating and removing a throwaway symlink in a temp subdir.
 *
 * Only an `EPERM` from the `symlink(2)` syscall means "incapable" (returns
 * false). Any other probe error (e.g. the probe dir cannot be created) returns
 * `true` — the preflight is an early, specific warning for the known
 * symlink-EPERM failure, not a general gatekeeper; unrelated failures surface
 * from the real operation with their own message.
 */
export function isSymlinkCapable(dir: string, fs: SymlinkProbeFs = realFs): boolean {
  // unique per-call name so concurrent probes (multi-agent runs sharing a
  // workspacesDir) never collide on EEXIST or rm each other's probe dir
  const probeDir = join(dir, `.harness-symlink-probe-${process.pid}-${randomUUID()}`);
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    fs.symlinkSync("probe-target", join(probeDir, "link"));
    return true;
  } catch (e) {
    if (hasCode(e, "EPERM")) return false;
    return true;
  } finally {
    try {
      fs.rmSync(probeDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; never mask the probe result
    }
  }
}

/** Throw {@link SymlinkUnsupportedError} when `dir` cannot hold symlinks (#68). */
export function assertSymlinkCapable(
  dir: string,
  fs: SymlinkProbeFs = realFs,
): void {
  if (!isSymlinkCapable(dir, fs)) {
    throw new SymlinkUnsupportedError(dir);
  }
}
