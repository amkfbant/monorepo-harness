import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeEventWriter, type RunEvent } from "./events.js";

export interface RunMeta {
  runId: string;
  repoId: string;
  repoPath: string;
  domain: string;
  workflow: string;
  baseBranch: string;
  runBranch: string;
  status:
    | "running"
    | "success"
    | "failed-policy-violation"
    | "failed-codex"
    | "failed-command"
    | "failed-internal-error";
  startedAt: string;
  finishedAt?: string;
}

export interface RunLog {
  runDir: string;
  emit(event: RunEvent): Promise<void>;
  finalize(p: {
    status: RunMeta["status"];
    finishedAt: string;
  }): Promise<void>;
}

export async function createRunLog(opts: {
  runsDir: string;
  runId: string;
  meta: RunMeta;
}): Promise<RunLog> {
  const runDir = join(opts.runsDir, opts.runId);
  await mkdir(runDir, { recursive: true });
  const metaPath = join(runDir, "meta.json");
  await writeFile(metaPath, `${JSON.stringify(opts.meta, null, 2)}\n`, "utf8");
  const emit = makeEventWriter(join(runDir, "events.jsonl"));
  return {
    runDir,
    emit,
    async finalize({ status, finishedAt }) {
      const current = JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
      const next: RunMeta = { ...current, status, finishedAt };
      await writeFile(metaPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    },
  };
}
