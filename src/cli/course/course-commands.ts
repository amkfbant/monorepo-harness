import process from "node:process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import { harnessPaths } from "../../config/paths.js";
import { startOperation, succeedOperation, failOperation } from "../../db/repositories/operations.js";
import { CourseRepository } from "../../roadmap/course-repository.js";
import { CourseOrchestrateError } from "../../roadmap/course-orchestrator.js";
import { normalizeCourseMaxDrivenHitches, normalizeCourseMaxStepsPerHitch } from "../../roadmap/course-normalize.js";
import { createProductionCourseOrchestrator } from "../../roadmap/course-orchestrate-runtime.js";
import { rollupCourse } from "../../roadmap/rollup.js";
import { COURSE_STATUSES, type CourseStatus } from "../../roadmap/types.js";
import { noteForMarkdownLine, withCourseErrorExit, withCourseOrchestrateErrorExit, withCourseDb, withCourseDbAsync, assertCourseOrchestrateSchemaCompatible, withCourseRepo, writeOutput, parseChoice, parsePositiveInt, buildCourseOrchestrateDryRun, operationErrorCode, writeCourseOrchestrateDryRunOutput, writeCourseOrchestrateOutput, CourseCliError, type RegisterCourseCommandsOptions } from "./helpers.js";
import { ingestClaudeSubagentUsage } from "../../telemetry/ingest-claude-subagent-usage.js";

/**
 * `harness course` サブコマンド（#125 A15: cli/course.ts から behaviour-zero 分割）。
 * create / list / show / status / orchestrate / pause / resume / close / export。
 * registration 順は golden で凍結。共有 helper は ./helpers から。
 */
export function registerCourseSubcommands(
  courseCmd: Command,
  opts: RegisterCourseCommandsOptions,
): void {
  courseCmd
    .command("create")
    .description("create a course")
    .requiredOption("--title <text>", "course title")
    .option("--description <text>", "course description")
    .option("--project <id>", "project id")
    .option("--repo-id <id>", "repo id")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ courses }) =>
          courses.create({
            title: String(raw.title),
            ...(raw.description !== undefined ? { description: String(raw.description) } : {}),
            ...(raw.project !== undefined ? { projectId: String(raw.project) } : {}),
            ...(raw.repoId !== undefined ? { repoId: String(raw.repoId) } : {}),
            createdBy: String(raw.createdBy),
            createdSource: "cli",
          }),
        );
        writeOutput(raw, result, `course=${result.courseId} status=${result.status}\n`);
      });
    });

  courseCmd
    .command("list")
    .description("list courses")
    .option("--status <s>", "filter by status (active|paused|closed)")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const status =
          raw.status !== undefined
            ? (parseChoice(raw.status, COURSE_STATUSES, "--status") as CourseStatus)
            : undefined;
        const rows = withCourseRepo(opts, ({ courses }) =>
          courses.list({
            ...(status !== undefined ? { status } : {}),
          }),
        );
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify({ courses: rows }, null, 2)}\n`);
        } else {
          process.stdout.write(
            rows.map((c) => `${c.courseId}\t${c.status}\t${c.title}`).join("\n") +
              (rows.length > 0 ? "\n" : ""),
          );
        }
      });
    });

  courseCmd
    .command("show")
    .description("show a course")
    .argument("<id>", "course id")
    .option("--json", "emit JSON", false)
    .action((id: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ courses }) => courses.require(id));
        writeOutput(raw, result, `course=${result.courseId} status=${result.status} title=${result.title}\n`);
      });
    });

  courseCmd
    .command("status")
    .description("show course rollup (phase tree + open P0/P1)")
    .argument("<id>", "course id")
    .option("--json", "emit JSON", false)
    .action((id: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const rollup = withCourseDb(opts, (db) => {
          new CourseRepository(db).require(id);
          return rollupCourse({ db, courseId: id });
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(rollup, null, 2)}\n`);
        } else {
          const tt = rollup.tokenTotals;
          const tokenSuffix =
            tt.runsWithUsage === 0
              ? ""
              : ` tokens=${tt.totalTokens}` +
                ` (coder=${tt.byKind.coder.totalTokens}` +
                ` reviewer=${tt.byKind.reviewer.totalTokens}` +
                ` evaluator=${tt.byKind.evaluator.totalTokens})`;
          const lines: string[] = [
            `course=${rollup.courseId} openP0=${rollup.openP0} openP1=${rollup.openP1}` +
              tokenSuffix,
          ];
          for (const p of rollup.phases) {
            const indent = "  ".repeat(p.depth);
            lines.push(
              `${indent}phase=${p.phaseId} title=${JSON.stringify(p.title)} status=${p.declaredStatus}` +
                ` openP0=${p.derivedOpenP0} openP1=${p.derivedOpenP1}` +
                ` readyToClose=${p.readyToClose}` +
                (p.latestDecision !== null ? ` decision=${p.latestDecision}` : ""),
            );
          }
          process.stdout.write(lines.join("\n") + "\n");
        }
      });
    });

  courseCmd
    .command("orchestrate")
    .description("drive linked hitches in phase-tree order")
    .argument("<course-id>", "course id")
    .option("--max-driven-hitches <n>", "max hitches to drive in this pass", "3")
    .option("--max-steps-per-hitch <n>", "max hitch orchestrator steps per hitch", "20")
    .option("--dry-run", "print phase actions only; do not lease, write, or drive", false)
    .option("--json", "emit JSON", false)
    .action(async (courseId: string, raw: Record<string, unknown>) => {
      await withCourseOrchestrateErrorExit(async () => {
        // #271: surface DB-newer-than-harness skew with friendly, actionable
        // guidance BEFORE the operation is started (no spurious operation row).
        assertCourseOrchestrateSchemaCompatible(opts);
        const maxDrivenHitches = normalizeCourseMaxDrivenHitches(
          parsePositiveInt(raw.maxDrivenHitches ?? 3, "--max-driven-hitches"),
        );
        const maxStepsPerHitch = normalizeCourseMaxStepsPerHitch(
          parsePositiveInt(raw.maxStepsPerHitch ?? 20, "--max-steps-per-hitch"),
        );
        if (raw.dryRun === true) {
          const result = await withCourseDbAsync(opts, (db) =>
            buildCourseOrchestrateDryRun(
              db,
              courseId,
              maxDrivenHitches,
              maxStepsPerHitch,
            ),
          );
          writeCourseOrchestrateDryRunOutput(raw, result);
          return;
        }

        const result = await withCourseDbAsync(opts, async (db) => {
          const courses = new CourseRepository(db);
          const course = courses.require(courseId);
          const operationId = `op-${randomUUID()}`;
          startOperation(db, {
            operationId,
            operationType: "course.orchestrate",
            targetType: "course",
            targetId: courseId,
            actor: "cli",
            dryRun: false,
            input: {
              courseId,
              maxDrivenHitches,
              maxStepsPerHitch,
            },
          });
          try {
            if (course.status !== "active") {
              throw new CourseOrchestrateError(
                "course_not_active",
                `course ${courseId} is not active (${course.status})`,
                { courseId, status: course.status },
              );
            }
            const dbPath = harnessPaths(opts.getHarnessRoot()).dbPath;
            const createdBy = `course-orchestrate:${course.courseId}`;
            const orchestrated = await createProductionCourseOrchestrator({
              db,
              dbPath,
              harnessRoot: opts.getHarnessRoot(),
              courseId: course.courseId,
              courseProjectId: course.projectId,
              createdBy,
            }).run({
              courseId,
              maxDrivenHitches,
              maxStepsPerHitch,
              createdBy,
            });
            succeedOperation(db, operationId, orchestrated);
            return orchestrated;
          } catch (e) {
            failOperation(
              db,
              operationId,
              operationErrorCode(e),
              e instanceof Error ? e.message : String(e),
            );
            throw e;
          }
        });

        writeCourseOrchestrateOutput(raw, result);
        // Fail-open telemetry: record ops-driven Claude subagent usage after the pass.
        // MUST never throw here — orchestrate already succeeded and output was written.
        ingestClaudeSubagentUsage({
          harnessRoot: opts.getHarnessRoot(),
          ...(process.env.HARNESS_CLAUDE_PROJECTS_DIR !== undefined
            ? { claudeProjectDir: process.env.HARNESS_CLAUDE_PROJECTS_DIR }
            : {}),
        });
      });
    });

  courseCmd
    .command("pause")
    .description("pause a course")
    .argument("<id>", "course id")
    .action((id: string) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ courses }) =>
          courses.setStatus(id, "paused"),
        );
        process.stdout.write(`course=${result.courseId} status=${result.status}\n`);
      });
    });

  courseCmd
    .command("resume")
    .description("resume a paused course")
    .argument("<id>", "course id")
    .action((id: string) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ courses }) =>
          courses.setStatus(id, "active"),
        );
        process.stdout.write(`course=${result.courseId} status=${result.status}\n`);
      });
    });

  courseCmd
    .command("close")
    .description("close a course")
    .argument("<id>", "course id")
    .action((id: string) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ courses }) =>
          courses.setStatus(id, "closed"),
        );
        process.stdout.write(`course=${result.courseId} status=${result.status}\n`);
      });
    });

  courseCmd
    .command("export")
    .description("export course as markdown")
    .argument("<id>", "course id")
    .option("--md", "render as markdown", false)
    .option("--out <path>", "output file (defaults to stdout)")
    .action((id: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        if (raw.md !== true) {
          throw new CourseCliError("course export requires --md");
        }
        const md = withCourseDb(opts, (db) => {
          const courses = new CourseRepository(db);
          const course = courses.require(id);
          const rollup = rollupCourse({ db, courseId: id });
          const lines: string[] = [`# Course: ${course.title}`, ""];
          if (course.description) {
            lines.push(course.description, "");
          }
          lines.push(
            `**Status**: ${course.status}  `,
            `**Open P0**: ${rollup.openP0}  `,
            `**Open P1**: ${rollup.openP1}  `,
            "",
          );
          for (const p of rollup.phases) {
            const level = p.depth + 2; // ## for depth 0, ### for depth 1 …
            const heading = "#".repeat(Math.min(level, 6));
            lines.push(`${heading} ${p.title}`, "");
            lines.push(
              `**Status**: ${p.declaredStatus}  `,
              `**Open P0**: ${p.derivedOpenP0}  `,
              `**Open P1**: ${p.derivedOpenP1}  `,
            );
            if (p.latestDecision !== null) {
              lines.push(`**Latest Decision**: ${p.latestDecision}  `);
            }
            if (p.note !== null) {
              lines.push(`**Note**: ${noteForMarkdownLine(p.note)}  `);
            }
            if (p.hitchIds.length > 0) {
              lines.push(`**Hitches**: ${p.hitchIds.join(", ")}  `);
            }
            lines.push("");
          }
          return lines.join("\n");
        });
        if (typeof raw.out === "string" && raw.out !== "") {
          writeFileSync(raw.out, md, "utf8");
          process.stdout.write(`wrote ${raw.out}\n`);
        } else {
          process.stdout.write(md);
        }
      });
    });
}
