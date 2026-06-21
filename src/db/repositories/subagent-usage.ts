import type Database from "better-sqlite3";

export interface SubagentUsageFilter {
  roles?: readonly string[];
  since?: string;
}

export interface SubagentUsageRow {
  agentType: string | null;
  model: string | null;
  invocations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
}

export interface SubagentUsageSummary {
  rows: SubagentUsageRow[];
  totals: Omit<SubagentUsageRow, "agentType" | "model">;
}

const ZERO_TOTALS: Omit<SubagentUsageRow, "agentType" | "model"> = {
  invocations: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  totalTokens: 0,
};

/**
 * Read-only aggregation of claude subagent usage from agent_invocation +
 * agent_usage_turn.
 *
 * Deliberately does NOT filter on usage_source='exact' — Phase-3 rows use
 * usage_source='parsed_log'. An exact-only filter would silently zero all
 * Phase-3 results. The test asserts non-zero to guard this invariant.
 *
 * roles defaults to ['external'] (ops subagents). Pass additional roles
 * (e.g. ['reviewer']) for Phase-4 internal-claude attribution.
 *
 * MODEL ATTRIBUTION (#353): rows are grouped by `i.model`, the INVOCATION-level
 * model (= the first turn's model). If a single subagent invocation mixed models
 * across turns (rare — a Claude Code subagent runs under one model in practice),
 * all of its turn tokens are attributed to that first-turn model. Grand totals
 * are unaffected (they reduce over all rows); only the per-model split row is a
 * simplification. Switch the GROUP BY to `t.model` if true per-turn-model
 * attribution is ever required.
 */
export function subagentUsageSummary(
  db: Database.Database,
  filter: SubagentUsageFilter = {},
): SubagentUsageSummary {
  const roles = filter.roles ?? ["external"];
  const where: string[] = [
    "i.tool = 'claude'",
    `i.role IN (${roles.map(() => "?").join(", ")})`,
  ];
  const params: unknown[] = [...roles];

  if (filter.since) {
    where.push("i.created_at >= ?");
    params.push(filter.since);
  }

  const sql = `
    SELECT i.agent_type AS agentType,
           i.model      AS model,
           COUNT(DISTINCT i.invocation_id)          AS invocations,
           COALESCE(SUM(t.input_tokens), 0)         AS inputTokens,
           COALESCE(SUM(t.output_tokens), 0)        AS outputTokens,
           COALESCE(SUM(t.cache_read_input_tokens), 0)      AS cacheReadInputTokens,
           COALESCE(SUM(t.cache_creation_input_tokens), 0)  AS cacheCreationInputTokens,
           COALESCE(SUM(t.total_tokens), 0)         AS totalTokens
      FROM agent_invocation i
      JOIN agent_usage_turn t ON t.invocation_id = i.invocation_id
     WHERE ${where.join(" AND ")}
     GROUP BY i.agent_type, i.model
     ORDER BY totalTokens DESC`;

  const rows = db.prepare(sql).all(...params) as unknown as SubagentUsageRow[];

  const totals = rows.reduce(
    (acc, r) => ({
      invocations: acc.invocations + r.invocations,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      cacheReadInputTokens: acc.cacheReadInputTokens + r.cacheReadInputTokens,
      cacheCreationInputTokens:
        acc.cacheCreationInputTokens + r.cacheCreationInputTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
    }),
    { ...ZERO_TOTALS },
  );

  return { rows, totals };
}
