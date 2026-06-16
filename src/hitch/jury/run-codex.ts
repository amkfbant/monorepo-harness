import type {
  CodexRunResult,
  CodexExecRunner,
} from "../../codex/codex-exec-runner.js";
import type { JuryProposerDeps } from "./types.js";

/**
 * #230 P1 safety — the single jury codex invocation wrapper for every Stage1/3/4
 * call (proposer / critique / refuter). It enforces BOTH P1 fixes in one place
 * so no jury stage can call `reviewerRunner.run` un-guarded:
 *
 * P1 FIX 1 (lease-loss abort, #132): the orchestrator's lease signal
 * (`deps.signal`) is threaded into the codex `run({..., signal})` call. When the
 * course loses its lease mid-deliberation it aborts that signal; the in-flight
 * codex is SIGKILLed (fail-closed) — a non-authoritative drive launches no new
 * codex once the lease is gone.
 *
 * P1 FIX 2 (per-call timeout): `JuryProposerDeps` carries `timeoutMs` but the
 * runner has NO timeout field — the CALLER must enforce it. Each call derives a
 * fresh `AbortController` and `setTimeout(() => abort(), timeoutMs)`, COMBINES it
 * with the lease signal via `AbortSignal.any`, and passes the combined signal in.
 * A hanging jury codex therefore cannot block the classify step indefinitely.
 *
 * Fail-closed mapping: an aborted run (lease loss OR timeout) is normalized to
 * `timedOut: true` so the existing per-stage fail-closed mappers (proposer
 * `timeout`, critique/refuter `inconclusive`) treat it as a non-complete result,
 * never `complete`. The runner spreads the original result first so a runner that
 * already set `timedOut`/`exitCode` is preserved; the abort overlay only forces
 * fail-closed when the call was aborted.
 */
export async function runJuryCodex(
  deps: Pick<JuryProposerDeps, "reviewerRunner" | "timeoutMs"> & {
    signal?: AbortSignal;
  },
  inputs: Parameters<CodexExecRunner["run"]>[0],
): Promise<CodexRunResult> {
  // Already lease-lost before launch: do not spawn a new codex — fail closed.
  if (deps.signal?.aborted === true) {
    return { exitCode: 1, timedOut: true, aborted: true, durationMs: 0 };
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => {
    timeoutController.abort();
  }, deps.timeoutMs);
  // Combine the lease signal (when present) with the per-call timeout signal.
  const combined =
    deps.signal !== undefined
      ? AbortSignal.any([deps.signal, timeoutController.signal])
      : timeoutController.signal;

  try {
    const result = await deps.reviewerRunner.run({ ...inputs, signal: combined });
    // Map an aborted (lease loss OR timeout) run to fail-closed. A runner that
    // does not surface `aborted` but exits non-zero on kill is already handled
    // by the per-stage exit-code check; this overlay covers signal-aware fakes
    // and the timeout path explicitly so it never reads as `complete`.
    if (combined.aborted || result.aborted === true) {
      return { ...result, timedOut: true, aborted: true };
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}
