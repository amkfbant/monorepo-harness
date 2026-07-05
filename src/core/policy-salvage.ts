import { join } from "node:path";
import { collectTrackedPatchForPaths } from "../git/diff.js";
import type {
  PolicySalvageInfo,
  RunLog,
  SafetyStatus,
} from "../logging/run-log.js";
import { writeArtifact } from "../logging/artifacts.js";
import type { Violation } from "../policy/path-policy-validator.js";
import {
  buildUntrackedDeniedReport,
  buildUntrackedPatch,
  buildUntrackedSecretsReport,
} from "../reporter/untracked-patch.js";
import { uniquePaths } from "./workflow-runner-diff.js";

export interface PolicyArtifactsResult {
  violatedPaths: Set<string>;
  untrackedAllowed: string[];
  untrackedDenied: string[];
  secretSuspects: { path: string; reasons: string[] }[];
  policySalvage?: PolicySalvageInfo;
}

export async function writePolicyArtifacts(input: {
  log: RunLog;
  worktreePath: string;
  baseSha: string;
  gitTimeoutMs: number;
  safetyStatus: SafetyStatus;
  trackedChangedPaths: readonly string[];
  finalDiffPatch: string;
  violations: readonly Violation[];
  untrackedKept: readonly string[];
}): Promise<PolicyArtifactsResult> {
  const violatedPaths = new Set<string>(input.violations.map((v) => v.path));
  await input.log.setSafetyStatus(input.safetyStatus);

  const untrackedAllowed: string[] = [];
  const untrackedDenied: string[] = [];
  for (const p of input.untrackedKept) {
    if (violatedPaths.has(p)) untrackedDenied.push(p);
    else untrackedAllowed.push(p);
  }

  await writeArtifact(
    join(input.log.runDir, "final-diff.patch"),
    input.finalDiffPatch,
  );
  let secretSuspects: { path: string; reasons: string[] }[] = [];
  let untrackedAllowedPatch = "";
  if (untrackedAllowed.length > 0) {
    await writeArtifact(
      join(input.log.runDir, "untracked-files.txt"),
      `${untrackedAllowed.join("\n")}\n`,
    );
    const result = await buildUntrackedPatch(
      input.worktreePath,
      untrackedAllowed,
    );
    untrackedAllowedPatch = result.patch;
    await writeArtifact(
      join(input.log.runDir, "untracked-files.patch"),
      result.patch,
    );
    secretSuspects = result.secretSuspects;
    if (secretSuspects.length > 0) {
      await writeArtifact(
        join(input.log.runDir, "untracked-secrets.txt"),
        buildUntrackedSecretsReport(secretSuspects),
      );
      await input.log.emit({
        type: "secret_suspects_redacted",
        count: secretSuspects.length,
        paths: secretSuspects.map((s) => s.path),
      });
    }
  }
  if (untrackedDenied.length > 0) {
    const deniedReport = await buildUntrackedDeniedReport(
      input.worktreePath,
      untrackedDenied,
    );
    await writeArtifact(
      join(input.log.runDir, "untracked-denied.txt"),
      deniedReport,
    );
  }

  const policySalvage = await buildPolicySalvage({
    safetyStatus: input.safetyStatus,
    runDir: input.log.runDir,
    worktreePath: input.worktreePath,
    baseSha: input.baseSha,
    gitTimeoutMs: input.gitTimeoutMs,
    trackedChangedPaths: input.trackedChangedPaths,
    violations: input.violations,
    untrackedAllowed,
    untrackedDenied,
    untrackedAllowedPatch,
  });
  if (policySalvage !== undefined) {
    await input.log.emit({
      type: policySalvage.available
        ? "policy_salvage_available"
        : "policy_salvage_unavailable",
      allowedPaths: policySalvage.allowedPaths,
      deniedPaths: policySalvage.deniedPaths,
      ...(policySalvage.patchArtifact !== undefined
        ? { patchArtifact: policySalvage.patchArtifact }
        : {}),
    });
  }

  return {
    violatedPaths,
    untrackedAllowed,
    untrackedDenied,
    secretSuspects,
    ...(policySalvage !== undefined ? { policySalvage } : {}),
  };
}

export async function buildPolicySalvage(input: {
  safetyStatus: SafetyStatus;
  runDir: string;
  worktreePath: string;
  baseSha: string;
  gitTimeoutMs: number;
  trackedChangedPaths: readonly string[];
  violations: readonly Violation[];
  untrackedAllowed: readonly string[];
  untrackedDenied: readonly string[];
  untrackedAllowedPatch: string;
}): Promise<PolicySalvageInfo | undefined> {
  if (input.safetyStatus !== "denied") return undefined;
  const violatedPaths = new Set(input.violations.map((v) => v.path));
  const trackedAllowed = input.trackedChangedPaths.filter(
    (p) => !violatedPaths.has(p),
  );
  const trackedDenied = input.trackedChangedPaths.filter((p) =>
    violatedPaths.has(p),
  );
  const allowedPaths = uniquePaths([
    ...trackedAllowed,
    ...input.untrackedAllowed,
  ]);
  const deniedPaths = uniquePaths([
    ...input.violations.map((v) => v.path),
    ...trackedDenied,
    ...input.untrackedDenied,
  ]);
  let patchArtifact: string | undefined;
  if (allowedPaths.length > 0) {
    const trackedAllowedPatch = await collectTrackedPatchForPaths({
      repoPath: input.worktreePath,
      baseSha: input.baseSha,
      timeoutMs: input.gitTimeoutMs,
      paths: trackedAllowed,
    });
    const patch = [trackedAllowedPatch, input.untrackedAllowedPatch]
      .map((p) => p.trimEnd())
      .filter((p) => p.length > 0)
      .join("\n\n");
    if (patch.length > 0) {
      patchArtifact = "policy-allowed.patch";
      await writeArtifact(join(input.runDir, patchArtifact), `${patch}\n`);
    }
  }
  return {
    available: patchArtifact !== undefined,
    allowedPaths,
    deniedPaths,
    ...(patchArtifact !== undefined ? { patchArtifact } : {}),
    recommendedNextAction:
      patchArtifact !== undefined
        ? "inspect policy-allowed.patch, then rerun or apply it in a fresh scoped run"
        : "rerun from base or discard this failed run",
  };
}
