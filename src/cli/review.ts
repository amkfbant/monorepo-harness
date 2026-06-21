import process from "node:process";
import { existsSync } from "node:fs";
import type { Command } from "commander";
import { createCodexCliRunner } from "../codex/codex-cli-runner.js";
import { resolveAgentRunner } from "../core/agent-runner.js";
import { harnessPaths } from "../config/paths.js";
import { evaluateReviewer, compareDecisions, ReviewEvaluateError } from "../core/review-evaluator.js";
import { listReviews, formatTable, formatJson } from "../core/review-lister.js";
import { processReviewDecision, ReviewGateError } from "../core/review-processor.js";
import { runReviewerAgent, ReviewerAgentGateError } from "../core/reviewer-agent.js";
import { syncRunArtifactsToDb } from "../core/run-materialize.js";
import { StateConflictError, SourceModeError } from "../db/errors.js";
import { openManagedDb } from "../db/managed-connection.js";
import { OverrideReasonRequiredError, UnauthorizedOverrideError } from "../db/repositories/review-overrides.js";
import { ReviewProposalRepository, type ReviewProposalRow } from "../db/repositories/review-proposals.js";
import { ReviewerRepository, DuplicateReviewerError, UnknownReviewerError, InvalidReviewerMetadataError, reviewerLensMetadata } from "../db/repositories/reviewers.js";
import { RUN_STATUSES } from "../logging/run-log.js";
import { DomainLockBusyError } from "../workspace/db-domain-lock.js";

/**
 * `harness review`（list/process/auto/evaluate + nested proposals/reviewers + compare）を
 * run.ts から behavior-zero で抽出。nested subcommand の列挙順を保持。getHarnessRoot は
 * opts 経由で遅延解決。
 */
export function registerReviewCommands(
  program: Command,
  opts: { getHarnessRoot: () => string },
): void {
  const getHarnessRoot = opts.getHarnessRoot;
  const reviewCmd = program
    .command("review")
    .description("operate on review-decision.yaml under runs/<id>/");
  reviewCmd
    .command("list")
    .description(
      "list runs (default: needs_review + changes_requested の review queue)",
    )
    .option("--all", "include runs of every status", false)
    .option(
      "--status <status>",
      "comma-separated status filter (e.g. needs_review,failed-policy-violation)",
    )
    .option("--domain <domain>", "restrict to a single domain")
    .option("--limit <n>", "cap the number of rows")
    .option("--json", "emit JSON ({ validRuns, invalidRuns }) instead of a table", false)
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(getHarnessRoot());
      const opts: Parameters<typeof listReviews>[0] = {
        runsDir: paths.runsDir,
        all: Boolean(raw.all),
      };
      if (raw.status !== undefined) {
        const statuses = String(raw.status)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (statuses.length === 0) {
          process.stderr.write(
            "harness error: --status was empty; pass at least one status\n",
          );
          process.exit(1);
        }
        const unknown = statuses.filter(
          (s) => !(RUN_STATUSES as readonly string[]).includes(s),
        );
        if (unknown.length > 0) {
          process.stderr.write(
            `harness error: unknown --status value(s): ${unknown.join(", ")}\n` +
              `  valid: ${RUN_STATUSES.join(", ")}\n`,
          );
          process.exit(1);
        }
        opts.statuses = statuses;
      }
      if (raw.domain !== undefined) opts.domain = String(raw.domain);
      if (raw.limit !== undefined) {
        const n = Number(raw.limit);
        if (!Number.isInteger(n) || n < 0) {
          process.stderr.write(
            `harness error: --limit must be a non-negative integer (got ${JSON.stringify(String(raw.limit))})\n`,
          );
          process.exit(1);
        }
        opts.limit = n;
      }
      const result = await listReviews(opts);
      if (raw.json) {
        process.stdout.write(formatJson(result));
        return;
      }
      process.stdout.write(formatTable(result));
      // invalid run dirs are surfaced on stderr so they never pollute the
      // table (and so --json's stdout stays parseable).
      if (result.invalid.length > 0) {
        process.stderr.write(
          `warning: ${result.invalid.length} unreadable run dir(s) hidden; use --all or --json to inspect\n`,
        );
        if (Boolean(raw.all)) {
          for (const inv of result.invalid) {
            process.stderr.write(`  ${inv.runId}: ${inv.error}\n`);
          }
        }
      }
    });
  reviewCmd
    .command("process")
    .description("apply review-decision.yaml to meta.status")
    .requiredOption("--run-id <id>", "target run identifier")
    .option(
      "--override <decision>",
      "Phase 11-6: human override — approved|changes_requested|rejected",
    )
    .option(
      "--reason <text>",
      "Phase 11-6: override reason (required with --override)",
    )
    .option(
      "--actor-reviewer <id>",
      "Phase 11-6: actor reviewer_id (default: system)",
    )
    .action(async (raw: Record<string, unknown>) => {
      const harnessRoot = getHarnessRoot();
      const paths = harnessPaths(harnessRoot);
      let overrideOpts: {
        decision: "approved" | "changes_requested" | "rejected";
        reason: string;
        actorReviewerId?: string;
      } | undefined;
      if (raw.override !== undefined) {
        const dec = String(raw.override);
        if (
          dec !== "approved" &&
          dec !== "changes_requested" &&
          dec !== "rejected"
        ) {
          process.stderr.write(
            `harness error: --override must be one of approved|changes_requested|rejected (got ${JSON.stringify(dec)})\n`,
          );
          process.exit(1);
        }
        if (raw.reason === undefined) {
          process.stderr.write(
            "harness error: --reason is required when --override is supplied\n",
          );
          process.exit(1);
        }
        overrideOpts = {
          decision: dec,
          reason: String(raw.reason),
          ...(raw.actorReviewer !== undefined
            ? { actorReviewerId: String(raw.actorReviewer) }
            : {}),
        };
      }
      try {
        const result = await processReviewDecision({
          runsDir: paths.runsDir,
          locksDir: paths.locksDir,
          dbPath: paths.dbPath,
          runId: String(raw.runId),
          ...(overrideOpts !== undefined ? { override: overrideOpts } : {}),
        });
        for (const w of result.warnings) {
          process.stdout.write(`warning: ${w}\n`);
        }
        process.stdout.write(
          `run=${result.runId} ${result.previousStatus} → ${result.newStatus} reviewer=${result.reviewer ?? "(none)"} reviewedAt=${result.reviewedAt}\n`,
        );
      } catch (e) {
        // a guard failure (concurrent reviewer, source-mode mismatch) is
        // user-facing → exit 1, not an exit-2 unexpected error.
        if (
          e instanceof ReviewGateError ||
          e instanceof DomainLockBusyError ||
          e instanceof StateConflictError ||
          e instanceof SourceModeError ||
          e instanceof OverrideReasonRequiredError ||
          e instanceof UnauthorizedOverrideError ||
          e instanceof UnknownReviewerError
        ) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });
  reviewCmd
    .command("auto")
    .description(
      "invoke a codex reviewer agent that reads run artifacts (read-only) and writes review-decision.yaml",
    )
    .requiredOption("--run-id <id>", "target run identifier")
    .option(
      "--reviewer-name <name>",
      "stamped into review-decision.yaml.reviewer (default: codex-reviewer, " +
        "or claude-reviewer when HARNESS_REVIEWER_BACKEND=claude)",
    )
    .option(
      "--allow-overwrite",
      "replace review-decision.yaml even if it already has a non-pending decision",
      false,
    )
    .option(
      "--dry-run",
      "run codex and validate the output but do NOT write review-decision.yaml",
      false,
    )
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(getHarnessRoot());
      // separate codex instance with read-only sandbox; the agent must not
      // touch the worktree/runs files except by us writing review-decision
      // afterward.
      const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
      // #191: the reviewer may be claude (opt-in via HARNESS_REVIEWER_BACKEND).
      // read-only sandbox for codex; claude's read-only tool surface + cwd
      // boundary for claude. Backend threaded so the events redaction / usage
      // dispatch matches the runner.
      const { runner, backend: reviewerBackend } = resolveAgentRunner({
        role: "reviewer",
        codexBin,
        sandbox: "read-only",
      });
      const runId = String(raw.runId);
      const dryRun = Boolean(raw.dryRun);
      // re-ingest the run's artifacts so reviewer-agent logs / the decision
      // become DB-canonical too (Phase 8-13). Skipped for --dry-run, which
      // writes nothing.
      const syncArtifacts = (untrustedReviewerEventsPublished?: boolean): void => {
        if (!dryRun) {
          syncRunArtifactsToDb({
            dbPath: paths.dbPath,
            runsDir: paths.runsDir,
            runId,
            ...(untrustedReviewerEventsPublished !== undefined
              ? {
                  untrustedReviewerArtifacts: {
                    reviewerEventsPublished: untrustedReviewerEventsPublished,
                  },
                }
              : {}),
          });
        }
      };
      try {
        const result = await runReviewerAgent({
          runsDir: paths.runsDir,
          runId,
          dbPath: paths.dbPath,
          // #191: a claude reviewer must not be stored under the codex-reviewer
          // identity (which carries its own lens/trust config). Default the name
          // to the backend when the operator didn't pass --reviewer-name.
          ...(raw.reviewerName !== undefined
            ? { reviewerName: String(raw.reviewerName) }
            : reviewerBackend === "claude"
              ? { reviewerName: "claude-reviewer" }
              : {}),
          allowOverwrite: Boolean(raw.allowOverwrite),
          dryRun,
          codexRunner: runner,
          reviewerBackend,
        });
        syncArtifacts();
        process.stdout.write(
          `run=${result.runId} decision=${result.decision} reviewer=${result.reviewer} reviewedAt=${result.reviewedAt}\n`,
        );
        if (result.dryRun) {
          process.stdout.write(
            `note: --dry-run — review-decision.yaml was NOT written.\n`,
          );
        } else {
          process.stdout.write(
            `note: review proposal was recorded; run 'harness review process --run-id ${result.runId}' to apply.\n`,
          );
        }
      } catch (e) {
        if (e instanceof ReviewerAgentGateError) {
          // the gate path may have written review-auto-error.json — capture it
          syncArtifacts(e.reviewerEventsPublished);
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });
  reviewCmd
    .command("evaluate")
    .description(
      "run the reviewer agent N times against one run to observe verdict stability",
    )
    .requiredOption("--run-id <id>", "target run identifier")
    .option("--samples <n>", "number of reviewer samples", "3")
    .option("--reviewer-name <name>", "reviewer identity")
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(getHarnessRoot());
      const samples = Number(raw.samples);
      if (!Number.isInteger(samples) || samples < 1) {
        process.stderr.write(
          `harness error: --samples must be a positive integer (got ${JSON.stringify(String(raw.samples))})\n`,
        );
        process.exit(1);
      }
      const codexBin = process.env.HARNESS_CODEX_BIN ?? "codex";
      const runner = createCodexCliRunner({ codexBin, sandbox: "read-only" });
      try {
        const r = await evaluateReviewer({
          runsDir: paths.runsDir,
          runId: String(raw.runId),
          samples,
          codexRunner: runner,
          ...(existsSync(paths.dbPath) ? { dbPath: paths.dbPath } : {}),
          ...(raw.reviewerName !== undefined
            ? { reviewerName: String(raw.reviewerName) }
            : {}),
        });
        const dist = Object.entries(r.decisionCounts)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        process.stdout.write(
          `run=${r.runId} samples=${r.samples.length} ${dist}\n`,
        );
        for (const f of r.dangerFlags) {
          process.stderr.write(`danger: ${f}\n`);
        }
      } catch (e) {
        if (e instanceof ReviewEvaluateError) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });
  const proposalsCmd = reviewCmd
    .command("proposals")
    .description("review proposal lifecycle (Phase 11-7)");
  proposalsCmd
    .command("list")
    .description("list proposals for a run")
    .argument("<runId>", "target run id")
    .option("--include-archived", "include archived proposals", false)
    .action(async (runId: string, raw: Record<string, unknown>) => {
      const paths = harnessPaths(getHarnessRoot());
      const dbHandle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
      try {
        const rows = new ReviewProposalRepository(dbHandle.db).listForRun(
          runId,
          { includeArchived: Boolean(raw.includeArchived) },
        );
        if (rows.length === 0) {
          process.stdout.write("(none)\n");
          return;
        }
        for (const r of rows) {
          process.stdout.write(
            `  ${String(r.proposalId).padStart(4, "0")}\treviewer=${r.reviewer}\tdecision=${r.decision}\tlifecycle=${(r as ReviewProposalRow & { lifecycleStatus?: string }).lifecycleStatus ?? "?"}\treviewedAt=${r.reviewedAt}\n`,
          );
        }
      } finally {
        dbHandle.close();
      }
    });
  proposalsCmd
    .command("archive")
    .description("archive a single proposal (audit-preserving)")
    .argument("<proposalId>", "proposal id")
    .action(async (proposalId: string) => {
      const paths = harnessPaths(getHarnessRoot());
      const id = Number(proposalId);
      if (!Number.isInteger(id) || id <= 0) {
        process.stderr.write(
          `harness error: proposal id must be a positive integer (got ${JSON.stringify(proposalId)})\n`,
        );
        process.exit(1);
      }
      const dbHandle = openManagedDb({ dbPath: paths.dbPath });
      try {
        const ok = new ReviewProposalRepository(dbHandle.db).archive(id);
        process.stdout.write(
          ok
            ? `archived proposal_id=${id}\n`
            : `proposal_id=${id} already archived (no-op)\n`,
        );
      } finally {
        dbHandle.close();
      }
    });
  proposalsCmd
    .command("vacuum")
    .description("vacuum (archive) old superseded / processed / rejected_stale proposals")
    .requiredOption("--older-than <days>", "threshold in days (positive integer)")
    .option("--apply", "actually archive (default: dry-run)", false)
    .action(async (raw: Record<string, unknown>) => {
      const days = Number(raw.olderThan);
      if (!Number.isFinite(days) || days <= 0) {
        process.stderr.write(
          `harness error: --older-than must be a positive number of days (got ${JSON.stringify(String(raw.olderThan))})\n`,
        );
        process.exit(1);
      }
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const paths = harnessPaths(getHarnessRoot());
      const dbHandle = openManagedDb({ dbPath: paths.dbPath });
      try {
        const ids = new ReviewProposalRepository(dbHandle.db).vacuumOlderThan({
          olderThan: cutoff,
          apply: Boolean(raw.apply),
        });
        const verb = raw.apply ? "archived" : "would archive";
        process.stdout.write(
          `${verb} ${ids.length} proposal(s) older than ${cutoff.toISOString()}` +
            (ids.length > 0 ? ` — ids: ${ids.join(", ")}` : "") +
            "\n",
        );
        if (!raw.apply) {
          process.stdout.write("  (dry-run — use --apply to perform)\n");
        }
      } finally {
        dbHandle.close();
      }
    });

  const reviewersCmd = reviewCmd
    .command("reviewers")
    .description("review reviewer identity registry (Phase 11)");
  reviewersCmd
    .command("list")
    .description("list registered reviewers")
    .option("--group <id>", "only list reviewers in this group")
    .action(async (raw: Record<string, unknown>) => {
      const paths = harnessPaths(getHarnessRoot());
      if (!existsSync(paths.dbPath)) {
        process.stderr.write(
          "harness error: db not initialised — run 'harness db init'\n",
        );
        process.exit(1);
      }
      const dbHandle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
      try {
        const reviewers = new ReviewerRepository(dbHandle.db);
        const rows =
          raw.group !== undefined
            ? reviewers.listByGroup(String(raw.group))
            : reviewers.list();
        if (rows.length === 0) {
          process.stdout.write("(none)\n");
          return;
        }
        for (const r of rows) {
          const lens = reviewerLensMetadata(r);
          const lensPart = lens === null ? "" : `\tlens=${lens.lens}`;
          process.stdout.write(
            `  ${r.reviewerId}\ttype=${r.reviewerType}\tgroup=${r.groupId ?? "-"}\ttrust=${r.trustLevel}${lensPart}\t"${r.displayName}"\n`,
          );
        }
      } finally {
        dbHandle.close();
      }
    });
  reviewersCmd
    .command("add")
    .description("register a new reviewer")
    .argument("<reviewer_id>", "stable reviewer id (slug)")
    .requiredOption("--type <type>", "reviewer type: human|codex|external|system")
    .requiredOption("--display-name <name>", "human-readable display name")
    .option("--group <id>", "group id (humans / codex / security / ...)")
    .option(
      "--trust <level>",
      "advisory | normal | required | policy (default: normal)",
      "normal",
    )
    .option("--lens <axis>", "review lens axis for multi-lens consensus")
    .option(
      "--lens-prompt <text>",
      "untrusted reviewer prompt guidance for the selected lens",
    )
    .action(async (reviewerId: string, raw: Record<string, unknown>) => {
      const paths = harnessPaths(getHarnessRoot());
      if (!existsSync(paths.dbPath)) {
        process.stderr.write(
          "harness error: db not initialised — run 'harness db init'\n",
        );
        process.exit(1);
      }
      const type = String(raw.type);
      if (
        type !== "human" &&
        type !== "codex" &&
        type !== "external" &&
        type !== "system"
      ) {
        process.stderr.write(
          `harness error: --type must be one of human|codex|external|system (got ${JSON.stringify(type)})\n`,
        );
        process.exit(1);
      }
      const trust = String(raw.trust ?? "normal");
      if (
        trust !== "advisory" &&
        trust !== "normal" &&
        trust !== "required" &&
        trust !== "policy"
      ) {
        process.stderr.write(
          `harness error: --trust must be one of advisory|normal|required|policy (got ${JSON.stringify(trust)})\n`,
        );
        process.exit(1);
      }
      const dbHandle = openManagedDb({ dbPath: paths.dbPath });
      try {
        const metadata: Record<string, unknown> = {};
        if (raw.lens !== undefined) metadata.lens = String(raw.lens);
        if (raw.lensPrompt !== undefined) {
          metadata.lens_prompt = String(raw.lensPrompt);
        }
        const r = new ReviewerRepository(dbHandle.db).add({
          reviewerId,
          reviewerType: type,
          displayName: String(raw.displayName),
          ...(raw.group !== undefined ? { groupId: String(raw.group) } : {}),
          trustLevel: trust,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        });
        process.stdout.write(
          `added reviewer ${r.reviewerId} (type=${r.reviewerType}, trust=${r.trustLevel})\n`,
        );
      } catch (e) {
        if (
          e instanceof DuplicateReviewerError ||
          e instanceof InvalidReviewerMetadataError
        ) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      } finally {
        dbHandle.close();
      }
    });

  reviewCmd
    .command("compare")
    .description("compare two review-decision.yaml files (e.g. human vs agent)")
    .requiredOption("--human <path>", "human review-decision.yaml")
    .requiredOption("--agent <path>", "agent review-decision.yaml")
    .action(async (raw: Record<string, unknown>) => {
      try {
        const r = await compareDecisions({
          humanPath: String(raw.human),
          agentPath: String(raw.agent),
        });
        process.stdout.write(r.report);
        if (!r.decisionMatch) process.exit(1);
      } catch (e) {
        if (e instanceof ReviewEvaluateError) {
          process.stderr.write(`harness error: ${(e as Error).message}\n`);
          process.exit(1);
        }
        throw e;
      }
    });

  // Phase 8-7: `index.sqlite` and `harness index` were removed — the
  // harness.sqlite read model (`harness db import` / the dashboard)
  // superseded the Phase 3-5 listing cache. The command is kept one phase
  // as an explicit error stub so `harness index` does not silently 404;
  // any leftover scripts get a pointer to the replacement instead.
  program
    .command("index")
    .description("removed (Phase 8) — superseded by the harness.sqlite read model")
    .argument("[args...]", "ignored — kept only so the stub catches subcommands")
    .allowUnknownOption()
    .action(() => {
      process.stderr.write(
        "harness error: 'harness index' was removed (Phase 8); index.sqlite is " +
          "superseded by the harness.sqlite read model:\n" +
          "  harness db status            — read-model / DB status\n" +
          "  harness db check-consistency — verify the DB against exported files\n" +
          "  harness dashboard export     — derived run views\n",
      );
      process.exit(1);
    });
}
