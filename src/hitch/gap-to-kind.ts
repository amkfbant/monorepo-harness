import type {
  HitchCloseCondition,
  HitchCloseConditionKind,
} from "./types.js";

export interface GapRow {
  metric: string;
  count: number;
  gap: number;
  reason?: string;
}

export interface GapAllowedCommand {
  id: string;
  display?: string;
}

export interface MappingContext {
  gap: GapRow;
  allowedKinds: readonly HitchCloseConditionKind[];
  allowedCommands?: readonly GapAllowedCommand[];
  existingConditions?: readonly HitchCloseCondition[];
}

export interface MappedCloseConditionProposal {
  kind: HitchCloseConditionKind;
  description: string;
  rule?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  command?: string;
  confidence: number;
  rationale: string;
}

export type GapMetricMappingResult =
  | { ok: true; proposal: MappedCloseConditionProposal }
  | {
      ok: false;
      code: "unmapped_metric" | "ambiguous_metric" | "kind_not_allowed";
      message: string;
    };

type Candidate = Omit<MappedCloseConditionProposal, "confidence" | "rationale">;

export function mapGapMetricToCloseConditionKind(
  gap: GapRow,
  context: Omit<MappingContext, "gap">,
): GapMetricMappingResult {
  const candidates = mappingCandidates(gap, context);
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "unmapped_metric",
      message: `cannot map gap metric to a close condition kind: ${gap.metric}`,
    };
  }
  const kinds = new Set(candidates.map((candidate) => candidate.kind));
  if (kinds.size > 1) {
    return {
      ok: false,
      code: "ambiguous_metric",
      message: `gap metric matches multiple close condition kinds: ${gap.metric}`,
    };
  }
  const candidate = candidates[0]!;
  if (!context.allowedKinds.includes(candidate.kind)) {
    return {
      ok: false,
      code: "kind_not_allowed",
      message: `mapped close condition kind ${candidate.kind} is not allowed`,
    };
  }
  return {
    ok: true,
    proposal: {
      ...candidate,
      confidence: 0.8,
      rationale: `metric matched ${candidate.kind} pattern`,
    },
  };
}

function mappingCandidates(
  gap: GapRow,
  context: Omit<MappingContext, "gap">,
): Candidate[] {
  const metric = gap.metric.trim();
  const normalized = metric.toLowerCase();
  const candidates: Candidate[] = [];

  const command = commandForMetric(metric, context.allowedCommands ?? []);
  if (command !== null) {
    candidates.push({
      kind: "command",
      command: command.id,
      description: metric,
    });
  }

  const rule = findingPolicyRule(metric);
  if (rule !== null) {
    candidates.push({
      kind: "finding_policy",
      description: metric,
      rule,
    });
  }

  if (/review\b.*\bapproved\b|review decision\s*=\s*approved/.test(normalized)) {
    candidates.push({ kind: "review_consensus", description: metric });
  }

  const artifactPath = artifactPathForMetric(metric);
  if (artifactPath !== null) {
    candidates.push({
      kind: "artifact_exists",
      description: metric,
      metadata: { path: artifactPath },
    });
  }

  if (/operator\s+verified|human\s+verified|manual\s+verification/.test(normalized)) {
    candidates.push({ kind: "manual", description: metric });
  }

  const operationId = operationIdForMetric(metric);
  if (operationId !== null) {
    candidates.push({
      kind: "operation_status",
      description: metric,
      metadata: { operationId },
    });
  }

  if (/\bdb\b.*\bmigration\b.*\bvalid\b|\bdatabase\b.*\bmigration\b.*\bvalid\b/.test(normalized)) {
    candidates.push({ kind: "db_doctor", description: metric });
  }

  return candidates;
}

function commandForMetric(
  metric: string,
  allowedCommands: readonly GapAllowedCommand[],
): GapAllowedCommand | null {
  const normalized = metric.toLowerCase();
  if (!/\b(command|cmd|npm|pnpm|yarn|test|typecheck|lint)\b.*\b(pass|passes|succeed|succeeds|green)\b/.test(normalized)) {
    return null;
  }
  const matches = allowedCommands.filter((command) => {
    const id = command.id.toLowerCase();
    const display = command.display?.toLowerCase();
    // Fail-closed: match on a whitespace-delimited token boundary, never a bare
    // substring — a short command id ("test") must not match inside a larger
    // word ("latest"). (design-231 §3.2: unmappable metrics REJECT.)
    return (
      tokenPresent(normalized, id) ||
      (display !== undefined && tokenPresent(normalized, display))
    );
  });
  return matches.length === 1 ? matches[0]! : null;
}

function tokenPresent(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(haystack);
}

function findingPolicyRule(metric: string): Record<string, number> | null {
  const normalized = metric.toLowerCase();
  const explicit = metric.match(
    /\b(maxOpenInScopeP0|maxOpenInScopeP1|maxOpenInScopeP2|maxOpenUnknownScope)\b\s*(?:<=|≤|less than or equal to)\s*(\d+)/,
  );
  if (explicit !== null) return { [explicit[1]!]: Number(explicit[2]) };

  const threshold = normalized.match(
    /\b(open\s+)?(p0|p1|p2|unknown(?:\s+scope)?)\b.*(?:<=|≤|less than or equal to|at most|max(?:imum)?)\s*(\d+)/,
  );
  if (threshold === null) return null;
  const key = canonicalFindingRuleKey(threshold[2]!);
  return key === null ? null : { [key]: Number(threshold[3]) };
}

function canonicalFindingRuleKey(raw: string): string | null {
  const value = raw.replace(/\s+/g, " ").toLowerCase();
  if (value === "p0") return "maxOpenInScopeP0";
  if (value === "p1") return "maxOpenInScopeP1";
  if (value === "p2") return "maxOpenInScopeP2";
  if (value === "unknown" || value === "unknown scope") {
    return "maxOpenUnknownScope";
  }
  return null;
}

function artifactPathForMetric(metric: string): string | null {
  const match = metric.match(
    /\b(?:file|artifact)\s+([^\s]+)\s+(?:exists|present)\b/i,
  );
  return match?.[1] ?? null;
}

function operationIdForMetric(metric: string): string | null {
  const match = metric.match(/\boperation(?:\s+status)?\s+([A-Za-z0-9_.:-]+)\b/i);
  return match?.[1] ?? null;
}
