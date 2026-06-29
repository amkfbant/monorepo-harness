import type Database from "better-sqlite3";

export interface CodexUsageFilter {
  course?: string;
  hitch?: string;
  label?: string;
  since?: string;
}

export interface CodexUsageRow {
  courseId: string | null;
  hitchId: string | null;
  externalLabel: string | null;
  invocations: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface CodexUsageSummary {
  rows: CodexUsageRow[];
  totals: Omit<CodexUsageRow, "courseId" | "hitchId" | "externalLabel">;
}

const ZERO_TOTALS: Omit<
  CodexUsageRow,
  "courseId" | "hitchId" | "externalLabel"
> = {
  invocations: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
};

/**
 * Read-only aggregation of EXTERNAL codex usage (tool='codex', role='external')
 * from agent_invocation + agent_usage_turn, grouped by course/hitch/external_label.
 *
 * These are the rows the `harness codex exec` transparent wrapper WRITES
 * (--harness-course-id / --harness-hitch-id / --harness-label →
 * agent_invocation.course_id / hitch_id / external_label). No prior reader
 * surfaces them: the legacy run_usage aggregators (tokenUsageSummary /
 * hitchTokenUsage) resolve scope via run_id and external rows carry run_id=NULL
 * (and run_usage has no course/hitch/label columns); subagentUsageSummary is
 * hardcoded to tool='claude'. Hence this dedicated reader (#403).
 *
 * Token columns use the CODEX taxonomy (cached_input / reasoning_output). The
 * claude cache_read / cache_creation_* columns are NULL on codex rows (the
 * agent_usage_turn XOR CHECK) and are intentionally NOT summed here.
 *
 * Deliberately does NOT filter on usage_source — mirrors subagentUsageSummary's
 * invariant; an exact-only filter would silently drop rows. External codex is
 * usage_source='exact' in practice, but the reader stays source-agnostic.
 *
 * NULL course/hitch/label collapse into a single GROUP BY bucket (SQLite groups
 * NULLs together); ORDER BY adds deterministic tiebreakers after totalTokens.
 *
 * Read before editing: docs/specs/cli.md ##`harness usage`
 */
export function codexUsageSummary(
  db: Database.Database,
  filter: CodexUsageFilter = {},
): CodexUsageSummary {
  const where: string[] = ["i.tool = 'codex'", "i.role = 'external'"];
  const params: unknown[] = [];

  if (filter.course !== undefined) {
    where.push("i.course_id = ?");
    params.push(filter.course);
  }
  if (filter.hitch !== undefined) {
    where.push("i.hitch_id = ?");
    params.push(filter.hitch);
  }
  if (filter.label !== undefined) {
    where.push("i.external_label = ?");
    params.push(filter.label);
  }
  if (filter.since !== undefined) {
    where.push("i.created_at >= ?");
    params.push(filter.since);
  }

  const sql = `
    SELECT i.course_id      AS courseId,
           i.hitch_id       AS hitchId,
           i.external_label AS externalLabel,
           COUNT(DISTINCT i.invocation_id)             AS invocations,
           COALESCE(SUM(t.input_tokens), 0)            AS inputTokens,
           COALESCE(SUM(t.cached_input_tokens), 0)     AS cachedInputTokens,
           COALESCE(SUM(t.output_tokens), 0)           AS outputTokens,
           COALESCE(SUM(t.reasoning_output_tokens), 0) AS reasoningOutputTokens,
           COALESCE(SUM(t.total_tokens), 0)            AS totalTokens
      FROM agent_invocation i
      JOIN agent_usage_turn t ON t.invocation_id = i.invocation_id
     WHERE ${where.join(" AND ")}
     GROUP BY i.course_id, i.hitch_id, i.external_label
     ORDER BY totalTokens DESC, i.course_id, i.hitch_id, i.external_label`;

  const rows = db.prepare(sql).all(...params) as unknown as CodexUsageRow[];

  const totals = rows.reduce(
    (acc, r) => ({
      invocations: acc.invocations + r.invocations,
      inputTokens: acc.inputTokens + r.inputTokens,
      cachedInputTokens: acc.cachedInputTokens + r.cachedInputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      reasoningOutputTokens:
        acc.reasoningOutputTokens + r.reasoningOutputTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
    }),
    { ...ZERO_TOTALS },
  );

  return { rows, totals };
}
