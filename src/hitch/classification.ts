import { minimatch } from "minimatch";
import type {
  HitchFinding,
  HitchFindingSeverity,
  HitchFindingSource,
  HitchScopeStatus,
  HitchSession,
} from "./types.js";

const MATCH_OPTS = { dot: true, nocomment: true } as const;
const FUTURE_OR_UNRELATED_RE =
  /\b(future|future-phase|later|nice-to-have|opportunistic|cleanup|refactor|unrelated|separate phase|follow-up only)\b/i;
const TEST_NOT_RUN_PATTERNS = [
  /\b(?:tests?|test suite|test command|checks?|verification)\b.{0,80}\b(?:not|never)\b.{0,40}\b(?:run|executed|performed|completed)\b/,
  /\b(?:not|never)\b.{0,40}\b(?:run|execute|perform|complete)\b.{0,80}\b(?:tests?|test suite|test command|checks?|verification)\b/,
  /\b(?:did not|didn't|cannot|can't|could not|couldn't|unable to|was not able to|wasn't able to|not able to)\b.{0,40}\b(?:run|execute|perform|complete)\b.{0,80}\b(?:tests?|test suite|test command|checks?|verification)\b/,
  /\bno\b.{0,20}\b(?:tests?|test suite|checks?|verification)\b.{0,30}\b(?:run|executed|performed|completed)\b/,
] as const;
const MISSING_COMMAND_LOG_PATTERNS = [
  /\b(?:no|missing|without|absent|unavailable)\b.{0,60}\b(?:command|test|check|verification)\b.{0,30}\b(?:logs?|output)\b/,
  /\b(?:command|test|check|verification)\b.{0,30}\b(?:logs?|output)\b.{0,60}\b(?:missing|absent|unavailable|not provided|not present|not included|not attached)\b/,
  /\b(?:cannot|can't|could not|couldn't|unable to|not able to)\b.{0,60}\b(?:find|see|inspect|verify)\b.{0,60}\b(?:command|test|check|verification)\b.{0,30}\b(?:logs?|output)\b/,
] as const;
const ENVIRONMENT_META_CONTEXT_RE =
  /\b(?:ci|container|environment|env|here|local|locally|machine|runner|sandbox)\b|\bthis setup\b/;
const REVIEWER_META_CONTEXT_RE =
  /\b(?:i|manual verification|reviewer|this review|we)\b/;
const MISSING_COMMAND_LOG_CONTEXT_RE =
  /\b(?:provided|present|available|included|attached|visible|found|see|inspect|verify)\b/;
const GENERIC_TARGET_TERMS = new Set([
  "add",
  "fix",
  "goal",
  "phase",
  "safety",
  "test",
  "update",
]);

export type HeuristicScopeStatus = Exclude<HitchScopeStatus, "duplicate">;

export interface ClassifiableHitchFinding {
  source?: HitchFindingSource | "close_check_failure";
  sourceRef?: string | null;
  severity?: HitchFindingSeverity;
  category?: string | null;
  summary: string;
  detail?: string | null;
  filePath?: string | null;
  symbol?: string | null;
}

export interface HitchFindingClassification {
  scopeStatus: HeuristicScopeStatus;
  reason: string;
}

export interface AutoFixCandidate {
  severity: HitchFindingSeverity;
  scopeStatus: HitchScopeStatus;
  lifecycleStatus?: HitchFinding["lifecycleStatus"];
}

export function classifyFindingForHitch(
  session: HitchSession,
  finding: ClassifiableHitchFinding,
): HitchFindingClassification {
  const category = normalizeToken(finding.category ?? "");
  const filePath = normalizePath(finding.filePath ?? "");
  const text = normalizeText(
    [finding.summary, finding.detail ?? "", finding.symbol ?? ""].join(" "),
  );

  if (isCloseCheckFailure(finding)) {
    return {
      scopeStatus: "in_scope",
      reason: "finding comes from a hitch close-check failure",
    };
  }

  if (
    category === "review-non-blocking-comment" &&
    isEnvironmentMetaNote([finding.summary, finding.detail ?? ""].join(" "))
  ) {
    return {
      scopeStatus: "out_of_scope",
      reason: "finding text is a reviewer environment meta note",
    };
  }

  const excludedCategory = matchToken(
    category,
    session.scope.excludedCategories ?? [],
  );
  if (excludedCategory !== null) {
    return {
      scopeStatus: "out_of_scope",
      reason: `category ${JSON.stringify(finding.category)} is excluded by hitch scope`,
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
      reason: `file ${JSON.stringify(finding.filePath)} is outside hitch targetFiles`,
    };
  }

  if (
    filePath !== "" &&
    targetFiles.length > 0 &&
    matchesAnyFile(filePath, targetFiles)
  ) {
    return {
      scopeStatus: "in_scope",
      reason: `file ${JSON.stringify(finding.filePath)} matches hitch targetFiles`,
    };
  }

  if (matchToken(category, session.scope.allowedFindingCategories ?? []) !== null) {
    return {
      scopeStatus: "in_scope",
      reason: `category ${JSON.stringify(finding.category)} is allowed by hitch scope`,
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

  const targetMention = matchedTargetMention(session, text);
  if (targetMention !== null) {
    return {
      scopeStatus: "in_scope",
      reason: `finding text mentions hitch target ${JSON.stringify(targetMention)}`,
    };
  }

  return {
    scopeStatus: "unknown",
    reason: "finding does not match hitch scope heuristics",
  };
}

export function isEnvironmentMetaNote(text: string): boolean {
  const normalized = normalizeText(text.replace(/[`*_>\[\]()]/g, " "));
  if (normalized === "") return false;
  if (TEST_NOT_RUN_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return (
      ENVIRONMENT_META_CONTEXT_RE.test(normalized) ||
      REVIEWER_META_CONTEXT_RE.test(normalized)
    );
  }
  if (!MISSING_COMMAND_LOG_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return (
    MISSING_COMMAND_LOG_CONTEXT_RE.test(normalized) ||
    ENVIRONMENT_META_CONTEXT_RE.test(normalized) ||
    REVIEWER_META_CONTEXT_RE.test(normalized)
  );
}

/**
 * Broader test-execution advisory matcher for reviewer non_blocking_comments.
 * Unlike `isEnvironmentMetaNote` (which additionally requires an environment /
 * reviewer context), this treats ANY test-not-run or missing-command-log
 * phrasing as a reviewer advisory — e.g. a plain "Tests were not run" with no
 * surrounding context. It MUST only ever be applied to non_blocking_comments;
 * required changes are never filtered, so a broad match here cannot suppress a
 * real blocker.
 */
export function isTestNotRunAdvisory(text: string): boolean {
  const normalized = normalizeText(text.replace(/[`*_>\[\]()]/g, " "));
  if (normalized === "") return false;
  return (
    TEST_NOT_RUN_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    MISSING_COMMAND_LOG_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

export function canAutoFixFinding(
  session: HitchSession,
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

function isCloseCheckFailure(finding: ClassifiableHitchFinding): boolean {
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
  session: HitchSession,
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
