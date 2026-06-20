import { existsSync, realpathSync, readFileSync, statSync } from 'node:fs'
import type Database from 'better-sqlite3'
import { openManagedDb } from '../db/managed-connection.js'
import { runMigrations } from '../db/migrations.js'
import { harnessPaths } from '../config/paths.js'
import { recordAgentUsage } from '../db/repositories/agent-usage.js'
import { resolveClaudeProjectDir } from './resolve-claude-project-dir.js'
import {
  listAgentTranscripts,
  claudeIdentityFromPath,
  parseAgentTranscriptFile,
  type ParsedSubagentInvocation,
  type ParsedTurn,
} from './claude-transcript-parser.js'

// Phase-3 external label — distinct from Phase-2 codex 'external'.
const EXTERNAL_LABEL = 'ops-subagent' as const

/**
 * Skip transcripts modified within this window of now.
 * A recently-written transcript may still be appending lines; ingesting it
 * early would freeze the (session, agent) slot via the unique index.
 */
const DEFAULT_SETTLE_MS = 30_000

export interface IngestOptions {
  harnessRoot: string
  /** Override the Claude transcript project dir (for testing). */
  claudeProjectDir?: string
  /** Skip files older than this epoch-ms timestamp (incremental ingest). */
  mtimeSinceMs?: number
  /** Skip files modified within this many ms of now (default 30 000). */
  settleMs?: number
  onWarn?: (message: string) => void
  /** Override Date.now() for deterministic tests. */
  now?: number
}

export interface IngestResult {
  scanned: number
  inserted: number
  skipped: number
}

function compositeKey(sessionId: string, agentId: string): string {
  return `${sessionId}\0${agentId}`
}

/**
 * Resolve the Claude project dir, trying realpath fallback when the literal
 * path does not exist. Logs a warning and returns null when absent.
 */
function resolveExistingProjectDir(opts: IngestOptions): string | null {
  const literal = resolveClaudeProjectDir({
    harnessRoot: opts.harnessRoot,
    ...(opts.claudeProjectDir !== undefined ? { override: opts.claudeProjectDir } : {}),
  })
  if (existsSync(literal)) return literal

  // Claude encodes the launch cwd verbatim; if harnessRoot is a symlink the
  // real path encoding may differ — try both.
  if (!opts.claudeProjectDir) {
    try {
      const real = resolveClaudeProjectDir({
        harnessRoot: realpathSync(opts.harnessRoot),
      })
      if (existsSync(real)) return real
    } catch {
      // realpathSync can throw on broken symlinks; ignore.
    }
  }

  opts.onWarn?.(`claude project dir not found: ${literal}`)
  return null
}

/**
 * Load the set of (session_id, agent_id) pairs already present in the DB.
 * Used to skip-before-read on subsequent passes (idempotency).
 */
function loadExistingKeys(db: Database.Database): Set<string> {
  const rows = db
    .prepare<[], { s: string; a: string }>(
      `SELECT session_id AS s, agent_id AS a
         FROM agent_invocation
        WHERE session_id IS NOT NULL
          AND agent_id   IS NOT NULL`,
    )
    .all()
  const set = new Set<string>()
  for (const row of rows) set.add(compositeKey(row.s, row.a))
  return set
}

/** Map a ParsedTurn to the AgentUsageTurnInput shape recordAgentUsage expects. */
function toTurnInput(t: ParsedTurn) {
  return {
    turnSeq: t.turnSeq,
    model: t.model,
    usageSource: 'parsed_log' as const,       // required per constraint
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    // XOR CHECK: omit cachedInputTokens / reasoningOutputTokens (codex-only cols).
    cacheReadInputTokens: t.cacheReadInputTokens,
    cacheCreationInputTokens: t.cacheCreationInputTokens,
    cacheCreation5mInputTokens: t.cacheCreation5mInputTokens,
    cacheCreation1hInputTokens: t.cacheCreation1hInputTokens,
    // total_tokens: writer accepts undefined and derives it; omit to avoid drift.
  }
}

/** Write one invocation. Delegates error surface to onError (fail-open path). */
function writeInvocation(
  db: Database.Database,
  inv: ParsedSubagentInvocation,
  onWarn?: (m: string) => void,
): void {
  recordAgentUsage({
    db,
    tool: 'claude',
    role: 'external',
    usageSource: 'parsed_log',
    sessionId: inv.sessionId,
    agentId: inv.agentId,
    agentType: inv.agentType ?? null,
    externalLabel: EXTERNAL_LABEL,
    description: inv.description ?? null,
    model: inv.model ?? null,
    turns: inv.turns.map(toTurnInput),
    onError: (e) =>
      onWarn?.(
        `recordAgentUsage failed for ${inv.agentId} (fail-open): ${String(e)}`,
      ),
  })
}

function readMeta(jsonlPath: string): unknown {
  try {
    return JSON.parse(readFileSync(jsonlPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Ingest claude subagent usage from JSONL transcripts into the harness DB.
 *
 * Design invariants (non-negotiable):
 * - NEVER throws — the entire body is wrapped in a single try/catch that
 *   returns a benign {scanned, inserted, skipped} on any error.
 * - Idempotent via the UNIQUE INDEX agent_invocation_session_agent_idx:
 *   pre-SELECT existing (session_id, agent_id) into a Set and skip before
 *   readFileSync so a 2nd pass inserts nothing new.
 * - mtime settle: skip files modified within settleMs (default 30 000 ms) of
 *   now — they may still be appending.
 *
 * See docs/specs/ for the broader telemetry architecture.
 */
export function ingestClaudeSubagentUsage(opts: IngestOptions): IngestResult {
  const result: IngestResult = { scanned: 0, inserted: 0, skipped: 0 }
  try {
    const projectDir = resolveExistingProjectDir(opts)
    if (!projectDir) return result

    const files = listAgentTranscripts(projectDir)
    result.scanned = files.length
    if (files.length === 0) return result

    const now = opts.now ?? Date.now()
    const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS

    const managed = openManagedDb({ dbPath: harnessPaths(opts.harnessRoot).dbPath })
    try {
      runMigrations(managed.db)
      const existing = loadExistingKeys(managed.db)

      for (const file of files) {
        // --- mtime checks (before any file reads) ---
        let mtime: number
        try {
          mtime = statSync(file).mtimeMs
        } catch {
          result.skipped += 1
          continue
        }

        // Settle guard: skip in-flight transcripts still being written.
        // settleMs=0 disables the guard entirely (used in tests and incremental
        // callers that manage recency via mtimeSinceMs instead).
        if (settleMs > 0 && now - mtime < settleMs) {
          result.skipped += 1
          continue
        }

        // Incremental filter: skip files older than the caller's watermark.
        if (opts.mtimeSinceMs !== undefined && mtime < opts.mtimeSinceMs) {
          result.skipped += 1
          continue
        }

        // --- identity (path-derived, no file read) ---
        const id = claudeIdentityFromPath(projectDir, file)
        if (!id) {
          result.skipped += 1
          continue
        }

        // --- idempotency check BEFORE readFileSync ---
        if (existing.has(compositeKey(id.sessionId, id.agentId))) {
          result.skipped += 1
          continue
        }

        // --- parse ---
        const meta = readMeta(file)
        const inv = parseAgentTranscriptFile(file, meta)
        if (!inv) {
          result.skipped += 1
          continue
        }

        // --- write ---
        writeInvocation(managed.db, inv, opts.onWarn)

        // Guard within-pass duplicates (e.g. two files for the same agent).
        existing.add(compositeKey(inv.sessionId, inv.agentId))
        result.inserted += 1
      }
    } finally {
      managed.close()
    }
  } catch (error) {
    opts.onWarn?.(
      `claude subagent usage ingest failed (fail-open): ${String(error)}`,
    )
  }
  return result
}
