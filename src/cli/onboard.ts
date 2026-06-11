import type { Command } from "commander";
import { buildOnboardSteps } from "../onboard/step-impls.js";
import type { OnboardCtx } from "../onboard/steps.js";
import { readlinePrompts, type Prompts } from "../onboard/prompts.js";

export interface RunOnboardOptions {
  harnessRoot: string;
  repoPath: string;
  projectId: string;
  isTTY: boolean;
  prompts: Prompts;
  /** output sink; defaults to process.stdout */
  print?: (line: string) => void;
}

export interface OnboardOutcome {
  completed: boolean;
  log: string[];
}

export async function runOnboard(opts: RunOnboardOptions): Promise<OnboardOutcome> {
  if (!opts.isTTY) {
    throw new Error(
      "harness onboard is interactive and needs a TTY. In a non-interactive shell, " +
        "run the steps directly: project inspect/init, project check, db import --from-files, " +
        "then edit .harness/mcp.yaml (see docs/specs/cli.md).",
    );
  }
  const print =
    opts.print ??
    ((s: string) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"));

  const ctx: OnboardCtx = {
    harnessRoot: opts.harnessRoot,
    repoPath: opts.repoPath,
    projectId: opts.projectId,
    prompts: opts.prompts,
    log: [],
    print,
  };
  const steps = buildOnboardSteps();
  for (const step of steps) {
    const status = step.probe(ctx);
    if (status === "done") {
      ctx.log.push(`✓ ${step.title} (already done)`);
      continue;
    }
    if (status === "blocked") {
      process.stdout.write(`✗ ${step.title}: blocked\n`);
      return { completed: false, log: ctx.log };
    }
    process.stdout.write(`▸ ${step.title}\n  ${step.describe(ctx)}\n`);
    const res = await step.run(ctx);
    process.stdout.write(`  ${res.ok ? "✓" : "✗"} ${res.message}\n`);
    if (!res.ok) {
      if (res.remediation !== undefined) process.stdout.write(`  → ${res.remediation}\n`);
      return { completed: false, log: ctx.log };
    }
  }
  process.stdout.write(`\nOnboarding complete for "${opts.projectId}".\n`);
  process.stdout.write(`\nSummary:\n`);
  for (const line of ctx.log) {
    process.stdout.write(`  ${line}\n`);
  }
  process.stdout.write(
    `\nNext steps:\n` +
      `  • If codex or gh were reported missing above, install/authenticate them first.\n` +
      `  • Start the MCP server: harness mcp serve --transport stdio\n`,
  );
  return { completed: true, log: ctx.log };
}

export function registerOnboardCommands(program: Command): void {
  program
    .command("onboard")
    .description("interactive wizard to onboard a new target repo (#92)")
    .requiredOption("--repo <path>", "target repo path")
    .requiredOption("--project-id <id>", "project id to create")
    .action(async (raw: Record<string, unknown>) => {
      try {
        const outcome = await runOnboard({
          harnessRoot: process.env.HARNESS_ROOT ?? process.cwd(),
          repoPath: String(raw.repo),
          projectId: String(raw.projectId),
          isTTY: process.stdin.isTTY === true,
          prompts: readlinePrompts(),
        });
        if (!outcome.completed) process.exit(1);
      } catch (e) {
        process.stderr.write(`harness error: ${(e as Error).message}\n`);
        process.exit(1);
      }
    });
}
