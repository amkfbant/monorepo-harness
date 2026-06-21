import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { basename, join, relative } from "node:path";

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
  cacheReadInputTokens: number;
  /** Flat cache-creation total; equals 5m + 1h (falls back to their sum). */
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

/**
 * A usable token value: non-negative integer within safe range. Untrusted
 * transcript input — like the codex parser's integerField guard PLUS an upper
 * sanity bound, so a malformed/adversarial transcript cannot inject negative /
 * fractional / overflow tokens (e.g. 1e308, which Number.isInteger accepts).
 */
function validToken(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= Number.MAX_SAFE_INTEGER
  );
}

function num(v: unknown): number {
  return validToken(v) ? v : 0; // fail-open: anything invalid → 0
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Cap a non-negative DERIVED total (a sum of already-num()-clamped values) to a
 * safe integer. Each addend is ≤ MAX_SAFE_INTEGER, so a sum can exceed it and
 * lose integer precision; cap (don't zero) to preserve magnitude. Keeps the
 * "token values are non-negative integers ≤ MAX_SAFE_INTEGER" contract for
 * derived columns too.
 */
export function capToken(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : n;
}

/**
 * List all agent transcript paths under projectDir recursively.
 * Returns absolute paths. Empty list on directory read error (fail-open).
 *
 * SECURITY: a manual walk (NOT `readdirSync({recursive:true})`) so we can SKIP
 * symlinks. `Dirent` reflects an lstat, so `isSymbolicLink()` is true for links;
 * we neither descend into a symlinked directory nor read a symlinked file. This
 * prevents a symlink planted under the project tree from redirecting the scan
 * outside projectDir or to an arbitrary read target. Because every descended
 * dir and every collected file is a real entry under projectDir, the path stays
 * contained without a separate realpath check. Fail-open: a readdir error stops
 * that subtree only.
 */
export function listAgentTranscripts(projectDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue; // never follow links
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
      } else if (
        ent.isFile() &&
        // Match against the path RELATIVE to projectDir (not the absolute path)
        // so a `subagents` component in a projectDir ANCESTOR cannot over-match.
        AGENT_FILE_RE.test(relative(projectDir, abs))
      ) {
        out.push(abs);
      }
    }
  };
  walk(projectDir);
  return out;
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
  const cacheCreation5m = num(cc.ephemeral_5m_input_tokens);
  const cacheCreation1h = num(cc.ephemeral_1h_input_tokens);
  // Prefer the flat total when it is a VALID token; fall back to 5m + 1h when
  // the flat is absent OR invalid. The reader (subagent-usage) SUMs the flat
  // column only, so a split-only (or bad-flat) transcript would otherwise
  // under-count cache creation.
  const cacheCreationInputTokens = validToken(u.cache_creation_input_tokens)
    ? u.cache_creation_input_tokens
    : capToken(cacheCreation5m + cacheCreation1h);
  return {
    turnSeq,
    model: normalizeClaudeModel(msg.model),
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadInputTokens: num(u.cache_read_input_tokens),
    cacheCreationInputTokens,
    cacheCreation5mInputTokens: cacheCreation5m,
    cacheCreation1hInputTokens: cacheCreation1h,
  };
}

/**
 * Parse the assistant `usage` turns out of a Claude Code JSONL stream.
 *
 * SHARED by the Phase-3 transcript ingest (file content) and the #191 internal
 * `claude -p --output-format stream-json` runner (stdout content): the assistant
 * event envelope (`{type:'assistant', message:{id,model,usage}}`) is identical
 * in both, so the drift-prone token mapping (cache_creation flat-vs-split,
 * num() clamping) and the streaming-snapshot dedup live in ONE place.
 *
 * Streaming dedup: Claude Code writes MULTIPLE assistant snapshots per
 * message.id during streaming; each intermediate snapshot has a stub
 * output_tokens, the FINAL snapshot carries authoritative usage. The map keeps
 * last-seen-per-message.id so naive summing cannot over-count (the ~4.6x bug,
 * #235 FIX 1). Lines with no message.id use a unique sentinel so they are never
 * collapsed together. Total function — never throws (malformed lines skipped).
 */
export function parseAssistantTurnsFromJsonl(raw: string): ParsedTurn[] {
  let noIdCounter = 0;
  // Ordered list of first-seen message keys (preserves first-appearance order).
  const messageOrder: string[] = [];
  const messageSnaps = new Map<string, Record<string, unknown>>();

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // Untrusted input: a line that is valid JSON but not an object (the literal
    // `null`, a number, a string, an array) would throw on property access and
    // abort the whole pass. Skip non-objects to keep this a total fn.
    if (!isRecord(parsed)) continue;
    const obj = parsed;
    if (obj.type !== "assistant") continue;
    const msg = obj.message as Record<string, unknown> | null | undefined;
    const msgId =
      msg && typeof (msg as { id?: unknown }).id === "string"
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
  return turns;
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

  // Identity pass: sessionId / agentId / attributionAgent are computed
  // independently of the turn extraction, so they can share the raw content
  // with parseAssistantTurnsFromJsonl without interleaving.
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const obj = parsed;
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
    if (
      obj.type === "assistant" &&
      typeof obj.attributionAgent === "string"
    ) {
      attributionAgent = obj.attributionAgent;
    }
  }

  const turns = parseAssistantTurnsFromJsonl(raw);

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
