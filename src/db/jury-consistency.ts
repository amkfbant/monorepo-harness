import type Database from "better-sqlite3";

/**
 * Shared fail-closed guard for the three jury audit repositories (#230,
 * design §0.1 R5/P2f). The v31 jury tables carry `finding_id` as the
 * authoritative key and `hitch_id` as a denormalised advisory column —
 * neither has a foreign key (backbone P1-1). Before any insert the
 * caller asserts that the given `(findingId, hitchId)` pair actually
 * matches the stored finding, so a mistyped hitch_id never silently
 * lands an audit row that doctor would later flag as inconsistent.
 *
 * Fail-closed: an unknown finding throws (rather than allowing the row),
 * and a stored/given hitch_id mismatch throws.
 */
export function assertFindingHitchConsistency(
  db: Database.Database,
  findingId: string,
  hitchId: string,
): void {
  const row = db
    .prepare("SELECT hitch_id FROM hitch_findings WHERE finding_id = ?")
    .get(findingId) as { hitch_id: string } | undefined;
  if (row === undefined) {
    throw new Error(
      `jury insert: finding_id ${findingId} not found (fail-closed)`,
    );
  }
  if (row.hitch_id !== hitchId) {
    throw new Error(
      `jury insert: hitch_id mismatch for finding ${findingId}: ` +
        `stored=${row.hitch_id} given=${hitchId}`,
    );
  }
}
