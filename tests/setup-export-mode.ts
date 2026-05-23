/**
 * Phase 9-10 — file export default flipped to OFF.
 *
 * Most existing tests were written when the Phase 8 default was ON and
 * exercise the export path (asserting `meta.json` / `events.jsonl` on
 * disk, `exported_files` rows, etc.). Pin the env var to ON for the test
 * suite so those tests keep covering the export path. Tests that need to
 * exercise OFF set `HARNESS_EXPORT_FILES = "0"` locally.
 *
 * Also suppress the one-time "default changed" stderr warning so test
 * output stays clean.
 */
process.env.HARNESS_EXPORT_FILES = "1";
process.env.HARNESS_SUPPRESS_EXPORT_MODE_WARNING = "1";
