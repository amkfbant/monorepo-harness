import type Database from "better-sqlite3";
import { JuryClassificationProposalRepository } from "../../db/repositories/jury-classification-proposals.js";
import { JuryClassificationRefutationRepository } from "../../db/repositories/jury-classification-refutations.js";
import { JurySeverityAuditRepository } from "../../db/repositories/jury-severity-audits.js";
import { gateInputSha256 } from "./ids.js";
import { finalRoundProposals } from "./classify-packet.js";
import type { DeliberationOutcome } from "./deliberate.js";
import type { HitchFindingSeverity } from "../types.js";

/**
 * #230 Task D1 — Phase 3 audit-row persistence (extracted from classify-runner
 * to keep both files small). PURE persistence: it inserts the generated
 * proposals / refutation / severity-audit rows for one deliberation. It does NOT
 * decide anything and NEVER calls `repo.classifyFinding` (state transitions stay
 * in the runner, gated by the deterministic Stage5 result).
 *
 * Safety boundary (P2k): these rows are persisted regardless of whether the
 * finding is still classifiable — a finding classified by another path mid-run
 * still gets its audit trail, and the business-key dedup (which includes
 * `deliberation_id`, R15) makes a Phase-3 retry idempotent.
 */

/** The minimal finding identity an audit row needs (no LLM-driven fields). */
export interface AuditFindingRef {
  findingId: string;
  hitchId: string;
  harnessSeverity: HitchFindingSeverity;
}

/**
 * Persist ALL generated audit rows for one deliberation outcome (P2k): the
 * round-1 (and round-2) proposals, the refutation (if the refuter ran), and the
 * advisory severity audit. `runId` (when present) is recorded for provenance.
 */
export function persistAuditRows(
  db: Database.Database,
  ref: AuditFindingRef,
  outcome: DeliberationOutcome,
  runId: string | null,
): void {
  const now = new Date().toISOString();
  const proposalRepo = new JuryClassificationProposalRepository(db);
  for (const p of outcome.proposals) {
    proposalRepo.insert({
      findingId: ref.findingId,
      hitchId: ref.hitchId,
      ...(runId !== null ? { runId } : {}),
      lens: p.lens,
      reviewerId: `jury-${p.lens}`,
      proposedScope: p.proposedScope,
      proposalStatus: p.proposalStatus,
      ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
      ...(p.reasoning !== undefined ? { reasoning: p.reasoning } : {}),
      promptSha256: rowPromptSha256("propose", ref.findingId, p.lens, p.round),
      round: p.round,
      evidence: p.evidence,
      ...(p.refutationCondition !== undefined
        ? { refutationCondition: p.refutationCondition }
        : {}),
      ...(p.uncertainty !== undefined ? { uncertainty: p.uncertainty } : {}),
      ...(p.voteChanged !== undefined ? { voteChanged: p.voteChanged } : {}),
      ...(p.critique !== undefined ? { critique: [p.critique] } : {}),
      deliberationId: outcome.deliberationId,
      createdAt: now,
    });
  }
  if (outcome.refutation !== null) {
    new JuryClassificationRefutationRepository(db).insert({
      findingId: ref.findingId,
      hitchId: ref.hitchId,
      ...(runId !== null ? { runId } : {}),
      targetScope: outcome.refutation.targetScope,
      refuteVerdict: outcome.refutation.verdict.refuteVerdict,
      ...(outcome.refutation.verdict.counterEvidence !== undefined
        ? { counterEvidence: outcome.refutation.verdict.counterEvidence }
        : {}),
      reasoning: outcome.refutation.verdict.reasoning,
      reviewerId: "jury-refuter",
      promptSha256: rowPromptSha256("refute", ref.findingId, "refuter", 0),
      deliberationId: outcome.deliberationId,
      createdAt: now,
    });
  }
  const audit = outcome.severityAudit;
  new JurySeverityAuditRepository(db).insert({
    findingId: ref.findingId,
    hitchId: ref.hitchId,
    ...(runId !== null ? { runId } : {}),
    harnessSeverity: audit.harnessSeverity,
    ...(audit.juryConsensus !== undefined
      ? { jurySeverity: audit.juryConsensus }
      : {}),
    auditStatus: audit.status,
    escalateFlag: audit.escalate,
    reasoning: audit.reasoning,
    // FIX 4 (cross-cutting P2): jury_votes_json MUST be the SAME set the verdict
    // (audit_status / jury_severity) was computed over. `buildSeverityAudit`
    // (deliberate.ts) audits the FINAL-round votes, so persist the final-round
    // severity votes here — NOT every round (a stale R1 vote would contradict
    // the persisted verdict when critique changed the severity in R2).
    juryVotes: finalRoundProposals(outcome)
      .filter((p) => p.proposedSeverity !== undefined)
      .map((p) => ({
        lens: p.lens,
        proposedSeverity: p.proposedSeverity,
        ...(p.reasoning !== undefined ? { reasoning: p.reasoning } : {}),
        round: p.round,
      })),
    promptSha256: rowPromptSha256("severity", ref.findingId, "audit", 0),
    deliberationId: outcome.deliberationId,
    createdAt: now,
  });
}

/**
 * Deterministic per-row prompt sha256. The `deliberate` outcome does not surface
 * the raw prompts; the audit-table `prompt_sha256` (NOT NULL, part of the
 * business key) is a stable deterministic digest of the (kind, finding,
 * lens/role, round) tuple so a Phase-3 retry dedups against the same business
 * key (R15: `deliberation_id` is ALSO in the key, so a NEW deliberation — a
 * different gate input — is persisted as a distinct row).
 */
function rowPromptSha256(
  kind: string,
  findingId: string,
  lensOrRole: string,
  round: number,
): string {
  return gateInputSha256({ kind, findingId, lensOrRole, round });
}
