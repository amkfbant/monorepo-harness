import { createHash } from "node:crypto";

export interface HitchFindingStableKeyInput {
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
  input: HitchFindingStableKeyInput,
): string {
  return [
    normalizePart(input.filePath),
    normalizePart(input.symbol),
    normalizePart(input.category),
    normalizePart(input.summary),
  ].join("\n");
}

export function hitchFindingStableKey(
  input: HitchFindingStableKeyInput,
): string {
  return createHash("sha256")
    .update(normalizeFindingIdentity(input))
    .digest("hex");
}
