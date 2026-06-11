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

- **`courses`** — `course_id` PK, `title`, `description`, `status`
  (`active` | `paused` | `closed`), `created_at`, `updated_at`.
- **`phases`** — `phase_id` PK, `course_id` FK → courses, `parent_phase_id`
  (nullable self-ref; null = top-level 大 phase), `title`, `position` (int, order
  within its parent), `status` (`pending` | `in_progress` | `closed` |
  `blocked`), `scope_json` (includes/excludes, target issues/files),
  `close_conditions_json` (the phase's deterministic gates, e.g. command checks),
  `review_state_json` (which reviews ran + verdict + open P0/P1 counts — recorded
  state, not the rules), `created_at`, `updated_at`.
- **`phase_hitches`** — link table: `phase_id` FK, `hitch_id` FK → hitch_sessions,
  `linked_at`. A phase has 0..N hitches; a hitch links to at most one phase.

A **self-referencing tree** (not two fixed entity types) represents 大/サブ in one
table, allows deeper splits if ever needed, and keeps #88 epic grouping at the
course level. Integrity: a phase's `parent_phase_id` must be in the same course;
no cycles; `position` orders siblings.

## API (read + write — the canonical surface)

CLI (`harness course` / `harness phase`):
- `harness course create --title … [--description …]` → course_id.
- `harness course list [--status …]` / `harness course show <id>`.
- `harness course status <id>` — walk the phase tree, **roll up** each phase's
  status + linked hitches' convergence decision/findings into a deterministic
  summary (done / in-progress / blocked / open P0-P1 counts). This rollup is the
  foundation for #84 (auto summary) and #88 (epic progress rollup).
- `harness course close <id>`.
- `harness phase add --course <id> [--parent <phase-id>] --title … [--position n]`.
- `harness phase list --course <id>` (tree) / `harness phase show <id>`.
- `harness phase update <id> [--status …] [--scope-file …] [--close-file …]`.
- `harness phase link-hitch <phase-id> <hitch-id>` / `phase unlink-hitch …`.

MCP:
- read: `harness.course.list` / `harness.course.get` / `harness.course.status` /
  `harness.phase.list` / `harness.phase.get`.
- guarded-mutation (allowedOperations + OperationRunner: idempotency/audit/budget):
  `course.create`, `phase.add`, `phase.update`, `phase.link_hitch`.

## Rollup / state (DB-canonical)

`course status` and the read tools are **deterministic projections** over the
phase tree + linked hitch state:
- per-phase: own `status` + linked hitches' latest convergence decision and open
  in-scope P0/P1 finding counts.
- per-course: aggregate (counts of phases by status; total open P0/P1).

`review_state_json` only **records** facts ("opus sub-review done, verdict X, open
P0/P1 = N"; "Fable large-phase review done"). It does not encode the rules — the
review cadence / gates stay in docs/prompt-context. Recording it in the DB lets an
agent query "which phases still need review / have open P1" instead of re-reading
markdown.

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
`confirmation_required`, or the hitch convergence logic. course/phase status
transitions are harness-only deterministic writes (the mutation tools go through
the existing OperationRunner). No LLM output drives a course/phase state
transition. Fail-closed on tree-integrity violations (orphan/cycle/cross-course
parent are rejected).

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

- `src/db/schema.ts` — new migration (courses/phases/phase_hitches), `SCHEMA_VERSION` bump.
- `src/roadmap/` (new) — `CourseRepository` / `PhaseRepository`, the tree + rollup logic (pure, testable).
- `src/cli/course.ts` (new) — `harness course` / `harness phase` commands.
- `src/mcp/tools/course-tools.ts` (new) + registry entries — read + guarded-mutation.
- docs: `docs/specs/roadmap.md` (new), pointers from CLAUDE.md.
