import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
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
 *
 * Round5 FIX 1 (codex#254 P2 — log-truncation safety): the per-(hitch,finding,
 * lens,stage) stdout/stderr/events log paths are DETERMINISTIC/SHARED. They must
 * be TRUNCATED before a real run so a codex that exits 0 WITHOUT writing stdout
 * cannot leave a STALE prior proposal for readFile to reparse (which would drive
 * the gate from stale output). Truncation is performed HERE — AFTER the
 * already-aborted short-circuit — so a STALE worker that lost its lease can NOT
 * erase the AUTHORITATIVE worker's log files for the same jury stage (an aborted
 * call neither truncates nor writes). The per-stage callers (proposer/critique/
 * refuter) therefore MUST NOT pre-truncate the log files themselves.
 */
export async function runJuryCodex(
  deps: Pick<JuryProposerDeps, "reviewerRunner" | "timeoutMs"> & {
    signal?: AbortSignal;
  },
  inputs: Parameters<CodexExecRunner["run"]>[0],
): Promise<CodexRunResult> {
  // Already lease-lost before launch: do not spawn a new codex AND do not touch
  // the (shared, deterministic) log files — fail closed. A stale lease-lost
  // worker erasing the authoritative worker's stdout would degrade a valid
  // proposal to parse_error (Round5 FIX 1).
  if (deps.signal?.aborted === true) {
    return { exitCode: 1, timedOut: true, aborted: true, durationMs: 0 };
  }

  // Truncate the deterministic stdout/stderr/events log files only now that we
  // are committed to launching a fresh codex. This clears any stale prior
  // attempt so an empty stdout fails to parse -> fail-closed (never reparses a
  // stale proposal); it runs ONLY on the non-aborted path (see above).
  for (const p of [
    inputs.logPaths.stdout,
    inputs.logPaths.stderr,
    inputs.logPaths.events,
  ]) {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, "", "utf8");
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
