import { createHash } from "node:crypto";
import { CourseRepository } from "../../roadmap/course-repository.js";
import { PhaseRepository } from "../../roadmap/phase-repository.js";
import { rollupCourse } from "../../roadmap/rollup.js";
import { errorResult, ok, type HarnessMcpToolResult } from "../schemas/outputs.js";
import type { McpToolContext } from "../registry/tool-registry.js";
import { ensureProjectVisible, withReadonlyDb } from "./tool-helpers.js";
import { runMcpMutationOperation } from "./operation-wrapper.js";
import type { CourseStatus, PhaseStatus } from "../../roadmap/types.js";

// ---------------------------------------------------------------------------
// Arg types
// ---------------------------------------------------------------------------

export interface CourseListArgs {
  status?: CourseStatus;
  projectId?: string;
  limit?: number;
}

export interface CourseIdArgs {
  courseId: string;
}

export interface PhaseIdArgs {
  phaseId: string;
}

export interface CourseCreateArgs {
  title: string;
  description?: string;
  projectId?: string;
  repoId?: string;
  idempotencyKey: string;
  actorNote?: string;
}

export interface PhaseAddArgs {
  courseId: string;
  title: string;
  parentPhaseId?: string;
  position?: number;
  scope?: unknown;
  closeConditions?: unknown;
  idempotencyKey: string;
  actorNote?: string;
}

export interface PhaseUpdateArgs {
  phaseId: string;
  status?: PhaseStatus;
  idempotencyKey: string;
  actorNote?: string;
}

export interface PhaseLinkHitchArgs {
  phaseId: string;
  hitchId: string;
  idempotencyKey: string;
  actorNote?: string;
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

export function courseListTool(
  args: CourseListArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  if (args.projectId !== undefined) {
    const denied = ensureProjectVisible(context.config, args.projectId);
    if (denied !== null) return denied;
  }
  return withReadonlyDb(context, ({ db }) => {
    const repo = new CourseRepository(db);
    const limit = args.limit ?? 50;
    const baseFilter = {
      ...(args.status !== undefined ? { status: args.status } : {}),
    };

    let courses;
    if (args.projectId !== undefined) {
      // explicit projectId filter (already visibility-checked above)
      courses = repo.list({ ...baseFilter, projectIds: [args.projectId] });
    } else if (context.config.allowedProjects.length > 0) {
      // project-restricted client: only show courses within allowed projects
      // fail-closed: null-project courses are invisible
      courses = repo.list({
        ...baseFilter,
        projectIds: context.config.allowedProjects,
      });
    } else {
      // unscoped client: show all
      courses = repo.list(baseFilter);
    }

    return ok("courses", { courses: courses.slice(0, limit) });
  }) as HarnessMcpToolResult;
}

export function courseGetTool(
  args: CourseIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new CourseRepository(db);
    const course = repo.get(args.courseId);
    if (course === null) return errorResult(`course not found: ${args.courseId}`);
    const denied = ensureProjectVisible(context.config, course.projectId);
    if (denied !== null) return denied;
    return ok("course", { course });
  }) as HarnessMcpToolResult;
}

export function courseStatusTool(
  args: CourseIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const repo = new CourseRepository(db);
    const course = repo.get(args.courseId);
    if (course === null) return errorResult(`course not found: ${args.courseId}`);
    const denied = ensureProjectVisible(context.config, course.projectId);
    if (denied !== null) return denied;
    try {
      const rollup = rollupCourse({ db, courseId: args.courseId });
      return ok("course status", { course, rollup });
    } catch (e) {
      return errorResult((e as Error).message);
    }
  }) as HarnessMcpToolResult;
}

export function phaseListTool(
  args: CourseIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const courseRepo = new CourseRepository(db);
    const course = courseRepo.get(args.courseId);
    if (course === null) return errorResult(`course not found: ${args.courseId}`);
    const denied = ensureProjectVisible(context.config, course.projectId);
    if (denied !== null) return denied;
    const phaseRepo = new PhaseRepository(db);
    const phases = phaseRepo.listForCourse(args.courseId);
    return ok("phases", { phases });
  }) as HarnessMcpToolResult;
}

export function phaseGetTool(
  args: PhaseIdArgs,
  context: McpToolContext,
): HarnessMcpToolResult {
  return withReadonlyDb(context, ({ db }) => {
    const phaseRepo = new PhaseRepository(db);
    const phase = phaseRepo.get(args.phaseId);
    if (phase === null) return errorResult(`phase not found: ${args.phaseId}`);
    // Enforce project visibility via the parent course
    const courseRepo = new CourseRepository(db);
    const course = courseRepo.get(phase.courseId);
    const denied = ensureProjectVisible(context.config, course?.projectId ?? null);
    if (denied !== null) return denied;
    return ok("phase", { phase });
  }) as HarnessMcpToolResult;
}

// ---------------------------------------------------------------------------
// resolveProjectId helpers (for tool-registry permission checks)
// ---------------------------------------------------------------------------

export function resolveCourseProjectId(
  args: { courseId?: string },
  context: McpToolContext,
): string | null | undefined {
  if (args.courseId === undefined) return undefined;
  const unresolved =
    context.config.allowedProjects.length > 0
      ? "__mcp_unresolved_course_project__"
      : undefined;
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare("SELECT project_id FROM courses WHERE course_id = ?")
      .get(args.courseId) as { project_id: string | null } | undefined;
    return row?.project_id ?? unresolved;
  }) as string | null | undefined;
}

export function resolvePhaseProjectId(
  args: { phaseId?: string },
  context: McpToolContext,
): string | null | undefined {
  if (args.phaseId === undefined) return undefined;
  const unresolved =
    context.config.allowedProjects.length > 0
      ? "__mcp_unresolved_phase_project__"
      : undefined;
  return withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare(
        `SELECT c.project_id
           FROM phases p
           JOIN courses c ON c.course_id = p.course_id
          WHERE p.phase_id = ?`,
      )
      .get(args.phaseId) as { project_id: string | null } | undefined;
    return row?.project_id ?? unresolved;
  }) as string | null | undefined;
}

// ---------------------------------------------------------------------------
// Deterministic id derivation (idempotency — mirrors hitchIdForIdempotencyKey)
// ---------------------------------------------------------------------------

// The OperationRunner replay key is (operation_type, target_id, idempotency_key)
// with NO project/client dimension. Hashing the idempotencyKey alone would let two
// clients in different projects (or under different courses) that reuse the same
// idempotencyKey collide on target_id → the second create is treated as a replay
// of the first and returns the OTHER resource (cross-project leak). We therefore
// fold the resource scope into the hashed material: a course is scoped by its
// project, a phase by its parent course. A NUL separator keeps the scope and key
// unambiguous (NUL cannot appear in either value).
function scopedIdForIdempotencyKey(
  prefix: string,
  scope: string | null,
  idempotencyKey: string,
): string {
  const material = `${scope ?? " null-scope"} ${idempotencyKey}`;
  const digest = createHash("sha256").update(material).digest("hex");
  return `${prefix}-${digest.slice(0, 32)}`;
}

function courseIdForIdempotencyKey(
  projectScope: string | null,
  idempotencyKey: string,
): string {
  return scopedIdForIdempotencyKey("course", projectScope, idempotencyKey);
}

function phaseIdForIdempotencyKey(
  courseScope: string,
  idempotencyKey: string,
): string {
  return scopedIdForIdempotencyKey("phase", courseScope, idempotencyKey);
}

// ---------------------------------------------------------------------------
// Mutation tools
// ---------------------------------------------------------------------------

function courseMetadata(
  context: McpToolContext,
  toolName: string,
  args: { idempotencyKey: string; actorNote?: string },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source: "mcp",
    clientName: context.clientName,
    sessionId: context.sessionId,
    toolName,
    idempotencyKey: args.idempotencyKey,
    ...(args.actorNote !== undefined ? { actorNote: args.actorNote } : {}),
    ...extra,
  };
}

export async function courseCreateTool(
  args: CourseCreateArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  const denied = ensureProjectVisible(context.config, args.projectId ?? null);
  if (denied !== null) return denied;
  // Derive a stable courseId from the idempotency key so that retrying the same
  // call with the same idempotencyKey produces the same target.id and is correctly
  // treated as an idempotency replay (not a duplicate row with a new random id).
  const courseId = courseIdForIdempotencyKey(
    args.projectId ?? null,
    args.idempotencyKey,
  );
  return runMcpMutationOperation(context, {
    operationType: "course.create",
    target: { type: "course", id: courseId },
    args,
    metadata: courseMetadata(context, "harness.course.create", args, { courseId }),
    workWithDb: async (db) => {
      const repo = new CourseRepository(db);
      const course = repo.create({
        courseId,
        title: args.title,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
        ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
        createdBy: `mcp:${context.clientName}`,
        createdSource: "mcp",
      });
      return { courseId: course.courseId, course };
    },
  });
}

export async function phaseAddTool(
  args: PhaseAddArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  // Resolve visibility of the parent course BEFORE entering runMcpMutationOperation so
  // a denied call returns permission_denied (not a generic error thrown inside workWithDb).
  const visibilityResult = withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare("SELECT project_id FROM courses WHERE course_id = ?")
      .get(args.courseId) as { project_id: string | null } | undefined;
    if (row === undefined) return errorResult(`course ${args.courseId} not found`);
    return ensureProjectVisible(context.config, row.project_id);
  });
  // withReadonlyDb returns a tool result directly when the DB is missing.
  // ensureProjectVisible returns null (ok) or a permission_denied result.
  // errorResult returns a tool result.
  if (visibilityResult !== null) return visibilityResult as HarnessMcpToolResult;

  // Derive a stable phaseId from the idempotency key so that retrying the same
  // call with the same idempotencyKey produces the same target.id and is correctly
  // treated as an idempotency replay (not a duplicate row with a new random id).
  const phaseId = phaseIdForIdempotencyKey(args.courseId, args.idempotencyKey);
  return runMcpMutationOperation(context, {
    operationType: "phase.add",
    target: { type: "phase", id: phaseId },
    args,
    metadata: courseMetadata(context, "harness.phase.add", args, {
      courseId: args.courseId,
      phaseId,
    }),
    workWithDb: async (db) => {
      const courseRepo = new CourseRepository(db);
      const course = courseRepo.get(args.courseId);
      if (course === null) throw new Error(`course ${args.courseId} not found`);
      const phaseRepo = new PhaseRepository(db);
      const phase = phaseRepo.add({
        phaseId,
        courseId: args.courseId,
        title: args.title,
        ...(args.parentPhaseId !== undefined ? { parentPhaseId: args.parentPhaseId } : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(args.closeConditions !== undefined ? { closeConditions: args.closeConditions } : {}),
        createdBy: `mcp:${context.clientName}`,
        createdSource: "mcp",
      });
      return { phaseId: phase.phaseId, phase };
    },
  });
}

export async function phaseUpdateTool(
  args: PhaseUpdateArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  // Resolve visibility of the parent course BEFORE entering runMcpMutationOperation so
  // a denied call returns permission_denied (not a generic error thrown inside workWithDb).
  const visibilityResult = withReadonlyDb(context, ({ db }) => {
    const row = db
      .prepare(
        `SELECT c.project_id
           FROM phases p
           JOIN courses c ON c.course_id = p.course_id
          WHERE p.phase_id = ?`,
      )
      .get(args.phaseId) as { project_id: string | null } | undefined;
    if (row === undefined) return errorResult(`phase ${args.phaseId} not found`);
    return ensureProjectVisible(context.config, row.project_id);
  });
  if (visibilityResult !== null) return visibilityResult as HarnessMcpToolResult;

  return runMcpMutationOperation(context, {
    operationType: "phase.update",
    target: { type: "phase", id: args.phaseId },
    args,
    metadata: courseMetadata(context, "harness.phase.update", args, {
      phaseId: args.phaseId,
    }),
    workWithDb: async (db) => {
      const phaseRepo = new PhaseRepository(db);
      const phase = phaseRepo.get(args.phaseId);
      if (phase === null) throw new Error(`phase ${args.phaseId} not found`);
      if (args.status !== undefined) {
        const updated = phaseRepo.setStatus(args.phaseId, args.status);
        return { phaseId: args.phaseId, phase: updated };
      }
      return { phaseId: args.phaseId, phase };
    },
  });
}

export async function phaseLinkHitchTool(
  args: PhaseLinkHitchArgs,
  context: McpToolContext,
): Promise<HarnessMcpToolResult> {
  return runMcpMutationOperation(context, {
    operationType: "phase.link_hitch",
    target: { type: "phase", id: args.phaseId },
    args,
    metadata: courseMetadata(context, "harness.phase.link_hitch", args, {
      phaseId: args.phaseId,
      hitchId: args.hitchId,
    }),
    workWithDb: async (db) => {
      const phaseRepo = new PhaseRepository(db);
      const phase = phaseRepo.get(args.phaseId);
      if (phase === null) throw new Error(`phase ${args.phaseId} not found`);
      // linkHitch already validates cross-project and double-link (throws on violation)
      phaseRepo.linkHitch(args.phaseId, args.hitchId);
      return { phaseId: args.phaseId, hitchId: args.hitchId };
    },
  });
}
