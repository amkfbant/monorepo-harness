export type CourseStatus = "active" | "paused" | "closed";
export type PhaseStatus = "pending" | "in_progress" | "closed" | "blocked";

export interface Course {
  courseId: string;
  projectId: string | null;
  repoId: string | null;
  title: string;
  description: string | null;
  status: CourseStatus;
  createdBy: string | null;
  createdSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Phase {
  phaseId: string;
  courseId: string;
  parentPhaseId: string | null;
  title: string;
  position: number;
  status: PhaseStatus;
  scope: unknown;            // parsed scope_json
  closeConditions: unknown;  // parsed close_conditions_json
  reviewState: unknown;      // parsed review_state_json
  createdBy: string | null;
  createdSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PhaseNode {
  phase: Phase;
  children: PhaseNode[];
}
