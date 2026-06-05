import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  DEFAULT_AUTO_MERGE_SENSITIVITY_MAP,
  type AutoMergeSensitivityRule,
} from "./automerge-tiers.js";

/** Operator override config, relative to the harness root. */
export const AUTO_MERGE_TIERS_CONFIG_PATH = "policies/automerge-tiers.yaml";

const AutoMergeTierRuleSchema = z
  .object({
    glob: z.string().min(1),
    tier: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  })
  .strict();

export const AutoMergeTiersConfigSchema = z
  .object({
    version: z.literal(1),
    rules: z.array(AutoMergeTierRuleSchema),
  })
  .strict();

/**
 * Load the auto-merge sensitivity map for a harness root.
 *
 * Operator rules from `policies/automerge-tiers.yaml` are APPENDED to the
 * built-in defaults. Because `computeAutoMergeTier` takes the MAX tier across
 * every matching rule, an operator rule can only RAISE a path's tier (tighten =
 * make auto-merge more restrictive), never lower it — a default Tier-2 always
 * wins over an operator Tier-0 for the same path. The override is therefore
 * fail-closed: operators can only harden the gate, never loosen it.
 *
 * Missing file → built-in defaults. A present-but-malformed file THROWS rather
 * than silently falling back: a broken merge-gate policy must stop the merge
 * (fail-closed), not quietly use a different map than the operator intended.
 */
export function loadAutoMergeSensitivityMap(
  harnessRoot: string,
): readonly AutoMergeSensitivityRule[] {
  const path = join(harnessRoot, AUTO_MERGE_TIERS_CONFIG_PATH);
  if (!existsSync(path)) return DEFAULT_AUTO_MERGE_SENSITIVITY_MAP;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `failed to read ${AUTO_MERGE_TIERS_CONFIG_PATH}: ${(e as Error).message}`,
    );
  }
  const parsed = AutoMergeTiersConfigSchema.safeParse(parseYaml(raw));
  if (!parsed.success) {
    throw new Error(
      `invalid ${AUTO_MERGE_TIERS_CONFIG_PATH}: ${parsed.error.message}`,
    );
  }
  return [...DEFAULT_AUTO_MERGE_SENSITIVITY_MAP, ...parsed.data.rules];
}
