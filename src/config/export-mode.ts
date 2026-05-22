/**
 * File-export mode (Phase 8-5).
 *
 * Phase 7 always exported the compatibility files after a DB-first write.
 * Phase 8 makes that export opt-out: with `HARNESS_EXPORT_FILES` set to a
 * falsy value the DB-first commands skip the automatic export and the
 * affected rows are marked `export_status='disabled'` — the harness runs
 * DB-only.
 *
 * The default is ON (backward compatible). An explicit `harness db
 * export-files` always exports regardless of this setting.
 */

const FALSY = new Set(["0", "false", "off", "no"]);

/** Whether DB-first commands maintain the compatibility file export. */
export function fileExportEnabled(): boolean {
  const v = process.env.HARNESS_EXPORT_FILES;
  if (v === undefined) return true;
  return !FALSY.has(v.trim().toLowerCase());
}
