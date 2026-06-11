import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Phase, PhaseNode, PhaseStatus } from "./types.js";

interface PhaseRow {
  phase_id: string; course_id: string; parent_phase_id: string | null;
  title: string; position: number; status: PhaseStatus;
  scope_json: string | null; close_conditions_json: string | null; review_state_json: string | null;
  created_by: string | null; created_source: string | null; created_at: string; updated_at: string;
}

function parse(text: string | null): unknown { return text === null ? null : JSON.parse(text); }

function mapPhase(r: PhaseRow): Phase {
  return {
    phaseId: r.phase_id, courseId: r.course_id, parentPhaseId: r.parent_phase_id,
    title: r.title, position: r.position, status: r.status,
    scope: parse(r.scope_json), closeConditions: parse(r.close_conditions_json), reviewState: parse(r.review_state_json),
    createdBy: r.created_by, createdSource: r.created_source, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export class PhaseRepository {
  constructor(private readonly db: Database.Database) {}

  add(input: {
    courseId: string; parentPhaseId?: string; title: string; position?: number;
    scope?: unknown; closeConditions?: unknown;
    createdBy: string; createdSource: string; now?: string;
  }): Phase {
    // integrity: parent must exist AND be in the same course
    if (input.parentPhaseId !== undefined) {
      const parent = this.db.prepare("SELECT course_id FROM phases WHERE phase_id = ?").get(input.parentPhaseId) as { course_id: string } | undefined;
      if (parent === undefined) throw new Error(`parent phase ${input.parentPhaseId} not found`);
      if (parent.course_id !== input.courseId) throw new Error(`parent phase ${input.parentPhaseId} is in a different course`);
    }
    const id = `phase-${randomUUID()}`;
    const now = input.now ?? new Date().toISOString();
    this.db.prepare(
      `INSERT INTO phases (phase_id, course_id, parent_phase_id, title, position, status, scope_json, close_conditions_json, created_by, created_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.courseId, input.parentPhaseId ?? null, input.title, input.position ?? 0,
      input.scope === undefined ? null : JSON.stringify(input.scope),
      input.closeConditions === undefined ? null : JSON.stringify(input.closeConditions),
      input.createdBy, input.createdSource, now, now);
    return this.require(id);
  }

  get(phaseId: string): Phase | null {
    const r = this.db.prepare("SELECT * FROM phases WHERE phase_id = ?").get(phaseId) as PhaseRow | undefined;
    return r === undefined ? null : mapPhase(r);
  }
  require(phaseId: string): Phase {
    const p = this.get(phaseId);
    if (p === null) throw new Error(`phase ${phaseId} not found`);
    return p;
  }

  listForCourse(courseId: string): Phase[] {
    return (this.db.prepare(
      "SELECT * FROM phases WHERE course_id = ? ORDER BY position ASC, phase_id ASC",
    ).all(courseId) as PhaseRow[]).map(mapPhase);
  }

  /** Build the phase forest for a course (deterministic: position then phase_id). */
  tree(courseId: string): PhaseNode[] {
    const all = this.listForCourse(courseId);
    const byParent = new Map<string | null, Phase[]>();
    for (const p of all) {
      const k = p.parentPhaseId;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k)!.push(p);
    }
    const build = (parentId: string | null): PhaseNode[] =>
      (byParent.get(parentId) ?? []).map((phase) => ({ phase, children: build(phase.phaseId) }));
    return build(null);
  }

  setStatus(phaseId: string, status: PhaseStatus, now?: string): Phase {
    this.require(phaseId);
    this.db.prepare("UPDATE phases SET status = ?, updated_at = ? WHERE phase_id = ?")
      .run(status, now ?? new Date().toISOString(), phaseId);
    return this.require(phaseId);
  }

  /** Link a hitch to a phase. Rejects a project mismatch and a double-link (PK). */
  linkHitch(phaseId: string, hitchId: string, now?: string): void {
    const phase = this.require(phaseId);
    const course = this.db.prepare("SELECT project_id FROM courses WHERE course_id = ?").get(phase.courseId) as { project_id: string | null } | undefined;
    const hitch = this.db.prepare("SELECT project_id FROM hitch_sessions WHERE hitch_id = ?").get(hitchId) as { project_id: string | null } | undefined;
    if (hitch === undefined) throw new Error(`hitch ${hitchId} not found`);
    if (course?.project_id != null && hitch.project_id !== course.project_id) {
      throw new Error(`hitch ${hitchId} project (${hitch.project_id}) differs from course project (${course.project_id})`);
    }
    try {
      this.db.prepare("INSERT INTO phase_hitches (hitch_id, phase_id, linked_at) VALUES (?, ?, ?)")
        .run(hitchId, phaseId, now ?? new Date().toISOString());
    } catch (e) {
      // only the PK violation means "already linked"; rethrow anything else.
      if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
        throw new Error(`hitch ${hitchId} is already linked to a phase`, { cause: e });
      }
      throw e;
    }
  }

  unlinkHitch(hitchId: string): void {
    this.db.prepare("DELETE FROM phase_hitches WHERE hitch_id = ?").run(hitchId);
  }

  hitchIdsFor(phaseId: string): string[] {
    return (this.db.prepare("SELECT hitch_id FROM phase_hitches WHERE phase_id = ? ORDER BY linked_at ASC, hitch_id ASC").all(phaseId) as Array<{ hitch_id: string }>).map((r) => r.hitch_id);
  }
}
