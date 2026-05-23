/**
 * File-export mode.
 *
 * Phase 7 always exported the compatibility files after a DB-first write.
 * Phase 8 made it opt-out (`HARNESS_EXPORT_FILES=0`); Phase 9 flips the
 * default to **OFF** — the runtime DB is the canonical store.
 *
 *   - `HARNESS_EXPORT_FILES=1 / true / on / yes` → file export ON
 *   - `HARNESS_EXPORT_FILES=0 / false / off / no` → file export OFF
 *   - unset → OFF (Phase 9 default; **breaking change** from Phase 8 ON)
 *
 * When the env var is unset, the first write command emits a one-time
 * stderr warning so existing operators discover the new default. Set
 * `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1` (CI / tests) to silence it.
 *
 * An explicit `harness db export-files` always exports regardless.
 */

const ON_VALUES = new Set(["1", "true", "on", "yes"]);
const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/** Whether DB-first commands maintain the compatibility file export. */
export function fileExportEnabled(): boolean {
  const raw = process.env.HARNESS_EXPORT_FILES;
  if (raw === undefined || raw === "") {
    maybeWarnUnset();
    return false;
  }
  const v = raw.trim().toLowerCase();
  if (ON_VALUES.has(v)) return true;
  if (OFF_VALUES.has(v)) return false;
  // unrecognised value — default to OFF and warn so operators notice.
  process.stderr.write(
    `warning: HARNESS_EXPORT_FILES=${JSON.stringify(raw)} is not a ` +
      `recognised value; treating as OFF (set to 1 or 0).\n`,
  );
  return false;
}

let warned = false;

function maybeWarnUnset(): void {
  if (warned) return;
  warned = true;
  if (process.env.HARNESS_SUPPRESS_EXPORT_MODE_WARNING) return;
  process.stderr.write(
    "warning: HARNESS_EXPORT_FILES is unset; the default changed from ON " +
      "(Phase 8) to OFF (Phase 9). Set HARNESS_EXPORT_FILES=1 to keep " +
      "files exported, or HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1 to " +
      "silence this notice.\n",
  );
}

/**
 * Internal: reset the one-time warning latch. Used by tests that toggle
 * the env var across cases — production code should never need this.
 */
export function _resetExportModeWarningForTest(): void {
  warned = false;
}
