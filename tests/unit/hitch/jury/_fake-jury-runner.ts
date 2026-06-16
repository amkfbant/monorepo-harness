import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  CodexExecRunner,
  CodexRunInputs,
  CodexRunResult,
} from "../../../../src/codex/codex-exec-runner.js";
import type { JuryLens, JuryStage } from "../../../../src/hitch/jury/types.js";

/**
 * #230 PR4 — shared prompt-routing fake codex runner for the jury Layer 2 tests.
 *
 * `createFakeCodexRunner` returns ONE fixed stdout for ALL run() calls, which
 * cannot differentiate the 3 lenses or 3 stages of a deliberation. The real
 * proposer/critique/refuter embed a lens token (`[[lens:correctness]]`) and a
 * stage token (`[[stage:propose]]`) into each per-lens prompt so the model
 * answers each lens independently. This routing runner mirrors that contract:
 * it inspects `input.prompt` for those tokens and writes the matching canned
 * JSON from the map, letting RED tests inject per-lens different proposals
 * (e.g. a 1-lens-out_of_scope split), unanimity, vote-changes, parse garbage,
 * and per-stage refuter/critique verdicts.
 */

/** The convention the jury prompts MUST follow so this runner can route. */
export const LENS_TOKEN = (lens: JuryLens): string => `[[lens:${lens}]]`;
export const STAGE_TOKEN = (stage: JuryStage): string => `[[stage:${stage}]]`;

/** Match `[[lens:<lens>]]` anywhere in the prompt. */
function extractLens(prompt: string): JuryLens | undefined {
  const m = /\[\[lens:(correctness|scope_fit|spec_adherence)\]\]/.exec(prompt);
  return m === null ? undefined : (m[1] as JuryLens);
}

/** Match `[[stage:<stage>]]` anywhere in the prompt. */
function extractStage(prompt: string): JuryStage | undefined {
  const m = /\[\[stage:(propose|critique|refute)\]\]/.exec(prompt);
  return m === null ? undefined : (m[1] as JuryStage);
}

/** A canned codex response for one (stage, lens) routing key. */
export interface RoutedResponse {
  /** stdout written to logPaths.stdout (the proposer reads this). */
  stdout: string;
  /** Force a timeout outcome (fail-closed -> proposalStatus=timeout). */
  timedOut?: boolean;
  /** Force a non-zero exit (fail-closed). */
  exitCode?: number;
  stderr?: string;
}

/** Routing map keyed by `<stage>:<lens>` (e.g. "propose:correctness"). */
export type RoutingMap = Record<string, RoutedResponse>;

/** Build the routing key the map is indexed by. */
export function routingKey(stage: JuryStage, lens: JuryLens): string {
  return `${stage}:${lens}`;
}

/**
 * A custom `CodexExecRunner` that routes each run() to the canned response for
 * the (stage, lens) tokens found in `input.prompt`. A prompt missing either
 * token, or one with no map entry, writes empty stdout and exits non-zero so a
 * mis-routed call fails closed (it never silently returns a stale response).
 */
export function routingRunner(map: RoutingMap): CodexExecRunner {
  return {
    async run(input: CodexRunInputs): Promise<CodexRunResult> {
      await mkdir(dirname(input.logPaths.stdout), { recursive: true });
      await mkdir(dirname(input.logPaths.stderr), { recursive: true });
      await mkdir(dirname(input.logPaths.events), { recursive: true });

      const lens = extractLens(input.prompt);
      const stage = extractStage(input.prompt);
      const routed =
        lens !== undefined && stage !== undefined
          ? map[routingKey(stage, lens)]
          : undefined;

      if (routed === undefined) {
        // Mis-routed / unmapped: fail closed (non-zero exit, empty stdout).
        await writeFile(input.logPaths.stdout, "", "utf8");
        await writeFile(
          input.logPaths.stderr,
          `routingRunner: no response for stage=${String(stage)} lens=${String(lens)}\n`,
          "utf8",
        );
        await writeFile(input.logPaths.events, "", "utf8");
        return { exitCode: 1, timedOut: false, aborted: false, durationMs: 0 };
      }

      await writeFile(input.logPaths.stdout, routed.stdout, "utf8");
      await writeFile(input.logPaths.stderr, routed.stderr ?? "", "utf8");
      await writeFile(input.logPaths.events, "", "utf8");
      return {
        exitCode: routed.exitCode ?? 0,
        timedOut: routed.timedOut ?? false,
        aborted: false,
        durationMs: 0,
      };
    },
  };
}
