import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingestClaudeSubagentUsage } from '../../../src/telemetry/ingest-claude-subagent-usage.js'
import { subagentUsageSummary } from '../../../src/db/repositories/subagent-usage.js'
import { harnessPaths } from '../../../src/config/paths.js'
import { openManagedDb } from '../../../src/db/managed-connection.js'
import { runMigrations } from '../../../src/db/migrations.js'
import { countInvocations, countTurns } from '../db/_agent-usage-helpers.js'

// Two assistant lines: input+output tokens that sum to deterministic totals.
const TURN_LINE_1 =
  '{"type":"assistant","sessionId":"sess-1","agentId":"aaa","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n'
const TURN_LINE_2 =
  '{"type":"assistant","sessionId":"sess-1","agentId":"aaa","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n'

function makeEnv(opts?: { broken?: boolean }): {
  harnessRoot: string
  claudeProjectDir: string
} {
  const harnessRoot = mkdtempSync(join(tmpdir(), 'hr-'))
  // openManagedDb needs the .harness dir to exist (db.lock sidecar lives there).
  mkdirSync(join(harnessRoot, '.harness'), { recursive: true })

  const claudeProjectDir = mkdtempSync(join(tmpdir(), 'cpd-'))
  const dir = join(claudeProjectDir, 'sess-1', 'subagents')
  mkdirSync(dir, { recursive: true })

  const content = opts?.broken
    ? 'not-json\n'
    : TURN_LINE_1 + TURN_LINE_2

  writeFileSync(join(dir, 'agent-aaa.jsonl'), content)
  writeFileSync(join(dir, 'agent-aaa.meta.json'), '{"agentType":"general-purpose"}')

  return { harnessRoot, claudeProjectDir }
}

/** Open a read-only managed connection and run migrations so helpers can query. */
function dbAt(harnessRoot: string) {
  const m = openManagedDb({ dbPath: harnessPaths(harnessRoot).dbPath })
  runMigrations(m.db)
  return m
}

describe('ingestClaudeSubagentUsage', () => {
  it('ingests parsed transcripts and ACTUALLY writes rows (positive assert)', () => {
    const env = makeEnv()
    const r = ingestClaudeSubagentUsage({ ...env, settleMs: 0 })
    expect(r.inserted).toBe(1)
    const m = dbAt(env.harnessRoot)
    try {
      const summary = subagentUsageSummary(m.db)
      expect(summary.rows.length).toBeGreaterThan(0)
      // P2: non-zero token sums — a zeroing parser would pass a rows.length check alone
      expect(summary.rows[0].inputTokens).toBeGreaterThan(0)
      expect(summary.rows[0].outputTokens).toBeGreaterThan(0)
    } finally {
      m.close()
    }
  })

  it('[P1] totalTokens is non-zero and equals input+output for ingested rows', () => {
    const env = makeEnv()
    ingestClaudeSubagentUsage({ ...env, settleMs: 0 })
    const m = dbAt(env.harnessRoot)
    try {
      const summary = subagentUsageSummary(m.db)
      expect(summary.rows.length).toBeGreaterThan(0)
      const row = summary.rows[0]
      // TURN_LINE_1: 10+20=30, TURN_LINE_2: 1+2=3 → total 33
      expect(row.totalTokens).toBe(33)
      expect(summary.totals.totalTokens).toBe(33)
      expect(summary.totals.totalTokens).toBe(
        summary.totals.inputTokens + summary.totals.outputTokens,
      )
    } finally {
      m.close()
    }
  })

  it('writes per-message turns (not collapsed)', () => {
    const env = makeEnv()
    ingestClaudeSubagentUsage({ ...env, settleMs: 0 })
    const m = dbAt(env.harnessRoot)
    try {
      expect(countTurns(m.db)).toBe(2)
    } finally {
      m.close()
    }
  })

  it('is idempotent: a 2nd pass inserts nothing new', () => {
    const env = makeEnv()
    ingestClaudeSubagentUsage({ ...env, settleMs: 0 })
    const r2 = ingestClaudeSubagentUsage({ ...env, settleMs: 0 })
    expect(r2.inserted).toBe(0)
    const m = dbAt(env.harnessRoot)
    try {
      expect(countInvocations(m.db)).toBe(1)
    } finally {
      m.close()
    }
  })

  it('[P1] mtime SKIP guard: fresh transcript is skipped, no row written', () => {
    const env = makeEnv()
    // File was just written (mtime ≈ now). settleMs=60000 ensures it's within
    // the settle window. Pass now explicitly so the comparison is deterministic.
    const now = Date.now()
    const result = ingestClaudeSubagentUsage({
      ...env,
      settleMs: 60_000,
      now,
    })
    expect(result.skipped).toBe(1)
    expect(result.inserted).toBe(0)
    // No agent_invocation row must have been written — guard-removal regression.
    const m = dbAt(env.harnessRoot)
    try {
      expect(countInvocations(m.db)).toBe(0)
    } finally {
      m.close()
    }
  })

  it('[P2] onWarn that throws does NOT propagate (fail-open contract)', () => {
    const env = makeEnv()
    const throwingWarn = (_msg: string): void => {
      throw new Error('onWarn intentionally throws')
    }
    // Must not throw — ingest is fail-open even when onWarn misbehaves.
    let result: { scanned: number; inserted: number; skipped: number } | undefined
    expect(() => {
      result = ingestClaudeSubagentUsage({
        ...env,
        settleMs: 0,
        onWarn: throwingWarn,
      })
    }).not.toThrow()
    // Should still return a valid result object.
    expect(result).toBeDefined()
    expect(result!.inserted).toBeGreaterThanOrEqual(0)
  })

  it('never throws on a broken transcript', () => {
    const env = makeEnv({ broken: true })
    expect(() => ingestClaudeSubagentUsage({ ...env, settleMs: 0 })).not.toThrow()
    // [P3] Broken transcript must persist nothing.
    const m = dbAt(env.harnessRoot)
    try {
      expect(countInvocations(m.db)).toBe(0)
    } finally {
      m.close()
    }
  })
})
