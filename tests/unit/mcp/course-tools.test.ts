import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../src/db/connection.js";
import { runMigrations } from "../../../src/db/migrations.js";
import { CourseRepository } from "../../../src/roadmap/course-repository.js";
import { PhaseRepository } from "../../../src/roadmap/phase-repository.js";
import { HitchRepository } from "../../../src/hitch/repository.js";
import { HarnessMcpServer } from "../../../src/mcp/server.js";
import {
  DEFAULT_MCP_CONFIG,
  type McpConfig,
} from "../../../src/mcp/security/config.js";

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harness-mcp-course-"));
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  runMigrations(db);
  db.close();
  return root;
}

function withDb(root: string, fn: (db: ReturnType<typeof openDb>) => void): void {
  const db = openDb(join(root, ".harness", "harness.sqlite"));
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function mutationConfig(allowedOperations: string[]): McpConfig {
  return {
    ...DEFAULT_MCP_CONFIG,
    defaultMode: "guarded-mutation",
    allowedProjects: ["demo"],
    allowedOperations,
  };
}

function server(root: string, config: McpConfig): HarnessMcpServer {
  return new HarnessMcpServer({
    harnessRoot: root,
    config,
    clientName: "unit-test",
    transport: "stdio",
    sessionId: "mcpsess_course",
  });
}

async function callTool(
  s: HarnessMcpServer,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const response = (await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  })) as any;
  return response.result.structuredContent as Record<string, any>;
}

async function listTools(s: HarnessMcpServer): Promise<string[]> {
  const response = (await s.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  })) as any;
  return (response.result.tools as Array<{ name: string }>).map((t) => t.name);
}

describe("MCP course-tools registration", () => {
  it("registers harness.course.list and harness.course.status in tools/list", async () => {
    const s = server(freshRoot(), DEFAULT_MCP_CONFIG);
    const names = await listTools(s);
    expect(names).toContain("harness.course.list");
    expect(names).toContain("harness.course.status");
    expect(names).toContain("harness.course.get");
    expect(names).toContain("harness.phase.list");
    expect(names).toContain("harness.phase.get");
  });
});

describe("MCP course-tools project-gating", () => {
  it("project-restricted client sees its project course and NOT other-project or null-project courses", async () => {
    const root = freshRoot();
    // Seed: one demo course, one other-project course, one null-project course
    let demoCourseId = "";
    let otherCourseId = "";
    let nullCourseId = "";
    withDb(root, (db) => {
      const repo = new CourseRepository(db);
      const demo = repo.create({
        title: "Demo Course",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      });
      demoCourseId = demo.courseId;
      const other = repo.create({
        title: "Other Course",
        projectId: "other",
        createdBy: "test",
        createdSource: "test",
      });
      otherCourseId = other.courseId;
      const nullProj = repo.create({
        title: "Null Project Course",
        createdBy: "test",
        createdSource: "test",
      });
      nullCourseId = nullProj.courseId;
    });

    const s = server(root, mutationConfig([]));
    const result = await callTool(s, "harness.course.list", {});
    expect(result.status).toBe("ok");
    const courses = result.data.courses as Array<{ courseId: string }>;
    const ids = courses.map((c) => c.courseId);

    expect(ids).toContain(demoCourseId);
    expect(ids).not.toContain(otherCourseId);
    // fail-closed: null-project course is invisible to a restricted client
    expect(ids).not.toContain(nullCourseId);
  });
});

describe("MCP course-tools mutations", () => {
  it("course.create is denied by default permissions (no allowedOperations)", async () => {
    const root = freshRoot();
    // No allowedOperations for course.create
    const s = server(root, mutationConfig([]));
    const result = await callTool(s, "harness.course.create", {
      title: "New Course",
      projectId: "demo",
      idempotencyKey: "course-create-denied",
    });
    expect(result.status).toBe("permission_denied");
  });

  it("course.create works with course.create in allowedOperations", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(["course.create"]));
    const result = await callTool(s, "harness.course.create", {
      title: "New Course",
      projectId: "demo",
      idempotencyKey: "course-create-ok",
    });
    expect(result.status).toBe("operation_started");
    const courseId = result.data.result.courseId as string;
    expect(courseId).toMatch(/^course-/);
    // Verify persisted in DB
    withDb(root, (db) => {
      const repo = new CourseRepository(db);
      const c = repo.get(courseId);
      expect(c).not.toBeNull();
      expect(c!.title).toBe("New Course");
      expect(c!.projectId).toBe("demo");
    });
  });

  it("phase.link_hitch rejects a hitch whose project differs from the course (cross-project)", async () => {
    const root = freshRoot();
    let courseId = "";
    let phaseId = "";
    let crossHitchId = "";
    withDb(root, (db) => {
      const courseRepo = new CourseRepository(db);
      const course = courseRepo.create({
        title: "Demo Course",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      });
      courseId = course.courseId;

      const phaseRepo = new PhaseRepository(db);
      const phase = phaseRepo.add({
        courseId,
        title: "Phase 1",
        createdBy: "test",
        createdSource: "test",
      });
      phaseId = phase.phaseId;

      // Hitch with a different project
      const hitchRepo = new HitchRepository(db);
      const hitch = hitchRepo.createSession({
        hitchId: "hitch-cross-project",
        title: "Cross project hitch",
        projectId: "other",
        createdBy: "test",
        createdSource: "cli",
      });
      crossHitchId = hitch.hitchId;
    });

    const s = server(root, {
      ...mutationConfig(["phase.link_hitch"]),
      // allow both projects so permission check passes, letting business logic run
      allowedProjects: [],
    });
    const result = await callTool(s, "harness.phase.link_hitch", {
      phaseId,
      hitchId: crossHitchId,
      idempotencyKey: "phase-link-cross-project",
    });
    // cross-project link should be rejected at the business logic level
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/project/i);
  });

  // P1 (codex App): a project-restricted client must not be able to probe or
  // audit-log out-of-scope source hitches via phase.link_hitch.
  it("phase.link_hitch hides out-of-scope source hitches from a project-restricted client (no oracle, no audit leak)", async () => {
    const root = freshRoot();
    let phaseId = "";
    const forbiddenHitchId = "hitch-in-other-project";
    withDb(root, (db) => {
      const courseRepo = new CourseRepository(db);
      const course = courseRepo.create({
        title: "Demo Course",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      });
      const phaseRepo = new PhaseRepository(db);
      phaseId = phaseRepo.add({
        courseId: course.courseId,
        title: "Phase 1",
        createdBy: "test",
        createdSource: "test",
      }).phaseId;
      // A hitch that belongs to a DIFFERENT project the client cannot see.
      new HitchRepository(db).createSession({
        hitchId: forbiddenHitchId,
        title: "Other project hitch",
        projectId: "other",
        createdBy: "test",
        createdSource: "cli",
      });
    });

    // Client scoped to "demo" only; phase is in demo so the destination gate passes.
    const s = server(root, mutationConfig(["phase.link_hitch"]));

    // Forbidden (exists, other project) and unknown hitch must be INDISTINGUISHABLE.
    const forbidden = await callTool(s, "harness.phase.link_hitch", {
      phaseId,
      hitchId: forbiddenHitchId,
      idempotencyKey: "probe-forbidden",
    });
    const unknown = await callTool(s, "harness.phase.link_hitch", {
      phaseId,
      hitchId: "hitch-does-not-exist",
      idempotencyKey: "probe-unknown",
    });

    expect(forbidden.status).toBe("permission_denied");
    expect(unknown.status).toBe("permission_denied");
    // Same shape — no existence oracle.
    expect(forbidden.summary).toBe(unknown.summary);

    // The out-of-scope hitchId must NOT be written into the operation audit log.
    withDb(root, (db) => {
      const leaked = db
        .prepare(
          "SELECT COUNT(*) AS n FROM operations WHERE input_json LIKE ? OR target_id = ?",
        )
        .get(`%${forbiddenHitchId}%`, forbiddenHitchId) as { n: number };
      expect(leaked.n).toBe(0);
    });
  });

  // P2 (codex App): phase.add must not let a restricted client probe an out-of-scope
  // parentPhaseId (same oracle/audit-leak class as the link_hitch source-hitch gate).
  it("phase.add hides an out-of-scope parentPhaseId from a project-restricted client", async () => {
    const root = freshRoot();
    let demoCourseId = "";
    const forbiddenParentId = "phase-in-other-course";
    withDb(root, (db) => {
      const courseRepo = new CourseRepository(db);
      demoCourseId = courseRepo.create({
        title: "Demo Course",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      }).courseId;
      // A phase in a DIFFERENT, out-of-scope project's course.
      const otherCourse = courseRepo.create({
        title: "Other Course",
        projectId: "other",
        createdBy: "test",
        createdSource: "test",
      });
      const phaseRepo = new PhaseRepository(db);
      phaseRepo.add({
        phaseId: forbiddenParentId,
        courseId: otherCourse.courseId,
        title: "Other-project phase",
        createdBy: "test",
        createdSource: "test",
      });
    });

    const s = server(root, mutationConfig(["phase.add"]));

    // Add to the VISIBLE demo course but with an out-of-scope parentPhaseId.
    const forbidden = await callTool(s, "harness.phase.add", {
      courseId: demoCourseId,
      title: "Should be denied",
      parentPhaseId: forbiddenParentId,
      idempotencyKey: "parent-probe-forbidden",
    });
    const unknown = await callTool(s, "harness.phase.add", {
      courseId: demoCourseId,
      title: "Should be denied",
      parentPhaseId: "phase-does-not-exist",
      idempotencyKey: "parent-probe-unknown",
    });

    expect(forbidden.status).toBe("permission_denied");
    expect(unknown.status).toBe("permission_denied");
    expect(forbidden.summary).toBe(unknown.summary);

    // The out-of-scope parent phase id must NOT be audit-logged, and no phase added.
    withDb(root, (db) => {
      const leaked = db
        .prepare(
          "SELECT COUNT(*) AS n FROM operations WHERE input_json LIKE ? OR target_id = ?",
        )
        .get(`%${forbiddenParentId}%`, forbiddenParentId) as { n: number };
      expect(leaked.n).toBe(0);
      const phases = new PhaseRepository(db).listForCourse(demoCourseId);
      expect(phases).toHaveLength(0);
    });
  });
});

describe("MCP course-tools harness.course.status", () => {
  it("returns rollup data for a course", async () => {
    const root = freshRoot();
    let courseId = "";
    withDb(root, (db) => {
      const courseRepo = new CourseRepository(db);
      const course = courseRepo.create({
        title: "Status Course",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      });
      courseId = course.courseId;
      const phaseRepo = new PhaseRepository(db);
      phaseRepo.add({
        courseId,
        title: "Phase A",
        createdBy: "test",
        createdSource: "test",
      });
    });

    // Use unscoped config so project visibility doesn't block the read
    const cfg: McpConfig = { ...DEFAULT_MCP_CONFIG, allowedProjects: [] };
    const s = server(root, cfg);
    const result = await callTool(s, "harness.course.status", { courseId });
    expect(result.status).toBe("ok");
    expect(result.data.rollup.courseId).toBe(courseId);
    expect(Array.isArray(result.data.rollup.phases)).toBe(true);
    expect(result.data.rollup.phases).toHaveLength(1);
    expect(result.data.rollup.phases[0].title).toBe("Phase A");
  });
});

// ---------------------------------------------------------------------------
// P1 regression: phase.link_hitch idempotency key corruption
// ---------------------------------------------------------------------------

describe("MCP course-tools phase.link_hitch — idempotency key regression (P1)", () => {
  it("two distinct link_hitch calls on the same phase with different idempotencyKeys and hitchIds both persist", async () => {
    const root = freshRoot();
    let phaseId = "";
    let hitchId1 = "";
    let hitchId2 = "";

    withDb(root, (db) => {
      const courseRepo = new CourseRepository(db);
      const course = courseRepo.create({
        title: "Idempotency Course",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      });

      const phaseRepo = new PhaseRepository(db);
      const phase = phaseRepo.add({
        courseId: course.courseId,
        title: "Phase A",
        createdBy: "test",
        createdSource: "test",
      });
      phaseId = phase.phaseId;

      // Two same-project hitches
      const hitchRepo = new HitchRepository(db);
      const h1 = hitchRepo.createSession({
        title: "Hitch 1",
        projectId: "demo",
        createdBy: "test",
        createdSource: "cli",
      });
      hitchId1 = h1.hitchId;

      const h2 = hitchRepo.createSession({
        title: "Hitch 2",
        projectId: "demo",
        createdBy: "test",
        createdSource: "cli",
      });
      hitchId2 = h2.hitchId;
    });

    const s = server(root, {
      ...mutationConfig(["phase.link_hitch"]),
      allowedProjects: [],
    });

    // First link
    const result1 = await callTool(s, "harness.phase.link_hitch", {
      phaseId,
      hitchId: hitchId1,
      idempotencyKey: "link-hitch-first",
    });
    expect(result1.status).toBe("operation_started");
    expect(result1.data.replayed).toBe(false);

    // Second link — different idempotencyKey and different hitchId
    const result2 = await callTool(s, "harness.phase.link_hitch", {
      phaseId,
      hitchId: hitchId2,
      idempotencyKey: "link-hitch-second",
    });
    // With the P1 bug the second call would be treated as an idempotency replay
    // (key collapsed to "[redacted]") and silently return the first op result.
    // With the fix it must be a new, non-replayed operation.
    expect(result2.status).toBe("operation_started");
    expect(result2.data.replayed).toBe(false);
    // The second link must have actually persisted
    expect(result2.data.result.hitchId).toBe(hitchId2);
  });
});

// ---------------------------------------------------------------------------
// Single-read gating: project-restricted client denied on wrong-project reads
// ---------------------------------------------------------------------------

describe("MCP course-tools single-read project gating", () => {
  it("course.get returns permission_denied for a project-restricted client on a different-project course", async () => {
    const root = freshRoot();
    let otherCourseId = "";
    withDb(root, (db) => {
      const repo = new CourseRepository(db);
      const course = repo.create({
        title: "Other Project Course",
        projectId: "other",
        createdBy: "test",
        createdSource: "test",
      });
      otherCourseId = course.courseId;
    });

    // Client scoped to "demo" — "other" project is not visible
    const s = server(root, mutationConfig([]));
    const result = await callTool(s, "harness.course.get", { courseId: otherCourseId });
    expect(result.status).toBe("permission_denied");
  });

  it("course.status returns permission_denied for a project-restricted client on a different-project course", async () => {
    const root = freshRoot();
    let otherCourseId = "";
    withDb(root, (db) => {
      const repo = new CourseRepository(db);
      const course = repo.create({
        title: "Other Project Course",
        projectId: "other",
        createdBy: "test",
        createdSource: "test",
      });
      otherCourseId = course.courseId;
    });

    const s = server(root, mutationConfig([]));
    const result = await callTool(s, "harness.course.status", { courseId: otherCourseId });
    expect(result.status).toBe("permission_denied");
  });

  it("phase.get returns permission_denied for a project-restricted client on a different-project phase", async () => {
    const root = freshRoot();
    let otherPhaseId = "";
    withDb(root, (db) => {
      const courseRepo = new CourseRepository(db);
      const course = courseRepo.create({
        title: "Other Project Course",
        projectId: "other",
        createdBy: "test",
        createdSource: "test",
      });
      const phaseRepo = new PhaseRepository(db);
      const phase = phaseRepo.add({
        courseId: course.courseId,
        title: "Phase X",
        createdBy: "test",
        createdSource: "test",
      });
      otherPhaseId = phase.phaseId;
    });

    const s = server(root, mutationConfig([]));
    const result = await callTool(s, "harness.phase.get", { phaseId: otherPhaseId });
    expect(result.status).toBe("permission_denied");
  });
});

// ---------------------------------------------------------------------------
// P1 idempotency regression: course.create / phase.add replay must not duplicate
// ---------------------------------------------------------------------------

describe("MCP course-tools create/add idempotency replay (P1)", () => {
  it("course.create called twice with the same idempotencyKey creates exactly ONE course", async () => {
    const root = freshRoot();
    const s = server(root, mutationConfig(["course.create"]));

    const idempotencyKey = "course-create-replay-test-01";
    const result1 = await callTool(s, "harness.course.create", {
      title: "Idempotent Course",
      projectId: "demo",
      idempotencyKey,
    });
    expect(result1.status).toBe("operation_started");
    expect(result1.data.replayed).toBe(false);
    const courseId1 = result1.data.result.courseId as string;

    // Second call with the same idempotencyKey — must be treated as a replay
    const result2 = await callTool(s, "harness.course.create", {
      title: "Idempotent Course",
      projectId: "demo",
      idempotencyKey,
    });
    expect(result2.status).toBe("operation_started");
    expect(result2.data.replayed).toBe(true);

    // Both calls must return the SAME courseId (not a new random one)
    const courseId2 = result2.data.result.courseId as string;
    expect(courseId2).toBe(courseId1);

    // Verify exactly one course row exists in the DB
    withDb(root, (db) => {
      const repo = new CourseRepository(db);
      const all = repo.list({ projectIds: ["demo"] });
      const matching = all.filter((c) => c.title === "Idempotent Course");
      expect(matching).toHaveLength(1);
    });
  });

  it("phase.add called twice with the same idempotencyKey creates exactly ONE phase", async () => {
    const root = freshRoot();
    let courseId = "";
    withDb(root, (db) => {
      const repo = new CourseRepository(db);
      const course = repo.create({
        title: "Replay Test Course",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      });
      courseId = course.courseId;
    });

    const s = server(root, mutationConfig(["phase.add"]));
    const idempotencyKey = "phase-add-replay-test-01";

    const result1 = await callTool(s, "harness.phase.add", {
      courseId,
      title: "Idempotent Phase",
      idempotencyKey,
    });
    expect(result1.status).toBe("operation_started");
    expect(result1.data.replayed).toBe(false);
    const phaseId1 = result1.data.result.phaseId as string;

    // Second call with the same idempotencyKey — must be treated as a replay
    const result2 = await callTool(s, "harness.phase.add", {
      courseId,
      title: "Idempotent Phase",
      idempotencyKey,
    });
    expect(result2.status).toBe("operation_started");
    expect(result2.data.replayed).toBe(true);

    // Both calls must return the SAME phaseId
    const phaseId2 = result2.data.result.phaseId as string;
    expect(phaseId2).toBe(phaseId1);

    // Verify exactly one phase row exists in the DB
    withDb(root, (db) => {
      const repo = new PhaseRepository(db);
      const phases = repo.listForCourse(courseId);
      const matching = phases.filter((p) => p.title === "Idempotent Phase");
      expect(matching).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// P1 (codex App): cross-resource idempotency-key collision must not leak.
// The OperationRunner replay key is (operation_type, target_id, idempotency_key)
// with NO project/client dimension. If the derived target_id hashes only the
// idempotencyKey, two clients in DIFFERENT projects that happen to reuse the same
// idempotencyKey collide → the second create is treated as a replay of the first
// and returns the OTHER project's course. The derived id must include the
// resource scope (project for course.create, course for phase.add) so distinct
// resources never collide.
// ---------------------------------------------------------------------------

describe("MCP course-tools create/add idempotency scope isolation (P1)", () => {
  it("course.create with the same idempotencyKey in DIFFERENT projects creates two distinct courses", async () => {
    const root = freshRoot();
    const idempotencyKey = "shared-key-across-projects";

    const demoServer = server(root, {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedProjects: ["demo"],
      allowedOperations: ["course.create"],
    });
    const otherServer = server(root, {
      ...DEFAULT_MCP_CONFIG,
      defaultMode: "guarded-mutation",
      allowedProjects: ["other"],
      allowedOperations: ["course.create"],
    });

    const demoResult = await callTool(demoServer, "harness.course.create", {
      title: "Demo Project Course",
      projectId: "demo",
      idempotencyKey,
    });
    expect(demoResult.status).toBe("operation_started");
    expect(demoResult.data.replayed).toBe(false);
    const demoCourseId = demoResult.data.result.courseId as string;

    // Different project, SAME idempotencyKey — must NOT be a cross-project replay.
    const otherResult = await callTool(otherServer, "harness.course.create", {
      title: "Other Project Course",
      projectId: "other",
      idempotencyKey,
    });
    expect(otherResult.status).toBe("operation_started");
    // With the bug this is replayed=true and returns the demo course (leak).
    expect(otherResult.data.replayed).toBe(false);
    const otherCourseId = otherResult.data.result.courseId as string;

    expect(otherCourseId).not.toBe(demoCourseId);

    // Each project owns exactly its own course; no cross-project leak.
    withDb(root, (db) => {
      const repo = new CourseRepository(db);
      const demoCourse = repo.get(demoCourseId);
      const otherCourse = repo.get(otherCourseId);
      expect(demoCourse?.projectId).toBe("demo");
      expect(demoCourse?.title).toBe("Demo Project Course");
      expect(otherCourse?.projectId).toBe("other");
      expect(otherCourse?.title).toBe("Other Project Course");
    });
  });

  it("phase.add with the same idempotencyKey under DIFFERENT courses creates two distinct phases", async () => {
    const root = freshRoot();
    let courseA = "";
    let courseB = "";
    withDb(root, (db) => {
      const repo = new CourseRepository(db);
      courseA = repo.create({
        title: "Course A",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      }).courseId;
      courseB = repo.create({
        title: "Course B",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      }).courseId;
    });

    const s = server(root, mutationConfig(["phase.add"]));
    const idempotencyKey = "shared-key-across-courses";

    const resultA = await callTool(s, "harness.phase.add", {
      courseId: courseA,
      title: "Phase under A",
      idempotencyKey,
    });
    expect(resultA.status).toBe("operation_started");
    expect(resultA.data.replayed).toBe(false);
    const phaseA = resultA.data.result.phaseId as string;

    // Same idempotencyKey under a DIFFERENT course — must NOT be a replay.
    const resultB = await callTool(s, "harness.phase.add", {
      courseId: courseB,
      title: "Phase under B",
      idempotencyKey,
    });
    expect(resultB.status).toBe("operation_started");
    expect(resultB.data.replayed).toBe(false);
    const phaseB = resultB.data.result.phaseId as string;

    expect(phaseB).not.toBe(phaseA);

    withDb(root, (db) => {
      const repo = new PhaseRepository(db);
      expect(repo.listForCourse(courseA).map((p) => p.title)).toContain(
        "Phase under A",
      );
      expect(repo.listForCourse(courseB).map((p) => p.title)).toContain(
        "Phase under B",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Deny-by-default: phase mutations not allowlisted are rejected
// ---------------------------------------------------------------------------

describe("MCP course-tools phase mutation deny-by-default", () => {
  it("phase.add is denied when not in allowedOperations", async () => {
    const root = freshRoot();
    let courseId = "";
    withDb(root, (db) => {
      const repo = new CourseRepository(db);
      const course = repo.create({
        title: "Demo Course",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      });
      courseId = course.courseId;
    });

    // allowedOperations does NOT include phase.add
    const s = server(root, mutationConfig([]));
    const result = await callTool(s, "harness.phase.add", {
      courseId,
      title: "Should be denied",
      idempotencyKey: "phase-add-denied",
    });
    expect(result.status).toBe("permission_denied");
  });

  it("phase.link_hitch is denied when not in allowedOperations", async () => {
    const root = freshRoot();
    let phaseId = "";
    let hitchId = "";
    withDb(root, (db) => {
      const courseRepo = new CourseRepository(db);
      const course = courseRepo.create({
        title: "Demo Course",
        projectId: "demo",
        createdBy: "test",
        createdSource: "test",
      });
      const phaseRepo = new PhaseRepository(db);
      const phase = phaseRepo.add({
        courseId: course.courseId,
        title: "Phase 1",
        createdBy: "test",
        createdSource: "test",
      });
      phaseId = phase.phaseId;

      const hitchRepo = new HitchRepository(db);
      const hitch = hitchRepo.createSession({
        title: "Hitch for deny test",
        projectId: "demo",
        createdBy: "test",
        createdSource: "cli",
      });
      hitchId = hitch.hitchId;
    });

    // allowedOperations does NOT include phase.link_hitch
    const s = server(root, mutationConfig([]));
    const result = await callTool(s, "harness.phase.link_hitch", {
      phaseId,
      hitchId,
      idempotencyKey: "phase-link-denied",
    });
    expect(result.status).toBe("permission_denied");
  });
});

// ---------------------------------------------------------------------------
// P2 consistency: phase.add / phase.update denial returns permission_denied
// ---------------------------------------------------------------------------

describe("MCP course-tools phase.add and phase.update visibility denial (P2)", () => {
  it("phase.add returns permission_denied (not error) when course project is not visible to client", async () => {
    const root = freshRoot();
    let otherCourseId = "";
    withDb(root, (db) => {
      const repo = new CourseRepository(db);
      const course = repo.create({
        title: "Other Course",
        projectId: "other",
        createdBy: "test",
        createdSource: "test",
      });
      otherCourseId = course.courseId;
    });

    // Client scoped to "demo" with phase.add allowed — but the course is in "other"
    const s = server(root, {
      ...mutationConfig(["phase.add"]),
      allowedProjects: ["demo"],
    });
    const result = await callTool(s, "harness.phase.add", {
      courseId: otherCourseId,
      title: "Denied Phase",
      idempotencyKey: "phase-add-visibility-denied",
    });
    expect(result.status).toBe("permission_denied");
  });

  it("phase.update returns permission_denied (not error) when phase project is not visible to client", async () => {
    const root = freshRoot();
    let otherPhaseId = "";
    withDb(root, (db) => {
      const courseRepo = new CourseRepository(db);
      const course = courseRepo.create({
        title: "Other Course",
        projectId: "other",
        createdBy: "test",
        createdSource: "test",
      });
      const phaseRepo = new PhaseRepository(db);
      const phase = phaseRepo.add({
        courseId: course.courseId,
        title: "Phase in Other",
        createdBy: "test",
        createdSource: "test",
      });
      otherPhaseId = phase.phaseId;
    });

    // Client scoped to "demo" with phase.update allowed — but the phase is in "other"
    const s = server(root, {
      ...mutationConfig(["phase.update"]),
      allowedProjects: ["demo"],
    });
    const result = await callTool(s, "harness.phase.update", {
      phaseId: otherPhaseId,
      status: "in_progress",
      idempotencyKey: "phase-update-visibility-denied",
    });
    expect(result.status).toBe("permission_denied");
  });
});
