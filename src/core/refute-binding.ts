import { createHash } from "node:crypto";
import type {
  ReviewRefuteVoteInput,
  ReviewRefuteVoteInsertResult,
} from "../db/repositories/review-refute-votes.js";

export const TARGET_CHANGE_HASH_VERSION = "refute-target-change:v1";
export const TARGET_CHANGE_HASH_MISSING_SENTINEL =
  "refute-target-change:missing:v1";

export interface RefuteRequiredChange {
  idx: number;
  changeText?: string;
  change_text?: string;
}

export interface RefuteBindingVote {
  targetChangeHash?: string | null;
  target_change_hash?: string | null;
  targetChangeText?: string | null;
  target_change_text?: string | null;
}

export type RefuteBindingRejectReason =
  | "missing_target"
  | "hash_mismatch"
  | "unknown_target";

export type RefuteBindingResult =
  | {
      bound: true;
      boundToIdx: number;
      targetChangeHash: string;
      normalizedChangeText: string;
    }
  | {
      bound: false;
      reason: RefuteBindingRejectReason;
      targetChangeHash: string | null;
      declaredTargetChangeHash?: string;
      computedTargetChangeHash?: string;
    };

export interface RefuteBindingRecorder {
  insert(input: ReviewRefuteVoteInput): ReviewRefuteVoteInsertResult;
}

export type VerifyAndRecordRefuteBindingInput = Omit<
  ReviewRefuteVoteInput,
  "targetChangeHash" | "targetChangeIdx" | "validationStatus" | "rejectReason"
> & {
  repository: RefuteBindingRecorder;
  refuteVote: RefuteBindingVote;
  activeRequiredChanges: RefuteRequiredChange[];
};

export type VerifyAndRecordRefuteBindingResult =
  ReviewRefuteVoteInsertResult & {
    binding: RefuteBindingResult;
  };

/**
 * Canonical form for binding a refute vote to a required_change.
 *
 * This is intentionally conservative: it normalizes Unicode form, line endings,
 * and horizontal whitespace, but it does not fold case or remove punctuation.
 */
export function normalizeChangeText(changeText: string): string {
  const lf = changeText.normalize("NFC").replace(/\r\n?/g, "\n");
  return lf
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

export function targetChangeHash(changeText: string): string {
  return sha256Hex(
    `${TARGET_CHANGE_HASH_VERSION}\0${normalizeChangeText(changeText)}`,
  );
}

export function verifyRefuteBinding(input: {
  refuteVote: RefuteBindingVote;
  activeRequiredChanges: RefuteRequiredChange[];
}): RefuteBindingResult {
  const declaredHash = readVoteHash(input.refuteVote);
  const targetText = readVoteText(input.refuteVote);
  const activeByHash = activeRequiredChangeMap(input.activeRequiredChanges);

  if (targetText !== null) {
    const computedHash = targetChangeHash(targetText);
    if (declaredHash !== null && declaredHash !== computedHash) {
      return {
        bound: false,
        reason: "hash_mismatch",
        targetChangeHash: computedHash,
        declaredTargetChangeHash: declaredHash,
        computedTargetChangeHash: computedHash,
      };
    }
    const active = activeByHash.get(computedHash);
    if (active === undefined) {
      return {
        bound: false,
        reason: "unknown_target",
        targetChangeHash: computedHash,
        computedTargetChangeHash: computedHash,
      };
    }
    return {
      bound: true,
      boundToIdx: active.idx,
      targetChangeHash: computedHash,
      normalizedChangeText: active.normalizedChangeText,
    };
  }

  if (declaredHash === null) {
    return {
      bound: false,
      reason: "missing_target",
      targetChangeHash: null,
    };
  }

  const active = activeByHash.get(declaredHash);
  if (active === undefined) {
    return {
      bound: false,
      reason: "unknown_target",
      targetChangeHash: declaredHash,
      declaredTargetChangeHash: declaredHash,
    };
  }
  return {
    bound: true,
    boundToIdx: active.idx,
    targetChangeHash: declaredHash,
    normalizedChangeText: active.normalizedChangeText,
  };
}

export function verifyAndRecordRefuteBinding(
  input: VerifyAndRecordRefuteBindingInput,
): VerifyAndRecordRefuteBindingResult {
  const { repository, refuteVote, activeRequiredChanges, ...footprint } = input;
  const binding = verifyRefuteBinding({ refuteVote, activeRequiredChanges });
  const recorded = repository.insert(
    binding.bound
      ? {
          ...footprint,
          targetChangeHash: binding.targetChangeHash,
          targetChangeIdx: binding.boundToIdx,
          validationStatus: "passed",
        }
      : {
          ...footprint,
          targetChangeHash: rejectedAuditTargetHash(binding),
          validationStatus: "rejected",
          rejectReason: binding.reason,
        },
  );
  return { ...recorded, binding };
}

function activeRequiredChangeMap(
  changes: RefuteRequiredChange[],
): Map<string, { idx: number; normalizedChangeText: string }> {
  const out = new Map<string, { idx: number; normalizedChangeText: string }>();
  for (const change of [...changes].sort((a, b) => a.idx - b.idx)) {
    const text = readChangeText(change);
    if (text === null) continue;
    const normalizedChangeText = normalizeChangeText(text);
    const hash = targetChangeHash(text);
    if (!out.has(hash)) {
      out.set(hash, { idx: change.idx, normalizedChangeText });
    }
  }
  return out;
}

function rejectedAuditTargetHash(
  binding: Extract<RefuteBindingResult, { bound: false }>,
): string {
  return (
    binding.computedTargetChangeHash ??
    binding.targetChangeHash ??
    TARGET_CHANGE_HASH_MISSING_SENTINEL
  );
}

function readChangeText(change: RefuteRequiredChange): string | null {
  return change.changeText ?? change.change_text ?? null;
}

function readVoteHash(vote: RefuteBindingVote): string | null {
  return vote.targetChangeHash ?? vote.target_change_hash ?? null;
}

function readVoteText(vote: RefuteBindingVote): string | null {
  return vote.targetChangeText ?? vote.target_change_text ?? null;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
