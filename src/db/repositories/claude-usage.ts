// recordClaudeUsage (#191 Phase-C / F14) — the write-side adapter that lands an
// internal `claude -p` coder/reviewer/evaluator invocation's usage into the
// #206 agent-usage tables. Partial mirror of `recordCodexUsage`
// (src/db/repositories/run-usage.ts): same `recordAgentUsage` choke point, but
// DELIBERATELY no `legacyRunUsage` — `run_usage` is the codex-only legacy
// summary and must stay byte-stable, so claude usage lives ONLY in
// `agent_invocation` + `agent_usage_turn`. No schema/enum/migration change.
import type Database from "better-sqlite3";
import type { UsageSource } from "../../codex/usage-parser.js";
import { recordAgentUsage } from "./agent-usage.js";
import type { RunUsageKind } from "./run-usage.js";
import { parseClaudeStreamJson } from "../../claude/usage-parser.js";

export interface RecordClaudeUsageInput {
  db: Database.Database;
  runId: string;
  kind: RunUsageKind;
  /** Raw `claude -p --output-format stream-json` stdout (the events stream). */
  eventsContent: string | null;
  /** Advisory invocation model; the per-turn model comes from the stream. */
  model?: string | null;
  now?: string | Date;
  /** Fencing/lease guard — runs in the same transaction as the write. */
  beforeWrite?: () => void;
  /** Receives the write error; the writer itself stays fail-open. */
  onError?: (error: unknown) => void;
}

/**
 * Record one internal claude invocation's structured usage from its stream-json
 * stdout. Thin, fail-open forwarder over `recordAgentUsage`: parsing is a total
 * function so building the turns before the writer cannot throw into the run
 * workflow; database/guard failures are reported via `onError`.
 *
 * An empty parse (claude produced no usable assistant usage — crash / early
 * exit) records ONE synthetic null turn with `usageSource:'unavailable'`, so the
 * invocation is still counted, mirroring `recordCodexUsage`'s unavailable path.
 */
export function recordClaudeUsage(input: RecordClaudeUsageInput): void {
  const turns = parseClaudeStreamJson(input.eventsContent ?? "");
  const usageSource: UsageSource = turns.length > 0 ? "exact" : "unavailable";
  // Prefer an explicit advisory model; else fall back to the real model the
  // stream reported (claude -p, unlike codex, carries the model per turn).
  const model = input.model ?? turns[0]?.model ?? null;
  const turnInputs =
    turns.length > 0
      ? turns
      : [{ turnSeq: 0, model, usageSource: "unavailable" as const }];
  recordAgentUsage({
    db: input.db,
    tool: "claude",
    role: input.kind,
    model,
    runId: input.runId,
    usageSource,
    turns: turnInputs,
    // NO legacyRunUsage (see file header).
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.beforeWrite !== undefined
      ? { beforeWrite: input.beforeWrite }
      : {}),
    ...(input.onError !== undefined ? { onError: input.onError } : {}),
  });
}
