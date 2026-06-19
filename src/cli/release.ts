import process from "node:process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { harnessVersion } from "../config/version.js";
import { harnessPaths } from "../config/paths.js";
import { loadProjectById } from "../project/profile-resolver.js";
import { verifyGuarded, guardedWriteGlobs } from "../core/verify-guarded.js";
import {
  loadCompileInputs,
  compileProjectPolicy,
} from "../project/policy-compiler.js";
import { MIGRATIONS } from "../db/migrations.js";
import {
  createGitReader,
  gatherReleasePlanInput,
  ReleaseGatherError,
} from "../release/release-git.js";
import { buildReleasePlan, renderReleasePlanText } from "../release/release-plan.js";
import {
  buildReleaseCheck,
  renderReleaseCheckText,
} from "../release/release-check.js";
import { gitCli } from "../git/git-cli.js";

/**
 * `harness verify-guarded`（#69 read-only guardrail）と `harness release`
 * （plan / check）を run.ts から behavior-zero で抽出。
 *
 * release.ts は release-git/release-plan/release-check を import する。CLI_PATHS は
 * release-git 側に据え置き（release-git は release.ts を import しないので循環なし）。
 * release plan/check の fail-closed exit code（plan: undeclared breaking で exit 2 /
 * check: not-ready で exit 1）を一字一句維持。getHarnessRoot は opts 経由で遅延解決。
 */
export function registerReleaseCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  // #69 — read-only guardrail: detect uncommitted out-of-band (non-harness)
  // changes to a guarded domain of the target repo. fail-closed (exit 1) so an
  // operator / CI / pre-push hook can gate on it. Does not mandate "always use
  // the harness"; only surfaces unverified guarded edits.
  program
    .command("verify-guarded")
    .description(
      "detect uncommitted out-of-band changes to guarded domains (read-only, #69)",
    )
    .requiredOption("--project <id>", "project profile id (projects/<id>.yaml)")
    .option("--repo <path>", "target repo path (overrides the profile's repo.path)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      try {
        const resolved = await loadProjectById(
          opts.getHarnessRoot(),
          String(raw.project),
          raw.repo !== undefined ? { repoOverride: String(raw.repo) } : {},
        );
        if (resolved.repoPath === null) {
          process.stderr.write(
            "harness error: no target repo path — set repo.path in the profile or pass --repo\n",
          );
          process.exit(1);
          return;
        }
        // Compile the policy so the guarded scope uses the SAME resolved
        // write/deny_write the harness enforces (kind-template defaults +
        // {root}/{other_domain_roots} placeholders + cross-domain denies), not
        // the raw profile globs — otherwise a template-driven profile's guarded
        // paths would be missed (not fail-closed).
        const compiled = compileProjectPolicy(
          await loadCompileInputs(resolved.profile, resolved.profilePath, {
            templatesDir: harnessPaths(opts.getHarnessRoot()).templatesDir,
            generatedAt: new Date().toISOString(),
          }),
        );
        const result = verifyGuarded({
          guardedGlobs: guardedWriteGlobs(compiled.repoPolicy),
          repo: resolved.repoPath,
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else if (result.ok) {
          process.stdout.write(
            `verify-guarded: ok — no unverified guarded changes in ${resolved.repoPath}\n`,
          );
        } else {
          process.stdout.write(
            `verify-guarded: FAIL — ${result.violations.length} uncommitted ` +
              `change(s) in guarded domains were not made through the harness:\n` +
              `${result.violations.map((p) => `  ${p}`).join("\n")}\n`,
          );
        }
        if (!result.ok) process.exit(1);
      } catch (e) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
    });

  // --- release planning ----------------------------------------------------
  // Deterministic release-readiness + compatibility analysis. Complements
  // release-please (which owns the bump / CHANGELOG / tag) by surfacing the DB
  // schema delta (no-downgrade) and removed/renamed CLI / MCP surface for any
  // tag range — see docs/specs/release.md.
  const releaseCmd = program
    .command("release")
    .description("release planning / compatibility analysis (complements release-please)");

  releaseCmd
    .command("plan")
    .description("analyze readiness + compatibility for the next version bump")
    .option("--since <ref>", "compare from this ref (default: the last tag)")
    .option("--to <ref>", "compare to this ref (default: HEAD)")
    .option("--repo <path>", "git repo to analyze (default: current directory)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      const reader = createGitReader(
        typeof raw.repo === "string" && raw.repo !== "" ? raw.repo : process.cwd(),
      );
      try {
        const input = await gatherReleasePlanInput(reader, {
          migrations: MIGRATIONS,
          currentVersion: harnessVersion(),
          ...(typeof raw.since === "string" ? { since: raw.since } : {}),
          ...(typeof raw.to === "string" ? { to: raw.to } : {}),
        });
        const plan = buildReleasePlan(input);
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(plan, null, 2)}\n`
            : renderReleasePlanText(plan),
        );
        // fail-closed (exit 2) for an agent / CI gate: an UNDECLARED breaking
        // change, OR an incomplete analysis (a surface file vanished / migration
        // metadata gap) — in which case "no breaking detected" is not trustworthy.
        if (plan.undeclaredBreaking.length > 0 || plan.analysisWarnings.length > 0) {
          process.exitCode = 2;
        }
      } catch (e) {
        if (e instanceof ReleaseGatherError) {
          process.stderr.write(`harness error: ${e.message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });

  releaseCmd
    .command("check")
    .description(
      "fail-closed release-readiness gate (plan-clean + version-consistency + spec-sync + clean-tree)",
    )
    .option("--since <ref>", "compare from this ref (default: the last tag)")
    .option("--to <ref>", "compare to this ref (default: HEAD)")
    .option("--repo <path>", "git repo to analyze (default: current directory)")
    .option("--json", "emit JSON instead of text", false)
    .action(async (raw: Record<string, unknown>) => {
      const repoArg =
        typeof raw.repo === "string" && raw.repo !== "" ? raw.repo : process.cwd();
      // Resolve to the git worktree root so the working-tree file reads
      // (package.json / manifest / docs/specs) are correct even when run from a
      // subdirectory — otherwise version-consistency / spec-sync falsely FAIL.
      const top = await gitCli(["rev-parse", "--show-toplevel"], {
        cwd: repoArg,
        timeoutMs: 15_000,
      });
      const repo =
        top.exitCode === 0 && !top.timedOut && top.stdout.trim() !== ""
          ? top.stdout.trim()
          : repoArg;
      const reader = createGitReader(repo);
      const readJson = (p: string): Record<string, unknown> | null => {
        try {
          return JSON.parse(readFileSync(join(repo, p), "utf8")) as Record<string, unknown>;
        } catch {
          return null;
        }
      };
      const readSpec = (p: string): string => {
        try {
          return readFileSync(join(repo, "docs", "specs", p), "utf8");
        } catch {
          return "";
        }
      };
      const pkg = readJson("package.json");
      const packageVersion =
        typeof pkg?.version === "string" ? pkg.version : null;
      const manifest = readJson(".release-please-manifest.json");
      const manifestVersion =
        manifest !== null && typeof manifest["."] === "string"
          ? (manifest["."] as string)
          : null;
      try {
        const input = await gatherReleasePlanInput(reader, {
          migrations: MIGRATIONS,
          currentVersion: packageVersion ?? "0.0.0",
          ...(typeof raw.since === "string" ? { since: raw.since } : {}),
          ...(typeof raw.to === "string" ? { to: raw.to } : {}),
        });
        const plan = buildReleasePlan(input);
        const status = await gitCli(["status", "--porcelain"], {
          cwd: repo,
          timeoutMs: 15_000,
        });
        const treeClean =
          status.exitCode === 0 && !status.timedOut && status.stdout.trim() === "";
        const report = buildReleaseCheck({
          plan,
          packageVersion,
          manifestVersion,
          treeClean,
          specs: {
            mcp: readSpec("mcp.md"),
            db: readSpec("db.md"),
            cli: readSpec("cli.md"),
          },
        });
        process.stdout.write(
          raw.json === true
            ? `${JSON.stringify(report, null, 2)}\n`
            : renderReleaseCheckText(report),
        );
        if (!report.ok) process.exitCode = 1; // fail-closed: not ready to release
      } catch (e) {
        if (e instanceof ReleaseGatherError) {
          process.stderr.write(`harness error: ${e.message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });
}
