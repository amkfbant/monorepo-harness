# Course → Phase Roadmap Layer (SP-1 / SP-2)

SP-1 adds a `course → phase` DB layer **above** the existing `hitch_*` convergence
tables. A course is a long-lived initiative (roadmap / program / epic); phases are
ordered planning nodes under it; hitches (convergence sessions) are loosely linked
to phases for tracking purposes. This layer is **DB-canonical** and does not replace
or alter the hitch execution tables. SP-2 adds a drive-only `course orchestrate`
pass on top of the same model.

Implementation: `src/roadmap/` (repositories + rollup + orchestrator),
`src/cli/course.ts` (CLI), `src/mcp/tools/course-tools.ts` (MCP tools). Schema:
`MIGRATION_V21_STATEMENTS` (`src/db/schema.ts`, `SCHEMA_VERSION = 21`). SP-2 adds
no migration.

SP-23 scope note: this layer documents and enforces roadmap/spec compatibility,
but does not change `GOAL_RULES.md` itself. The root GOAL_RULES file remains the
operator/process source of truth for reviewer retry limits, P0-P3 classification,
merge gates, and development discipline; roadmap review state only records phase
facts such as notes and spec ratification.

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
| `position` | INTEGER | sibling ordering; DEFAULT 0; repository `add` auto-assigns the next sibling position when omitted |
| `status` | TEXT | `pending` \| `in_progress` \| `closed` \| `blocked`; DEFAULT `pending` |
| `scope_json` | TEXT nullable | arbitrary includes/excludes/target spec |
| `close_conditions_json` | TEXT nullable | phase-level deterministic gates |
| `review_state_json` | TEXT nullable | phase-level review facts (not hitch-convergence) |
| `review_state_version` | INTEGER | optimistic-lock version for `review_state_json`; DEFAULT 0 |
| `created_by`, `created_source` | TEXT nullable | |
| `created_at`, `updated_at` | TEXT | |

The self-referencing tree represents 大/サブ phases in a single table. New phases
with no explicit `position` are assigned `COALESCE(MAX(position) + 1, 0)` within
the same `(course_id, parent_phase_id)` sibling group in the same `BEGIN IMMEDIATE`
transaction as the insert; explicit `position` values are preserved. Reads are
ordered by `(position ASC, created_at ASC, phase_id ASC)` within a parent. The
`created_at` tiebreak improves ordering for legacy courses whose siblings were
all stored with `position = 0`, but it is best-effort: legacy rows created in the
same millisecond still fall back to `phase_id` order. A phase's `parent_phase_id`
must belong to the same course; cross-course parents are rejected by
`PhaseRepository`.

Phase `scope_json` and `close_conditions_json` writes are guarded by
`PhaseRepository.updateSpec()` and the same parser/validator used for hitch
specs. `phase add`, MCP `phase.add`, and `phase update --scope-file/--close-file`
reject invalid close-condition forms before writing. Updates that widen scope or
loosen required close gates require the explicit `allowScopeWiden` /
`allowGateLoosen` path (`--allow-scope-widen` / `--allow-gate-loosen` in the CLI).
CLI `phase update` applies scope/close-condition replacements, declared status,
and `--note` in one `BEGIN IMMEDIATE` transaction through `PhaseRepository.update()`;
if any part fails, none of the phase row changes are committed.

`review_state_json` records only phase-level reviews that are **not** a hitch's own
convergence (e.g. a codex/Fable review of the phase's roadmap/plan as a fact). It
does **not** store hitch-derived P0/P1 counts (those are always derived live) and
does not encode the GOAL_RULES.md build rules. Writers use
`PhaseRepository.updateReviewState()` with `review_state_version` CAS and a
bounded retry budget, then throw `ReviewStateConflictError` rather than applying
a last-writer-wins overwrite. `recordSpecApproval()` stores human ratification
under the namespaced `specApproval` key with `{ approvedBy, approvedAt, reason,
specHash }`; `specHash` is the sha256 of the canonical JSON of the
`[scope, closeConditions]` tuple (a structured tuple rather than concatenated
scalars, which would let `1`+`23` and `12`+`3` both hash to "123"). `setNote()` also uses this CAS path so
operator notes and spec approvals preserve each other's keys.

`phase ratify <phase-id> --approved-by <actor>` is the CLI ceremony for this
write. Ratification is opt-in: phases without `specApproval` keep the legacy free
link behavior. Once ratified, `phase link-hitch` and `phase start-hitch` enforce
that the hitch's scope and close conditions match or tighten the current phase
spec. A scope widening requires `--allow-scope-widen`; removing or weakening a
required close gate requires `--allow-gate-loosen`. If the phase spec was edited
after approval, the link/start path recomputes the current spec hash, compares it
with `specApproval.specHash`, and emits a drift warning while still applying the
same current-spec compatibility gate.

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
null-`project_id` course accepts any hitch. `phase.start_hitch` derives the new
hitch's `project_id` / `repo_id` from the parent course and then uses the same
link gate atomically, so a ratified-spec rejection rolls back the hitch insert.

## Deterministic Rollup (`course status`)

`rollupCourse({ db, courseId })` (`src/roadmap/rollup.ts`) is a **deterministic
projection** over the phase tree + live hitch state. It is never a stored snapshot.

### Per-phase rollup

For each phase in the tree (pre-order, depth-first):

- **`declaredStatus`**: the phase's own `status` column (tracking metadata set by
  the operator or a guarded MCP mutation).
- **`hitchIds`**: all hitches linked to the phase via `phase_hitches`.
- **`derivedOpenP0` / `derivedOpenP1`**: live counts of open in-scope P0 / P1
  findings, read from `hitch_findings` via a direct `COUNT(*)` SQL aggregate
  (`openCounts`, `src/roadmap/rollup.ts`) with no row-fetch LIMIT. They count the
  same active lifecycle set as hitch convergence — `open`, `reopened`, and
  `escalated` (`OPEN_FINDING_LIFECYCLES`). These are **never read from a
  snapshot**: a caller cannot mark a phase "closed" to hide open findings.
- **`latestDecision`**: the most recent `hitch_convergence_decisions.decision`
  across all linked hitches (latest by `created_at`, tie-broken by `decision_id`),
  or null if none. **Advisory rows are excluded from this display** (#230 /
  codex#254-P2 FIX1): the D2b severity-audit advisory record writes a
  status-neutral `decision:"continue"` row (`metrics.advisorySeverityRecord ===
  true`, `updateStatus:false`) solely to surface a diverged severity audit; it is
  not a convergence decision. `latestDecisionForPhase` skips any row detected as
  advisory by `isAdvisoryRecord`, which matches **either** (a) the explicit
  `metrics.advisorySeverityRecord === true` marker (current builds) **or** (b) a
  **shape fallback** (codex#254-R5 P2 FIX2) for pre-marker rows written by earlier
  #230 builds that had no marker: `decision === "continue"` AND the row's
  `recommended_next_action.decisionPacket.decisionKinds` includes `severity_audit`.
  The shape fallback keeps the display honest after a harness upgrade **without a
  backfill migration**. Either way a phase whose **live** convergence is still
  blocking (`needs_classification` / `needs_fix` / …) is not displayed as
  `continue`. The
  advisory row stays persisted and retrievable via `listDecisions`; only the
  rollup display ignores it (the blocking gate uses live `convergence.evaluate()`,
  never this display value). **#171** — when the selected hitch has been terminally
  closed/cancelled (`hitch close --force` / `cancel` record no decision row), its
  stored last decision is a stale mid-flight value (e.g. `diverging`); the rollup
  reports that hitch's **live** decision (`closed` / `cancel`) instead so a
  force-closed phase does not read as unresolved. Active (non-terminal) hitches
  keep their recorded decision — the genuine latest audit value — and
  `readyToClose` already reflects live convergence independently. For a
  multi-hitch phase this is a single-value display projection (the
  recency-selected hitch); `readyToClose` / `derivedOpenP0` / `derivedOpenP1`
  are the authoritative, all-hitch readiness signals and are what `course
  orchestrate` depends on — never `latestDecision`.
- **`note`**: the phase's operator audit note (#171b), or null. Set with
  `phase update --note <text>` (a force-close reason / PR ref), stored verbatim
  under the generic `review_state_json` blob as `{ note }` (no schema migration;
  merges with any other review-state keys). `course export --md` renders it as a
  `**Note**:` line with newlines collapsed to spaces so a note cannot inject
  extra Markdown blocks into the audit export.
- **`readyToClose`**: derived live by `derivePhaseReadiness`: at least one linked
  hitch, every linked hitch is `close_ready` or `closed`, and independently
  aggregated open in-scope P0/P1 counts are both zero. This is not stored.
- **`depth`**: tree depth (0 = 大 phase).

### Course totals

- `openP0` / `openP1`: sum of derived counts across all phases.
- `phaseCountsByStatus`: counts of phases in each status category.
- `tokenTotals`: **live** sum of every linked hitch's `hitchTokenUsage`
  (`run_usage` over the hitch's distinct attempt runs, retry-inclusive) across
  the whole course — total tokens (input / cached / output / reasoning / total),
  `runsWithUsage`, and a `byKind` (coder / reviewer / evaluator) split. Like the
  open P0/P1 counts this is a derived projection, never a stored snapshot. The
  per-hitch fold counts a run once per hitch (`phase_hitches` keeps a hitch in
  at most one phase). `course status` prints `tokens=<total> (coder=… reviewer=…
  evaluator=…)` on the course line when any usage is present.

### Tree integrity guard (fail-closed)

After the tree walk, if `flat.length !== allPhases.length`, there is a cycle or an
orphaned `parent_phase_id`. `rollupCourse` throws rather than silently
under-reporting open P0/P1. The error message names the course id.

A cycle cannot be created in normal operation (`phase add` only adds new leaf
nodes; reparent is not exposed in SP-1). The guard is a defensive invariant.

## SP-2 `course orchestrate`

`course orchestrate` is a bounded, drive-only, single-pass orchestrator over an
active course's phase tree. It walks the current `rollupCourse` pre-order at most
once, decides a deterministic action per phase, and drives only already-linked
hitches that are allowed by the existing hitch convergence gate.

It does **not** spawn hitches, auto-close phases, close hitches, open PRs, merge
PRs, or persist course orchestration run rows. The production hitch runtime is
created without a publisher and calls `HitchOrchestrator.run(...,
stopAtCloseReady: true)`, so a ready hitch stops at `close_ready`.

This drive-only stop is used by `course orchestrate` and other drive-only callers
such as `hitch finding classify --then-rerun`; it is not the direct
`harness hitch orchestrate <hitch-id>` terminal path. A direct invocation does
have a publisher; when the hitch's required auto-verify close conditions all pass
and no required operator gate is pending, `close_ready` maps to the terminal
`close_and_pr` action. By default that action creates a draft PR; with
`--auto-merge`, it first evaluates the merge gate approval preflight. A preflight
hard blocker escalates before new PR publication; if a previous retryable pass
already published a ready PR, that PR remains open. Otherwise it creates a ready
PR, then the full merge gate may merge it, leave it open for transient blockers,
or escalate after publication if post-publish facts hard-block the merge. If a
course phase is meant to produce a reviewed diff but hold PR publication for
later aggregation, include a required operator-owned close condition such as
`kind: manual` (or `kind: operation_status` with `metadata.operationId`).
`kind: review_consensus` keeps the coder/reviewer loop from closing vacuously,
but it is still auto-verify and does not stop PR creation.

### Per-phase dispatch

`decideCoursePhaseAction` is a pure function over phase declared status, leaf-ness,
linked hitch ids with live convergence, and derived open P0/P1 counts:

At the beginning of each `course orchestrate` pass, the orchestrator fixes only
the phase tree structure: pre-order walk order, depth, and leaf/container shape.
Each phase's dispatch inputs are then read live when that phase is reached:
declared status, linked hitch ids, linked hitch convergence, and derived open
P0/P1 counts all come from the database at evaluation time. Phases added after
the pass begins are outside the fixed tree structure and become visible on the
next pass.

| Condition | Action |
|-----------|--------|
| `declaredStatus = closed` | `skip_closed` |
| `declaredStatus = blocked` | `skip_blocked` |
| no linked hitches and non-leaf phase | `container` |
| no linked hitches and leaf phase | `needs_link` (reported only; pass continues) |
| any linked hitch decision is `escalate`, `diverging`, `budget_exhausted`, or `needs_classification` | `blocked_hitch` |
| any linked hitch is allowed by `allowedByConvergence("hitch.orchestrate", convergence)` | `drive` those hitch ids |
| all linked hitches are `close_ready` / `closed` and derived open P0/P1 are zero | `ready_to_close` (derived; not stored) |
| none of the above | `report_only` |

`blocked_hitch` isolates the current top-level subtree: the phase records
`blocked_hitch`, the remaining descendants in that subtree are reported as
`blocked_subtree`, and the pass continues with the next top-level phase. This is
an escalation boundary, not a whole-course hard stop. `blocked_hitch` and
`blocked_subtree` are exit-0 structured phase outcomes; the course pass
`stopReason` remains `completed`.

The same subtree isolation also fires **after** a non-escalating drive. A
driven hitch can halt benignly (e.g. `max_steps_exhausted` after a jury classify
batch was capped at `JURY_BATCH_LIMIT`) while a blocking condition REMAINS — most
importantly unknown-scope findings keeping the hitch at `needs_classification`.
After each non-escalating drive the orchestrator re-derives the hitch's live
convergence and, if it is a blocking decision (`escalate` / `diverging` /
`budget_exhausted` / `needs_classification`), records `blocked_hitch` and
isolates the subtree just like the pre-drive gate. This is **retryable**: the
phase is not marked closed and downstream phases do not advance, so a later
invocation re-fires the same decision and continues classifying. The pre-drive
gate and the post-drive re-check share one blocked-decision set.

### Writes and stopping

The only phase status write performed by SP-2 is a CAS transition
`pending -> in_progress` immediately before the first driven hitch for that phase.
The orchestrator does not write `closed`, does not write `blocked`, and does not
store `readyToClose`.

Hard stops are limited to:

- non-active course (`paused` / `closed`) before planning or driving;
- course-pass lease busy;
- a driver/runtime exception while preparing or driving a hitch.

Course-pass budget consumption is a normal bounded-pass terminal condition, not a
hard stop. If the deterministic `drivenHitches.length >= maxDrivenHitches`
counter is reached after at least one hitch was driven in the current phase, that
phase is recorded as `partially_driven` with
`reason = partially_driven_budget_reached`, remaining phases are marked
`not_driven`, and the pass returns `stopReason = budget_reached`. If the budget is
already reached before a phase starts, that phase is recorded as `not_driven`.
Both `completed` and `budget_reached` are successful course-pass results.

The course-pass `budget_reached` stop reason is intentionally distinct from the
hitch-convergence `budget_exhausted` decision. A linked hitch whose convergence
decision is `budget_exhausted` still records a `blocked_hitch` phase outcome and
isolates the subtree, while the course pass continues and exits 0 unless a
separate fatal error occurs. Fatal course orchestration failures surface through
`CourseOrchestrateError` / unexpected exceptions, not through the course-pass
budget label.

### Budget and lease

Budgets are course-pass scoped:

- `maxDrivenHitches`: default `3`, clamped to `10`.
- `maxStepsPerHitch`: default `20`, clamped to `50`.

A drive pass takes a course lease through the existing `domain_locks` table with
`domainKey = "course:<courseId>"` and `domain = "course-orchestrate"`. A non-active
course or busy lease refuses the pass before any hitch is driven. `--dry-run` plans
the same phase actions without taking the lease, writing phase status, preparing
runners, or driving hitches.

JSON output uses `stopReason = completed | budget_reached`; the pre-1.0 contract
change from the former course-level `budget_exhausted` literal is semver-minor and
does not require a DB schema change.

The drive pass fences every course-layer write with the held lease. It heartbeats
before each hitch drive, calls the lock handle's non-extending `assertHeld`
immediately before the only course-layer CAS write (`pending -> in_progress`),
and folds the same `lock_id` / `holder_run_id` lease predicate into the phase
CAS as a single `UPDATE ... EXISTS (SELECT 1 FROM domain_locks ...)`.
If the lease is released, expired, or replaced after the pre-check but before the
CAS statement, the phase write gets zero changes; the repository rechecks the
lease predicate, reports `LeaseGuardFailedError`, and the pass aborts as
`CourseOrchestrateError("lease_lost")`.

During a long hitch drive, the course lease is also heartbeated in the background.
If that heartbeat reports lease loss the course pass normalizes the failure to
`lease_lost`; if the driven hitch/run layer surfaces a domain lock *busy*
conflict (another holder is active), it normalizes to `lease_busy`. In either
case the pass performs no further course-layer writes, and subsequent phase/hitch
work in this course pass is not started.

The in-flight hitch drive is interrupted, not run to completion (#132). A
run-scoped `AbortSignal` is threaded through the drive — course orchestrator →
hitch orchestrator → runners → codex runner. On lease loss the heartbeat aborts
it with the lease error as the abort reason, so: the hitch orchestrator stops
between steps and propagates the abort as a transient lease cause (mapped to
`lease_lost`, not an `escalated` hitch); and the in-flight codex process is
SIGKILLed (an already-aborted signal short-circuits before launching codex). A
killed codex run finalizes `failed-codex` via the existing non-zero-exit path, so
the abort is fail-closed — the spent attempt is recorded and the hitch stays in a
resumable state. The run layer's own domain lock + heartbeat remain the backstop
against same-domain concurrent execution.

Compatibility note: `hitch orchestrate` invoked underneath `course orchestrate`
does not mark the hitch `escalated` for transient domain lock / lease conflicts
(`DomainLockBusyError`, `LeaseLostError`, `LeaseGuardFailedError`). Those errors
are rethrown so the caller can stop without converting "another process is
working" into a false escalation. Coder attempts that hit those transient
conflicts are discarded as no-op attempts, so iteration/rerun budgets are not
consumed.

### Safety boundary mapping

- Project visibility and null-project fail-closed behavior are unchanged.
- `phase.link_hitch` and explicit `phase.start_hitch` are the only attach paths;
  `needs_link` is still a future auto-spawn integration point and is only
  reported by course orchestration.
- Drivability is delegated to the existing hitch mutation gate
  (`allowedByConvergence`) and each hitch drive still re-checks its own gate.
- Per-hitch repo/domain resolution is server-side via `prepareProjectRun`; clients
  do not supply repo paths to the MCP tool.
- Close/PR/spawn are deliberate follow-up operations outside this pass.

## CLI (`harness course` / `harness phase`)

Implemented in `src/cli/course.ts`, registered via `registerCourseCommands`.

### `harness course`

| Subcommand | Description |
|------------|-------------|
| `course create --title <text> [--description …] [--project <id>] [--repo-id <id>] [--created-by <actor>] [--json]` | Create a course (status=`active`). Prints `course=<id> status=active` or JSON. |
| `course list [--status active\|paused\|closed] [--json]` | List courses (tab-separated id/status/title or JSON). |
| `course show <id> [--json]` | Show a single course. |
| `course status <id> [--json]` | Walk the phase tree and print the deterministic rollup (open P0/P1 per phase + course totals). |
| `course orchestrate <id> [--max-driven-hitches <n>] [--max-steps-per-hitch <n>] [--dry-run] [--json]` | Drive eligible linked hitches in phase-tree order for one bounded pass. Dry-run prints actions only. |
| `course close <id>` | Set course status to `closed`. |
| `course export <id> --md [--out <path>]` | One-way DB → markdown view of the course roadmap. DB stays canonical; no markdown → DB round-trip. |

### `harness phase`

| Subcommand | Description |
|------------|-------------|
| `phase add --course <id> --title <text> [--parent <phase-id>] [--position <n>] [--scope-file <path>] [--close-file <path>] [--created-by <actor>] [--json]` | Add a phase. `--scope-file` / `--close-file` accept JSON or YAML. Rejects cross-course parent. |
| `phase list --course <id> [--json]` | List phases for a course (flat, ordered by position/created_at/id). |
| `phase show <id> [--json]` | Show a phase plus its linked hitch ids. |
| `phase update <id> [--status pending\|in_progress\|closed\|blocked] [--scope-file <path>] [--close-file <path>] [--allow-scope-widen] [--allow-gate-loosen] [--note <text>]` | Update a phase's declared status, scope/close conditions, and/or note atomically. Spec writes use `PhaseRepository.updateSpec()` validation/gates inside the same transaction as status and note writes. |
| `phase ratify <id> --approved-by <actor> [--reason <text>] [--json]` | Record human approval under `review_state_json.specApproval` with the current `specHash`. |
| `phase link-hitch <phase-id> <hitch-id> [--allow-scope-widen] [--allow-gate-loosen] [--json]` | Link a hitch to a phase. Rejects cross-project mismatch, double-link, and ratified-spec loosening unless explicitly allowed. Emits a warning if the phase spec hash drifted after approval. |
| `phase start-hitch <phase-id> --title <text> [--hitch-id <id>] [--description …] [--domain …] [--backlog-item-id …] [--scope-file …] [--close-file …] [--policy-file …] [--max-iterations …] [--max-review-cycles …] [--max-reruns …] [--max-total-new-findings …] [--allow-scope-widen] [--allow-gate-loosen] [--created-by <actor>] [--json]` | Create a hitch using the parent course project/repo and the phase spec by default, then link it in one transaction. Explicit scope/close overrides are checked against ratified phase specs with the same flags as `link-hitch`. |
| `phase unlink-hitch <hitch-id>` | Remove a hitch's phase link. |

### Exit codes

- `0`: success (`course orchestrate` returned `completed` or `budget_reached`;
  dry-run planned successfully)
- `1`: user-fixable error (not found / different course / already linked / project
  mismatch / invalid `--status` choice / `--position` not an integer / missing
  `--md` flag for export / non-active course / course lease busy
  / project resolution error / DB error)
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
| `harness.course.orchestrate` | `course.orchestrate` | `courseId`, `maxDrivenHitches?`, `maxStepsPerHitch?`, `idempotencyKey`, `actorNote?` | Drive eligible linked hitches for one bounded pass. Visibility-checked via course; defaults/clamps match CLI; no confirmation; does not open PRs. |
| `harness.phase.add` | `phase.add` | `courseId`, `title`, `parentPhaseId?`, `position?`, `scope?`, `closeConditions?`, `idempotencyKey`, `actorNote?` | Add a phase to a course. Visibility-checked via parent course before entering `OperationRunner`. |
| `harness.phase.update` | `phase.update` | `phaseId`, `status?`, `idempotencyKey`, `actorNote?` | Update a phase's declared status. Visibility-checked via parent course. |
| `harness.phase.ratify` | `phase.ratify` | `phaseId`, `approvedBy`, `reason?`, `idempotencyKey`, `actorNote?` | Record human approval for the current phase spec. |
| `harness.phase.link_hitch` | `phase.link_hitch` | `phaseId`, `hitchId`, `allowScopeWiden?`, `allowGateLoosen?`, `idempotencyKey`, `actorNote?` | Link a hitch to a phase. Cross-project mismatch, double-link, and ratified-spec loosening are rejected inside the operation. |
| `harness.phase.start_hitch` | `phase.start_hitch` | `phaseId`, `hitchId?`, `title`, `description?`, `domain?`, `backlogItemId?`, `scope?`, `closeConditions?`, `policy?`, budgets?, `allowScopeWiden?`, `allowGateLoosen?`, `idempotencyKey`, `actorNote?` | Create and link a phase hitch atomically. Defaults scope/close conditions from the phase. |

`course.create` / phase guarded mutations use `runMcpMutationOperation`
(idempotency ledger / operation audit / mutation budget enforcement).
`course.orchestrate` uses `runMcpOperation` so the bounded driver can resolve
per-hitch project/domain state and apply hitch gates while still recording an
audited, idempotent operation. The `idempotencyKey` is caller-supplied and
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
`setStatus`, `recordSpecApproval`, `phaseSpecApprovalStatus`, `linkHitch` (with
cross-project guard, double-link detection, ratified-spec gate, and drift
warnings), `unlinkHitch`, `hitchIdsFor`.

## Out of Scope

- Auto-spawn from a phase (`needs_link`) is a later increment. SP-2/SP-21 are
  drive-only over explicitly linked or explicitly started phase hitches.
- Course-level PR automation, phase auto-close, parallel hitch drive, durable
  `course_orchestration_runs`, and phase dependency edges are later increments.
- SP-23 does not modify GOAL_RULES.md content. The GOAL_RULES.md build rules
  (retry limits, P0-P3 classification, gates) stay as docs / prompt-context and
  are not duplicated into the DB or phase spec-review state.
- The individual roadmap features (#84–#93) build on this model in later sub-projects.
- A markdown → DB auto-importer. The old `GOAL.md` markdown roadmap has been retired
  (kept in git history); new courses/phases are created through the API.
- `course.close` / `phase.update → closed` do not require MCP `confirmation_required`
  (reversible tracking writes with no destructive or external effect).
- Phase reparent (`phase update --parent`) is not exposed; a new node added via
  `phase add` is always a leaf and cannot create a cycle.
