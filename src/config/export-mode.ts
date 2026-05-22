/**
 * File-export mode (Phase 8-5).
 *
 * Phase 7 always exported the compatibility files after a DB-first write.
 * Phase 8 makes that export opt-out: with `HARNESS_EXPORT_FILES` set to
 * one of `0` / `false` / `off` / `no` the DB-first commands skip the
 * automatic export and the affected rows are marked
 * `export_status='disabled'` — the harness runs DB-only.
 *
 * The default is ON (backward compatible). Unset, empty, or any other
 * value is ON. An explicit `harness db export-files` always exports
 * regardless of this setting.
 */

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/** Whether DB-first commands maintain the compatibility file export. */
export function fileExportEnabled(): boolean {
  const v = process.env.HARNESS_EXPORT_FILES;
  if (v === undefined) return true;
  return !OFF_VALUES.has(v.trim().toLowerCase());
}
