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
 * The Phase 9 migration is long settled, so the "default changed to OFF"
 * notice is **opt-in** (#79): silent by default — every short-lived CLI
 * process used to emit it once, spamming a session's logs. Set
 * `HARNESS_WARN_EXPORT_MODE=1` to surface the one-time notice;
 * `HARNESS_SUPPRESS_EXPORT_MODE_WARNING=1` still silences it even when opted in.
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
  // #79 — the migration notice is opt-in to avoid cross-process log spam
  // (each short-lived CLI process otherwise emits it once). Default silent;
  // only surface it when explicitly requested.
  const warn = process.env.HARNESS_WARN_EXPORT_MODE ?? "";
  if (!ON_VALUES.has(warn.trim().toLowerCase())) return;
  // truthy-only normalization (same as HARNESS_EXPORT_FILES) — only
  // `1` / true / on / yes silences; an operator setting `=0` still sees it.
  const suppress = process.env.HARNESS_SUPPRESS_EXPORT_MODE_WARNING ?? "";
  if (ON_VALUES.has(suppress.trim().toLowerCase())) return;
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
