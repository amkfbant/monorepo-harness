import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateJuryProposals,
  type JuryProposerFinding,
} from "../../../../src/hitch/jury/proposer.js";
import { runClassificationRefuter } from "../../../../src/hitch/jury/refuter.js";
import type {
  JuryLens,
  JuryProposerDeps,
  JuryStage,
  EvidenceCheckContext,
} from "../../../../src/hitch/jury/types.js";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "../../../../src/codex/codex-exec-runner.js";
import type { GlobalPolicy, RepoPolicy } from "../../../../src/policy/schema.js";

/**
 * #230 P1 safety — per-call jury codex timeout (P1 FIX 2) and lease-signal
 * threading/combination (P1 FIX 1) exercised at the proposer/refuter layer,
 * where a TINY `timeoutMs` is controllable. A hanging codex (run() resolves only
 * on signal abort) is aborted after ~timeoutMs and fail-closes; the lease signal
 * is combined into the codex call (AbortSignal.any) so a lease abort also fires.
 */

let tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup.
    }
  }
  tmpDirs = [];
});

const GLOBAL: GlobalPolicy = { always_deny_write: [], ignore_untracked: [] };
const REPO: RepoPolicy = { repo_id: "t", read: [], domains: {} };

function makeDeps(
  runner: CodexExecRunner,
  opts: { timeoutMs: number; signal?: AbortSignal },
): JuryProposerDeps {
  const worktreePath = mkdtempSync(join(tmpdir(), "jury-runcodex-"));
  tmpDirs = [...tmpDirs, worktreePath];
  mkdirSync(join(worktreePath, "src"), { recursive: true });
  writeFileSync(join(worktreePath, "src", "a.ts"), "line 1\nline 2\n", "utf8");
  const auditDir = join(worktreePath, "audit");
  const evidenceCtx: EvidenceCheckContext = {
    worktreePath,
    compiledPolicy: { global: GLOBAL, repo: REPO },
  };
  const logPaths = (findingId: string, lens: JuryLens, stage: JuryStage) => ({
    stdout: join(auditDir, `${findingId}.${lens}.${stage}.out.log`),
    stderr: join(auditDir, `${findingId}.${lens}.${stage}.err.log`),
    events: join(auditDir, `${findingId}.${lens}.${stage}.events.jsonl`),
  });
  return {
    reviewerRunner: runner,
    harnessRoot: worktreePath,
    worktreePath,
    logPaths,
    timeoutMs: opts.timeoutMs,
    parseSchema: undefined,
    auditDir,
    evidenceCtx,
    scopeSnapshot: { goal: "run-codex test scope" },
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  };
}

const FINDING: JuryProposerFinding = {
  findingId: "f-1",
  summary: "ambiguous finding",
  filePath: "src/a.ts",
  category: "core",
};

/**
 * A runner whose run() NEVER resolves until the passed signal aborts. With the
 * caller-enforced per-call timeout (P1 FIX 2) the combined signal aborts after
 * `timeoutMs` and the call resolves fail-closed. WITHOUT the fix no signal is
 * threaded, so the promise hangs forever — the test times out (genuine RED).
 */
function hangingRunner(): CodexExecRunner {
  return {
    run: (input: CodexRunInputs): Promise<CodexRunResult> =>
      new Promise<CodexRunResult>((resolve) => {
        const finish = () =>
          resolve({ exitCode: 124, timedOut: false, durationMs: 0 });
        if (input.signal === undefined) {
          // No signal threaded -> hang forever (the fix is missing); the test
          // times out, proving the timeout is not caller-enforced.
          return;
        }
        if (input.signal.aborted) {
          finish();
          return;
        }
        input.signal.addEventListener("abort", finish, { once: true });
      }),
  };
}

describe("runJuryCodex — P1 FIX 2: per-call timeout fail-closed", () => {
  it("a proposer call whose codex hangs is aborted after timeoutMs and becomes a fail-closed (timeout) proposal", async () => {
    const deps = makeDeps(hangingRunner(), { timeoutMs: 50 });
    const start = Date.now();
    const proposals = await generateJuryProposals(deps, FINDING);
    const elapsed = Date.now() - start;

    // It did NOT hang (3 lenses x ~50ms each, well under the 5s test budget).
    expect(elapsed).toBeLessThan(5_000);
    // Fail-closed: every lens proposal is non-complete (timeout), scope unknown.
    expect(proposals.length).toBe(3);
    for (const p of proposals) {
      expect(p.proposalStatus).toBe("timeout");
      expect(p.proposedScope).toBe("unknown");
    }
  }, 10_000);

  it("a refuter call whose codex hangs is aborted after timeoutMs and fail-closes to inconclusive (veto)", async () => {
    const deps = makeDeps(hangingRunner(), { timeoutMs: 50 });
    const verdict = await runClassificationRefuter(deps, {
      findingId: "f-1",
      filePath: "src/a.ts",
      category: "core",
      unanimousScope: "in_scope",
      refutationConditions: [],
      verifiedEvidence: [],
    });
    // Fail-closed: a timed-out refuter is a veto, never an uphold.
    expect(verdict.refuteVerdict).toBe("inconclusive");
  }, 10_000);
});

describe("runJuryCodex — P1 FIX 1: lease signal combined into the codex call", () => {
  it("threads a combined signal into every codex call and a lease abort fires it (fail-closed)", async () => {
    const controller = new AbortController();
    const seen: boolean[] = [];
    const observing: CodexExecRunner = {
      run: (input: CodexRunInputs): Promise<CodexRunResult> =>
        new Promise<CodexRunResult>((resolve) => {
          seen.push(input.signal !== undefined);
          const finish = () =>
            resolve({ exitCode: 124, timedOut: false, durationMs: 0 });
          if (input.signal !== undefined && input.signal.aborted) {
            finish();
            return;
          }
          input.signal?.addEventListener("abort", finish, { once: true });
          // Abort the LEASE shortly after the call begins (not the timeout).
          setTimeout(() => controller.abort(new Error("lease lost")), 20);
        }),
    };
    // Large timeout so the abort comes from the LEASE, not the timeout path.
    const deps = makeDeps(observing, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    const proposals = await generateJuryProposals(deps, FINDING);
    // Every codex call received a (combined) signal.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((got) => got === true)).toBe(true);
    // Fail-closed: the lease abort makes the proposals non-complete.
    for (const p of proposals) {
      expect(p.proposalStatus).not.toBe("complete");
    }
  }, 10_000);
});
