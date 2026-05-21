import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
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

export function domainLockName(domain: string): string {
  return `${domain
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()}.lock`;
}

export function domainLockPath(locksDir: string, domain: string): string {
  return join(locksDir, domainLockName(domain));
}

export async function acquireDomainLock(
  opts: AcquireOpts,
): Promise<DomainLock> {
  await mkdir(opts.locksDir, { recursive: true });
  const path = join(opts.locksDir, domainLockName(opts.domain));
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
