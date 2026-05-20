import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeEventWriter, type RunEvent } from "./events.js";

export type RunStatus =
  | "running"
  | "generated"
  | "verified"
  | "needs_review"
  | "approved"
  | "changes_requested"
  | "rejected"
  | "failed-policy-violation"
  | "failed-codex"
  | "failed-codex-timeout"
  | "failed-command"
  | "failed-internal-error";

export interface RunMeta {
  runId: string;
  repoId: string;
  repoPath: string;
  domain: string;
  workflow: string;
  baseBranch: string;
  /** SHA snapshot at run start; diffs are always taken against this. */
  baseSha: string;
  runBranch: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
}

export interface RunLog {
  runDir: string;
  emit(event: RunEvent): Promise<void>;
  setStatus(status: RunStatus): Promise<void>;
  finalize(p: { status: RunStatus; finishedAt: string }): Promise<void>;
}

export async function createRunLog(opts: {
  runsDir: string;
  runId: string;
  meta: RunMeta;
}): Promise<RunLog> {
  // Parent must exist; the run-specific directory itself is created
  // non-recursively so collisions surface as EEXIST instead of silently
  // overlapping with another run's artifacts.
  await mkdir(opts.runsDir, { recursive: true });
  const runDir = join(opts.runsDir, opts.runId);
  await mkdir(runDir, { recursive: false });

  const metaPath = join(runDir, "meta.json");
  await writeFile(metaPath, `${JSON.stringify(opts.meta, null, 2)}\n`, "utf8");
  const emit = makeEventWriter(join(runDir, "events.jsonl"));

  async function updateMeta(patch: Partial<RunMeta>): Promise<void> {
    const current = JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
    const next: RunMeta = { ...current, ...patch };
    await writeFile(metaPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  return {
    runDir,
    emit,
    async setStatus(status) {
      await updateMeta({ status });
    },
    async finalize({ status, finishedAt }) {
      await updateMeta({ status, finishedAt });
    },
  };
}
