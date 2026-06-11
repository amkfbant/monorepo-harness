# Course → Phase Roadmap Layer (SP-1)

SP-1 adds a `course → phase` DB layer **above** the existing `hitch_*` convergence
tables. A course is a long-lived initiative (roadmap / program / epic); phases are
ordered planning nodes under it; hitches (convergence sessions) are loosely linked
to phases for tracking purposes. This layer is **DB-canonical** and does not replace
or alter the hitch execution tables.

Implementation: `src/roadmap/` (repositories + rollup), `src/cli/course.ts` (CLI),
`src/mcp/tools/course-tools.ts` (MCP tools). Schema: `MIGRATION_V21_STATEMENTS`
(`src/db/schema.ts`, `SCHEMA_VERSION = 21`).

## Data Model

```txt
course   (long-lived initiative, project-scoped)
  └ phase  (self-referencing ordered tree: parent_phase_id null = 大 phase)
       └ hitch_session  (existing; 0..N linked via phase_hitches)
```

### `courses`

| Column | Type | Notes |
|--------|------|-------|
| `course_id` | TEXT PK | `course-<uuid>` |
| `project_id` | TEXT nullable | mirrors `hitch_sessions.project_id`; governs MCP visibility |
| `repo_id` | TEXT nullable | advisory |
| `title` | TEXT | required |
| `description` | TEXT nullable | |
| `status` | TEXT | `active` \| `paused` \| `closed`; DEFAULT `active` |
| `created_by`, `created_source` | TEXT nullable | actor + `cli` / `mcp` |
| `created_at`, `updated_at` | TEXT | ISO-8601 |

### `phases`

| Column | Type | Notes |
|--------|------|-------|
| `phase_id` | TEXT PK | `phase-<uuid>` |
| `course_id` | TEXT FK → courses | ON DELETE CASCADE |
| `parent_phase_id` | TEXT nullable FK → phases | null = top-level (大 phase) |
| `title` | TEXT | required |
| `position` | INTEGER | sibling ordering; DEFAULT 0 |
| `status` | TEXT | `pending` \| `in_progress` \| `closed` \| `blocked`; DEFAULT `pending` |
| `scope_json` | TEXT nullable | arbitrary includes/excludes/target spec |
| `close_conditions_json` | TEXT nullable | phase-level deterministic gates |
| `review_state_json` | TEXT nullable | phase-level review facts (not hitch-convergence) |
| `created_by`, `created_source` | TEXT nullable | |
| `created_at`, `updated_at` | TEXT | |

The self-referencing tree represents 大/サブ phases in a single table, ordered by
`(position ASC, phase_id ASC)` within a parent. A phase's `parent_phase_id` must
belong to the same course; cross-course parents are rejected by `PhaseRepository`.

`review_state_json` records only phase-level reviews that are **not** a hitch's own
convergence (e.g. a codex/Fable review of the phase's roadmap/plan as a fact). It
does **not** store hitch-derived P0/P1 counts (those are always derived live) and
does not encode the GOAL_RULES.md build rules.

### `phase_hitches`

| Column | Type | Notes |
|--------|------|-------|
| `hitch_id` | TEXT **PK** → hitch_sessions | one hitch belongs to at most one phase |
| `phase_id` | TEXT FK → phases | ON DELETE CASCADE |
| `linked_at` | TEXT | ISO-8601 |

The PK on `hitch_id` enforces the 1-hitch-to-at-most-1-phase constraint at the
schema level. Linking a hitch that is already linked to a phase is rejected with
`SQLITE_CONSTRAINT_PRIMARYKEY`.

### Indexes

```sql
CREATE INDEX courses_project_idx ON courses(project_id, status);
CREATE INDEX phases_course_idx   ON phases(course_id, parent_phase_id, position);
CREATE INDEX phase_hitches_phase_idx ON phase_hitches(phase_id);
```

### No compat file export

`courses` / `phases` / `phase_hitches` are DB-only (no compat file export, no
consistency entry). This follows the same precedent as `hitch_*` and `workspaces`.

## Project Scope & Visibility

A course is scoped by its `project_id` (nullable), mirroring `hitch_sessions`. The
MCP read tools and rollup enforce `ensureProjectVisible`:

- **Unrestricted client** (`allowedProjects` empty): sees all courses.
- **Project-restricted client** (`allowedProjects` non-empty): sees only courses
  whose `project_id` is in `allowedProjects`.
- **Null-`project_id` course** (the harness's own cross-project roadmap): is
  **fail-closed invisible** to project-restricted clients. It does not appear in
  `course.list` and returns `permission_denied` from `course.get` / `course.status`.

CLI commands are operator-level (unrestricted).

**Cross-project link rejection**: `phase.link_hitch` rejects linking a hitch whose
`hitch_sessions.project_id` differs from the course's `project_id`. A
null-`project_id` course accepts any hitch.

## Deterministic Rollup (`course status`)

`rollupCourse({ db, courseId })` (`src/roadmap/rollup.ts`) is a **deterministic
projection** over the phase tree + live hitch state. It is never a stored snapshot.

### Per-phase rollup

For each phase in the tree (pre-order, depth-first):

- **`declaredStatus`**: the phase's own `status` column (tracking metadata set by
  the operator or a guarded MCP mutation).
- **`hitchIds`**: all hitches linked to the phase via `phase_hitches`.
- **`derivedOpenP0` / `derivedOpenP1`**: live counts of open in-scope P0 / P1
  findings, read from `hitch_findings` via `HitchRepository.listFindings` with
  `limit: 100_000`. These are **never read from a snapshot**: a caller cannot mark
  a phase "closed" to hide open findings.
- **`latestDecision`**: the most recent `hitch_convergence_decisions.decision`
  across all linked hitches (latest by `created_at`), or null if none.
- **`depth`**: tree depth (0 = 大 phase).

### Course totals

- `openP0` / `openP1`: sum of derived counts across all phases.
- `phaseCountsByStatus`: counts of phases in each status category.

### Tree integrity guard (fail-closed)

After the tree walk, if `flat.length !== allPhases.length`, there is a cycle or an
orphaned `parent_phase_id`. `rollupCourse` throws rather than silently
under-reporting open P0/P1. The error message names the course id.

A cycle cannot be created in normal operation (`phase add` only adds new leaf
nodes; reparent is not exposed in SP-1). The guard is a defensive invariant.

## CLI (`harness course` / `harness phase`)

Implemented in `src/cli/course.ts`, registered via `registerCourseCommands`.

### `harness course`

| Subcommand | Description |
|------------|-------------|
| `course create --title <text> [--description …] [--project <id>] [--repo-id <id>] [--created-by <actor>] [--json]` | Create a course (status=`active`). Prints `course=<id> status=active` or JSON. |
| `course list [--status active\|paused\|closed] [--json]` | List courses (tab-separated id/status/title or JSON). |
| `course show <id> [--json]` | Show a single course. |
| `course status <id> [--json]` | Walk the phase tree and print the deterministic rollup (open P0/P1 per phase + course totals). |
| `course close <id>` | Set course status to `closed`. |
| `course export <id> --md [--out <path>]` | One-way DB → markdown view of the course roadmap. DB stays canonical; no markdown → DB round-trip. |

### `harness phase`

| Subcommand | Description |
|------------|-------------|
| `phase add --course <id> --title <text> [--parent <phase-id>] [--position <n>] [--scope-file <path>] [--close-file <path>] [--created-by <actor>] [--json]` | Add a phase. `--scope-file` / `--close-file` accept JSON or YAML. Rejects cross-course parent. |
| `phase list --course <id> [--json]` | List phases for a course (flat, ordered by position/id). |
| `phase show <id> [--json]` | Show a phase plus its linked hitch ids. |
| `phase update <id> [--status pending\|in_progress\|closed\|blocked] [--scope-file <path>] [--close-file <path>]` | Update a phase's declared status or scope/close conditions. |
| `phase link-hitch <phase-id> <hitch-id>` | Link a hitch to a phase. Rejects cross-project mismatch and double-link. |
| `phase unlink-hitch <hitch-id>` | Remove a hitch's phase link. |

### Exit codes

- `0`: success
- `1`: user-fixable error (not found / different course / already linked / project
  mismatch / invalid `--status` choice / `--position` not an integer / missing
  `--md` flag for export / DB error)
- `2`: unexpected exception (rethrown)

## MCP Tools

Implemented in `src/mcp/tools/course-tools.ts`. All tools apply
`ensureProjectVisible` against the course's `project_id` before reading or
mutating.

### Read tools (enabled by default, no allowlist required)

| Tool | Args | Description |
|------|------|-------------|
| `harness.course.list` | `status?`, `projectId?`, `limit?` (default 50) | List courses. Project-restricted client: only courses in `allowedProjects` (null-project courses hidden). Explicit `projectId` is visibility-checked first. |
| `harness.course.get` | `courseId` | Get a single course. Returns `permission_denied` if not visible to client. |
| `harness.course.status` | `courseId` | Get course + full `rollupCourse` output (phase tree with derived open P0/P1 per phase + course totals). Returns error if tree is inconsistent. |
| `harness.phase.list` | `courseId` | List phases for a course (flat, ordered). Visibility-checked via parent course. |
| `harness.phase.get` | `phaseId` | Get a single phase. Visibility-checked via parent course. |

### Guarded-mutation tools (deny-by-default; requires `guarded-mutation` mode + `allowedOperations`)

| Tool | Operation key | Args | Description |
|------|---------------|------|-------------|
| `harness.course.create` | `course.create` | `title`, `description?`, `projectId?`, `repoId?`, `idempotencyKey`, `actorNote?` | Create a course. Visibility-checked against `projectId`. Idempotent via `OperationRunner`. |
| `harness.phase.add` | `phase.add` | `courseId`, `title`, `parentPhaseId?`, `position?`, `scope?`, `closeConditions?`, `idempotencyKey`, `actorNote?` | Add a phase to a course. Visibility-checked via parent course before entering `OperationRunner`. |
| `harness.phase.update` | `phase.update` | `phaseId`, `status?`, `idempotencyKey`, `actorNote?` | Update a phase's declared status. Visibility-checked via parent course. |
| `harness.phase.link_hitch` | `phase.link_hitch` | `phaseId`, `hitchId`, `idempotencyKey`, `actorNote?` | Link a hitch to a phase. Cross-project mismatch and double-link are rejected inside the operation. |

All guarded mutations use `runMcpMutationOperation` (idempotency ledger / operation
audit / mutation budget enforcement). The `idempotencyKey` is caller-supplied and
required.

### Visibility rule summary

A project-restricted client (`allowedProjects` non-empty) cannot see or mutate
null-`project_id` courses. This is fail-closed: `course.list` excludes them,
`course.get` / `course.status` / `phase.list` / `phase.get` return
`permission_denied`.

## Repositories

`src/roadmap/CourseRepository` — `create`, `get`, `require`, `list` (with optional
`status` and `projectIds` filter), `setStatus`.

`src/roadmap/PhaseRepository` — `add` (with cross-course parent guard), `get`,
`require`, `listForCourse`, `tree` (builds `PhaseNode[]` forest in pre-order),
`setStatus`, `linkHitch` (with cross-project guard and double-link detection),
`unlinkHitch`, `hitchIdsFor`.

## Out of Scope (SP-1)

- **SP-2**: autonomous `course orchestrate` (phase auto-advance, phase → hitch spawn,
  gate enforcement one level up). SP-1 links are all manual.
- The GOAL_RULES.md build rules (retry limits, P0–P3 classification, gates) stay as
  docs / prompt-context — not duplicated into the DB.
- The individual roadmap features (#84–#93) build on this model in later sub-projects.
- A markdown → DB auto-importer. The existing `GOAL.md` is migrated by hand via the
  API or kept as historical context.
- `course.close` / `phase.update → closed` do not require MCP `confirmation_required`
  (reversible tracking writes with no destructive or external effect).
- Phase reparent (`phase update --parent`) is not exposed; a new node added via
  `phase add` is always a leaf and cannot create a cycle.
