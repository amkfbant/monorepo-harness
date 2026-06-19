import process from "node:process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations, readSchemaVersion } from "../db/migrations.js";
import { evaluateSchemaCompatibility } from "../db/schema-compat.js";
import { DbError } from "../db/connection.js";
import {
  startOperation,
  succeedOperation,
  failOperation,
} from "../db/repositories/operations.js";
import { ProjectError } from "../project/errors.js";
import { CourseRepository } from "../roadmap/course-repository.js";
import {
  CourseOrchestrateError,
  CourseOrchestrator,
} from "../roadmap/course-orchestrator.js";
import {
  normalizeCourseMaxDrivenHitches,
  normalizeCourseMaxStepsPerHitch,
} from "../roadmap/course-normalize.js";
import { CourseUserError } from "../roadmap/errors.js";
import { HitchValidationError } from "../hitch/types.js";
import { HitchRepository } from "../hitch/repository.js";
import {
  parseHitchCloseConditions,
  parseHitchPolicy,
  parseHitchScope,
} from "../hitch/schemas.js";
import { createProductionCourseOrchestrator } from "../roadmap/course-orchestrate-runtime.js";
import type {
  CourseOrchestrationResult,
  PhaseOutcome,
} from "../roadmap/orchestrator-types.js";
import {
  PhaseRepository,
  phaseSpecApprovalStatus,
} from "../roadmap/phase-repository.js";
import { rollupCourse, type CourseRollup } from "../roadmap/rollup.js";
import {
  COURSE_STATUSES,
  PHASE_STATUSES,
  type CourseStatus,
  type PhaseStatus,
} from "../roadmap/types.js";

export interface RegisterCourseCommandsOptions {
  getHarnessRoot: () => string;
}

class CourseCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseCliError";
  }
}

/**
 * Render a phase note onto a single Markdown line for `course export --md`.
 * Newlines are collapsed to spaces so a note cannot break out of the
 * `**Note**:` line and inject extra Markdown blocks/headings into the audit
 * export (the stored note stays verbatim for `--json` / the DB). #171b.
 */
export function noteForMarkdownLine(note: string): string {
  return note.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** User-fixable errors are explicit domain/CLI/configuration errors only. */
function courseError(e: unknown): never {
  if (
    e instanceof CourseCliError ||
    e instanceof CourseUserError ||
    e instanceof CourseOrchestrateError ||
    e instanceof ProjectError ||
    e instanceof DbError ||
    e instanceof HitchValidationError
  ) {
    process.stderr.write(`harness error: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

function withCourseErrorExit(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    courseError(e);
  }
}

async function withCourseOrchestrateErrorExit(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (
      e instanceof CourseCliError ||
      e instanceof CourseUserError ||
      e instanceof CourseOrchestrateError ||
      e instanceof ProjectError ||
      e instanceof DbError ||
      e instanceof HitchValidationError
    ) {
      process.stderr.write(`harness error: ${e.message}\n`);
      process.exit(1);
    }
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`harness error: ${message}\n`);
    process.exit(2);
  }
}

/** Opens, migrates, and closes the DB around a callback that receives the raw handle. */
function withCourseDb<T>(
  opts: RegisterCourseCommandsOptions,
  fn: (db: ReturnType<typeof openManagedDb>["db"]) => T,
): T {
  const root = opts.getHarnessRoot();
  const paths = harnessPaths(root);
  const handle = openManagedDb({ dbPath: paths.dbPath });
  try {
    runMigrations(handle.db);
    return fn(handle.db);
  } finally {
    handle.close();
  }
}

async function withCourseDbAsync<T>(
  opts: RegisterCourseCommandsOptions,
  fn: (db: ReturnType<typeof openManagedDb>["db"]) => Promise<T>,
): Promise<T> {
  const root = opts.getHarnessRoot();
  const paths = harnessPaths(root);
  const handle = openManagedDb({ dbPath: paths.dbPath });
  try {
    runMigrations(handle.db);
    return await fn(handle.db);
  } finally {
    handle.close();
  }
}

/**
 * Early schema-version-skew preflight for `course orchestrate` (#271). Opens a
 * read-only handle (shared lock — non-contending), reads the on-disk schema
 * version WITHOUT migrating, and throws a friendly, actionable
 * `CourseOrchestrateError` BEFORE any operation is started or hitch is leased
 * when the DB is newer than this harness. The `runMigrations` guard inside
 * `withCourseDbAsync` remains the fail-closed backstop.
 */
function assertCourseOrchestrateSchemaCompatible(
  opts: RegisterCourseCommandsOptions,
): void {
  const paths = harnessPaths(opts.getHarnessRoot());
  // A fresh/uninitialized harness root has no DB to be skewed against — skip the
  // read-only preflight and let the normal create+migrate path run (with the
  // runMigrations backstop). The read-only handle below requires the file to
  // exist (fileMustExist), so opening it on a fresh root would throw.
  if (!existsSync(paths.dbPath)) return;
  const handle = openManagedDb({ dbPath: paths.dbPath, readonly: true });
  try {
    const dbVersion = readSchemaVersion(handle.db);
    const compat = evaluateSchemaCompatibility(dbVersion);
    if (compat.kind === "db-newer-than-harness") {
      throw new CourseOrchestrateError("schema_version_skew", compat.message, {
        dbVersion: compat.dbVersion,
        harnessVersion: compat.harnessVersion,
        kind: compat.kind,
      });
    }
  } finally {
    handle.close();
  }
}

function withCourseRepo<T>(
  opts: RegisterCourseCommandsOptions,
  fn: (ctx: { courses: CourseRepository; phases: PhaseRepository }) => T,
): T {
  return withCourseDb(opts, (db) =>
    fn({ courses: new CourseRepository(db), phases: new PhaseRepository(db) }),
  );
}

function writeOutput(raw: Record<string, unknown>, value: unknown, text: string): void {
  process.stdout.write(raw.json === true ? `${JSON.stringify(value, null, 2)}\n` : text);
}

function readStructuredFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return JSON.parse(text) as unknown;
  return parseYaml(text) as unknown;
}

function parseChoice<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  flag: string,
): T[number] {
  const str = String(value);
  if (!(allowed as readonly string[]).includes(str)) {
    throw new CourseCliError(
      `${flag} must be one of ${allowed.join("|")} (got ${JSON.stringify(str)})`,
    );
  }
  return str as T[number];
}

function parseNonNegativeInt(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new CourseCliError(`${flag} must be a non-negative integer`);
  }
  return n;
}

function parsePositiveInt(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new CourseCliError(`${flag} must be a positive integer`);
  }
  return n;
}

interface CourseOrchestrateDryRunResult {
  courseId: string;
  dryRun: true;
  phaseOutcomes: PhaseOutcome[];
  drivenHitches: [];
  rollupAfter: CourseRollup;
  followUps: string[];
}

async function buildCourseOrchestrateDryRun(
  db: Database.Database,
  courseId: string,
  maxDrivenHitches: number,
  maxStepsPerHitch: number,
): Promise<CourseOrchestrateDryRunResult> {
  const orchestrator = new CourseOrchestrator({
    db,
    makeHitchOrchestrator: () => {
      throw new CourseCliError("dry-run plan must not drive hitches");
    },
    makeRunners: () => {
      throw new CourseCliError("dry-run plan must not prepare runners");
    },
  });
  const phaseOutcomes = await orchestrator.plan({
    courseId,
    maxDrivenHitches,
    maxStepsPerHitch,
  });
  return {
    courseId,
    dryRun: true,
    phaseOutcomes,
    drivenHitches: [],
    rollupAfter: rollupCourse({ db, courseId }),
    followUps: [],
  };
}

function operationErrorCode(e: unknown): string {
  if (e instanceof CourseOrchestrateError) return e.code;
  if (e instanceof CourseCliError) return "course_cli_error";
  if (e instanceof DbError) return "db_error";
  if (e instanceof ProjectError) return "project_error";
  return "driver_exception";
}

function writeCourseOrchestrateDryRunOutput(
  raw: Record<string, unknown>,
  result: CourseOrchestrateDryRunResult,
): void {
  if (raw.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [`course=${result.courseId} dryRun=true`];
  for (const outcome of result.phaseOutcomes) {
    lines.push(formatPhaseOutcome(outcome));
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function writeCourseOrchestrateOutput(
  raw: Record<string, unknown>,
  result: CourseOrchestrationResult,
): void {
  if (raw.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [
    `course=${result.courseId} stopReason=${result.stopReason}` +
      ` openP0=${result.rollupAfter.openP0} openP1=${result.rollupAfter.openP1}`,
  ];
  for (const outcome of result.phaseOutcomes) {
    lines.push(formatPhaseOutcome(outcome));
  }
  for (const followUp of result.followUps) {
    lines.push(`followUp=${followUp}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function formatPhaseOutcome(outcome: PhaseOutcome): string {
  const driven =
    outcome.drivenHitches !== undefined && outcome.drivenHitches.length > 0
      ? ` driven=${outcome.drivenHitches.map((h) => h.hitchId).join(",")}`
      : "";
  const blocked =
    outcome.blockedHitch !== undefined
      ? ` blockedHitch=${outcome.blockedHitch.hitchId}:${outcome.blockedHitch.decision}`
      : "";
  const ready =
    outcome.readyToClose === true ? " readyToClose=true" : "";
  const note = outcome.note !== undefined ? ` note=${outcome.note}` : "";
  return `phase=${outcome.phaseId} action=${outcome.action}${driven}${blocked}${ready}${note}`;
}

export function registerCourseCommands(
  program: Command,
  opts: RegisterCourseCommandsOptions,
): void {
  // ── course ──────────────────────────────────────────────────────────────────
  const courseCmd = program
    .command("course")
    .description("course roadmap management");

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

  // ── phase ──────────────────────────────────────────────────────────────────
  const phaseCmd = program
    .command("phase")
    .description("course phase management");

  phaseCmd
    .command("add")
    .description("add a phase to a course")
    .requiredOption("--course <id>", "course id")
    .option("--parent <phase-id>", "parent phase id")
    .requiredOption("--title <text>", "phase title")
    .option("--position <n>", "position (integer)")
    .option("--scope-file <path>", "YAML/JSON scope file")
    .option("--close-file <path>", "YAML/JSON close conditions file")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ phases }) =>
          phases.add({
            courseId: String(raw.course),
            ...(raw.parent !== undefined ? { parentPhaseId: String(raw.parent) } : {}),
            title: String(raw.title),
            ...(raw.position !== undefined
              ? { position: parseNonNegativeInt(raw.position, "--position") }
              : {}),
            ...(raw.scopeFile !== undefined
              ? { scope: readStructuredFile(String(raw.scopeFile)) }
              : {}),
            ...(raw.closeFile !== undefined
              ? { closeConditions: readStructuredFile(String(raw.closeFile)) }
              : {}),
            createdBy: String(raw.createdBy),
            createdSource: "cli",
          }),
        );
        writeOutput(raw, result, `phase=${result.phaseId} course=${result.courseId} status=${result.status}\n`);
      });
    });

  phaseCmd
    .command("list")
    .description("list phases for a course (tree order)")
    .requiredOption("--course <id>", "course id")
    .option("--json", "emit JSON", false)
    .action((raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const phases = withCourseRepo(opts, ({ courses, phases: repo }) => {
          const courseId = String(raw.course);
          courses.require(courseId);
          return repo.listForCourse(courseId);
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify({ phases }, null, 2)}\n`);
        } else {
          process.stdout.write(
            phases
              .map((p) => `${p.phaseId}\t${p.status}\t${p.title}`)
              .join("\n") + (phases.length > 0 ? "\n" : ""),
          );
        }
      });
    });

  phaseCmd
    .command("show")
    .description("show a phase with linked hitch ids")
    .argument("<id>", "phase id")
    .option("--json", "emit JSON", false)
    .action((id: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ phases }) => {
          const phase = phases.require(id);
          const hitchIds = phases.hitchIdsFor(id);
          return { phase, hitchIds };
        });
        writeOutput(
          raw,
          result,
          `phase=${result.phase.phaseId} status=${result.phase.status} title=${result.phase.title} hitches=${result.hitchIds.join(",") || "(none)"}\n`,
        );
      });
    });

  phaseCmd
    .command("update")
    .description("update a phase's status, scope/close files, or audit note")
    .argument("<id>", "phase id")
    .option("--status <s>", "new status (pending|in_progress|closed|blocked)")
    .option("--scope-file <path>", "replace scope with YAML/JSON file")
    .option("--close-file <path>", "replace close conditions with YAML/JSON file")
    .option("--allow-scope-widen", "allow a phase scope widening update")
    .option("--allow-gate-loosen", "allow a phase close-gate loosening update")
    .option(
      "--note <text>",
      "operator audit note (e.g. force-close reason / PR ref); shown in course export",
    )
    .action((id: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const newStatus =
          raw.status !== undefined
            ? (parseChoice(raw.status, PHASE_STATUSES, "--status") as PhaseStatus)
            : undefined;
        withCourseDb(opts, (db) => {
          const phases = new PhaseRepository(db);
          if (raw.scopeFile !== undefined || raw.closeFile !== undefined) {
            phases.updateSpec({
              phaseId: id,
              ...(raw.scopeFile !== undefined
                ? { scope: readStructuredFile(String(raw.scopeFile)) }
                : {}),
              ...(raw.closeFile !== undefined
                ? { closeConditions: readStructuredFile(String(raw.closeFile)) }
                : {}),
              allowScopeWiden: raw.allowScopeWiden === true,
              allowGateLoosen: raw.allowGateLoosen === true,
            });
          }
          if (newStatus !== undefined) {
            phases.setStatus(id, newStatus);
          }
          if (raw.note !== undefined) {
            phases.setNote(id, String(raw.note));
          }
          const updated = phases.require(id);
          process.stdout.write(`phase=${updated.phaseId} status=${updated.status}\n`);
        });
      });
    });

  phaseCmd
    .command("ratify")
    .description("record human approval for the phase spec")
    .argument("<id>", "phase id")
    .requiredOption("--approved-by <actor>", "approving operator")
    .option("--reason <text>", "approval reason")
    .option("--json", "emit JSON", false)
    .action((id: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ phases }) => {
          const phase = phases.recordSpecApproval(id, {
            approvedBy: String(raw.approvedBy),
            ...(raw.reason !== undefined ? { reason: String(raw.reason) } : {}),
          });
          return {
            phase,
            specApproval: phaseSpecApprovalStatus(phase),
          };
        });
        writeOutput(
          raw,
          result,
          `phase=${result.phase.phaseId} approvedBy=${result.specApproval.approval?.approvedBy ?? ""} specHash=${result.specApproval.currentSpecHash}\n`,
        );
      });
    });

  phaseCmd
    .command("link-hitch")
    .description("link a hitch to a phase")
    .argument("<phase-id>", "phase id")
    .argument("<hitch-id>", "hitch id")
    .option("--allow-scope-widen", "allow a ratified phase scope widening link")
    .option("--allow-gate-loosen", "allow a ratified phase close-gate loosening link")
    .option("--json", "emit JSON", false)
    .action((phaseId: string, hitchId: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseRepo(opts, ({ phases }) => {
          return phases.linkHitch(phaseId, hitchId, {
            allowScopeWiden: raw.allowScopeWiden === true,
            allowGateLoosen: raw.allowGateLoosen === true,
          });
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          for (const warning of result.warnings) {
            process.stdout.write(`warning: ${warning}\n`);
          }
          process.stdout.write(`linked hitch=${hitchId} to phase=${phaseId}\n`);
        }
      });
    });

  phaseCmd
    .command("start-hitch")
    .description("create a hitch from a phase and link it")
    .argument("<phase-id>", "phase id")
    .requiredOption("--title <text>", "hitch title")
    .option("--hitch-id <id>", "explicit hitch id")
    .option("--description <text>", "hitch description")
    .option("--domain <domain>", "hitch domain")
    .option("--backlog-item-id <id>", "source backlog item id")
    .option("--scope-file <path>", "YAML/JSON hitch scope override")
    .option("--close-file <path>", "YAML/JSON close conditions override")
    .option("--policy-file <path>", "YAML/JSON policy file")
    .option("--max-iterations <n>", "iteration budget")
    .option("--max-review-cycles <n>", "review cycle budget")
    .option("--max-reruns <n>", "rerun budget")
    .option("--max-total-new-findings <n>", "new finding budget")
    .option("--allow-scope-widen", "allow a ratified phase scope widening start")
    .option("--allow-gate-loosen", "allow a ratified phase close-gate loosening start")
    .option("--created-by <actor>", "actor label", "cli")
    .option("--json", "emit JSON", false)
    .action((phaseId: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const result = withCourseDb(opts, (db) => {
          const courses = new CourseRepository(db);
          const phases = new PhaseRepository(db);
          const hitches = new HitchRepository(db);
          const tx = db.transaction(() => {
            const phase = phases.require(phaseId);
            const course = courses.require(phase.courseId);
            const scope =
              raw.scopeFile === undefined
                ? parseHitchScope(phase.scope ?? {})
                : parseHitchScope(readStructuredFile(String(raw.scopeFile)));
            const closeConditions =
              raw.closeFile === undefined
                ? parseHitchCloseConditions(phase.closeConditions ?? [])
                : parseHitchCloseConditions(
                    readStructuredFile(String(raw.closeFile)),
                  );
            const hitch = hitches.createSession({
              ...(raw.hitchId !== undefined ? { hitchId: String(raw.hitchId) } : {}),
              title: String(raw.title),
              ...(raw.description !== undefined
                ? { description: String(raw.description) }
                : {}),
              ...(course.projectId !== null ? { projectId: course.projectId } : {}),
              ...(course.repoId !== null ? { repoId: course.repoId } : {}),
              ...(raw.domain !== undefined ? { domain: String(raw.domain) } : {}),
              ...(raw.backlogItemId !== undefined
                ? { backlogItemId: String(raw.backlogItemId) }
                : {}),
              scope,
              closeConditions,
              ...(raw.policyFile !== undefined
                ? { policy: parseHitchPolicy(readStructuredFile(String(raw.policyFile))) }
                : {}),
              ...(raw.maxIterations !== undefined
                ? { maxIterations: parsePositiveInt(raw.maxIterations, "--max-iterations") }
                : {}),
              ...(raw.maxReviewCycles !== undefined
                ? {
                    maxReviewCycles: parsePositiveInt(
                      raw.maxReviewCycles,
                      "--max-review-cycles",
                    ),
                  }
                : {}),
              ...(raw.maxReruns !== undefined
                ? { maxReruns: parseNonNegativeInt(raw.maxReruns, "--max-reruns") }
                : {}),
              ...(raw.maxTotalNewFindings !== undefined
                ? {
                    maxTotalNewFindings: parseNonNegativeInt(
                      raw.maxTotalNewFindings,
                      "--max-total-new-findings",
                    ),
                  }
                : {}),
              createdBy: String(raw.createdBy),
              createdSource: "cli",
            });
            const link = phases.linkHitch(phaseId, hitch.hitchId, {
              allowScopeWiden: raw.allowScopeWiden === true,
              allowGateLoosen: raw.allowGateLoosen === true,
            });
            return { phaseId, hitch, link, warnings: link.warnings };
          });
          return tx.immediate();
        });
        if (raw.json === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          for (const warning of result.warnings) {
            process.stdout.write(`warning: ${warning}\n`);
          }
          process.stdout.write(
            `hitch=${result.hitch.hitchId} phase=${phaseId} linked\n`,
          );
        }
      });
    });

  phaseCmd
    .command("unlink-hitch")
    .description("unlink a hitch from its phase")
    .argument("<hitch-id>", "hitch id")
    .action((hitchId: string) => {
      withCourseErrorExit(() => {
        const removed = withCourseRepo(opts, ({ phases }) =>
          phases.unlinkHitch(hitchId),
        );
        process.stdout.write(
          removed
            ? `unlinked hitch=${hitchId}\n`
            : `no link for hitch=${hitchId}\n`,
        );
      });
    });
}
