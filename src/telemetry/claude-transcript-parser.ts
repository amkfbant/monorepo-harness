import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const DATE_SUFFIX = /-\d{8}$/;
// Matches subagents/agent-*.jsonl AND subagents/workflows/wf_*/agent-*.jsonl;
// excludes journal.jsonl and *.meta.json.
const AGENT_FILE_RE = /(^|[/\\])subagents[/\\](?:.*[/\\])?agent-[^/\\]+\.jsonl$/;

/** Strip -YYYYMMDD date suffix from model names; pass '<synthetic>' verbatim. */
export function normalizeClaudeModel(model: string): string {
  if (model === "<synthetic>") return model;
  return model.replace(DATE_SUFFIX, "");
}

export interface ParsedTurn {
  turnSeq: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Flat sum of 5m + 1h. */
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreation5mInputTokens: number;
  cacheCreation1hInputTokens: number;
}

export interface ParsedSubagentInvocation {
  sessionId: string;
  agentId: string;
  agentType: string | null;
  description: string | null;
  /** Model of the first turn; null when no turns (should not occur in practice). */
  model: string | null;
  turns: ParsedTurn[];
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * List all agent transcript paths under projectDir recursively.
 * Returns absolute paths. Empty list on directory read error (fail-open).
 */
export function listAgentTranscripts(projectDir: string): string[] {
  let rels: string[];
  try {
    rels = readdirSync(projectDir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return rels
    .filter((rel) => AGENT_FILE_RE.test(rel))
    .map((rel) => join(projectDir, rel));
}

/**
 * Derive session/agent identity from the file path — no file read needed.
 * session = first path component under projectDir; agent = filename agent-<id>.jsonl.
 * Returns null when either component is empty.
 */
export function claudeIdentityFromPath(
  projectDir: string,
  jsonlPath: string,
): { sessionId: string; agentId: string } | null {
  const rel = jsonlPath.startsWith(projectDir)
    ? jsonlPath.slice(projectDir.length).replace(/^[/\\]/, "")
    : jsonlPath;
  const sessionId = rel.split(/[/\\]/)[0] ?? "";
  const agentId = basename(jsonlPath)
    .replace(/^agent-/, "")
    .replace(/\.jsonl$/, "");
  if (!sessionId || !agentId) return null;
  return { sessionId, agentId };
}

/**
 * Parse a single assistant line into a turn.
 * PRIVACY: reads ONLY model + usage fields — message.content is never accessed.
 */
function parseAssistantLine(
  obj: Record<string, unknown>,
  turnSeq: number,
): ParsedTurn | null {
  const msg = obj.message as Record<string, unknown> | null | undefined;
  if (!msg || typeof msg.model !== "string") return null;
  const u = msg.usage as Record<string, unknown> | null | undefined;
  if (!u) return null;
  const cc = (u.cache_creation as Record<string, unknown> | null | undefined) ?? {};
  return {
    turnSeq,
    model: normalizeClaudeModel(msg.model),
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    cacheCreationInputTokens: num(u.cache_creation_input_tokens),
    cacheCreation5mInputTokens: num(cc.ephemeral_5m_input_tokens),
    cacheCreation1hInputTokens: num(cc.ephemeral_1h_input_tokens),
  };
}

/**
 * Parse a transcript file into a subagent invocation.
 * metaJson: parsed sibling .meta.json content (may be null).
 * Returns null when the file is unreadable or contains no valid turns.
 */
export function parseAgentTranscriptFile(
  jsonlPath: string,
  metaJson: unknown,
): ParsedSubagentInvocation | null {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const meta = (metaJson ?? {}) as Record<string, unknown>;
  let sessionId = "";
  let agentId = basename(jsonlPath)
    .replace(/^agent-/, "")
    .replace(/\.jsonl$/, "");
  let attributionAgent: string | null = null;

  // Streaming dedup: real Claude Code transcripts write MULTIPLE assistant
  // snapshots per message.id during streaming. Each intermediate snapshot has
  // a stub output_tokens (1); the FINAL snapshot carries authoritative usage.
  // We keep a map from message.id → snapshot object so the last-seen wins.
  // Lines with no message.id use a unique sentinel so they are never collapsed.
  let noIdCounter = 0;
  // Ordered list of first-seen message keys (preserves first-appearance order).
  const messageOrder: string[] = [];
  const messageSnaps = new Map<string, Record<string, unknown>>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.sessionId === "string" && !sessionId) {
      sessionId = obj.sessionId;
    }
    if (typeof obj.agentId === "string") {
      // Defensive: strip agent- prefix from in-file agentId. Real Claude Code
      // transcripts store the id WITHOUT the prefix (filename agent-<id>.jsonl
      // has in-file agentId="<id>"). This strip makes the idempotency check
      // (path-derived vs content-derived) robust either way.
      agentId = obj.agentId.replace(/^agent-/, "");
    }
    if (obj.type === "assistant") {
      if (typeof obj.attributionAgent === "string") {
        attributionAgent = obj.attributionAgent;
      }
      const msg = obj.message as Record<string, unknown> | null | undefined;
      const msgId = msg && typeof (msg as { id?: unknown }).id === "string"
        ? (msg as { id: string }).id
        : null;
      // Use message.id when available; fall back to a unique-per-line sentinel
      // so no-id lines are never collapsed with each other.
      const key = msgId ?? `__no_id_${noIdCounter++}`;
      if (!messageSnaps.has(key)) {
        messageOrder.push(key);
      }
      messageSnaps.set(key, obj);
    }
  }

  // Build turns from the deduped snapshots in first-seen order.
  const turns: ParsedTurn[] = [];
  let seq = 0;
  for (const key of messageOrder) {
    const obj = messageSnaps.get(key)!;
    const turn = parseAssistantLine(obj, seq);
    if (turn) {
      turns.push(turn);
      seq += 1;
    }
  }

  if (!sessionId || !agentId || turns.length === 0) return null;

  // Prefer explicit meta; fall back to attributionAgent seen in transcript lines.
  const agentType =
    (typeof meta.agentType === "string" ? meta.agentType : null) ??
    attributionAgent;
  const description =
    typeof meta.description === "string" ? meta.description : null;

  return {
    sessionId,
    agentId,
    agentType,
    description,
    model: turns[0]?.model ?? null,
    turns,
  };
}

function readMeta(jsonlPath: string): unknown {
  try {
    return JSON.parse(
      readFileSync(jsonlPath.replace(/\.jsonl$/, ".meta.json"), "utf8"),
    );
  } catch {
    return null;
  }
}

/**
 * Discover and parse all agent transcripts under projectDir.
 * mtimeSinceMs: optional mtime filter (skip files older than this epoch ms).
 * Returns empty array on directory error (fail-open).
 */
export function discoverAndParse(
  projectDir: string,
  opts?: { mtimeSinceMs?: number },
): ParsedSubagentInvocation[] {
  const out: ParsedSubagentInvocation[] = [];
  for (const f of listAgentTranscripts(projectDir)) {
    try {
      if (opts?.mtimeSinceMs && statSync(f).mtimeMs < opts.mtimeSinceMs) {
        continue;
      }
    } catch {
      continue;
    }
    const inv = parseAgentTranscriptFile(f, readMeta(f));
    if (inv) out.push(inv);
  }
  return out;
}
