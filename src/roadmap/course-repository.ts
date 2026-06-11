import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Course, CourseStatus } from "./types.js";

interface CourseRow {
  course_id: string; project_id: string | null; repo_id: string | null;
  title: string; description: string | null; status: CourseStatus;
  created_by: string | null; created_source: string | null;
  created_at: string; updated_at: string;
}

function mapCourse(r: CourseRow): Course {
  return {
    courseId: r.course_id, projectId: r.project_id, repoId: r.repo_id,
    title: r.title, description: r.description, status: r.status,
    createdBy: r.created_by, createdSource: r.created_source,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class CourseRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    title: string; description?: string; projectId?: string; repoId?: string;
    createdBy: string; createdSource: string; now?: string;
  }): Course {
    const id = `course-${randomUUID()}`;
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(
      `INSERT INTO courses (course_id, project_id, repo_id, title, description, status, created_by, created_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    ).run(id, input.projectId ?? null, input.repoId ?? null, input.title, input.description ?? null, input.createdBy, input.createdSource, now, now);
    return this.require(id);
  }

  get(courseId: string): Course | null {
    const r = this.db.prepare("SELECT * FROM courses WHERE course_id = ?").get(courseId) as CourseRow | undefined;
    return r === undefined ? null : mapCourse(r);
  }

  require(courseId: string): Course {
    const c = this.get(courseId);
    if (c === null) throw new Error(`course ${courseId} not found`);
    return c;
  }

  list(filter: { status?: CourseStatus; projectIds?: string[] } = {}): Course[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) { where.push("status = ?"); params.push(filter.status); }
    if (filter.projectIds !== undefined) {
      // project-scoped read: only these projects (a null-project course is excluded here)
      where.push(`project_id IN (${filter.projectIds.map(() => "?").join(",")})`);
      params.push(...filter.projectIds);
    }
    const sql = `SELECT * FROM courses ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, course_id DESC`;
    return (this.db.prepare(sql).all(...params) as CourseRow[]).map(mapCourse);
  }

  setStatus(courseId: string, status: CourseStatus, now?: string): Course {
    this.require(courseId);
    this.db.prepare("UPDATE courses SET status = ?, updated_at = ? WHERE course_id = ?")
      .run(status, now ?? new Date().toISOString(), courseId);
    return this.require(courseId);
  }
}
