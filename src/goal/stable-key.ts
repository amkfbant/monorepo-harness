import { createHash } from "node:crypto";

export interface GoalFindingStableKeyInput {
  filePath?: string | null | undefined;
  symbol?: string | null | undefined;
  category: string;
  summary: string;
}

function normalizePart(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function normalizeFindingIdentity(
  input: GoalFindingStableKeyInput,
): string {
  return [
    normalizePart(input.filePath),
    normalizePart(input.symbol),
    normalizePart(input.category),
    normalizePart(input.summary),
  ].join("\n");
}

export function goalFindingStableKey(
  input: GoalFindingStableKeyInput,
): string {
  return createHash("sha256")
    .update(normalizeFindingIdentity(input))
    .digest("hex");
}
