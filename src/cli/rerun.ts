import process from "node:process";
import { resolve } from "node:path";
import type { Command } from "commander";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import { codexBinaryVersion } from "../codex/codex-version.js";
import { harnessPaths } from "../config/paths.js";
import { prepareRerunFromReview, buildRerunChain, formatChain, RerunGateError, DEFAULT_MAX_ATTEMPTS } from "../core/rerun.js";
import { runDomainCoding } from "../core/workflow-runner.js";
import { loadGlobalPolicy, loadRepoPolicy } from "../policy/loader.js";
import { resolvePolicy } from "../policy/resolver.js";
import { ProjectError } from "../project/errors.js";
import { prepareProjectRun, type PreparedProjectRun } from "../project/run-project.js";

/**
 * `harness rerun`（changes_requested parent からの再実行）と `harness rerun chain`
 * （lineage 連鎖）を run.ts から behavior-zero で抽出。getHarnessRoot は opts 経由で遅延解決。
 */
export function registerRerunCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const rerunCmd = program
    .command("rerun")
    .description("spawn a new run from a changes_requested parent")
    // NOTE: a plain option (not requiredOption) so the `rerun chain`
    // subcommand can be invoked without --from-review. The action below
    // enforces presence for the bare `rerun` form.
    .option(
      "--from-review <run-id>",
      "parent run id (must be in changes_requested status)",
    )
    .option(
      "--max-attempts <n>",
      `max rerun attempts from the chain root (default ${DEFAULT_MAX_ATTEMPTS}); ` +
        `the n-th rerun is refused once rerunAttempt would exceed n`,
    )
    .action(async (raw: Record<string, unknown>) => {
      const harnessRoot = opts.getHarnessRoot();
      const paths = harnessPaths(harnessRoot);
      if (raw.fromReview === undefined) {
        process.stderr.write(
          "harness error: 'harness rerun' requires --from-review <run-id> " +
            "(did you mean 'harness rerun chain --run-id <id>'?)\n",
        );
        process.exit(1);
      }
      let maxAttempts: number | undefined;
      if (raw.maxAttempts !== undefined) {
        const n = Number(raw.maxAttempts);
        if (!Number.isInteger(n) || n < 1) {
          process.stderr.write(
            `harness error: --max-attempts must be a positive integer (got ${JSON.stringify(String(raw.maxAttempts))})\n`,
          );
          process.exit(1);
        }
        maxAttempts = n;
      }
      let prep;
      try {
        prep = await prepareRerunFromReview({
          runsDir: paths.runsDir,
          parentRunId: String(raw.fromReview),
          dbPath: paths.dbPath,
          ...(maxAttempts !== undefined ? { maxAttempts } : {}),
        });
      } catch (e) {
        if (e instanceof RerunGateError) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
      for (const w of prep.warnings) {
        process.stderr.write(`warning: ${w}\n`);
      }

      // Resolve policy the same way `harness run` does. A rerun of a
      // `--project` parent must re-resolve the profile (Phase 6-1) so the
      // child keeps the same compiled policy / context packs / project
      // provenance; a plain `--repo-id` parent reads policies/repos/<id>.yaml.
      const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
      // the parent's repoPath is the repo the chain actually ran against — a
      // `--project` parent may have used `--repo` as an override, so the rerun
      // reuses it instead of re-deriving the path from the profile. It comes
      // from the parent's canonical meta (the `runs` row for a db-first
      // parent), not a possibly-stale exported meta.json (P1-b).
      const parentRepoPath = prep.repoPath;
      const resolvedCodexBinaryVersion = codexBinaryVersion(codexBin);
      let prepared: PreparedProjectRun | undefined;
      let resolved;
      let repoPath: string;
      let repoId: string;
      if (prep.projectId !== undefined) {
        try {
          prepared = await prepareProjectRun({
            harnessRoot,
            projectId: prep.projectId,
            domain: prep.domain,
            repoOverride: parentRepoPath,
          });
        } catch (e) {
          if (e instanceof ProjectError) {
            process.stderr.write(`harness error: ${e.message}\n`);
            process.exit(1);
          }
          throw e;
        }
        // the profile must still resolve to the same repo the parent ran
        // against — otherwise the rerun would silently change attribution.
        if (prepared.repoId !== prep.repoId) {
          process.stderr.write(
            `harness error: rerun repo attribution drift — parent ` +
              `${prep.parentRunId} recorded repoId "${prep.repoId}" but project ` +
              `"${prep.projectId}" now resolves to "${prepared.repoId}"\n`,
          );
          process.exit(1);
        }
        resolved = prepared.resolvedPolicy;
        repoPath = prepared.repoPath;
        repoId = prepared.repoId;
      } else {
        const global = await loadGlobalPolicy(paths.globalPolicyPath);
        const repo = await loadRepoPolicy(paths.repoPolicyPath(prep.repoId));
        resolved = resolvePolicy(global, repo, prep.domain);
        repoPath = parentRepoPath;
        repoId = prep.repoId;
      }
      const runner = createCodexCliRunner({
        codexBin,
        sandbox: resolved.codex.sandbox,
        ...(resolved.codex.approval !== undefined
          ? { approvalPolicy: resolved.codex.approval }
          : {}),
        ...(resolved.codex.timeoutMs !== undefined
          ? { timeoutMs: resolved.codex.timeoutMs }
          : {}),
      });

      const result = await runDomainCoding({
        harnessRoot,
        repoPath,
        repoId,
        domain: prep.domain,
        goal: prep.goal,
        baseBranch: prep.baseBranch,
        codexRunner: runner,
        codexBinaryVersion: resolvedCodexBinaryVersion,
        parentRunId: prep.parentRunId,
        rootRunId: prep.rootRunId,
        rerunAttempt: prep.rerunAttempt,
        ...(prepared !== undefined
          ? {
              compiledPolicy: prepared.compiledPolicy,
              reviewRuleResolution: prepared.reviewRuleResolution,
              project: prepared.project,
              ...(prepared.projectContextPacks !== undefined
                ? {
                    projectContextPacks: {
                      promptText: prepared.projectContextPacks.promptText,
                      manifestYaml: prepared.projectContextPacks.manifestYaml,
                    },
                  }
                : {}),
            }
          : {}),
      });
      const cmdTotal = result.commandResults.length;
      const cmdOk = result.commandResults.filter(
        (c) => c.exitCode === 0 && !c.timedOut,
      ).length;
      process.stdout.write(
        `run=${result.runId} parentRunId=${prep.parentRunId} rootRunId=${prep.rootRunId} rerunAttempt=${prep.rerunAttempt} status=${result.status} safetyStatus=${result.safetyStatus} commands=${cmdOk}/${cmdTotal}\n`,
      );
      if (
        result.status === "failed-policy-violation" ||
        result.status === "failed-codex" ||
        result.status === "failed-codex-timeout" ||
        result.status === "failed-diff-collection" ||
        result.status === "failed-budget-exceeded" ||
        result.status === "failed-command" ||
        result.status === "failed-internal-error"
      ) {
        process.exit(1);
      }
    });
  rerunCmd
    .command("chain")
    .description("show the rerun chain a run belongs to (root → descendants)")
    .requiredOption("--run-id <id>", "any run in the chain")
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(opts.getHarnessRoot());
      try {
        const root = await buildRerunChain({
          runsDir: paths.runsDir,
          runId: String(raw.runId),
          dbPath: paths.dbPath,
        });
        process.stdout.write(formatChain(root));
      } catch (e) {
        if (e instanceof RerunGateError) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });
}
