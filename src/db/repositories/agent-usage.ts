import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  ParsedCodexUsage,
  UsageSource,
} from "../../codex/usage-parser.js";

/**
 * Agent-usage telemetry writer (#206 epic Phase-1).
 *
 * `recordAgentUsage` is the single choke point for the v36 dual-write: it
 * persists one `agent_invocation` row + one `agent_usage_turn` row per turn,
 * and — for codex roles — ALSO writes the legacy `run_usage` summary row in the
 * SAME `BEGIN IMMEDIATE` transaction. The three writes are both-or-neither: a
 * lease loss / constraint violation mid-transaction rolls back all of them so
 * `run_usage` never drifts from the new tables.
 *
 * Safety invariants (do not relax — `docs/specs/workflow.md` recording order):
 *   - **Fail-open**: the whole body (timestamp, description truncation, hashing,
 *     all INSERTs) runs inside ONE try; any failure is reported through
 *     `onError` and swallowed. Telemetry must never throw into the run workflow.
 *   - **Byte-stable legacy row**: the `run_usage` INSERT matches the pre-#206
 *     `recordCodexUsage` exactly except that `model` is now populated when the
 *     caller provides one (NULL otherwise → no-config rows are unchanged).
 *   - **Deterministic id**: codex invocation ids are a pure function of
 *     `(run_id, role, seq)` so a re-import / backfill never duplicates a row.
 */

export type AgentTool = "codex" | "claude";
export type AgentRole = "coder" | "reviewer" | "evaluator" | "external";

/** Codex roles that also own a legacy `run_usage` row. */
export type RunUsageKind = "coder" | "reviewer" | "evaluator";

/**
 * Max stored length of `agent_invocation.description`. Phase-1 codex callers do
 * not set a description; this HARD-TRUNCATE bound is a defensive cap for the
 * future claude consumer (#235), which records untrusted agent task text. Cap
 * mirrors the `import_errors.error` 2000-char convention (`import/common.ts`).
 */
export const AGENT_INVOCATION_DESCRIPTION_MAX = 2000;

/**
 * One usage turn destined for `agent_usage_turn`. UNION-nullable: codex fills
 * `cached_input` / `reasoning_output`; claude fills `cache_read` /
 * `cache_creation_*`. A row never mixes the two (DDL XOR CHECK enforces it).
 */
export interface AgentUsageTurnInput {
  turnSeq: number;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningOutputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheCreation5mInputTokens?: number | null;
  cacheCreation1hInputTokens?: number | null;
  usageSource: UsageSource;
}

/** Legacy `run_usage` summary co-written for codex invocations. */
export interface LegacyRunUsage {
  kind: RunUsageKind;
  summary: ParsedCodexUsage;
}

export interface RecordAgentUsageInput {
  db: Database.Database;
  tool: AgentTool;
  role: AgentRole;
  model?: string | null;
  runId?: string | null;
  hitchId?: string | null;
  courseId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  agentType?: string | null;
  externalLabel?: string | null;
  description?: string | null;
  /** Invocation-level usage source (matches the legacy `run_usage` row). */
  usageSource: UsageSource;
  turns: readonly AgentUsageTurnInput[];
  /** When set, also write the byte-stable legacy `run_usage` row (codex). */
  legacyRunUsage?: LegacyRunUsage;
  now?: string | Date;
  /**
   * Fencing/lease guard. Runs first inside the BEGIN IMMEDIATE transaction so a
   * lost lease rolls back every write.
   */
  beforeWrite?: () => void;
  /** Receives any write error; the writer itself stays fail-open. */
  onError?: (error: unknown) => void;
}

function isoNow(now: string | Date | undefined): string {
  const date = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid agent usage timestamp: ${String(now)}`);
  }
  return date.toISOString();
}

/**
 * HARD-TRUNCATE the description to the stored cap. A non-string (defensive,
 * from an untyped consumer) makes `.slice` throw — deliberately, so the single
 * try fails open rather than silently storing a coerced/garbage value.
 */
function truncateDescription(
  description: string | null | undefined,
): string | null {
  if (description === null || description === undefined) return null;
  return (description as string).slice(0, AGENT_INVOCATION_DESCRIPTION_MAX);
}

/**
 * Live invocation id. External rows use a readable composite key; identity-
 * bearing claude rows hash their `(session, agent, role, seq)`; codex rows hash
 * `(run, role, seq)`. Backfilled rows use a `bf:` surrogate (pure SQL) — the
 * three namespaces are disjoint so live and backfill never collide.
 */
function sha256Hex(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

/**
 * Treat an empty-string identifier as absent (null). Seq allocation compares
 * with `IS` (NULL-safe) while the id hash coalesces with `?? ""`; without this
 * normalization an omitted field (null) and an explicit "" would land in
 * different `allocateSeq` scopes (both seq 0) yet hash to the same id —
 * colliding on the PK and silently dropping the second invocation.
 */
function nullIfEmpty(v: string | null | undefined): string | null {
  return v === undefined || v === null || v === "" ? null : v;
}

function deriveInvocationId(input: RecordAgentUsageInput, seq: number): string {
  if (input.externalLabel !== undefined && input.externalLabel !== null) {
    // Hash the FULL identity scope `allocateSeq` counts over, NUL-joined (the
    // codebase's injective convention — see import/runs.ts). A NUL byte cannot
    // appear in these identifier fields, so distinct
    // (label, session, agent, run, role, seq) tuples never map to the same id
    // even when a field contains ':' or '_' — unlike a readable separator join,
    // which is NOT injective. A collision would be silently dropped by the
    // fail-open writer. The `ext:` prefix keeps the id in a namespace disjoint
    // from the bare-hex codex/claude ids and the `bf:` backfill surrogate.
    return `ext:${sha256Hex([
      input.externalLabel,
      input.sessionId ?? "",
      input.agentId ?? "",
      input.runId ?? "",
      input.role,
      String(seq),
    ])}`;
  }
  const parts =
    input.sessionId != null && input.agentId != null
      ? [input.sessionId, input.agentId, input.role, String(seq)]
      : [input.runId ?? "", input.role, String(seq)];
  return sha256Hex(parts);
}

/**
 * Allocate the invocation sequence. For codex the legacy `run_usage`
 * `MAX(seq)+1` is the SINGLE authority so `invocation_seq` stays lock-step with
 * `run_usage.seq`. The general path counts existing invocations in the same
 * `(role, run, external_label, session)` series (NULL-safe `IS`).
 */
function allocateSeq(input: RecordAgentUsageInput): number {
  if (input.legacyRunUsage) {
    const row = input.db
      .prepare(
        `SELECT COALESCE(MAX(seq) + 1, 0) AS seq
           FROM run_usage WHERE run_id = ? AND kind = ?`,
      )
      .get(input.runId, input.legacyRunUsage.kind) as { seq: number };
    return row.seq;
  }
  const row = input.db
    .prepare(
      `SELECT COALESCE(MAX(invocation_seq) + 1, 0) AS seq
         FROM agent_invocation
        WHERE role = @role
          AND run_id IS @run_id
          AND external_label IS @external_label
          AND session_id IS @session_id
          AND agent_id IS @agent_id`,
    )
    .get({
      role: input.role,
      run_id: input.runId ?? null,
      external_label: input.externalLabel ?? null,
      session_id: input.sessionId ?? null,
      agent_id: input.agentId ?? null,
    }) as { seq: number };
  return row.seq;
}

function insertLegacyRunUsage(
  input: RecordAgentUsageInput,
  legacy: LegacyRunUsage,
  seq: number,
  createdAt: string,
): void {
  input.db
    .prepare(
      `INSERT INTO run_usage
         (run_id, kind, seq, model, input_tokens, cached_input_tokens,
          output_tokens, reasoning_output_tokens, total_tokens,
          usage_source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      legacy.kind,
      seq,
      input.model ?? null,
      legacy.summary.inputTokens,
      legacy.summary.cachedInputTokens,
      legacy.summary.outputTokens,
      legacy.summary.reasoningOutputTokens,
      legacy.summary.totalTokens,
      legacy.summary.usageSource,
      createdAt,
    );
}

function insertInvocation(
  input: RecordAgentUsageInput,
  invocationId: string,
  seq: number,
  description: string | null,
  createdAt: string,
): void {
  input.db
    .prepare(
      `INSERT INTO agent_invocation
         (invocation_id, tool, role, model, run_id, hitch_id, course_id,
          session_id, agent_id, agent_type, external_label, invocation_seq,
          description, usage_source, created_at)
       VALUES (@invocation_id, @tool, @role, @model, @run_id, @hitch_id,
               @course_id, @session_id, @agent_id, @agent_type, @external_label,
               @invocation_seq, @description, @usage_source, @created_at)`,
    )
    .run({
      invocation_id: invocationId,
      tool: input.tool,
      role: input.role,
      model: input.model ?? null,
      run_id: input.runId ?? null,
      hitch_id: input.hitchId ?? null,
      course_id: input.courseId ?? null,
      session_id: input.sessionId ?? null,
      agent_id: input.agentId ?? null,
      agent_type: input.agentType ?? null,
      external_label: input.externalLabel ?? null,
      invocation_seq: seq,
      description,
      usage_source: input.usageSource,
      created_at: createdAt,
    });
}

function insertTurn(
  db: Database.Database,
  invocationId: string,
  turn: AgentUsageTurnInput,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO agent_usage_turn
       (invocation_id, turn_seq, model, input_tokens, output_tokens,
        total_tokens, cached_input_tokens, reasoning_output_tokens,
        cache_read_input_tokens, cache_creation_input_tokens,
        cache_creation_5m_input_tokens, cache_creation_1h_input_tokens,
        usage_source, created_at)
     VALUES (@invocation_id, @turn_seq, @model, @input_tokens, @output_tokens,
             @total_tokens, @cached_input_tokens, @reasoning_output_tokens,
             @cache_read_input_tokens, @cache_creation_input_tokens,
             @cache_creation_5m_input_tokens, @cache_creation_1h_input_tokens,
             @usage_source, @created_at)`,
  ).run({
    invocation_id: invocationId,
    turn_seq: turn.turnSeq,
    model: turn.model ?? null,
    input_tokens: turn.inputTokens ?? null,
    output_tokens: turn.outputTokens ?? null,
    total_tokens: turn.totalTokens ?? null,
    cached_input_tokens: turn.cachedInputTokens ?? null,
    reasoning_output_tokens: turn.reasoningOutputTokens ?? null,
    cache_read_input_tokens: turn.cacheReadInputTokens ?? null,
    cache_creation_input_tokens: turn.cacheCreationInputTokens ?? null,
    cache_creation_5m_input_tokens: turn.cacheCreation5mInputTokens ?? null,
    cache_creation_1h_input_tokens: turn.cacheCreation1hInputTokens ?? null,
    usage_source: turn.usageSource,
    created_at: createdAt,
  });
}

/**
 * Record one agent invocation's usage. See the module header for the dual-write
 * / fail-open / determinism invariants. Returns nothing; failures surface only
 * via `onError`.
 */
export function recordAgentUsage(input: RecordAgentUsageInput): void {
  try {
    const createdAt = isoNow(input.now);
    const description = truncateDescription(input.description);
    // Normalize empty-string identifiers to null so seq allocation and id
    // hashing agree on "absent" (see nullIfEmpty). Applied to every field that
    // feeds allocateSeq's scope or the invocation id.
    const norm: RecordAgentUsageInput = {
      ...input,
      runId: nullIfEmpty(input.runId),
      sessionId: nullIfEmpty(input.sessionId),
      agentId: nullIfEmpty(input.agentId),
      externalLabel: nullIfEmpty(input.externalLabel),
    };
    const tx = input.db.transaction(() => {
      input.beforeWrite?.();
      const seq = allocateSeq(norm);
      if (norm.legacyRunUsage) {
        insertLegacyRunUsage(norm, norm.legacyRunUsage, seq, createdAt);
      }
      const invocationId = deriveInvocationId(norm, seq);
      insertInvocation(norm, invocationId, seq, description, createdAt);
      for (const turn of norm.turns) {
        insertTurn(norm.db, invocationId, turn, createdAt);
      }
    });
    tx.immediate();
  } catch (error) {
    input.onError?.(error);
  }
}
