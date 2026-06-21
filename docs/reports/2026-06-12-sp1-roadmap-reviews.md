# SP-1 (course→phase DB roadmap) — final review record

Branch: `feat/course-phase-roadmap` (main..ce2058e, +3,675/−105, 12 commits).
Verification (both reviews): typecheck clean, full suite **1916 passed / 1 skipped** (242 files), no skips/weakening.

This file records the two independent final reviews (Fable-5 + codex `gpt-5.5` xhigh)
for later reference. Per the operator's instruction, findings are recorded first;
the fix pass follows after both reviews are in.

---

## Review A — Fable-5 (final gate, 2026-06-12)

Scope: cross-cutting safety, behaviour-unchanged, completeness, docs, merge-readiness.
Task 1–3 (DB core) pre-approved at the mid checkpoint; Task 4/5 Opus-reviewed + P1/P2 fixed.

### Verdict: ✅ merge 可 — P0/P1 ゼロ

### Verified clean
- **Visibility gate (all 5 read paths)**: `courseGet/courseStatus/phaseList/phaseGet` gate via the parent course's `ensureProjectVisible`; `courseList` filters restricted clients by `allowedProjects` (null-project course excluded). Registry-layer `resolveCourseProjectId`/`resolvePhaseProjectId` (`src/mcp/tools/course-tools.ts:172-209`) map both unknown-id and null-project to a sentinel → `permission_denied`, so the existence oracle (exists-but-denied vs not-found) does not leak. Two-layer gate.
- **null-project course write**: `courseCreateTool` rejects a restricted client's null-project create (`course-tools.ts:236`). Fail-closed.
- **rollup live-derive**: `openCounts` reads `hitch_findings` with `limit: 100_000` each call (`src/roadmap/rollup.ts:32-37`); `HitchRepository.listFindings` does not cap limit (`src/hitch/repository.ts:969`) — no >200 hole. "declared closed cannot hide open P1" test at `tests/unit/roadmap/rollup.test.ts:20`.
- **tree integrity fail-closed**: walk-reached ≠ total phases → throw (`rollup.ts:112`); cycle-injection test present.
- **idempotency-key corruption (Task 5 P1) fixed**: `d5ff9df` changed `args: redactMcpAuditValue(args)` → `args`; redaction only on the wrapper's audit `input` (`operation-wrapper.ts:59`); regression test (2nd distinct-key link not a replay) at `course-tools.test.ts:255`.
- **deny-by-default**: `decideMcpPermission` denies operations not in `allowedOperations` (`permissions.ts:128`); deny tests for course.create / phase.add / phase.link_hitch.
- **cross-project / double-link**: repo rejects hitch.project ≠ course.project; PK violation caught only on `SQLITE_CONSTRAINT_PRIMARYKEY`, else rethrow (`phase-repository.ts:92-104`); both tested.
- **behaviour-unchanged**: v21 purely additive (3 tables + indexes, zero existing-table change). `runMcpMutationOperation` is a verbatim extraction of `runHitchOperation`; hitch callers pass raw args unchanged.
- **docs**: `roadmap.md` (new) / db.md (v21 + 3 tables) / cli.md / mcp.md / CLAUDE.md all match the code.
- **scope**: no SP-2 elements (auto-advance / spawn) in code; rollup is sufficient as #84/#88 foundation.

### Findings
- **P0 / P1: none.**
- **P2-1**: CLI `course status <missing-id>` returns a clean empty rollup at exit 0 (no `courses.require(id)` in the status action — `src/cli/course.ts:189-209`; `course show`/`export` do call require at :237). A typo'd id prints `openP0=0 openP1=0`, mis-readable as "all clear". MCP path is safe (`repo.get` pre-check). Fix: add `courses.require(id)` to the CLI status action (or existence-check in `rollupCourse`). Operator-CLI-only ⇒ not a merge blocker, but **must fix before SP-2/#84/#88 build on the primitive**.
- **P3-1**: `linkHitch` mismatch error embeds the hitch's `project_id` (`phase-repository.ts:93`) — a restricted MCP client knowing a hitch UUID could infer its project. Generalize the message.
- **P3-2**: CLI `phase update --scope-file` sets `updated_at` via `datetime('now')` (`course.ts:382`), inconsistent with other writes' ISO-8601 `toISOString()` (roadmap.md says ISO-8601).
- **P3-3**: `courseMetadata` stores the raw idempotencyKey in operation metadata (audit `input` redacts it — asymmetric). Mirrors existing `hitchMetadata` (`hitch-tools.ts:953`); not an SP-1 regression. Note for a future redaction-policy cleanup.
- **P3-4**: no explicit deny-by-default test for `phase.update` (add/link/create have one; shared registry logic ⇒ low risk).
- **P3-5**: CLI `phase unlink-hitch` is a silent success for an unlinked/unknown hitch (idempotent delete; undocumented).

---

## Review B — codex `gpt-5.5` (model_reasoning_effort=xhigh, read-only, 2026-06-12)

Scope: same SP-1 diff (`main...HEAD`). codex caught issues Fable rated only ✅/P3 —
the reason both reviews were run.

### Verdict: **NO (merge blocked)** — 1 P0 + 2 P1

- **P0 — `src/roadmap/rollup.ts:32` `openCounts` counts only `lifecycleStatus:"open"`, dropping `reopened`.** Existing convergence treats BOTH `open` and `reopened` as open blockers (`src/hitch/convergence.ts:15`, counts P0/P1 from that set at `:100`). A **reopened** in-scope P0/P1 therefore disappears from `course.status`, letting a declared-closed phase hide live blockers — violates the SP-1 "declared status cannot hide findings" invariant.
  Fix: count `lifecycle_status IN ('open','reopened')` for in-scope P0/P1; add a rollup test for a reopened P1 under a closed phase.
- **P1 — `src/mcp/tools/course-tools.ts:238` `course.create`/`phase.add` generate the operation `target.id` BEFORE `runOperation`, but the repositories generate a DIFFERENT random row id** (`course-repository.ts:28`, `phase-repository.ts:37`). Idempotency replay keys include `target.id` (`operation-runner.ts:84`), so retrying the same create/add with the same `idempotencyKey` uses a new target id → **can create duplicates**; audit target/metadata also won't match the actual created row.
  Fix: make create/add target ids stable and reuse the same id for the row insert (derive from op-type + idempotency key, OR let repos accept a caller-supplied id). Add replay tests for `course.create` and `phase.add`.
- **P1 — `src/roadmap/rollup.ts:36` rollup uses a capped `listFindings(... limit: 100_000)`, and `listFindings` always applies `LIMIT` (`src/hitch/repository.ts:969`)** — can silently under-report P0/P1 on a very large hitch.
  Fix: replace the row-fetch/filter with a SQL aggregate `COUNT` over `hitch_findings` (no reporting cap). (Subsumes the P0 fix: one aggregate query with `scope_status='in_scope' AND lifecycle_status IN ('open','reopened') GROUP BY severity`.)

### Verified clean (codex)
No cross-project / null-project leak in the 5 roadmap read tools or rollup. The
`runMcpMutationOperation` extraction is behaviour-identical to the old
`runHitchOperation`. No SQL injection in the reviewed paths.

---

## Reconciliation & fix plan (both reviews)

codex found a **P0 + 2 P1** that Fable missed (Fable's spot-checks of the rollup/
idempotency didn't exercise reopened findings or create/add replay). Fix order:

1. **codex P0 + P1(limit)** — rewrite `openCounts` (rollup.ts) as a SQL aggregate
   `COUNT(*) … WHERE scope_status='in_scope' AND lifecycle_status IN ('open','reopened') GROUP BY severity`,
   no cap. Add a rollup test: a **reopened** P1 under a declared-`closed` phase
   still surfaces.
2. **codex P1(idempotency target id)** — generate the course/phase id ONCE in the
   MCP tool and reuse it for both `target.id` and the repo insert (repos accept an
   optional caller-supplied id). Replay tests for `course.create` / `phase.add`.
3. **Fable P2-1** — `course status <missing-id>` must error (CLI: `courses.require(id)`).
4. **P3s (defer or quick)**: Fable P3-1 (linkHitch message leaks hitch project_id),
   P3-2 (`updated_at` `datetime('now')` vs ISO-8601), P3-4 (phase.update deny test),
   P3-5 (unlink silent-success doc) — fix the cheap ones; defer the rest to
   `docs/future-features.md`.


---

## Review C — codex GitHub App (PR #109, reviewed commit `2f5a84102b`, 2026-06-12)

The codex GitHub App auto-reviewed the PR after open. One inline finding:

- **P1 — `src/mcp/tools/course-tools.ts:217` cross-resource idempotency-key collision.**
  `courseIdForIdempotencyKey`/`phaseIdForIdempotencyKey` hashed the `idempotencyKey`
  ALONE into `target.id`. The OperationRunner replay key is
  `(operation_type, target_id, idempotency_key)` with NO project/client dimension,
  so two project-scoped clients reusing the same `idempotencyKey` for `course.create`
  (or `phase.add`) collide → the second is treated as a replay of the first and
  returns the OTHER project's course/phase, leaking out-of-scope roadmap data past
  the permission gate. Distinct from the codex-exec P1 (target-id vs random-row-id
  mismatch) — this is the cross-CLIENT collision angle the earlier fix did not close.
  **Fixed (029b0c6)**: fold resource scope into the hashed material — course scoped
  by project, phase by parent course (`scopedIdForIdempotencyKey`, NUL separator).
  Same-scope+same-key still replays; cross-scope+same-key now yields distinct ids.
  Regression tests added. The parallel pre-existing pattern in `hitch.start` is
  deferred to `docs/future-features.md` (out of this PR's scope).

### codex App round 2 (reviewed commit `029b0c6301`, 2026-06-12)

After the first codex App P1 fix, codex App re-reviewed and found a second, distinct P1:

- **P1 — `phase.link_hitch` did not gate the SOURCE hitch's project.** The tool
  authorizes only on the destination `phaseId` (registry `resolvePhaseProjectId`),
  leaving the source hitch unchecked. A client scoped to project A could submit
  arbitrary hitch IDs from other projects and (a) distinguish "not found" from
  "different project" via the business-logic error (existence/membership oracle)
  and (b) get the out-of-scope hitchId written into the failed-operation audit
  input/metadata. **Fixed (this commit)**: resolve the hitch's project and apply
  `ensureProjectVisible` BEFORE `runMcpMutationOperation`; an unknown hitch maps to
  a sentinel so not-found and forbidden return the same `permission_denied` shape
  for restricted clients, and nothing about the hitch is audit-logged. Unrestricted
  operators still get the descriptive cross-project/not-found errors. Regression
  test asserts forbidden==unknown shape and zero audit rows referencing the hitchId.

Also addressed (automated security review, MEDIUM): `scopedIdForIdempotencyKey`
material switched from NUL-joined `scope+key` to `JSON.stringify([scope, key])`
for unambiguous, injection-proof framing and a clean null-vs-empty distinction.

### codex App round 3 (reviewed commit `7cb1b17f`, 2026-06-12)

codex App re-reviewed after the link_hitch fix; only one new finding, a **P2** of
the same oracle class:

- **P2 — `phase.add` did not gate an out-of-scope `parentPhaseId`.** A restricted
  client adding to a VISIBLE course could pass a `parentPhaseId` from another course;
  `PhaseRepository.add` then threw `parent phase ... is in a different course` / `not
  found`, exposing whether that id exists and audit-logging it. Fixed in the same
  family as the link_hitch gate: resolve the parent phase's owning project and apply
  `ensureProjectVisible` BEFORE the mutation (sentinel for unknown → not-found and
  forbidden indistinguishable for restricted clients; no audit leak). Chose to fix
  (not defer) since it's the twin of the link_hitch P1 and the fix is cheap +
  consistent. Regression test mirrors the link_hitch probe test.

### codex App round 4 (reviewed commit `749128d`, 2026-06-12)

codex App found the handler-level secondary gates (rounds 2–3) were placed too late
for the confirmation flow — two **P2**s:

- **P2 — `phase.add` / `phase.link_hitch` secondary gate bypassed under
  `requireConfirmation`.** The generic confirmation branch in `src/mcp/server.ts`
  builds the preview and writes the confirmation record (`mcp_confirmation_requests`,
  `input_json = parsed.data`) BEFORE the handler runs. A handler-level visibility
  pre-check therefore never executes on the initial call, so a restricted client could
  force an out-of-scope `parentPhaseId` / `hitchId` into the confirmation/audit record.
  **Fixed**: moved the secondary-resource gate UP to the PERMISSION layer — new
  `resolvePhaseAddProjectId` / `resolvePhaseLinkHitchProjectId` return the unresolved
  sentinel when the secondary resource is not visible to a restricted client, so
  `decideMcpPermission` denies with `project_not_allowed` BEFORE the confirmation
  record or handler (it checks `isProjectAllowed` before the requireConfirmation
  branch — `permissions.ts:77`). The now-redundant handler pre-checks (rounds 2–3)
  were removed; the permission layer is the single gate covering both the
  confirmation and non-confirmation paths. New regression tests assert: out-of-scope
  secondary under `requireConfirmation` → `permission_denied` + zero
  `mcp_confirmation_requests` rows referencing the id; in-scope secondary still
  proceeds to `confirmation_required`.

### codex App round 5 (reviewed commit `3478ec5`, 2026-06-12)

Same confirmation-bypass class, now for `course.create` — one **P2**:

- **P2 — `course.create` null-project create not denied before confirmation.**
  `course.create` used `projectIdFromArgs: (args) => args.projectId`; a restricted
  client omitting `projectId` yielded `undefined`, and `isProjectAllowed` treats
  null/undefined as project-agnostic (`true`). Under `requireConfirmation` the server
  enqueued an unactionable confirmation before `courseCreateTool`'s fail-closed
  `ensureProjectVisible(null)` rejection — violating the null-project fail-closed rule
  and letting restricted clients queue junk human confirmations. **Fixed**: replaced
  `projectIdFromArgs` with `resolveCourseCreateProjectId`, which returns the unresolved
  sentinel for a restricted client's null-project (omitted projectId) create, so
  `decideMcpPermission` denies at the permission layer before the confirmation record.
  Operators (unrestricted) may still create null-project courses and reach confirmation.
  Regression tests: restricted null-project create under requireConfirmation →
  permission_denied + zero confirmation rows; operator null-project create still
  confirmation_required.

### codex App round 6 (reviewed commit `7fd85c4`, 2026-06-12)

One **P2**, repository-layer (not a security boundary this time):

- **P2 — `PhaseRepository.add()` did not validate course existence.** With no
  parentPhaseId and an unknown `--course`, the CLI `harness phase add` fell through to
  the INSERT and raised a raw `FOREIGN KEY constraint failed`, which `courseError`
  does not classify as not-found → an internal DB error leaked instead of the
  documented `course ... not found`. (The MCP handler already pre-checks.) **Fixed**
  (implemented via `codex exec gpt-5.5 high` per operator instruction): course-existence
  guard in `add()` throwing `course ... not found` before the insert; TDD regression
  test in `tests/unit/roadmap/repository.test.ts`.

### codex App round 7 (reviewed commit `a1f657b`, 2026-06-12)

One **P2**, CLI not-found consistency (same family as Fable P2-1):

- **P2 — `harness phase list --course <typo>` returned an empty success.** A
  mistyped/deleted course was indistinguishable from a real course with no phases,
  whereas MCP `phase.list` and the other CLI subcommands report `course ... not found`.
  **Fixed** (codex exec gpt-5.5 high): `phase list` calls `courses.require(courseId)`
  before `listForCourse` → exit 1 with the not-found error; TDD integration test.
