import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { harnessPaths } from "../config/paths.js";
import type { Prompts } from "./prompts.js";

export type StepStatus = "done" | "pending" | "blocked";

export interface StepResult {
  ok: boolean;
  message: string;
  /** when ok=false and the step is blocked rather than failed, remediation text */
  remediation?: string;
}

export interface OnboardCtx {
  harnessRoot: string;
  repoPath: string;
  projectId: string;
  prompts: Prompts;
  /** accumulated human-readable log lines for the final summary */
  log: string[];
}

export interface OnboardStep {
  id: string;
  title: string;
  /** deterministic, side-effect-free completion detection */
  probe(ctx: OnboardCtx): StepStatus;
  /** what running this step will do (shown before acting) */
  describe(ctx: OnboardCtx): string;
  /** drive the underlying work; may prompt via ctx.prompts */
  run(ctx: OnboardCtx): Promise<StepResult>;
}

/** Write policies/global.yaml only when missing (the #78 ENOENT fix); returns whether written. */
export function writeGlobalPolicyIfMissing(harnessRoot: string, globalPolicy: unknown): boolean {
  const path = harnessPaths(harnessRoot).globalPolicyPath;
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true }); // policies/ may not exist yet
  writeFileSync(path, stringifyYaml(globalPolicy), "utf8");
  return true;
}
