import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
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
    // Use a non-existent claudeProjectDir so resolveExistingProjectDir calls
    // onWarn("claude project dir not found…") deterministically — without this
    // trigger onWarn is never called and the test passes even if safeWarn were
    // removed (non-discriminating).
    const nonExistentDir = join(tmpdir(), 'no-such-cpd-xyzzy-' + Date.now())
    const throwingWarn = (_msg: string): void => {
      throw new Error('onWarn intentionally throws')
    }
    // Must not throw — safeWarn catches the throwing onWarn (fail-open).
    let result: { scanned: number; inserted: number; skipped: number } | undefined
    expect(() => {
      result = ingestClaudeSubagentUsage({
        harnessRoot: env.harnessRoot,
        claudeProjectDir: nonExistentDir,
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

  // ---------------------------------------------------------------------------
  // FIX 3 [P2]: created_at must reflect the transcript file mtime, NOT ingest
  // wall-clock. On the first scan of an existing project dir, old transcripts
  // must NOT get created_at=now (which would wrongly include them in --since
  // <today> queries).
  // ---------------------------------------------------------------------------
  it('[P2-mtime] created_at reflects file mtime, not ingest time', () => {
    const harnessRoot = mkdtempSync(join(tmpdir(), 'hr-mtime-'))
    mkdirSync(join(harnessRoot, '.harness'), { recursive: true })
    const claudeProjectDir = mkdtempSync(join(tmpdir(), 'cpd-mtime-'))
    const dir = join(claudeProjectDir, 'sess-old', 'subagents')
    mkdirSync(dir, { recursive: true })
    const jsonlPath = join(dir, 'agent-bak.jsonl')
    writeFileSync(
      jsonlPath,
      '{"type":"assistant","sessionId":"sess-old","agentId":"bak","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}\n',
    )
    // Backdate to 2 days ago
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(jsonlPath, twoDaysAgo, twoDaysAgo)

    ingestClaudeSubagentUsage({ harnessRoot, claudeProjectDir, settleMs: 0 })

    const m = dbAt(harnessRoot)
    try {
      // Query with since = 1 day ago: the backdated transcript must NOT appear.
      const oneDayAgoIso = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
      const recent = subagentUsageSummary(m.db, { since: oneDayAgoIso })
      expect(
        recent.totals.invocations,
        'backdated transcript must NOT appear in since=1d-ago query (created_at must be mtime, not now)',
      ).toBe(0)

      // Without since filter the row IS present (the row was written).
      const all = subagentUsageSummary(m.db)
      expect(all.totals.invocations).toBe(1)
    } finally {
      m.close()
    }
  })

  // ---------------------------------------------------------------------------
  // #349: a transcript ingested partial (mid-stream) must SELF-HEAL when it
  // later grows past its stored source_size — the previously-frozen row is
  // re-ingested with the complete usage instead of staying partial forever.
  // ---------------------------------------------------------------------------
  it('[#349] re-ingests a GROWN transcript and corrects the frozen partial usage', () => {
    const harnessRoot = mkdtempSync(join(tmpdir(), 'hr-grow-'))
    mkdirSync(join(harnessRoot, '.harness'), { recursive: true })
    const claudeProjectDir = mkdtempSync(join(tmpdir(), 'cpd-grow-'))
    const dir = join(claudeProjectDir, 'sess-1', 'subagents')
    mkdirSync(dir, { recursive: true })
    const jsonlPath = join(dir, 'agent-aaa.jsonl')

    // Pass 1: only the first turn is present (a mid-stream partial read).
    writeFileSync(jsonlPath, TURN_LINE_1)
    const r1 = ingestClaudeSubagentUsage({ harnessRoot, claudeProjectDir, settleMs: 0 })
    expect(r1.inserted).toBe(1)
    let m = dbAt(harnessRoot)
    try {
      expect(subagentUsageSummary(m.db).totals.totalTokens).toBe(30) // 10+20
      expect(countTurns(m.db)).toBe(1)
    } finally {
      m.close()
    }

    // Pass 2: the transcript has GROWN (second turn appended).
    writeFileSync(jsonlPath, TURN_LINE_1 + TURN_LINE_2)
    const r2 = ingestClaudeSubagentUsage({ harnessRoot, claudeProjectDir, settleMs: 0 })
    expect(r2.inserted).toBe(1) // a write happened (replacement)
    m = dbAt(harnessRoot)
    try {
      // still ONE invocation (unique session+agent), now with BOTH turns + the
      // corrected total (33), not the frozen partial 30.
      expect(countInvocations(m.db)).toBe(1)
      expect(countTurns(m.db)).toBe(2)
      expect(subagentUsageSummary(m.db).totals.totalTokens).toBe(33)
    } finally {
      m.close()
    }

    // Pass 3: unchanged size → idempotent skip (no churn).
    const r3 = ingestClaudeSubagentUsage({ harnessRoot, claudeProjectDir, settleMs: 0 })
    expect(r3.inserted).toBe(0)
  })

  // ---------------------------------------------------------------------------
  // #353: path-derived identity is authoritative for keying. Even if the in-file
  // sessionId drifts from the directory name, the row is stored under the PATH
  // identity so the skip-before-read pre-check and the stored key agree.
  // ---------------------------------------------------------------------------
  it('[#353] stores the row under the PATH identity, not the in-file sessionId', () => {
    const harnessRoot = mkdtempSync(join(tmpdir(), 'hr-id-'))
    mkdirSync(join(harnessRoot, '.harness'), { recursive: true })
    const claudeProjectDir = mkdtempSync(join(tmpdir(), 'cpd-id-'))
    const dir = join(claudeProjectDir, 'sess-PATH', 'subagents')
    mkdirSync(dir, { recursive: true })
    // in-file sessionId deliberately differs from the directory ('sess-PATH').
    writeFileSync(
      join(dir, 'agent-zzz.jsonl'),
      '{"type":"assistant","sessionId":"sess-CONTENT","agentId":"zzz","message":{"model":"claude-opus-4-8","usage":{"input_tokens":7,"output_tokens":3}}}\n',
    )

    const r1 = ingestClaudeSubagentUsage({ harnessRoot, claudeProjectDir, settleMs: 0 })
    expect(r1.inserted).toBe(1)
    const m = dbAt(harnessRoot)
    try {
      const row = m.db
        .prepare(
          "SELECT session_id AS s, agent_id AS a FROM agent_invocation WHERE tool='claude'",
        )
        .get() as { s: string; a: string }
      expect(row.s).toBe('sess-PATH') // path-derived, NOT 'sess-CONTENT'
      expect(row.a).toBe('zzz')
    } finally {
      m.close()
    }

    // pre-check now matches the stored (path) key → 2nd pass is idempotent.
    const r2 = ingestClaudeSubagentUsage({ harnessRoot, claudeProjectDir, settleMs: 0 })
    expect(r2.inserted).toBe(0)
  })
})
