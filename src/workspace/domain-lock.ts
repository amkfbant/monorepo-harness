import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

export interface DomainLock {
  path: string;
  release: () => Promise<void>;
}

export interface AcquireOpts {
  locksDir: string;
  domain: string;
  runId: string;
}

function domainLockName(domain: string): string {
  return `${domain
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()}.lock`;
}

export async function acquireDomainLock(
  opts: AcquireOpts,
): Promise<DomainLock> {
  await mkdir(opts.locksDir, { recursive: true });
  const path = join(opts.locksDir, domainLockName(opts.domain));
  try {
    await writeFile(
      path,
      JSON.stringify({
        runId: opts.runId,
        acquiredAt: new Date().toISOString(),
      }),
      { flag: "wx" },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `domain "${opts.domain}" is already locked (${path})`,
      );
    }
    throw e;
  }
  return {
    path,
    release: async () => {
      await rm(path, { force: true });
    },
  };
}
