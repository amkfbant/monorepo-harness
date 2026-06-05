import { minimatch } from "minimatch";

export type AutoMergeTier = 0 | 1 | 2;

export interface AutoMergeSensitivityRule {
  glob: string;
  tier: AutoMergeTier;
}

const MATCH_OPTS = { dot: true, nocomment: true } as const;

export const DEFAULT_AUTO_MERGE_SENSITIVITY_MAP: readonly AutoMergeSensitivityRule[] =
  [
    { glob: "src/policy/**", tier: 2 },
    { glob: "src/codex/**", tier: 2 },
    { glob: "src/core/merge-gate.ts", tier: 2 },
    { glob: "src/goal/**", tier: 2 },
    { glob: "src/core/reviewer-agent.ts", tier: 2 },
    { glob: "src/db/repositories/review-*.ts", tier: 2 },
    { glob: "src/db/migrations*", tier: 2 },
    { glob: ".github/**", tier: 2 },
    { glob: "policies/**", tier: 2 },
    { glob: "docs/**", tier: 0 },
    { glob: "tests/**", tier: 0 },
  ];

function tierForPath(
  path: string,
  sensitivityMap: readonly AutoMergeSensitivityRule[],
): AutoMergeTier {
  let tier: AutoMergeTier | null = null;
  for (const rule of sensitivityMap) {
    if (
      minimatch(path, rule.glob, MATCH_OPTS) &&
      (tier === null || rule.tier > tier)
    ) {
      tier = rule.tier;
    }
  }
  return tier ?? 1;
}

export function computeAutoMergeTier(
  changedPaths: readonly string[],
  sensitivityMap: readonly AutoMergeSensitivityRule[] =
    DEFAULT_AUTO_MERGE_SENSITIVITY_MAP,
): AutoMergeTier {
  let maxTier: AutoMergeTier = changedPaths.length === 0 ? 1 : 0;
  for (const path of changedPaths) {
    const tier = tierForPath(path, sensitivityMap);
    if (tier > maxTier) maxTier = tier;
  }
  return maxTier;
}
