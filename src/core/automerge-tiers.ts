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
    { glob: "src/hitch/**", tier: 2 },
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

// Added lines that weaken a test instead of adding coverage: skip/only/todo
// markers and the xit/xdescribe family.
const TEST_SKIP_MARKER =
  /(?:\bx(?:it|describe|test|context)\s*\(|\b(?:it|test|describe|context)\.(?:skip|only|todo)\b|\.(?:skip|only|todo)\s*\()/;

// A line that DEFINES a test case or suite (any vitest/jest style, incl. the
// skip/only/todo/each variants and the xit/xdescribe family). Used to count the
// net change in test cases per file: removing more definitions than are added
// (without a whole-file delete or a skip marker) still drops coverage.
const TEST_DEFINITION =
  /\b(?:x?(?:it|test|describe|context))(?:\.(?:skip|only|todo|each|concurrent|failing))?\s*[(`]/;

/**
 * Whether a unified diff WEAKENS the test suite for any `tests/**` file: it
 * deletes the file, adds a skip/only/todo marker, or removes more test/suite
 * definitions than it adds (a net decrease in cases). Used to drop a Tier-0
 * (tests-only) change out of auto-merge eligibility — a tests-only PR that
 * removes or disables coverage must not auto-merge silently.
 *
 * The net-count check is evaluated PER FILE so an unrelated test file that only
 * adds cases cannot mask another that drops them. A balanced rename/refactor
 * (removed == added) is not flagged.
 *
 * Fail-safe in BOTH directions: a false positive only forces a human merge
 * (safe), and a false negative is no worse than the deletion/skip signals alone.
 */
export function detectsTestWeakening(patch: string): boolean {
  let currentFileIsTest = false;
  let added = 0;
  let removed = 0;
  // True once we know the current file drops more definitions than it adds.
  const fileHasNetDecrease = (): boolean => currentFileIsTest && removed > added;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // Settle the file we just finished before switching context.
      if (fileHasNetDecrease()) return true;
      added = 0;
      removed = 0;
      const m = line.match(/^diff --git a\/\S+ b\/(\S+)/);
      currentFileIsTest =
        m !== null && m[1] !== undefined ? m[1].startsWith("tests/") : false;
      continue;
    }
    if (!currentFileIsTest) continue;
    // a deleted tests/ file removes coverage.
    if (line.startsWith("deleted file mode")) return true;
    // skip the unified-diff file headers (not real content lines).
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      // an added line that disables a test.
      if (TEST_SKIP_MARKER.test(line)) return true;
      if (TEST_DEFINITION.test(line)) added += 1;
    } else if (line.startsWith("-")) {
      if (TEST_DEFINITION.test(line)) removed += 1;
    }
  }
  // Settle the final file in the diff.
  return fileHasNetDecrease();
}
