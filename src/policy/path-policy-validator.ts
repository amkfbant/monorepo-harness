import { minimatch } from "minimatch";
import type { ResolvedPolicy } from "./schema.js";

export interface Violation {
  path: string;
  reason: "deny_write" | "not_in_write_scope" | "unsafe_path";
}

export interface ValidationResult {
  status: "allowed" | "denied";
  violations: Violation[];
}

const MATCH_OPTS = { dot: true, nocomment: true } as const;

function isUnsafePath(p: string): boolean {
  if (p === "") return true;
  if (p.includes("\0")) return true;
  // Absolute paths (POSIX or Windows drive-letter) are never allowed.
  if (p.startsWith("/")) return true;
  if (/^[A-Za-z]:/.test(p)) return true;
  // Backslashes invite Windows-style separator confusion; reject outright.
  if (p.includes("\\")) return true;
  // `..` segment escapes the repository root.
  const segments = p.split("/");
  if (segments.some((s) => s === "..")) return true;
  return false;
}

export function validateChangedPaths(
  policy: ResolvedPolicy,
  changedPaths: readonly string[],
): ValidationResult {
  const violations: Violation[] = [];
  for (const p of changedPaths) {
    if (isUnsafePath(p)) {
      violations.push({ path: p, reason: "unsafe_path" });
      continue;
    }
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
