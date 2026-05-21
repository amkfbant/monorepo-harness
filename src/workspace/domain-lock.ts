import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface LockInfo {
  runId: string;
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface DomainLock {
  path: string;
  info: LockInfo;
  release: () => Promise<void>;
}

export interface AcquireOpts {
  locksDir: string;
  domain: string;
  runId: string;
  /**
   * When set, the lock is namespaced by repo: `<repoId>--<domain>.lock`
   * (Phase 5-7 dual-mode). Two repos that both define `apps/catalog` then
   * lock independently. Omitted → the legacy domain-only lock.
   */
  repoId?: string;
}

/**
 * Thrown when a domain lock is already held. This is expected, retryable
 * contention (another run/cleanup/review is in flight) — distinct from an
 * unexpected fs error. Callers can map it to a retryable exit code.
 */
export class DomainLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainLockError";
  }
}

function slugify(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/**
 * Lock filename for a domain.
 *
 * - no `repoId` → legacy domain-only `<domain-slug>.lock` (unchanged, so
 *   manual `lock release --domain` on old locks still works).
 * - with `repoId` → namespaced `<repo-slug>--<domain-slug>-<hash>.lock`.
 *   The slugs are lossy and exist only for readability; the hash is taken
 *   over the raw `repoId` + `domain` pair, so no two distinct (repo,
 *   domain) pairs can map to the same lock even when their slugs collide
 *   (`foo.bar` vs `foo-bar`, `apps/user-api` vs `apps/user/api`).
 */
export function domainLockName(domain: string, repoId?: string): string {
  const domainSlug = slugify(domain);
  if (repoId === undefined) return `${domainSlug}.lock`;
  const hash = createHash("sha1")
    .update(`${repoId}\0${domain}`)
    .digest("hex")
    .slice(0, 12);
  return `${slugify(repoId)}--${domainSlug}-${hash}.lock`;
}

export function domainLockPath(
  locksDir: string,
  domain: string,
  repoId?: string,
): string {
  return join(locksDir, domainLockName(domain, repoId));
}

export async function acquireDomainLock(
  opts: AcquireOpts,
): Promise<DomainLock> {
  await mkdir(opts.locksDir, { recursive: true });
  const path = join(
    opts.locksDir,
    domainLockName(opts.domain, opts.repoId),
  );
  const info: LockInfo = {
    runId: opts.runId,
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  };
  try {
    await writeFile(path, JSON.stringify(info, null, 2), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DomainLockError(
        `domain "${opts.domain}" is already locked (${path})`,
      );
    }
    throw e;
  }
  return {
    path,
    info,
    release: async () => {
      // Read current lock content; only remove if it still belongs to us.
      // Protects against a future stale-recovery process taking over the lock.
      try {
        const raw = await readFile(path, "utf8");
        const existing = JSON.parse(raw) as LockInfo;
        if (existing.runId !== opts.runId) return;
      } catch {
        return;
      }
      await rm(path, { force: true });
    },
  };
}
