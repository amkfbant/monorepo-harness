import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { harnessPaths } from "../config/paths.js";
import { openManagedDb } from "../db/managed-connection.js";
import { runMigrations } from "../db/migrations.js";
import { DbError } from "../db/connection.js";
import { CourseRepository } from "../roadmap/course-repository.js";
import { PhaseRepository } from "../roadmap/phase-repository.js";
import { rollupCourse } from "../roadmap/rollup.js";
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

/** User-fixable errors: typed CLI errors, DB errors, and common "not found" / constraint messages. */
function courseError(e: unknown): never {
  if (e instanceof CourseCliError || e instanceof DbError) {
    process.stderr.write(`harness error: ${e.message}\n`);
    process.exit(1);
  }
  if (
    e instanceof Error &&
    /not found|different course|already linked|project/i.test(e.message)
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
          const lines: string[] = [
            `course=${rollup.courseId} openP0=${rollup.openP0} openP1=${rollup.openP1}`,
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
    .description("update a phase's status or scope/close files")
    .argument("<id>", "phase id")
    .option("--status <s>", "new status (pending|in_progress|closed|blocked)")
    .option("--scope-file <path>", "replace scope with YAML/JSON file")
    .option("--close-file <path>", "replace close conditions with YAML/JSON file")
    .action((id: string, raw: Record<string, unknown>) => {
      withCourseErrorExit(() => {
        const newStatus =
          raw.status !== undefined
            ? (parseChoice(raw.status, PHASE_STATUSES, "--status") as PhaseStatus)
            : undefined;
        withCourseDb(opts, (db) => {
          const phases = new PhaseRepository(db);
          if (newStatus !== undefined) {
            phases.setStatus(id, newStatus);
          }
          if (raw.scopeFile !== undefined || raw.closeFile !== undefined) {
            db.prepare(
              `UPDATE phases SET
                 scope_json = COALESCE(?, scope_json),
                 close_conditions_json = COALESCE(?, close_conditions_json),
                 updated_at = ?
               WHERE phase_id = ?`,
            ).run(
              raw.scopeFile !== undefined
                ? JSON.stringify(readStructuredFile(String(raw.scopeFile)))
                : null,
              raw.closeFile !== undefined
                ? JSON.stringify(readStructuredFile(String(raw.closeFile)))
                : null,
              new Date().toISOString(),
              id,
            );
          }
          const updated = phases.require(id);
          process.stdout.write(`phase=${updated.phaseId} status=${updated.status}\n`);
        });
      });
    });

  phaseCmd
    .command("link-hitch")
    .description("link a hitch to a phase")
    .argument("<phase-id>", "phase id")
    .argument("<hitch-id>", "hitch id")
    .action((phaseId: string, hitchId: string) => {
      withCourseErrorExit(() => {
        withCourseRepo(opts, ({ phases }) => {
          phases.linkHitch(phaseId, hitchId);
        });
        process.stdout.write(`linked hitch=${hitchId} to phase=${phaseId}\n`);
      });
    });

  phaseCmd
    .command("unlink-hitch")
    .description("unlink a hitch from its phase")
    .argument("<hitch-id>", "hitch id")
    .action((hitchId: string) => {
      withCourseErrorExit(() => {
        withCourseRepo(opts, ({ phases }) => {
          phases.unlinkHitch(hitchId);
        });
        process.stdout.write(`unlinked hitch=${hitchId}\n`);
      });
    });
}
