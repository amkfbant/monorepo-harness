import type Database from "better-sqlite3";
import type { DoctorCheck, DoctorFinding } from "./doctor.js";
import {
  aggregateDeliberation,
  selectFinalRound,
} from "../hitch/jury/aggregation.js";
import type {
  DeliberationInput,
  JuryClassificationProposal,
  JuryLens,
  JuryProposalStatus,
  JuryProposedScope,
  RefuterVerdict,
  VerifiedJuryEvidence,
} from "../hitch/jury/types.js";

/**
 * Doctor checks for the v31 jury audit tables (#230 deliberation jury,
 * design §6.3 / §0.1 R11 / P2f / P2g / P2h / P2b).
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
 * The `auto_confirm` legitimacy re-verification (design P2b) REPLAYS the
 * deterministic gate `aggregateDeliberation` over the stored final-round
 * proposals + refutation for every jury-auto_confirmed finding; if the
 * replay does NOT yield `auto_confirm` the finding is flagged advisory (a
 * possible LLM->state leak). This is the post-hoc, mechanized audit of the
 * safety boundary itself.
 */

const JURY_TABLES = [
  "jury_classification_proposals",
  "jury_classification_refutations",
  "jury_severity_audits",
] as const;

/**
 * Whether a table exists in the connected DB (SQLite `sqlite_master` lookup).
 * Used to GATE the jury checks on v31-table presence: a read-only caller running
 * `DEFAULT_CHECKS` against a DB not yet migrated to v31 (e.g. `dbRepairDryRunTool`
 * → `withReadonlyDb` + `DEFAULT_CHECKS.flatMap`, which never runs migrations)
 * would otherwise crash with "no such table" (codex#254-R5 P2). Fail-OPEN here is
 * safe: an ABSENT v31 table means there are no jury rows to audit, so skipping the
 * check is correct — never a masked inconsistency.
 */
function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
  return row !== undefined;
}

/**
 * Wrap a jury `DoctorCheck.run` so it SKIPS (returns no findings) when any of its
 * required v31 jury tables is absent. v31-present behaviour is byte-identical to
 * the unwrapped check. A skip yields zero findings — `runDoctor` then synthesises
 * the standard single "ok" row for an empty result, so a pre-v31 DB reports the
 * jury checks as ok rather than crashing.
 */
function guardOnTables(
  required: readonly string[],
  run: DoctorCheck["run"],
): DoctorCheck["run"] {
  return (db) => {
    for (const table of required) {
      if (!tableExists(db, table)) return [];
    }
    return run(db);
  };
}

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
  run: guardOnTables(JURY_TABLES, (db) => {
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
  }),
};

/** Check 2: stored hitch_id differs from the hitch_findings join. */
export const juryHitchMismatchCheck: DoctorCheck = {
  id: "jury.hitch_mismatch",
  category: "review",
  severity: "warn",
  description:
    "jury audit row stored hitch_id disagrees with hitch_findings join",
  run: guardOnTables(JURY_TABLES, (db) => {
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
  }),
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
 *      with the stored refutation.refute_verdict — but ONLY for the LEAD
 *      finding the shared block represents (FIX 3: in a bundled packet the
 *      single `deliberation.refuter` reflects `findings[0]` only; non-lead
 *      findings are validated by (a) against their own per-deliberation rows).
 */
export const juryRefutationMismatchCheck: DoctorCheck = {
  id: "jury.refutation_mismatch",
  category: "review",
  severity: "warn",
  description:
    "jury refutation disagrees with its proposals' unanimous scope or the persisted packet refuter verdict",
  run: guardOnTables(JURY_TABLES, (db) => {
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
  }),
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
 * one shared `deliberation.refuter` block.
 *
 * FIX 3 (codex P1): that single `deliberation.refuter` block reflects ONLY the
 * LEAD split (`buildJurySplitPacket` sets `deliberation = splits[0]`). Mapping
 * it to EVERY findings[] entry produces false matches/mismatches for non-lead
 * findings (whose own refuter lives in their OWN deliberation rows, validated
 * by the per-deliberation target_scope sub-check (a)). So the shared verdict is
 * keyed ONLY to the LEAD finding (`findings[0]`); non-lead findings are NOT
 * compared against the lead's summary block.
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
    // Only the LEAD finding (findings[0]) is represented by the shared
    // deliberation.refuter block; non-lead entries are skipped (FIX 3).
    const lead = packetLeadFindingLink(packet);
    if (lead === undefined) continue;
    verdicts.set(verdictKey(lead.findingId, lead.deliberationId), verdict);
  }
  return verdicts;
}

interface PacketFindingLink {
  findingId: string;
  deliberationId: string;
}

/**
 * Extract the LEAD `findings[0]` entry's (findingId, deliberationId) linkage —
 * the only finding the shared `deliberation.refuter` block authoritatively
 * represents (FIX 3). Non-array `findings`, a non-record lead entry, or a lead
 * entry missing either id yields undefined (corrupt blobs must not crash).
 */
function packetLeadFindingLink(
  packet: Record<string, unknown>,
): PacketFindingLink | undefined {
  const findings = packet.findings;
  if (!Array.isArray(findings) || findings.length === 0) return undefined;
  const entry = findings[0];
  if (!isRecord(entry)) return undefined;
  const findingId = asString(entry.findingId);
  const deliberationId = asString(entry.deliberationId);
  if (findingId === undefined || deliberationId === undefined) return undefined;
  return { findingId, deliberationId };
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
  return `${findingId}\0${deliberationId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Check 4 (design P2b): auto_confirm legitimacy re-verification. For every
 * finding whose `classification_reason` records a jury auto_confirm with an
 * embedded `deliberation_id`, REPLAY the deterministic gate
 * (`aggregateDeliberation`) over the stored final-round proposals + refutation
 * and FLAG (advisory) any finding whose replay does NOT yield
 * `decision==='auto_confirm'`. A finding recorded as jury auto_confirm whose
 * stored rows no longer satisfy the gate is a possible LLM->state leak (the
 * safety boundary was bypassed or the rows were tampered after the fact).
 *
 * The replay uses `selectFinalRound` (round 2 when any round-2 row exists for
 * the deliberation_id, else round 1) exactly as the live gate did, so it
 * reproduces the same arbiter the auto_confirm was based on.
 *
 * Round6 FIX 2 (codex#254 P2 — replay scope-match audit): replaying to
 * `auto_confirm` is necessary but NOT sufficient. A corrupt row recording "jury
 * auto_confirm" with the OPPOSITE scope (e.g. the proposals replay to in_scope
 * but the finding's stored `scope_status` is out_of_scope) replays as
 * auto_confirm and would pass silently. So when replay DOES yield auto_confirm,
 * the replayed `scope` is ALSO compared to the finding's stored `scope_status`;
 * a disagreement is FLAGGED advisory (the recorded scope does not match the
 * deterministic gate's scope — a possible LLM->state leak / post-hoc tamper).
 */
export const juryAutoConfirmReplayCheck: DoctorCheck = {
  id: "jury.auto_confirm_replay",
  category: "review",
  severity: "warn",
  description:
    "jury auto_confirmed finding whose stored proposals/refutation do not replay to auto_confirm (possible LLM->state leak)",
  run: guardOnTables(JURY_TABLES, (db) => {
    const findings = db
      .prepare(
        `SELECT finding_id, file_path, category, scope_status,
                classification_reason
           FROM hitch_findings
          WHERE classification_reason LIKE '%jury auto_confirm (deliberation_id=%'`,
      )
      .all() as Record<string, unknown>[];
    const out: DoctorFinding[] = [];
    for (const raw of findings) {
      const findingId = String(raw.finding_id);
      const reason = asString(raw.classification_reason);
      if (reason === undefined) continue;
      const deliberationId = parseDeliberationId(reason);
      if (deliberationId === undefined) continue;

      const proposals = loadFinalRoundProposals(db, findingId, deliberationId);
      const refuterVerdict = loadRefuterVerdict(db, findingId, deliberationId);
      const input: DeliberationInput = {
        findingId,
        deliberationId,
        finding: {
          ...(asString(raw.file_path) !== undefined
            ? { filePath: asString(raw.file_path) as string }
            : {}),
          ...(nonEmptyCategory(raw.category) !== undefined
            ? { category: nonEmptyCategory(raw.category) as string }
            : {}),
        },
        proposals,
        ...(refuterVerdict !== undefined ? { refuterVerdict } : {}),
      };
      const replay = aggregateDeliberation(input);
      if (replay.decision !== "auto_confirm") {
        out.push({
          checkId: "jury.auto_confirm_replay",
          severity: "warn",
          status: "flagged",
          message:
            `finding ${findingId} (deliberation ${deliberationId}) is recorded as ` +
            `jury auto_confirm but replaying the gate over its stored rows yields ` +
            `${replay.decision} (${replay.reason}); possible LLM->state leak`,
          repairable: false,
          details: {
            findingId,
            deliberationId,
            replayDecision: replay.decision,
            replayReason: replay.reason,
            gateTrace: replay.gateTrace,
          },
        });
        continue;
      }
      // Round6 FIX 2: replay DOES auto_confirm — also verify the replayed scope
      // matches the finding's stored scope_status. A disagreement means the
      // recorded scope was not produced by the deterministic gate (possible
      // LLM->state leak / tamper) even though the gate would have auto_confirmed.
      const storedScope = asString(raw.scope_status);
      if (
        replay.scope !== undefined &&
        storedScope !== undefined &&
        storedScope !== replay.scope
      ) {
        out.push({
          checkId: "jury.auto_confirm_replay",
          severity: "warn",
          status: "flagged",
          message:
            `finding ${findingId} (deliberation ${deliberationId}) is recorded as ` +
            `jury auto_confirm with scope_status=${storedScope} but replaying the ` +
            `gate yields scope ${replay.scope}; recorded scope does not match the ` +
            `deterministic gate (possible LLM->state leak)`,
          repairable: false,
          details: {
            findingId,
            deliberationId,
            storedScope,
            replayScope: replay.scope,
            gateTrace: replay.gateTrace,
          },
        });
      }
    }
    return out;
  }),
};

/** Extract `<id>` from a `...jury auto_confirm (deliberation_id=<id>)...` reason. */
function parseDeliberationId(reason: string): string | undefined {
  const m = /jury auto_confirm \(deliberation_id=([^)]+)\)/.exec(reason);
  return m?.[1];
}

/** A non-empty `category` value, or undefined (the empty string is "no category"). */
function nonEmptyCategory(value: unknown): string | undefined {
  const s = asString(value);
  return s !== undefined && s.length > 0 ? s : undefined;
}

/**
 * Reconstruct the selected final-round `JuryClassificationProposal[]` for a
 * deliberation from the stored proposal rows. ALL rounds are loaded and
 * `selectFinalRound` picks the target round (round 2 if any round-2 row exists,
 * else round 1) — identical to the live gate's selection.
 */
function loadFinalRoundProposals(
  db: Database.Database,
  findingId: string,
  deliberationId: string,
): JuryClassificationProposal[] {
  const rows = db
    .prepare(
      `SELECT lens, proposed_scope, proposal_status, round, evidence_json,
              reasoning, confidence, refutation_condition, uncertainty
         FROM jury_classification_proposals
        WHERE finding_id = ? AND deliberation_id = ?`,
    )
    .all(findingId, deliberationId) as Record<string, unknown>[];
  const all = rows.map((r) => reconstructProposal(findingId, r));
  return selectFinalRound(all);
}

/** Rebuild one `JuryClassificationProposal` (incl. evidence) from a stored row. */
function reconstructProposal(
  findingId: string,
  row: Record<string, unknown>,
): JuryClassificationProposal {
  const round = Number(row.round) === 2 ? 2 : 1;
  return {
    findingId,
    lens: String(row.lens) as JuryLens,
    proposedScope: String(row.proposed_scope) as JuryProposedScope,
    proposalStatus: String(row.proposal_status) as JuryProposalStatus,
    evidence: parseEvidence(row.evidence_json),
    round,
    ...(asString(row.reasoning) !== undefined
      ? { reasoning: asString(row.reasoning) as string }
      : {}),
    ...(typeof row.confidence === "number"
      ? { confidence: row.confidence }
      : {}),
    ...(asString(row.refutation_condition) !== undefined
      ? { refutationCondition: asString(row.refutation_condition) as string }
      : {}),
    ...(asString(row.uncertainty) !== undefined
      ? { uncertainty: asString(row.uncertainty) as string }
      : {}),
  };
}

/**
 * Parse the stored `evidence_json` into `VerifiedJuryEvidence[]`. Malformed /
 * absent JSON yields an empty array (fail-closed: no verified evidence -> the
 * replay escalates, which surfaces the tampering rather than hiding it).
 */
function parseEvidence(value: unknown): VerifiedJuryEvidence[] {
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord) as unknown as VerifiedJuryEvidence[];
}

/**
 * Reconstruct the `RefuterVerdict` for a deliberation from the stored
 * refutation row, or `undefined` when none exists (so the replayed gate sees a
 * never-run refuter and escalates — fail-closed, matching the live gate).
 */
function loadRefuterVerdict(
  db: Database.Database,
  findingId: string,
  deliberationId: string,
): RefuterVerdict | undefined {
  const row = db
    .prepare(
      `SELECT refute_verdict, reasoning
         FROM jury_classification_refutations
        WHERE finding_id = ? AND deliberation_id = ?
        LIMIT 1`,
    )
    .get(findingId, deliberationId) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  const refuteVerdict = asString(row.refute_verdict);
  if (refuteVerdict === undefined) return undefined;
  return {
    refuteVerdict: refuteVerdict as RefuterVerdict["refuteVerdict"],
    reasoning: asString(row.reasoning) ?? "",
  };
}

/** All v31 jury doctor checks, in registration order. */
export const JURY_DOCTOR_CHECKS: readonly DoctorCheck[] = [
  juryOrphanRowsCheck,
  juryHitchMismatchCheck,
  juryRefutationMismatchCheck,
  juryAutoConfirmReplayCheck,
];

export { JURY_TABLES };
