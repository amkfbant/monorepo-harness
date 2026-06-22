import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { harnessPaths } from "../../config/paths.js";
import { openManagedDb } from "../../db/managed-connection.js";
import { runMigrations, readSchemaVersion } from "../../db/migrations.js";
import { evaluateSchemaCompatibility } from "../../db/schema-compat.js";
import { DbError } from "../../db/connection.js";
import { ProjectError } from "../../project/errors.js";
import { CourseRepository } from "../../roadmap/course-repository.js";
import { CourseOrchestrateError, CourseOrchestrator } from "../../roadmap/course-orchestrator.js";
import { CourseUserError } from "../../roadmap/errors.js";
import { HitchValidationError } from "../../hitch/types.js";
import { type CourseOrchestrationResult, type PhaseOutcome } from "../../roadmap/orchestrator-types.js";
import { PhaseRepository } from "../../roadmap/phase-repository.js";
import { rollupCourse, type CourseRollup } from "../../roadmap/rollup.js";

/**
 * `harness course` / `harness phase` CLI の共有ヘルパー（#125 A15: cli/course.ts から
 * behaviour-zero 分割）。course と phase の両 command group が使う DB wrapper /
 * orchestrate dry-run / 出力整形 / parse ヘルパーと、型・エラークラスを集約。helper は
 * opts(getHarnessRoot) を引数で受ける（モジュール内で再定義しない）。
 */
export interface RegisterCourseCommandsOptions {
  getHarnessRoot: () => string;
}

export class CourseCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseCliError";
  }
}

// #171b sanitizer. Moved to the pure `reporter/markdown-line.ts` so the pure
// summary renderers (#84) can share the canonical impl without importing the
// CLI/DB graph; re-exported here to preserve this module's public surface
// (course-commands.ts and the `src/cli/course.js` re-export both consume it).
export { noteForMarkdownLine } from "../../reporter/markdown-line.js";

/** User-fixable errors are explicit domain/CLI/configuration errors only. */
export function courseError(e: unknown): never {
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

export function withCourseErrorExit(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    courseError(e);
  }
}

export async function withCourseOrchestrateErrorExit(fn: () => Promise<void>): Promise<void> {
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
export function withCourseDb<T>(
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

export async function withCourseDbAsync<T>(
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
export function assertCourseOrchestrateSchemaCompatible(
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

export function withCourseRepo<T>(
  opts: RegisterCourseCommandsOptions,
  fn: (ctx: { courses: CourseRepository; phases: PhaseRepository }) => T,
): T {
  return withCourseDb(opts, (db) =>
    fn({ courses: new CourseRepository(db), phases: new PhaseRepository(db) }),
  );
}

export function writeOutput(raw: Record<string, unknown>, value: unknown, text: string): void {
  process.stdout.write(raw.json === true ? `${JSON.stringify(value, null, 2)}\n` : text);
}

export function readStructuredFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return JSON.parse(text) as unknown;
  return parseYaml(text) as unknown;
}

export function parseChoice<T extends readonly string[]>(
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

export function parseNonNegativeInt(value: unknown, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new CourseCliError(`${flag} must be a non-negative integer`);
  }
  return n;
}

export function parsePositiveInt(value: unknown, flag: string): number {
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

export async function buildCourseOrchestrateDryRun(
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

export function operationErrorCode(e: unknown): string {
  if (e instanceof CourseOrchestrateError) return e.code;
  if (e instanceof CourseCliError) return "course_cli_error";
  if (e instanceof DbError) return "db_error";
  if (e instanceof ProjectError) return "project_error";
  return "driver_exception";
}

export function writeCourseOrchestrateDryRunOutput(
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

export function writeCourseOrchestrateOutput(
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

export function formatPhaseOutcome(outcome: PhaseOutcome): string {
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

