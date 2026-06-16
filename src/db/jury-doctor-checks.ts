import type Database from "better-sqlite3";
import type { DoctorCheck, DoctorFinding } from "./doctor.js";

/**
 * Doctor checks for the v31 jury audit tables (#230 deliberation jury,
 * design §6.3 / §0.1 R11 / P2f / P2g / P2h).
 *
 * The three jury tables (`jury_classification_proposals`,
 * `jury_classification_refutations`, `jury_severity_audits`) carry NO
 * foreign keys — `finding_id` is the authoritative key, `hitch_id` an
 * advisory denormalised column. doctor reports inconsistencies a missing
 * FK would otherwise hide; it never silently repairs them. All findings
 * are advisory (`warn`) and non-repairable: deleting an audit row is an
 * operator decision routed through the existing `repairFinding`
 * approval gate, never an automatic doctor side effect.
 *
 * orphan / hitch_id checks are SQL-only. The refutation<->proposals check
 * parses `recommended_next_action` JSON in TS (a SQL-only check cannot
 * reach the nested packet), per R11.
 *
 * NOTE (Layer 3 follow-up): design P2b also asks for an `auto_confirm`
 * legitimacy re-verification check that re-runs `aggregateDeliberation`
 * (Layer 1 / Task B3) over the stored proposals/refutations for
 * jury-confirmed findings. `aggregateDeliberation` does not exist yet, so
 * wiring that check is deferred to Layer 3; importing it now would break
 * typecheck. The three checks below (orphan / hitch mismatch / refutation
 * consistency) are implemented in full.
 */

const JURY_TABLES = [
  "jury_classification_proposals",
  "jury_classification_refutations",
  "jury_severity_audits",
] as const;

interface OrphanRow {
  table: string;
  rowId: number;
  findingId: string;
  hitchId: string;
}

/** Check 1: jury rows whose parent finding no longer exists. */
export const juryOrphanRowsCheck: DoctorCheck = {
  id: "jury.orphan_rows",
  category: "review",
  severity: "warn",
  description:
    "jury audit row references a finding that no longer exists (FK-zero orphan)",
  run(db) {
    const rows: OrphanRow[] = [];
    for (const [table, pk] of [
      ["jury_classification_proposals", "proposal_id"],
      ["jury_classification_refutations", "refutation_id"],
      ["jury_severity_audits", "audit_id"],
    ] as const) {
      const found = db
        .prepare(
          `SELECT j.${pk} AS row_id, j.finding_id, j.hitch_id
             FROM ${table} j
            WHERE NOT EXISTS (
              SELECT 1 FROM hitch_findings f
              WHERE f.finding_id = j.finding_id
            )
            LIMIT 50`,
        )
        .all() as Record<string, unknown>[];
      for (const r of found) {
        rows.push({
          table,
          rowId: Number(r.row_id),
          findingId: String(r.finding_id),
          hitchId: String(r.hitch_id),
        });
      }
    }
    return rows.map((r) => ({
      checkId: "jury.orphan_rows",
      severity: "warn" as const,
      status: "flagged" as const,
      message:
        `${r.table} row ${r.rowId} references missing finding ` +
        `${r.findingId} (orphan; advisory)`,
      repairable: false,
      details: r as unknown as Record<string, unknown>,
    }));
  },
};

/** Check 2: stored hitch_id differs from the hitch_findings join. */
export const juryHitchMismatchCheck: DoctorCheck = {
  id: "jury.hitch_mismatch",
  category: "review",
  severity: "warn",
  description:
    "jury audit row stored hitch_id disagrees with hitch_findings join",
  run(db) {
    const out: DoctorFinding[] = [];
    for (const [table, pk] of [
      ["jury_classification_proposals", "proposal_id"],
      ["jury_classification_refutations", "refutation_id"],
      ["jury_severity_audits", "audit_id"],
    ] as const) {
      const rows = db
        .prepare(
          `SELECT j.${pk} AS row_id, j.finding_id,
                  j.hitch_id AS stored_hitch_id,
                  f.hitch_id AS join_hitch_id
             FROM ${table} j
             JOIN hitch_findings f ON f.finding_id = j.finding_id
            WHERE j.hitch_id != f.hitch_id
            LIMIT 50`,
        )
        .all() as Record<string, unknown>[];
      for (const r of rows) {
        out.push({
          checkId: "jury.hitch_mismatch",
          severity: "warn",
          status: "flagged",
          message:
            `${table} row ${r.row_id} (finding ${r.finding_id}) stored ` +
            `hitch_id=${r.stored_hitch_id} but join=${r.join_hitch_id}`,
          repairable: false,
          details: { table, ...r },
        });
      }
    }
    return out;
  },
};

interface RefutationRow {
  refutationId: number;
  findingId: string;
  hitchId: string;
  targetScope: string;
  refuteVerdict: string;
  deliberationId: string;
}

/**
 * Check 3: refutation <-> proposals/packet consistency.
 *  (a) refutation.target_scope == the unanimous proposed_scope of the same
 *      deliberation_id's LATEST-round proposals (skipped when not unanimous
 *      or there are no proposals — nothing to compare against).
 *  (b) the persisted packet's refuter verdict (parsed from
 *      `recommended_next_action.decisionPacket.deliberation.refuter`) agrees
 *      with the stored refutation.refute_verdict for that finding +
 *      deliberation_id.
 */
export const juryRefutationMismatchCheck: DoctorCheck = {
  id: "jury.refutation_mismatch",
  category: "review",
  severity: "warn",
  description:
    "jury refutation disagrees with its proposals' unanimous scope or the persisted packet refuter verdict",
  run(db) {
    const refutations = db
      .prepare(
        `SELECT refutation_id, finding_id, hitch_id, target_scope,
                refute_verdict, deliberation_id
           FROM jury_classification_refutations`,
      )
      .all() as Record<string, unknown>[];
    if (refutations.length === 0) return [];

    const packetVerdicts = collectPacketRefuterVerdicts(db);
    const out: DoctorFinding[] = [];
    for (const raw of refutations) {
      const r: RefutationRow = {
        refutationId: Number(raw.refutation_id),
        findingId: String(raw.finding_id),
        hitchId: String(raw.hitch_id),
        targetScope: String(raw.target_scope),
        refuteVerdict: String(raw.refute_verdict),
        deliberationId: String(raw.deliberation_id),
      };

      // (a) target_scope vs unanimous proposed_scope.
      const unanimous = unanimousScope(db, r.findingId, r.deliberationId);
      if (unanimous !== null && unanimous !== r.targetScope) {
        out.push({
          checkId: "jury.refutation_mismatch",
          severity: "warn",
          status: "flagged",
          message:
            `refutation ${r.refutationId} (finding ${r.findingId}, ` +
            `deliberation ${r.deliberationId}) target_scope=${r.targetScope} ` +
            `but proposals are unanimous ${unanimous}`,
          repairable: false,
          details: {
            kind: "target_scope",
            ...r,
            unanimousScope: unanimous,
          },
        });
      }

      // (b) packet refuter verdict vs stored refutation verdict.
      const packetVerdict = packetVerdicts.get(
        verdictKey(r.findingId, r.deliberationId),
      );
      if (
        packetVerdict !== undefined &&
        packetVerdict !== r.refuteVerdict
      ) {
        out.push({
          checkId: "jury.refutation_mismatch",
          severity: "warn",
          status: "flagged",
          message:
            `refutation ${r.refutationId} (finding ${r.findingId}, ` +
            `deliberation ${r.deliberationId}) refute_verdict=` +
            `${r.refuteVerdict} but persisted packet refuter=${packetVerdict}`,
          repairable: false,
          details: {
            kind: "packet_verdict",
            ...r,
            packetVerdict,
          },
        });
      }
    }
    return out;
  },
};

/**
 * The unanimous proposed_scope of a finding's latest-round proposals for a
 * deliberation, or null when there are no proposals or they disagree. Uses
 * MAX(round) so a post-critique re-vote (round 2) supersedes round 1.
 */
function unanimousScope(
  db: Database.Database,
  findingId: string,
  deliberationId: string,
): string | null {
  const latest = db
    .prepare(
      `SELECT MAX(round) AS r
         FROM jury_classification_proposals
        WHERE finding_id = ? AND deliberation_id = ?`,
    )
    .get(findingId, deliberationId) as { r: number | null };
  if (latest.r === null) return null;
  const scopes = db
    .prepare(
      `SELECT DISTINCT proposed_scope
         FROM jury_classification_proposals
        WHERE finding_id = ? AND deliberation_id = ? AND round = ?`,
    )
    .all(findingId, deliberationId, latest.r) as { proposed_scope: string }[];
  if (scopes.length !== 1) return null;
  return scopes[0]?.proposed_scope ?? null;
}

/**
 * Parse every `hitch_convergence_decisions.recommended_next_action` JSON
 * and collect each decisionPacket's refuter verdict keyed by
 * (finding_id, deliberation_id). Malformed JSON / absent packet fields are
 * skipped defensively (a corrupt audit blob must never crash doctor).
 *
 * The authoritative packet shape (design §0.1 R14 / §5.2 / codex#252-P1)
 * carries `findingId` + `deliberationId` PER-FINDING inside `findings[]`
 * (a single packet-level ID cannot bundle multiple deliberations — "packet
 * 単一 ID では複数 deliberation を束ねられない"). A mixed-batch escalate
 * packet bundles several findings, each with its own `deliberationId`, under
 * one shared `deliberation.refuter` block. Each findings[] entry therefore
 * maps to the same shared refuter verdict.
 */
function collectPacketRefuterVerdicts(
  db: Database.Database,
): Map<string, string> {
  const verdicts = new Map<string, string>();
  const rows = db
    .prepare(
      `SELECT recommended_next_action
         FROM hitch_convergence_decisions
        WHERE recommended_next_action IS NOT NULL`,
    )
    .all() as { recommended_next_action: string }[];
  for (const row of rows) {
    const packet = parseDecisionPacket(row.recommended_next_action);
    if (packet === undefined) continue;
    const verdict = packetRefuterVerdict(packet);
    if (verdict === undefined) continue;
    for (const entry of packetFindingLinks(packet)) {
      verdicts.set(verdictKey(entry.findingId, entry.deliberationId), verdict);
    }
  }
  return verdicts;
}

interface PacketFindingLink {
  findingId: string;
  deliberationId: string;
}

/**
 * Extract each `findings[]` entry's (findingId, deliberationId) linkage from a
 * decision packet. Non-array `findings`, non-record entries, or entries
 * missing either id are skipped defensively (corrupt blobs must not crash).
 */
function packetFindingLinks(
  packet: Record<string, unknown>,
): PacketFindingLink[] {
  const findings = packet.findings;
  if (!Array.isArray(findings)) return [];
  const links: PacketFindingLink[] = [];
  for (const entry of findings) {
    if (!isRecord(entry)) continue;
    const findingId = asString(entry.findingId);
    const deliberationId = asString(entry.deliberationId);
    if (findingId === undefined || deliberationId === undefined) continue;
    links.push({ findingId, deliberationId });
  }
  return links;
}

function parseDecisionPacket(
  recommendedNextAction: string,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recommendedNextAction);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const packet = parsed.decisionPacket;
  return isRecord(packet) ? packet : undefined;
}

function packetRefuterVerdict(
  packet: Record<string, unknown>,
): string | undefined {
  const deliberation = packet.deliberation;
  if (!isRecord(deliberation)) return undefined;
  const refuter = deliberation.refuter;
  if (!isRecord(refuter)) return undefined;
  return asString(refuter.refuteVerdict);
}

function verdictKey(findingId: string, deliberationId: string): string {
  return `${findingId} ${deliberationId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** All v31 jury doctor checks, in registration order. */
export const JURY_DOCTOR_CHECKS: readonly DoctorCheck[] = [
  juryOrphanRowsCheck,
  juryHitchMismatchCheck,
  juryRefutationMismatchCheck,
];

export { JURY_TABLES };
