import type Database from "better-sqlite3";

/**
 * Cross-concern helpers shared by the {@link HitchRepository} facade and its
 * per-concern sub-repositories (#125 Track C). Every sub-repo is constructed
 * with the FACADE's `db` handle and holds NO transaction of its own, so these
 * helpers operate directly on that shared handle and compose inside whatever
 * transaction the caller already opened.
 */

/** Bump a hitch session's `updated_at`. Shared because nearly every mutating
 * path (attempt / review-cycle / finding / close-check / decision writes) must
 * mark the session touched. Pre-extraction this was the private
 * `HitchRepository.touchSession`; lifting it here lets the sub-repos and the
 * facade share ONE implementation against the single shared db handle. */
export function touchHitchSession(
  db: Database.Database,
  hitchId: string,
  updatedAt: string,
): void {
  db.prepare(
    "UPDATE hitch_sessions SET updated_at = ? WHERE hitch_id = ?",
  ).run(updatedAt, hitchId);
}

/** Stable JSON encoder used by every repository write that stores a JSON column
 * (`metrics_json`, `evidence_json`, `input_json`, …). Mirrors the former
 * module-private `json` helper. */
export function json(value: unknown): string {
  return JSON.stringify(value);
}

/** Parse a stored JSON object column back into a record, returning `{}` for a
 * non-object payload (null / array / scalar). Mirrors the former module-private
 * `parseRecord` helper shared by the `rowTo*` converters. */
export function parseRecord(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}
