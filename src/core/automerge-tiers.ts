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

// Added lines that weaken a test instead of adding coverage: skip/only/todo
// markers and the xit/xdescribe family. Removing coverage by editing (net fewer
// `it()` blocks) is intentionally NOT flagged here to avoid false positives on
// refactors — that net-count check is a follow-up; deletion + skip markers are
// the clear, low-false-positive signals.
const TEST_SKIP_MARKER =
  /(?:\bx(?:it|describe|test|context)\s*\(|\b(?:it|test|describe|context)\.(?:skip|only|todo)\b|\.(?:skip|only|todo)\s*\()/;

/**
 * Whether a unified diff WEAKENS the test suite: it deletes a `tests/**` file,
 * or adds a skip/only/todo marker inside a `tests/**` file. Used to drop a
 * Tier-0 (tests-only) change out of auto-merge eligibility — a tests-only PR
 * that removes or disables coverage must not auto-merge silently.
 *
 * Fail-safe in BOTH directions: a false positive only forces a human merge
 * (safe), and a false negative is no worse than today. Conservative on purpose.
 */
export function detectsTestWeakening(patch: string): boolean {
  let currentFileIsTest = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/\S+ b\/(\S+)/);
      currentFileIsTest = m !== null && m[1] !== undefined
        ? m[1].startsWith("tests/")
        : false;
      continue;
    }
    if (!currentFileIsTest) continue;
    // a deleted tests/ file removes coverage.
    if (line.startsWith("deleted file mode")) return true;
    // an added line (not the `+++` header) that disables a test.
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (TEST_SKIP_MARKER.test(line)) return true;
    }
  }
  return false;
}
