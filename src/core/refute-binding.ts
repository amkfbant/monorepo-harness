import { createHash } from "node:crypto";

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
  return sha256Hex(normalizeChangeText(changeText));
}

export function verifyRefuteBinding(input: {
  refuteVote: RefuteBindingVote;
  activeRequiredChanges: RefuteRequiredChange[];
}): RefuteBindingResult {
  const declaredHash = readVoteHash(input.refuteVote);
  const targetText = readVoteText(input.refuteVote);
  const activeByHash = activeRequiredChangeMap(input.activeRequiredChanges);

  if (targetText !== null) {
    const normalized = normalizeChangeText(targetText);
    const computedHash = sha256Hex(normalized);
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

function activeRequiredChangeMap(
  changes: RefuteRequiredChange[],
): Map<string, { idx: number; normalizedChangeText: string }> {
  const out = new Map<string, { idx: number; normalizedChangeText: string }>();
  for (const change of [...changes].sort((a, b) => a.idx - b.idx)) {
    const text = readChangeText(change);
    if (text === null) continue;
    const normalizedChangeText = normalizeChangeText(text);
    const hash = sha256Hex(normalizedChangeText);
    if (!out.has(hash)) {
      out.set(hash, { idx: change.idx, normalizedChangeText });
    }
  }
  return out;
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
