// Claude `-p --output-format stream-json` usage parser (#191 Phase-C / F14).
//
// Mirror of `parseCodexTurns` (src/codex/usage-parser.ts): turn the live event
// stream into per-turn rows for `agent_usage_turn`. The drift-prone token
// mapping + streaming-snapshot dedup is SHARED with the Phase-3 transcript
// ingest via `parseAssistantTurnsFromJsonl` — the assistant event envelope is
// byte-identical between a transcript file and `-p` stdout, so there is exactly
// one place that knows the cache_creation flat-vs-split / num()-clamp rules.
//
// CUMULATIVE result event — DELIBERATELY ignored for usage. The trailing
// `{type:'result', usage:{...,iterations:[...]}}` event carries the invocation's
// CUMULATIVE totals; summing it on top of the per-assistant turns would
// double-count. `parseAssistantTurnsFromJsonl` only emits `type:'assistant'`
// turns, so the result event is naturally excluded here (it supplies the final
// message to the runner, not usage).
import type { AgentUsageTurnInput } from "../db/repositories/agent-usage.js";
import {
  capToken,
  parseAssistantTurnsFromJsonl,
} from "../telemetry/claude-transcript-parser.js";

/**
 * Parse `claude -p --output-format stream-json` stdout into claude-shaped usage
 * turns. `usageSource:'exact'` — this is the live authoritative stream (the
 * Phase-3 ingest uses `'parsed_log'` because it re-reads a transcript after the
 * fact). Total function (never throws): malformed input → [].
 *
 * XOR CHECK: only the claude token columns are populated; the codex-only
 * `cachedInputTokens` / `reasoningOutputTokens` are left absent so the
 * `agent_usage_turn` DDL constraint is satisfied.
 */
export function parseClaudeStreamJson(stdout: string): AgentUsageTurnInput[] {
  return parseAssistantTurnsFromJsonl(stdout).map((t) => ({
    turnSeq: t.turnSeq,
    model: t.model,
    usageSource: "exact" as const,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadInputTokens: t.cacheReadInputTokens,
    cacheCreationInputTokens: t.cacheCreationInputTokens,
    cacheCreation5mInputTokens: t.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: t.cacheCreation1hInputTokens,
    // Derive total so `harness usage` totalTokens is non-zero; capToken keeps
    // the sum a non-negative safe integer (addends already clamped).
    totalTokens: capToken((t.inputTokens ?? 0) + (t.outputTokens ?? 0)),
  }));
}
