import { readdirSync, existsSync } from "node:fs";

/**
 * Phase 10-1: file domain lock (`.harness/locks/*.lock`) is no longer used
 * at runtime. If an older harness binary (Phase ≤ 9) left lock sentinels
 * behind, emit a one-shot stderr warning so operators can delete them.
 *
 * - Per-process: warns at most once across all callers in the same node
 *   process (module-level flag).
 * - Suppressible: `HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING=1` skips the
 *   warning (useful in CI / scripted runs where the warning is noisy).
 * - Best-effort: any fs error is silently ignored — this helper must never
 *   block a runtime command.
 */
let warned = false;

export function warnLegacyFileLocks(locksDir: string): void {
  if (warned) return;
  if (process.env.HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING === "1") return;
  if (!existsSync(locksDir)) return;
  let staleFiles: string[];
  try {
    staleFiles = readdirSync(locksDir).filter((e) => e.endsWith(".lock"));
  } catch {
    return;
  }
  if (staleFiles.length === 0) return;
  warned = true;
  const example = staleFiles.slice(0, 3).join(", ");
  const more = staleFiles.length > 3 ? ` (+${staleFiles.length - 3} more)` : "";
  process.stderr.write(
    `warning: legacy file domain lock(s) found in ${locksDir} ` +
      `(${example}${more}) — ignored.\n` +
      `         Phase 10 uses DB domain locks (domain_locks table) exclusively.\n` +
      `         You can safely delete ${locksDir}/.\n` +
      `         Suppress with HARNESS_SUPPRESS_LEGACY_FILE_LOCK_WARNING=1.\n`,
  );
}

/** Test-only: reset the per-process warned flag. */
export function _resetLegacyFileLockWarning(): void {
  warned = false;
}
