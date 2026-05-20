import type { ResolvedPolicy } from "../policy/schema.js";
import type { HarnessPaths } from "../config/paths.js";
import type { RunLog } from "../logging/run-log.js";

export interface RunContext {
  runId: string;
  paths: HarnessPaths;
  policy: ResolvedPolicy;
  repoPath: string;
  baseBranch: string;
  goal: string;
  log: RunLog;
}
