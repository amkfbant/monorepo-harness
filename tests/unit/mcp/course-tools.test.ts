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
