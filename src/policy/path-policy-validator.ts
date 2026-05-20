import { minimatch } from "minimatch";
import type { ResolvedPolicy } from "./schema.js";

export interface Violation {
  path: string;
  reason: "deny_write" | "not_in_write_scope";
}

export interface ValidationResult {
  status: "allowed" | "denied";
  violations: Violation[];
}

const MATCH_OPTS = { dot: true, nocomment: true } as const;

export function validateChangedPaths(
  policy: ResolvedPolicy,
  changedPaths: readonly string[],
): ValidationResult {
  const violations: Violation[] = [];
  for (const p of changedPaths) {
    if (policy.denyWrite.some((g) => minimatch(p, g, MATCH_OPTS))) {
      violations.push({ path: p, reason: "deny_write" });
      continue;
    }
    if (!policy.write.some((g) => minimatch(p, g, MATCH_OPTS))) {
      violations.push({ path: p, reason: "not_in_write_scope" });
    }
  }
  return {
    status: violations.length === 0 ? "allowed" : "denied",
    violations,
  };
}
