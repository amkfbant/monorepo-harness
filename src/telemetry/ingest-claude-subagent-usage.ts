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
  capToken,
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
 * Fire opts.onWarn without letting a throwing caller break the never-throws
 * contract. All warn paths must route through here.
 */
function safeWarn(opts: IngestOptions, message: string): void {
  try {
    opts.onWarn?.(message)
  } catch {
    // A throwing onWarn must not propagate — ingest is fail-open.
  }
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

  safeWarn(opts, `claude project dir not found: ${literal}`)
  return null
}

/**
 * Load `(session_id, agent_id) → source_size` for every claude invocation
 * already present. Used to skip-before-read on later passes (idempotency) AND to
 * detect a GROWN transcript that must be re-ingested (#349). source_size is NULL
 * for pre-v37 rows (treated as complete → never re-ingested).
 */
function loadExistingKeys(db: Database.Database): Map<string, number | null> {
  const rows = db
    .prepare<[], { s: string; a: string; sz: number | null }>(
      `SELECT session_id AS s, agent_id AS a, source_size AS sz
         FROM agent_invocation
        WHERE session_id IS NOT NULL
          AND agent_id   IS NOT NULL`,
    )
    .all()
  const map = new Map<string, number | null>()
  for (const row of rows) map.set(compositeKey(row.s, row.a), row.sz)
  return map
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
    // Writer saves total_tokens verbatim (null when absent); derive it here so
    // `harness usage subagents` totalTokens is non-zero. capToken keeps the
    // derived sum a non-negative safe integer (the addends are already clamped).
    totalTokens: capToken((t.inputTokens ?? 0) + (t.outputTokens ?? 0)),
  }
}

/**
 * Write one invocation. Returns true when the write succeeded, false on any
 * error. The caller must not increment inserted / mark existing on false —
 * a failed write must not be treated as a successful insert.
 *
 * identity: PATH-derived (session, agent). It — not the in-file content ids — is
 * authoritative for keying so the skip-before-read pre-check and the stored row
 * agree on a single identity even if a transcript's in-file sessionId drifts
 * from its directory (#353).
 *
 * fileMtime: the transcript file's mtime (epoch ms). Passed as `now` to
 * recordAgentUsage so agent_invocation.created_at reflects WHEN the transcript
 * was written, not when this ingest pass ran. This ensures `--since <today>`
 * queries correctly exclude historical transcripts scanned for the first time.
 *
 * sourceSize: the transcript byte size, persisted for grown-transcript re-ingest
 * (#349). replace=true (a grown previously-partial transcript) deletes the old
 * `(session, agent)` row IN THE SAME transaction (beforeWrite) so the rewrite is
 * atomic and the FK ON DELETE CASCADE clears its stale turns.
 */
function writeInvocation(
  db: Database.Database,
  identity: { sessionId: string; agentId: string },
  inv: ParsedSubagentInvocation,
  opts: IngestOptions,
  fileMtime: number,
  sourceSize: number,
  replace: boolean,
): boolean {
  let ok = true
  recordAgentUsage({
    db,
    tool: 'claude',
    role: 'external',
    usageSource: 'parsed_log',
    sessionId: identity.sessionId,
    agentId: identity.agentId,
    agentType: inv.agentType ?? null,
    externalLabel: EXTERNAL_LABEL,
    description: inv.description ?? null,
    model: inv.model ?? null,
    turns: inv.turns.map(toTurnInput),
    sourceSize,
    now: new Date(fileMtime),
    ...(replace
      ? {
          beforeWrite: () => {
            db.prepare(
              `DELETE FROM agent_invocation
                WHERE session_id = ? AND agent_id = ?`,
            ).run(identity.sessionId, identity.agentId)
          },
        }
      : {}),
    onError: (e) => {
      ok = false
      safeWarn(
        opts,
        `recordAgentUsage failed for ${identity.agentId} (fail-open): ${String(e)}`,
      )
    },
  })
  return ok
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
 *   pre-SELECT existing (session_id, agent_id) → source_size and skip before
 *   readFileSync so a 2nd pass over an UNCHANGED transcript inserts nothing new.
 * - Self-healing (#349): a transcript that has GROWN past its stored
 *   source_size (a previously-partial mid-stream read) is re-ingested
 *   (delete + re-record) so its frozen partial usage is corrected.
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
        // --- stat (mtime + size) before any file reads ---
        let mtime: number
        let size: number
        try {
          const st = statSync(file)
          mtime = st.mtimeMs
          size = st.size
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

        // --- idempotency / changed-transcript check BEFORE readFileSync ---
        // Skip an unchanged transcript; re-ingest one whose byte size has
        // CHANGED from its stored source_size (#349): growth = a previously
        // partial mid-stream read; shrink = truncation/rotation. (A same-size
        // content change is NOT detected — would need an mtime/hash; out of
        // scope as Claude transcripts are append-only per agentId.) A NULL stored
        // size (pre-v37 row) is treated as complete → never re-ingested, so a
        // v37 upgrade does not churn existing telemetry.
        const key = compositeKey(id.sessionId, id.agentId)
        const known = existing.has(key)
        const replace = known && (() => {
          const storedSize = existing.get(key)
          return storedSize !== null && storedSize !== undefined && size !== storedSize
        })()
        if (known && !replace) {
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

        // --- write (path-authoritative identity; replace deletes the stale row) ---
        const wrote = writeInvocation(managed.db, id, inv, opts, mtime, size, replace)

        // Guard within-pass duplicates only when the write succeeded.
        // A failed write (onError path) must not update the size map or count —
        // the cross-pass UNIQUE index + pre-SELECT still guarantee idempotency
        // on retry.
        if (wrote) {
          existing.set(key, size)
          result.inserted += 1
        }
      }
    } finally {
      managed.close()
    }
  } catch (error) {
    safeWarn(
      opts,
      `claude subagent usage ingest failed (fail-open): ${String(error)}`,
    )
  }
  return result
}
