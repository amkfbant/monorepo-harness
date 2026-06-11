# Design: `course → phase` DB roadmap layer (SP-1)

Status: brainstorm — pending user spec review, then implementation plan.
Date: 2026-06-11.

## Problem

The harness's roadmap — large/sub phases, implementation order, scope, and
review state — lives in hand-edited markdown (`GOAL.md`, `GOAL_RULES.md`,
`docs/superpowers/plans/`). Since the harness is agent-driven and everything else
is **DB-canonical** (`.harness/harness.sqlite`), the roadmap should be too: an
agent should query and update phase/progress state from the DB rather than
parse/patch markdown by hand.

This is **SP-1**, the second sub-project of the naming/roadmap foundation. SP-0
(rename `goal`→`hitch`) is merged. SP-1 adds a `course → phase` layer **above** the
existing `hitch_*` convergence tables. SP-2 (autonomous `course orchestrate`) is a
separate later spec. The 10 roadmap-feature issues (#84–#93) land on SP-1's model.

## Settled decisions (from brainstorm)

- **Naming**: `course` (roadmap/program layer) → `phase` (大/サブ — agent-read,
  stays "phase") → `hitch` (convergence unit, already renamed in SP-0).
- **Upper layer added, not a redesign**: new `courses`/`phases` tables; the
  `hitch_*` tables and convergence logic are unchanged.
- **Model scope = roadmap STRUCTURE only**: course/phase structure + state
  (title/scope/order/status/close-conditions/review-state/hitch links). The
  GOAL_RULES.md "how to build" rules (retry limits, P0–P3 classification, gates)
  **stay as docs / prompt-context** — not duplicated into the DB (they overlap
  the hitch-level convergence policy).
- **phase ↔ hitch = loose link**: a phase is a planning/tracking node; 0..N
  hitches are linked to it. Manual linking in SP-1; SP-2 adds phase→hitch spawn.
- **Importer = API-first**: the create API is canonical; existing `GOAL.md` is
  imported by hand via the API (or kept as historical). No brittle markdown parser.
- **DB-canonical**, model-first (no autonomous driver in SP-1).

## Data model

```
course   (= roadmap / program / epic — #88 epic grouping is a course)
  └ phase  (self-referencing tree: 大 → サブ via parent_phase_id)
       └ hitch_session  (existing; 0..N linked through phase_hitches)
```

New tables (additive migration, next schema version):

- **`courses`** — `course_id` PK, `project_id` (nullable), `repo_id` (nullable),
  `title`, `description`, `status` (`active` | `paused` | `closed`), `created_by`,
  `created_source`, `created_at`, `updated_at`. The `project_id`/`repo_id` mirror
  `hitch_sessions` so the MCP `allowedProjects` visibility gate applies (P1 — see
  Project scope & visibility).
- **`phases`** — `phase_id` PK, `course_id` FK → courses, `parent_phase_id`
  (nullable self-ref; null = top-level 大 phase), `title`, `position` (int, order
  within its parent), `status` (`pending` | `in_progress` | `closed` |
  `blocked`), `scope_json` (includes/excludes, target issues/files),
  `close_conditions_json` (the phase's deterministic gates, e.g. command checks),
  `review_state_json` (phase-level reviews recorded — see Rollup), `created_by`,
  `created_source`, `created_at`, `updated_at`. A phase inherits its course's
  project scope.
- **`phase_hitches`** — link table: `hitch_id` **PRIMARY KEY** (a hitch links to at
  most ONE phase — enforced by schema, not just the repository), `phase_id` FK →
  phases `ON DELETE CASCADE`, `hitch_id` FK → hitch_sessions, `linked_at`. A phase
  has 0..N hitches.

A **self-referencing tree** (not two fixed entity types) represents 大/サブ in one
table, allows deeper splits if ever needed, and keeps #88 epic grouping at the
course level. Integrity: a phase's `parent_phase_id` must be in the same course;
no cycles (only reachable via reparent, which SP-1 does NOT expose — `phase add`
cannot create a cycle since a new node has no children; the cycle check is a
defensive guard); `(position, phase_id)` orders siblings deterministically.

The new tables are **DB-only** (no compat file export / consistency entry — same
as the `hitch_*` and `workspaces` precedent).

## Project scope & visibility (P1)

A `course` is scoped by its `project_id` (nullable) like everything else. The
course/phase MCP read + rollup tools apply the existing `ensureProjectVisible`
gate: a project-restricted client (`allowedProjects` non-empty) sees only courses
whose `project_id` is in its set; a **null-`project_id` course** (the harness's own
cross-project roadmap) is **fail-closed invisible** to restricted clients. CLI is
unrestricted (operator). `phase.link_hitch` **rejects** linking a hitch whose
`hitch_sessions.project_id` differs from the course's `project_id` (no
cross-project leak via a link); a null-project course accepts any hitch.

## API (read + write — the canonical surface)

CLI (`harness course` / `harness phase`):
- `harness course create --title … [--description …]` → course_id.
- `harness course list [--status …]` / `harness course show <id>`.
- `harness course status <id>` — walk the phase tree, **roll up** each phase's
  status + linked hitches' convergence decision/findings into a deterministic
  summary (done / in-progress / blocked / open P0-P1 counts). This rollup is the
  foundation for #84 (auto summary) and #88 (epic progress rollup).
- `harness course close <id>`.
- `harness course export <id> --md [--out <path>]` — one-way DB→markdown roadmap
  view (DB stays canonical; no markdown→DB round-trip).
- `harness phase add --course <id> [--parent <phase-id>] --title … [--position n]`.
- `harness phase list --course <id>` (tree) / `harness phase show <id>`.
- `harness phase update <id> [--status …] [--scope-file …] [--close-file …]`.
- `harness phase link-hitch <phase-id> <hitch-id>` / `phase unlink-hitch …`.

(CLI exposes `course close` / `phase unlink-hitch`; the MCP mutation surface is
deliberately narrower — create/add/update/link only — terminal/destructive ops
stay CLI-operator-driven, consistent with how `hitch.close`/`cancel` are gated.)

MCP:
- read: `harness.course.list` / `harness.course.get` / `harness.course.status` /
  `harness.phase.list` / `harness.phase.get`.
- guarded-mutation (deny-by-default `allowedOperations` allow-list; OperationRunner
  for idempotency/audit; the MCP security limiter enforces the mutation budget):
  `course.create`, `phase.add`, `phase.update`, `phase.link_hitch`.

## Rollup / state (DB-canonical)

`course status` and the read tools are **deterministic projections** over the
phase tree + linked hitch state:
- per-phase: its declared `status` PLUS the **independently derived** state of its
  linked hitches — latest convergence decision and open in-scope P0/P1 finding
  counts read live from `hitch_findings` (via `HitchRepository.listFindings`).
- per-course: aggregate (counts of phases by status; total derived open P0/P1).

**The hitch-derived counts are always read live from `hitch_findings` — never from
a stored snapshot — so a declared phase `status` cannot hide open P0/P1.** The
declared `status` is tracking metadata; the rollup surfaces both it and the live
truth side by side.

`review_state_json` records **only phase-level reviews that are NOT a hitch's own
convergence** — e.g. a codex/opus/Fable review of the phase's roadmap/plan — as
facts ("Fable large-phase review done, verdict X"). It does **not** store
hitch-derived P0/P1 counts (those are always derived, never duplicated) and does
**not** encode the build rules (retry limits / gates stay docs/prompt-context).
This keeps it from overlapping the hitch convergence policy.

## Importer / migration (API-first)

The create API is canonical. The existing `GOAL.md` is migrated by an operator/
agent **through the API by hand** (or left as a historical doc). No markdown
parser. Optionally, a one-way **generated read-only view** — `harness course
export --md <id>` renders the DB roadmap as markdown for reading/reporting — but
the DB is the source of truth (no round-trip edit-the-markdown path).

## Out of scope (YAGNI / follow-on)

- **SP-2**: autonomous `course orchestrate` (phase auto-advance, phase→hitch
  spawn, gate enforcement one level up). SP-1's links are manual.
- The GOAL_RULES.md build rules stay docs/prompt-context.
- The individual roadmap features (#84–#93) build ON this model later; SP-1 only
  provides the structure + rollup primitive they need.
- A markdown→DB auto-importer.

## Safety boundaries

The new layer does not touch the post-hoc `git diff` policy verification, MCP
`confirmation_required`, or the hitch convergence logic. course/phase `status` is
**declarative tracking metadata** (declared by the caller — operator or an MCP
client — through a guarded, audited mutation), NOT a convergence verdict: unlike a
hitch's status (synced from the deterministic `ConvergenceService`), a phase's
status is a label. The safety guarantee is therefore narrower and explicit: the
mutation is **deny-by-default + audited**, and crucially the **rollup derives open
P0/P1 live from `hitch_findings` independently of the declared status**, so a
caller cannot mark a phase "closed" to hide unresolved findings. Project
visibility is gated (Project scope & visibility). Fail-closed on tree-integrity
violations (cross-course parent / cycle / double-link are rejected — double-link
by the `phase_hitches` PK). Whether `course.close` / `phase.update`→`closed`
warrant `requireConfirmation` is decided in the plan (default: not required, since
no destructive/external effect — they are reversible tracking writes).

## Error handling

- Schema enforces FKs (course_id, parent_phase_id, hitch_id); the repository
  rejects a `parent_phase_id` from a different course and a cycle (walk to root,
  detect repeat).
- Linking a hitch already linked to another phase is rejected (or moves it,
  explicitly — decide in the plan; default: reject, require unlink first).
- `course status` on a course with no phases returns an empty rollup, not an error.

## Testing

- Migration: the new tables exist, FKs enforced, `foreign_key_check` empty.
- Repository: tree insert/walk, sibling ordering by `position`, rollup aggregation
  determinism, integrity rejections (orphan / cycle / cross-course parent /
  double-link).
- CLI: create/list/show/status/phase add/update/link round-trip; the markdown
  export view.
- MCP: read tools shape; guarded-mutation gating (deny by default, idempotent,
  audited); `course.status` rollup.
- No schema regression; full suite + typecheck green.

## Files (sketch)

- `src/db/schema.ts` — new migration (`MIGRATION_V21_STATEMENTS`: courses /
  phases / phase_hitches), `SCHEMA_VERSION` 20→21, `ALL_TABLE_NAMES` additions.
- `src/roadmap/` (new) — `CourseRepository` / `PhaseRepository`, the tree-walk +
  deterministic rollup logic (pure, testable; rollup reads `HitchRepository`
  finding/decision data live).
- `src/cli/course.ts` (new) — `harness course` / `harness phase` commands.
- `src/mcp/tools/course-tools.ts` (new) + `tool-registry.ts` entries — read +
  guarded-mutation, each applying `ensureProjectVisible`.
- docs (same-commit, spec-driven): `docs/specs/roadmap.md` (new) + a CLAUDE.md
  pointer; `docs/specs/db.md` (the migration-version table + new tables);
  `docs/specs/cli.md` (`harness course`/`phase` subcommands — cli.md is the
  canonical subcommand reference); `docs/specs/mcp.md` (the new tools).
