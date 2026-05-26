import { minimatch } from "minimatch";
import type {
  GoalFinding,
  GoalFindingSeverity,
  GoalFindingSource,
  GoalScopeStatus,
  GoalSession,
} from "./types.js";

const MATCH_OPTS = { dot: true, nocomment: true } as const;
const FUTURE_OR_UNRELATED_RE =
  /\b(future|future-phase|later|nice-to-have|opportunistic|cleanup|refactor|unrelated|separate phase|follow-up only)\b/i;
const GENERIC_TARGET_TERMS = new Set([
  "add",
  "fix",
  "goal",
  "phase",
  "safety",
  "test",
  "update",
]);

export type HeuristicScopeStatus = Exclude<GoalScopeStatus, "duplicate">;

export interface ClassifiableGoalFinding {
  source?: GoalFindingSource | "close_check_failure";
  sourceRef?: string | null;
  severity?: GoalFindingSeverity;
  category?: string | null;
  summary: string;
  detail?: string | null;
  filePath?: string | null;
  symbol?: string | null;
}

export interface GoalFindingClassification {
  scopeStatus: HeuristicScopeStatus;
  reason: string;
}

export interface AutoFixCandidate {
  severity: GoalFindingSeverity;
  scopeStatus: GoalScopeStatus;
  lifecycleStatus?: GoalFinding["lifecycleStatus"];
}

export function classifyFindingForGoal(
  session: GoalSession,
  finding: ClassifiableGoalFinding,
): GoalFindingClassification {
  const category = normalizeToken(finding.category ?? "");
  const filePath = normalizePath(finding.filePath ?? "");
  const text = normalizeText(
    [finding.summary, finding.detail ?? "", finding.symbol ?? ""].join(" "),
  );

  if (isCloseCheckFailure(finding)) {
    return {
      scopeStatus: "in_scope",
      reason: "finding comes from a goal close-check failure",
    };
  }

  const excludedCategory = matchToken(
    category,
    session.scope.excludedCategories ?? [],
  );
  if (excludedCategory !== null) {
    return {
      scopeStatus: "out_of_scope",
      reason: `category ${JSON.stringify(finding.category)} is excluded by goal scope`,
    };
  }

  if (
    FUTURE_OR_UNRELATED_RE.test(
      [finding.summary, finding.detail ?? ""].join(" "),
    )
  ) {
    return {
      scopeStatus: "out_of_scope",
      reason: "finding text indicates future, unrelated, or opportunistic work",
    };
  }

  const targetFiles = session.scope.targetFiles ?? [];
  if (
    filePath !== "" &&
    targetFiles.length > 0 &&
    !matchesAnyFile(filePath, targetFiles)
  ) {
    return {
      scopeStatus: "out_of_scope",
      reason: `file ${JSON.stringify(finding.filePath)} is outside goal targetFiles`,
    };
  }

  if (
    filePath !== "" &&
    targetFiles.length > 0 &&
    matchesAnyFile(filePath, targetFiles)
  ) {
    return {
      scopeStatus: "in_scope",
      reason: `file ${JSON.stringify(finding.filePath)} matches goal targetFiles`,
    };
  }

  if (matchToken(category, session.scope.allowedFindingCategories ?? []) !== null) {
    return {
      scopeStatus: "in_scope",
      reason: `category ${JSON.stringify(finding.category)} is allowed by goal scope`,
    };
  }

  const targetMention = matchedTargetMention(session, text);
  if (targetMention !== null) {
    return {
      scopeStatus: "in_scope",
      reason: `finding text mentions goal target ${JSON.stringify(targetMention)}`,
    };
  }

  return {
    scopeStatus: "unknown",
    reason: "finding does not match goal scope heuristics",
  };
}

export function canAutoFixFinding(
  session: GoalSession,
  finding: AutoFixCandidate,
): boolean {
  if (!session.policy.autoFixSeverities.includes(finding.severity)) {
    return false;
  }
  if (
    finding.lifecycleStatus !== undefined &&
    !["open", "reopened"].includes(finding.lifecycleStatus)
  ) {
    return false;
  }
  if (session.policy.autoFixOnlyInScope) {
    return finding.scopeStatus === "in_scope";
  }
  return (
    finding.scopeStatus !== "unknown" && finding.scopeStatus !== "duplicate"
  );
}

function isCloseCheckFailure(finding: ClassifiableGoalFinding): boolean {
  if (finding.source === "close_check_failure") return true;
  const category = normalizeToken(finding.category ?? "");
  if (category === "close-check-failure" || category === "close_check_failure") {
    return true;
  }
  const sourceRef = normalizeText(finding.sourceRef ?? "");
  return (
    sourceRef.startsWith("close-check:") ||
    sourceRef.startsWith("close_check:")
  );
}

function matchesAnyFile(filePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    minimatch(filePath, normalizePattern(pattern), MATCH_OPTS),
  );
}

function matchedTargetMention(
  session: GoalSession,
  findingText: string,
): string | null {
  const targets = [
    session.scope.targetSummary ?? "",
    session.domain ?? "",
    ...(session.scope.targetOperations ?? []),
  ];
  for (const target of targets.flatMap(splitTargetTerms)) {
    if (target.length >= 3 && hasWord(findingText, target)) {
      return target;
    }
  }
  return null;
}

function splitTargetTerms(value: string): string[] {
  const normalized = normalizeText(value);
  if (normalized === "") return [];
  return normalized
    .split(/[^a-z0-9._-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !GENERIC_TARGET_TERMS.has(term));
}

function matchToken(value: string, allowed: readonly string[]): string | null {
  if (value === "") return null;
  for (const candidate of allowed) {
    if (normalizeToken(candidate) === value) return candidate;
  }
  return null;
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function normalizePattern(pattern: string): string {
  return normalizePath(pattern);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hasWord(text: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(term)}([^a-z0-9]|$)`).test(
    text,
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
