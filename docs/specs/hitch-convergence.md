# Hitch Convergence Controller

Phase 19 adds a DB-backed control plane for long-running coding-agent hitches.
It answers whether a hitch has converged, needs another bounded fix pass, should
defer new findings, or must stop for human classification/escalation.

Implementation status: Phase 19 is implemented as schema v16 plus repository,
CLI, MCP, run/review integration, and a simulated hitch-loop fixture matrix.
The source of truth is `.harness/harness.sqlite`; compatibility files remain
outside this feature's authority.

## Problem

Iterative agent loops can drift:

```txt
implement -> review -> fix -> review finds unrelated work -> fix -> ...
```

The harness already records runs, review proposals, operations, backlog items,
MCP confirmations, and budgets. Phase 19 ties those primitives to one explicit
hitch session so the loop has a bounded close condition.

## Core Rules

Close conditions are evaluated before opportunistic review expansion. If the
original close conditions pass and only out-of-scope, accepted-risk, or deferred
follow-up findings remain (including out-of-scope findings that were escalated),
the hitch may close. Open, reopened, or escalated in-scope/unknown P0/P1 findings
are active blockers and cannot be treated as ordinary deferred work.

Hitch scope is frozen at session start:

```txt
scope includes: target files/domains/operations, allowed categories, close criteria
scope excludes: unrelated refactors, future features, opportunistic cleanup
```

Every finding is classified:

```txt
in_scope
out_of_scope
duplicate
unknown
```

`unknown` findings are not auto-fixed by default. They require a classification
step or human escalation.

Review mode narrows over time:

```txt
initial -> delta -> close
```

Regression/manual reviews can be recorded explicitly, but they do not
automatically expand the hitch.

Mode semantics:

```txt
initial:
  review the full frozen hitch scope against close conditions

delta:
  verify the previous fixes and changed files; unrelated new findings default
  out_of_scope unless they clearly block the original close conditions

close:
  answer whether the original hitch can close; do not add new scope except
  P0/security-critical findings, which escalate instead of extending the loop

regression:
  check existing safety boundaries, tests, and policy gates without expanding
  the hitch
```

## Data Model

Schema v16 stores:

```txt
hitch_sessions                 top-level hitch scope, close conditions, policy, budget
hitch_attempts                 implementation/fix/validate/close-check attempts
hitch_review_cycles            review mode and finding counts per cycle
hitch_findings                 deduped finding lifecycle and scope classification
hitch_close_checks             latest evidence for close conditions
hitch_convergence_decisions    audit trail of continue/close/escalate decisions
```

Hitch sessions link outward to projects, repos, domains, backlog items, run ids,
and operation ids. The hitch tables are the lifecycle authority for convergence;
they do not replace the run/review/operation tables.

## Finding Lifecycle

Findings have both a scope classification and a lifecycle status:

```txt
open -> fixed -> reopened
open -> deferred
open -> escalated
open -> accepted_risk
open -> duplicate
```

The dedup key is a deterministic hash of normalized file path, symbol,
category, and summary. Semantic clustering is not part of Phase 19.

Out-of-scope findings default to deferred follow-up. A deferred finding may
create a backlog item and stores the linked item id.

## Convergence Decisions

Evaluation is deterministic and conservative:

1. Terminal sessions stay terminal — with one exception. `closed` / `cancelled`
   are hard-terminal, and `budget_exhausted` / `escalated` are operator-gated
   (require an explicit `reopen`). `diverging`, however, is **re-derived live, not
   cached** (#164): a stored `diverging` status does not short-circuit evaluation
   — the divergence circuit breaker (rule 4) is re-run against current metrics, so
   a divergence whose trigger no longer holds **self-clears** and the hitch
   returns to normal flow (the status syncs off `diverging` back to `in_progress`
   / `close_ready`). A still-active trigger simply re-derives to `diverging`.
2. Iteration/review/rerun budgets are enforced.
3. Open in-scope P0 escalates.
4. Growing finding counts or reopened churn is `diverging`. Divergence churn
   is derived from recorded finding rows that carry a `source`. It counts only
   harness-origin findings (`review`, `test`, `doctor`, `codex`, and
   fail-closed `other`) and excludes operator-origin findings (`human`, `mcp`).
   Operator-origin findings still count for close blockers: open in-scope P0
   escalates, open in-scope P1 blocks close, and configured P2 /
   unknown-scope blockers are enforced. A finding's divergence origin is the
   first-seen `source` / `source_cycle_id`; later duplicate upserts do not move
   it between operator and harness origin. Summary-only cycle completion counts
   such as `hitch review-cycle complete --findings-new` do not drive
   divergence because they are source-blind and cannot distinguish harness from
   operator findings. The orchestrate review-import path records harness-origin
   (`review`) finding rows, so the automated review loop always feeds the
   circuit breaker. MCP `record_findings` also records source-bearing rows, but
   as operator-origin (`mcp`), which (by design) block close yet do not drive
   divergence.
5. Passed fresh required close checks plus configured `closeRequires` blockers clear is `close_ready`.
6. (#104/#197) An **unreviewed** coder run — the latest coding attempt
   (implement/rerun) is newer than the latest review cycle — is **reviewed**
   (`continue` → `run_review`) before routing to another rerun,
   classification, or fix pass. Two placements: (#104) ordinary **under-budget**
   reviews happen after the budget-limit gate; (#197) when the soft budget LIMIT
   has been reached, a latest coding attempt whose deterministic DB status is
   `succeeded` **and that carries a `runId`** is reviewed once — gated on an
   actual `budgetLimitReason` (so it does not shadow the #104 branch) and on
   remaining review-cycle budget (so it cannot loop) — before the `>=`
   budget-limit `budget_exhausted` stop, so its successful work is not discarded.
   The strict `>` over-budget (EXCEEDED) stop, P0 escalation, divergence, and
   close_ready all precede it and still win. A failed, running, pending, or
   cancelled final coding run — or a succeeded one without a `runId` (the review
   runner reviews the latest coding attempt that has a run) — is not reviewable
   here and still stops at budget (or follows the failed-run recovery path), so
   an open finding cannot drive endless reruns that never review the fix that
   would clear it.
7. Unknown-scope findings block automation when policy requires it.
8. Open in-scope P1 needs a fix.
9. Failed required close checks need a fix.
10. Un-deferred out-of-scope findings require `defer_followups` when policy requires deferral.
11. If the most recent coding attempt (implement/rerun) ended `failed` (e.g. a
    `failed-command` run that never reached `needs_review`), the decision is
    `needs_fix` with `fix_findings` — route to a bounded recovery rerun rather
    than to review (review on a non-`needs_review` run would throw and dead-end
    the hitch). The rerun budget (step 2) terminates this as `budget_exhausted`
    if the run cannot be recovered. The recovery rerun's coder goal carries the
    failed run status so it fixes the cause instead of re-coding blind.
12. If a required `review_consensus` close check is not passed (e.g. stale after
    an approved run), the decision is `continue` with `run_review` (bounded by
    the review-cycle budget) so the review runner refreshes the consensus
    evidence — for an already-approved run via the short-circuit above. Routing
    such a condition to the command close-check runner would mishandle it (that
    runner only executes `kind: command` conditions).
13. If a required command close-check is runnable (`pending`, `skipped`, or
    `unknown`), the decision is `continue` with `run_close_check` (record fresh
    command evidence). Required `failed` close-checks still route to
    `needs_fix` first so the next coder pass fixes the failure before the
    command is re-run.
14. If the only remaining required close checks need external/operator evidence
    (`manual`, `artifact_exists`, `operation_status`, or another non-command
    condition), the decision is `continue` with `ask_human`; the orchestrator
    waits for recorded evidence and does not auto-escalate by invoking the
    command runner with no runnable command.

Recorded close-check evidence is fresh only when it is at or after the latest
invalidating hitch event: a non-close-check attempt, finding seen/fixed/deferred
transition, or completed review cycle. Stale passed evidence is treated as
pending and the next action is to record fresh close-check evidence.

Hitches with no close conditions are not close-ready by default. Set
`policy.allowEmptyCloseConditions: true` only for hitches where an empty close
condition list is intentional.

Decision values:

```txt
continue
needs_fix
needs_classification
close_ready
closed
diverging
budget_exhausted
escalate
cancel
```

## Deliberation Jury (Classification, #230)

When convergence routes to `needs_classification`, the in-loop classify runner
resolves open + `unknown`-scope findings. Two resolution paths exist and are
mutually exclusive per finding:

- **Heuristic + operator-manual** — the frozen-scope classifier
  (`classifyFindingForHitch`) and operator `classify_finding` mutations. This is
  the only path used by the standalone CLI `harness hitch finding classify` and
  MCP `harness.hitch.classify_finding`. Those entry points do **not** run the
  jury (R13): standalone callers carry no reviewer runner, run worktree, or
  audit context, so they stay on the deterministic heuristic boundary
  (fail-closed). The jury runs **only** in the orchestrate-driven classify
  runner (`src/hitch/jury/classify-runner.ts`), reached through
  `harness hitch orchestrate` / `harness.hitch.orchestrate` /
  `harness course orchestrate`.

- **Deliberation jury** — for a finding that is **harness-origin AND still
  `unknown` after the heuristic**, the orchestrate classify runner runs a
  5-stage deliberation. Operator-origin (`human` / `mcp`) `unknown` findings are
  **never machine-classified** (R5); they are bundled into the escalate packet as
  `operator_origin_unknown` for manual classification.

The classify runner is structured in 3 DB phases so the LLM never holds the DB
open (design §3 invariant 4): **Phase 1** (DB open, synchronous) drains
heuristic-resolvable findings and snapshots the still-`unknown` jury candidates +
operator-origin findings, then closes the DB; **Phase 2** (DB closed) runs the
LLM deliberation per candidate in memory; **Phase 3** (DB re-open) persists the
audit rows, re-verifies state, freshness-checks file citations, and classifies or
escalates.

### The 5-stage deliberation pipeline

Each finding is deliberated independently (`deliberate.ts`):

1. **Stage 1 — PROPOSE** (LLM, DB closed, 3 lenses). Three lenses
   (`correctness`, `scope_fit`, `spec_adherence`) each propose a scope
   *independently* (no shared view): `{ proposedScope, proposalStatus,
   evidence[]{citation,kind,claim}, refutationCondition, uncertainty, reasoning,
   confidence?, proposedSeverity? }`. This is round 1.

2. **Stage 2 — EVIDENCE-CHECK** (deterministic, no LLM, read-only). The harness
   recomputes each citation's existence via `verifyEvidence`. The model's
   self-asserted `verified` flag is ignored and re-derived. A proposal with no
   verified evidence is treated as inconclusive (fail-closed). Unresolvable
   citations surface in the packet's `unvalidatedAssumptions[]`, never in the
   evaluation axes. (Stage 2 is woven into the Stage-1/Stage-3 proposer output —
   the proposer returns already-`verifyEvidence`-d proposals.)

3. **Stage 3 — CRITIQUE** (LLM, conditional). The critique round runs **iff
   round 1 is non-unanimous (`split`)**. A clean unanimous round 1 skips straight
   to Stage 4. (The "unanimous but weak evidence" trigger is unreachable and was
   removed: a lens is `complete` iff it carries ≥1 verified evidence, so a lens
   with zero verified evidence is `inconclusive`, which already makes round 1
   non-unanimous — and critique cannot manufacture verified evidence anyway.)
   When it runs, each lens sees the others' proposals + evidence,
   raises a concrete objection, and re-votes (round 2), recording `voteChanged` /
   `critique`. **Convergence after critique does NOT auto-confirm**: the
   post-critique round is re-aggregated, and a post-critique unanimous set still
   must pass Stage 4 + Stage 5.

4. **Stage 4 — REFUTE** (LLM, adversarial, conditional). The refuter runs **only
   when the selected final round is unanimous AND every final-round proposal
   carries verified evidence**. It receives the unanimous verdict, each lens's
   `refutationCondition`, the verified evidence, and (only when critique ran) who
   changed their vote, and attacks the consensus — explicitly probing for false
   consensus by conformity. It returns `{ refuteVerdict: uphold | refute |
   inconclusive, reasoning, counterEvidence? }`.

5. **Stage 5 — AGGREGATE** (deterministic gate, `aggregateDeliberation`). The
   sole arbiter (see below).

The final round handed to the gate is selected deterministically by
`selectFinalRound`: if any round-2 proposal exists, the target round is 2 and
**every** lens must supply a round-2 proposal; otherwise the target round is 1.
Missing lenses, duplicate `(lens, round)` rows, and partial round-2 mixes are
**not** silently repaired — the resulting set fails `aggregateJuryVotes`'
unanimity test and the gate escalates.

Per-finding codex cost: a clean unanimous finding costs 3 (propose) + 1 (refute)
= 4 calls (critique skipped); a non-unanimous (split) finding costs 3 + 3
(critique) + 0–1 (refute) = 6–7 calls.

### Monotonic, fail-closed invariants (the safety backbone)

The deliberation can only *add* safety; it can never relax a decision (design
§3, mirrored in the harness safety boundary):

0. **Two deterministic deciders, MECE over the finding population — no LLM
   utterance ever drives a classification.** Every open + `unknown` finding is
   resolved by **exactly one** of two *deterministic* (non-LLM) deciders, and the
   two cover the population without overlap:
   - **The deterministic heuristic** (`classifyFindingForHitch`, non-LLM, Phase 1):
     clear-cut **harness-origin** findings the frozen-scope classifier can resolve
     (e.g. a target-file / category / glob hit) are classified **BEFORE the jury
     ever runs** and the scope is written **directly** (`repo.classifyFinding`).
     The jury is **bypassed** for these — no proposer/critique/refuter call, no
     jury audit rows. (Operator-origin `unknown` findings are also handled here:
     they are never machine-classified at all — bundled to escalate, R5.)
   - **The deterministic gate** (`aggregateDeliberation`, Stage 5): only the
     **jury-candidate** findings — harness-origin AND still `unknown` *after* the
     heuristic — reach the jury, and their scope is decided **solely** by the
     deterministic Stage-5 gate over verified evidence.

   So the **"deterministic gate is the sole arbiter"** invariant is scoped to the
   **jury-candidate** findings; the heuristic-resolvable findings are arbitrated by
   the (equally deterministic) heuristic. In BOTH paths the decision is made by
   deterministic harness logic — an LLM proposal / critique / refutation is only
   ever *advisory input* to the gate, never the decider. There is no third path
   and no overlap: a finding is either heuristic-resolved, jury-arbitrated, or
   (operator-origin) escalated.

1. **No split → auto_confirm path exists structurally.** LLM speech can never
   turn a split into an auto-confirm. The post-critique convergence still passes
   the refuter and gate. The refuter can only `uphold` (does not block the gate)
   or `refute` / `inconclusive` (veto).

2. **The deterministic gate (`aggregateDeliberation`) is the sole arbiter** of
   `auto_confirm` vs `escalate`. It auto-confirms **iff** the scope is unanimous
   (`aggregateJuryVotes` is the authority — it already subsumes 3-distinct-lenses
   + zero-inconclusive) AND every proposal has verified evidence AND every
   proposal has at least one verified+proximate citation AND the refuter
   `uphold`s. Everything else escalates. The gate is pure (same input → deep-equal
   output, no IO, no state). `confidence` never drives the decision (no float
   gate). A missing (never-run) refuter (`refuterUpheld === null`) vetoes. Before
   the gate runs, `deliberate` asserts every final-round proposal's evidence is
   `VerifiedJuryEvidence` and throws (fail-closed) on a violation — a
   programming-error guard, not an LLM behavior.

3. **State transitions stay harness-only.** `repo.classifyFinding` runs **only**
   on a Stage-5 `auto_confirm` (never from LLM output), and only after Phase 3
   re-verifies the finding is still `unknown` + open and re-stats its file
   citations. Hitch status syncs deterministically via
   `recordConvergenceDecisionWithStatus`. The LLM never writes finding scope /
   severity / lifecycle / hitch status.

4. **Evidence is verified deterministically.** Hallucinated citations are
   rejected in Stage 2; the gate never trusts the model's evidence claim.

5. **Severity is never auto-modified.** `auditSeverity` returns the harness
   severity unchanged; divergence only sets an `escalate` flag and a packet
   record for human review (see severity precedence below).

The DB is open only during Phase 1 (synchronous snapshot) and Phase 3
(append-only audit persistence + classify), and closed for the whole LLM
deliberation, mirroring the reviewer path.

### RACI: Decision Transitions

Accountable is exactly one role per row. Jury stages and the non-jury
convergence paths (P0 / budget / divergence) are both covered.

| Decision transition | Responsible (R) | Accountable (A) | Consulted (C) | Informed (I) |
|---|---|---|---|---|
| Do not machine-classify operator-origin `unknown` | classify runner (source filter) | **operator** | — | audit trail |
| Stage 1 independent proposals (DB closed) | jury proposers (LLM input layer) | harness classify runner | reviewer context | audit (proposals / audit dir) |
| Stage 2 evidence existence check | `verifyEvidence` (deterministic) | harness classify runner | worktree / policy / specs | audit (evidence JSON) |
| Stage 3 mutual critique + re-vote | jury proposers (LLM input layer) | harness classify runner | other lenses' proposals | audit (round-2 rows) |
| Stage 4 adversarial refute | refuter (LLM input layer) | harness classify runner | refutation conditions / verified evidence | audit (refutations) |
| Stage 5 `auto_confirm` → scope set | `aggregateDeliberation` (pure) | harness classify runner (txn) | session policy snapshot | audit trail |
| Stage 5 `escalate` (packet persisted) | `aggregateDeliberation` + orchestrator (record) | **operator** | harness convergence | dashboard, escalation log |
| Severity divergence (advisory) → packet record | `auditSeverity` (deterministic) | **operator** | harness mapping (authoritative) | escalate / advisory packet |
| Operator overrides an auto/classification | operator (CLI/MCP **guarded-mutation** `classify_finding`) | **operator** | jury reasoning (packet) | audit (`created_by` / actor note) |
| P0 open → `escalate` (non-jury) | convergence | harness convergence | — | operator |
| `budget_exhausted` → stop (non-jury) | convergence | harness convergence | — | operator |
| `diverging` → `escalate` (non-jury, harness-origin only) | divergence circuit breaker | harness convergence | divergence policy | operator |

Override is the `harness.hitch.classify_finding` guarded mutation
(`kind: "mutation"`, outside the dangerous / confirmation-required list) —
guarded-mutation mode + permission snapshot + audit. It is not bypassed by a
raw shell mutation.

### HitchDecisionPacket v2

Escalations carry a consultant-grade MCDA decision packet
(`packetVersion: 2`) persisted into the escalating
`hitch_convergence_decisions` row's `recommended_next_action`. The v2 shape
(`src/hitch/jury/decision-packet.ts`):

- `decisionKinds` is a **plural** array — `classify_scope`, `severity_audit`,
  and/or `operator_origin_unknown` — so a mixed harness/operator batch never
  hides one side's required action.
- There is **no top-level `packet.deliberationId`**. Each `findings[]` entry
  carries its own `deliberationId` and `origin` (`harness` / `operator`), so one
  packet can bundle several deliberations and each finding maps to its own audit
  rows.
- `recommendation.action` ∈ {`classify_manually`, `review_split`,
  `review_severity`}; MCDA fields include `evaluationAxes[]` (per-lens votes +
  consensus), `deliberation` (`critiqueRan` / `refuter` / `gateTrace`),
  `rejectedProposals[]`, `minorityView`, `riskFlags[]`,
  `unvalidatedAssumptions[]` (UNVERIFIED citations only — R1), `nextActions[]`
  (one per finding, none hidden), and optional `severityAudit`.

Pre-v2 (`packetVersion: 1`) packets remain in older
`hitch_convergence_decisions` rows. Readers of `recommended_next_action`
(dashboard read API, MCP, CLI `listDecisions`) are packet-shape-agnostic:
`decisionPacket` is stored verbatim and discriminated by `packetVersion`, so a
v2 reader treats the v2-only `deliberation` / evidence fields as `undefined`
when reading a v1 row.

**Severity precedence.** The **harness severity mapping is authoritative** and
is never changed by the jury. `auditSeverity` is advisory-only: it records
whether the jury's strict-majority severity vote is `aligned`, `diverged`, or
`inconclusive`. A `diverged` / `inconclusive` audit on an **auto-confirmed**
finding does NOT escalate the hitch — the orchestrator records a
status-neutral advisory `severity_audit` packet once
(`updateStatus: false`, a non-blocking `continue` decision so the
course/phase rollup is untouched) so an operator can review the divergence
while the classification stands.

### `verifyEvidence` guarantees and its limit

`verifyEvidence` (`src/hitch/jury/evidence.ts`) is deterministic, read-only IO
(no SQLite, no network — same input + same context → deep-equal output). It
ignores any model-supplied `verified` flag and recomputes existence:

- `file` (`<path>[:line[-line]]`): the path resolves under the run worktree as a
  file, and any cited line is within range. `resolvedRef` is the absolute path.
- `spec` (`<md-path>#<anchor>`): the md is covered by `specDocsGlobs` (default
  `docs/specs/**/*.md`) and exactly one heading slug equals the anchor (missing
  → false; duplicate-ambiguous → false, fail-closed).
- `policy`: the citation names an existing domain key, or string-equals a glob in
  any domain's `read` / `write` / `deny_write` list.

**Limit (relevance is not machine-checkable):** `verifyEvidence` proves a
citation **EXISTS** only — never that it is RELEVANT to the finding (an
unrelated-but-existing citation cannot be rejected here). Relevance is handled by
the Stage-3 critique (each lens must state how a citation supports/refutes the
finding) plus the deterministic **proximity filter** AND-gated into the gate's
auto_confirm condition: a `file` citation must share the first two path segments
of the finding's `filePath`; a `spec` / `policy` citation must include the
finding's `category` as an exact token. A verified-but-unrelated-domain citation
yields `false` → escalate (strictly safer). This limit is also noted in the
scope notes (design §12); true multi-model diversity is out of scope (single
backend, distinct prompts; the adversarial refuter supplies partial stance
diversity).

**Current-state note — `auto_confirm` requires PROXIMATE verified evidence
(deliberate strict-proximity, design §0.1 R1 / §12):** because the proximity
filter is an AND-gate on `auto_confirm`, a finding can only be auto-confirmed
when it carries **locatable** metadata the filter can match against —
`finding.filePath` for a `file`-kind citation, or `finding.category` for a
`spec` / `policy`-kind citation. A finding that lacks a locatable `filePath` (and
whose lenses cite `file`-kind evidence) therefore **escalates** even on a
unanimous, verified, refuter-upheld jury (`proximityOk` is `false`,
fail-closed). The realistic dominant jury population — `review`-source findings
that often carry no `filePath` — consequently escalates rather than
auto-confirms. This is intentional: the headline benefit (誤 escalate 削減 —
auto-confirming findings the heuristic left `unknown`) applies to findings with
**locatable, proximate** evidence; the gate never auto-confirms on a verified but
non-locatable citation. This behavior is pinned by tests (the gate unit
`finding without filePath/category → escalate`, and the classify-runner
end-to-end `PRODUCTION review-finding shape (filePath OMITTED) ESCALATES`).
Relaxing proximity to broaden the auto-confirm population is a future-feature
trade-off, not a bug.

### Phase-3 freshness and batch limit

After Phase 2, Phase 3 re-stats only the **FINAL-round** verified `file`
citations against the current worktree; if any is now stale (path gone / line out
of range), the auto_confirm is withdrawn → escalate. `spec` / `policy` citations
are treated as immutable (no recheck). Superseded round-1 citations that did not
drive the auto_confirm never withdraw it.

The jury processes at most `JURY_BATCH_LIMIT = 25` candidates per orchestrate
invocation. Remaining unknowns are deferred: the runner returns
`moreUnknownsPending` and the orchestrator halts this invocation cleanly (a
non-escalate `max_steps_exhausted` outcome) so per-invocation cost is bounded to
one jury batch; the next orchestrate invocation re-fires `needs_classification`
and drains the remainder.

> Scope note: the convergence direct-escalate paths (P0 / budget / divergence)
> do NOT carry a `decisionPacket` — the additive packet for those non-jury
> escalations (design D3) was deferred. Only the classify runner's
> jury/operator-origin escalations attach a `HitchDecisionPacket`.

## Default Policy

```yaml
maxIterations: 3
maxReviewCycles: 3
maxReruns: 2
maxTotalNewFindings: 12
autoFixSeverities: [P1]
autoFixOnlyInScope: true
stopOnUnknownScope: true
allowEmptyCloseConditions: false
deferOutOfScope: true
reviewModeSequence: [initial, delta, close]
divergence:
  maxNewFindingsPerCycle: 5
  maxTotalNewFindings: 12
  requireNewFindingsDecreaseAfterCycle: 2
  maxReopenedPerFinding: 2
  nearDuplicateDedup: true
```

## Operation And Review Integration

Hitch-aware operation paths accept an optional `hitchId` and validate that the
hitch project, repo, and domain match the target run or project before recording
anything. A scoped hitch cannot be linked to an unscoped run.

Hitch-linked mutations are also gated by a fresh convergence evaluation. The
harness rejects implementation/review/rerun/process mutations when the hitch is
`close_ready`, `needs_classification`, `diverging`, `budget_exhausted`,
`escalated`, `closed`, or `cancelled`. The gate also checks the recommended
next action: `needs_fix` with `fix_findings` permits only `run.start` and
`rerun.start`; `needs_fix` with `run_close_check` also permits `run.start` and
`rerun.start` so failed close checks can be fixed. `continue` with
`run_review` permits review validation (`review.auto` and `review.process`) so
review-derived evidence can be generated, but still blocks implementation
mutations. `continue` with `run_close_check` is reserved for deterministic
command close checks and does not permit review tools. `continue` with
`defer_followups` blocks these hitch-linked mutations until the recommended
deferral action is handled. `continue` with `ask_human` blocks linked mutations
until an operator records the required external close-check evidence.
`review.process` confirmation requests are not created when this gate denies the
linked hitch. The bounded MCP driver `hitch.orchestrate` (`harness.hitch.orchestrate`)
is gated by the same evaluation: it is permitted **exactly when some per-step
mutation would be permitted** (`needs_fix` with `fix_findings`/`run_close_check`,
or `continue` with `run_review`) or when it can run a deterministic command
close check (`continue` with `run_close_check`). The entry gate denies the
driver for `close_ready`, the stop/terminal decisions (`escalate` /
`diverging` / `budget_exhausted` / `closed` / `cancel`), `defer_followups`, and
`needs_classification`, plus `continue` / `ask_human` external-evidence waits.
That denial is about *entering* the driver: once the driver is running, its loop
auto-classifies, auto-defers, and runs allowlisted command close checks via the
internal deterministic runner dispatch (see the three-layer table below); only
the deliberate `close_ready` close/PR, external-evidence waits, and the
escalation path are left to an operator out of band. Each internal coder/review
step the orchestrator runs re-checks its own gate. `harness hitch check-convergence` and
`harness.hitch.check_convergence` record an audit decision and synchronize the
durable hitch status for stop/close-ready decisions by default. Review proposal
import uses the same status synchronization after it records its convergence
decision.

### Three layers handle the same decision differently

The same convergence decision is acted on at three layers. All three are
deterministic and fail-closed; the differences are intentional, not a
contradiction:

| decision | MCP per-step gate (`mutation-gate.ts`) | hitch loop (`HitchOrchestrator`) | course dispatch (`orchestrate-dispatch.ts`) |
|---|---|---|---|
| `needs_fix` (`fix_findings`/`run_close_check`) | permits `run.start`/`rerun.start` | drives a bounded fix/rerun | drives the phase |
| `continue` + `run_review` | permits review validation | reviews the latest coding run | drives the phase |
| `continue` + `run_close_check` | no review/run mutation; driver entry is allowed | runs allowlisted command close checks and records evidence | drives the phase |
| `continue` + `ask_human` | denies the step | waits for external evidence without changing hitch status to escalated | `report_only` |
| `needs_classification` | denies the step | **auto-classifies** via the classify runner, then continues | **blocks** the phase and isolates its subtree (operator classifies) |
| `defer_followups` | denies the step | **auto-defers** via the defer runner, then continues | not blocked, but the hitch is not drivable (`allowedByConvergence` is false) → `report_only` unless another linked hitch is drivable |
| `close_ready` | denies the step (operator closes/PRs) | default loop runs `closeAndPr` (close + PR); stops before the PR only when `stopAtCloseReady` is set (the MCP/course drivers set it) | `ready_to_close` when all hitches are ready and no open P0/P1; no auto-close |
| `escalate` / `diverging` / `budget_exhausted` | denies the step | stops | blocks the phase and isolates its subtree |

The in-loop classify/defer/command-close-check runners are internal
deterministic dispatch, not gated mutations, which is why the MCP gate
"denying classification/deferral/review tools" and the loop "auto-handling"
them are both correct. The course layer deliberately stops on
`needs_classification` rather than auto-resolving across phases.

Implemented links:

```txt
run.start        -> hitch_attempts(attempt_type='implement')
review.auto      -> hitch_attempts(attempt_type='fix-review')
rerun.start      -> hitch_attempts(attempt_type='rerun')
review.process   -> hitch_review_cycles + hitch_findings + close checks
close_check      -> hitch_attempts(attempt_type='close-check') + hitch_close_checks + runs/<runId>/close-checks/
```

Review proposal import maps `required_changes` to P1 finding seeds, then runs
the normal frozen-scope classifier. Required changes that match the hitch scope
become in-scope blockers; required changes that are outside scope or unknown
must be deferred or classified before the loop can continue safely.
`non_blocking_comments` become P2 finding seeds, and
`out_of_scope_suggestions` are forced to out-of-scope follow-ups. A negative
review decision with no required changes still creates an in-scope P1 blocker
so a rejected/changes-requested verdict cannot accidentally become
`close_ready`.
In consensus mode, the normal review import uses the DB-canonical aggregate
decision (`processResult.newStatus`, or `review_decisions.decision` when the
process result is not available) as the state basis. An aggregate `approved`
decision never imports blocking `required_change` or `negative_decision`
findings from a non-approving participant proposal; advisory
`non_blocking_comment` findings and forced out-of-scope suggestions are still
imported. When the canonical decision is `changes_requested` or `rejected`,
blocking hitch findings are generated from the DB-canonical aggregate
`review_required_changes` rows, not from any single participant proposal's
self-reported `requiredChanges`. If the active consensus row cannot be parsed,
does not identify a trace proposal, or references a missing proposal, review
import fails closed instead of falling back to the latest processed participant
proposal.
Generic reviewer advisories that only say tests/checks were not run, could not
be run in the review environment, that command logs/output are missing, or that
observed command/test logs passed successfully are not imported as hitch
findings when they appear in `non_blocking_comments`. This includes
command-evidence advisories such as "no commands directory was present", "test
execution is evidenced only by the run summary", or "typecheck/vitest passed";
`commands/` is optional run evidence, not a required workspace artifact.
Reviewer advisories are vetoed if the same text describes a command/test
failure or a not-run problem caused by failure, such as "failed", "did not
pass", or "no tests passed"; mixed pass/fail notes remain findings so failed
validation cannot be hidden by an advisory carve-out. Negated failure words in
successful validation notes, such as "no errors", "no failures", "without
errors", or "0 failures", do not trigger the veto.
They are surfaced as `reviewAdvisories` on review import and copied into
`hitch_close_checks.evidence.reviewerAdvisories`, so operators can see the
missing test evidence without triggering `needs_classification` or escalation.
The carve-out does not apply to `required_changes`, close-check failures, or
actual command-evidence defects such as unverified command arrays.
If an advisory wording variant is still imported as a
`review-non-blocking-comment` finding, classification treats that category as
`out_of_scope`; only other categories can remain `unknown` and trigger the
fail-closed classification gate.

Review-imported findings are deduplicated in two tiers. Tier 1 is the stable
SHA-256 key over the normalized file path, symbol, category, and summary and is
unchanged for DB compatibility. If Tier 1 misses, no explicit stable key was
provided, and `policy.divergence.nearDuplicateDedup` is true, the repository
runs a deterministic same-hitch near-duplicate check over canonical findings in
the same category, with compatible file paths and symbols (both absent or
normalized-equal). A hit inserts a retained audit row with
`scope_status='duplicate'` and `duplicate_of=<canonical>`, promotes the
canonical severity/scope/lifecycle toward the more close-blocking side as
needed, and excludes that duplicate row from review-cycle `findingsNew` and
harness-origin divergence counts. In particular, a returning open close blocker
must not disappear behind a canonical that was previously `out_of_scope`,
`deferred`, `accepted_risk`, or `fixed`; the canonical is promoted back to a
blocking scope and `reopened` lifecycle instead. Non-blocking repeats do not
reopen a `fixed` canonical. `escalated` canonicals are
never downgraded to `reopened`; incoming blockers may still promote their
severity/scope toward the more blocking side. Repository promotion is
intentionally fail-closed: open incoming findings with `in_scope` or `unknown`
scope and P0-P2 severity are treated as close-blocker candidates even though
policy decides the final convergence action. P3/info incoming findings do not
promote canonical scope/lifecycle. When a canonical is promoted, its
summary/detail are refreshed from the incoming, more blocking finding so rerun
context shows the current blocker text. The heuristic
requires both token-set Jaccard
similarity >= 0.6 and word-bigram Jaccard similarity >= 0.5; summaries under
five tokens use exact-only matching to avoid broad short-text merges. Line
reference numbers in forms such as "line 123", "line:123", "l123",
"file.ts:123", and path-suffixed ":123" may be normalized only when the token
looks like a file/path reference; host/IP ports such as "127.0.0.1:3000" and
"example.com:443" are not line references. Other numeric tokens must match so
meaningful differences like HTTP 404 vs 500, timeout 30s vs 5s, or port 3000 vs
4000 remain separate findings. If neither side has a file path or symbol anchor, near-duplicate
matching uses stricter text thresholds (token-set >= 0.75 and bigram >= 0.6) and,
when both summaries contain distinctive path-like/quoted/identifier tokens,
requires at least one such token to match. This keeps separate pathless review
blockers, such as different endpoints, from being merged merely because their
surrounding prose is similar.

`review_consensus` close conditions are static review evidence only. A passed
`review_consensus` check records that static review consensus approved the run;
it does not prove tests executed. Hitches that require tests must include normal
`kind: command` close conditions for those commands. Convergence evaluates those
command checks using the existing close-condition machinery; it does not inject
synthetic test gates and does not use reviewer self-report as state-transition
evidence.

When a hitch review step is re-driven for a run whose **DB-canonical decision**
(`review_decisions`, not any single participant proposal) is `approved`, AND a
**completed** review cycle already exists for that run, the orchestrator
refreshes the `review_consensus` close-check evidence at the current time
without starting a new review cycle and without invoking Codex. The evidence's
`decision` / `reviewer` / `sourceSha256` come from `review_decisions` (the
canonical decision); the latest processed proposal only supplies supplementary
`proposalId` / advisories. If the run is approved but no completed review cycle
exists (the import never ran, or crashed after persisting the cycle row but
before importing findings), the short-circuit fails closed and escalates rather
than recording a passed check over an unimported/partial review.
This lets stale-but-approved review evidence advance to `close_ready` and then
to `close_and_pr` on the next loop step. If that refreshed review evidence is
fresh but another required close condition is still pending, the loop escalates
with the pending condition id(s) instead of starting another review.
The normal (non-short-circuit) import path follows the same canonicality rule:
close-check status and evidence decision come from `processResult.newStatus`;
member proposal ids and advisories are traceability-only. If a member proposal's
self-reported decision contradicts the canonical aggregate, its
`reviewDecisionId` is omitted from close-check evidence rather than recording a
contradicting id.

When the loop reaches `continue` / `run_close_check`, the orchestrator resolves
each required `kind: command` condition whose latest status is `pending`,
`skipped`, or `unknown` to the effective domain policy `ResolvedCommand`
allowlist. A condition without `command` selects by condition id; a condition
with `command` may select either the allowlisted command id or the exact display
command. Matching commands are run with `runAllowedCommands` against the latest
reviewed run worktree, and evidence is recorded only in `hitch_close_checks`
plus `runs/<runId>/close-checks/`. Failed command evidence records the command
result plus bounded stdout/stderr excerpts; a following coder rerun injects
that failed close-check evidence into the goal so it can fix the concrete
failure instead of re-running the original task blindly. If a condition cannot
be resolved to exactly one allowlisted command, the command is not executed and
the orchestrator escalates with an external-evidence request.

Before and after command execution, the close-check runner verifies the latest
reviewed run worktree against the recorded reviewed surface. The diff collection
uses the resolved policy `limits.gitTimeoutMs`; timeout or git failure is
fail-closed. Validation includes untracked policy surface and the cached/index
state: any staged index path is rejected, so a command cannot hide a side effect
by staging a mutation and restoring the working tree. The run worktree's index is
expected to equal the base because the run flow normalizes the coder's net change
into the working tree before review (see `workflow.md`, "worktree index
normalization"): the coder may COMMIT or stage its work, but
`normalizeWorktreeIndexToBase` (`git reset --mixed <base>`) folds that back into
the working tree so `harness pr create` publishes exactly the reviewed surface as
a single fresh commit and no unreviewed intermediate commit reaches the run branch.
The runner also rejects any baseline-to-post-command change to untracked files
under `ignore_untracked` globs, so a close-check command cannot pollute the run
worktree through an ignored path; this is intentionally stricter than the normal
coding-path `ignore_untracked` semantics in `policy.md`, which still suppress
build artifacts from write-scope validation. The close-check snapshot excludes
only never-reviewable dependency paths under the repository-root
`node_modules/**`, because test tools may update dependency-owned caches such as
`node_modules/.vite/vitest/results.json` without changing PR-reviewable
content. Other cache-like paths, including `.vite/`, `.vitest/`, `.cache/`,
`.turbo/`, `*.tsbuildinfo`, and `.eslintcache` outside root `node_modules/**`,
are not in this volatile set. Reviewable ignored artifacts such as `dist/**` or
`build/**` still fail closed on add, modify, delete, chmod, symlink retarget,
or unreadable fingerprint errors, even when their subpaths look cache-like or
include nested `node_modules/`.
If an ignored path listed by git cannot be fingerprinted with lstat, no-follow
open/read/hash, or readlink, the close-check fails closed instead of treating
the error as a comparable unchanged state.

`hitch_lifecycle_events` records `closed`, `cancelled`, `reopened`,
`pr_adopted`, and `updated` reasons with actor/timestamp for audit. It is not a
state-transition source. Convergence, mutation gates, roadmap rollup, and
auto-merge derive state from deterministic harness inputs (`hitch_sessions`,
findings, close checks, budgets, and convergence metrics), never from lifecycle
event rows. `pr_adopted` affects status display only; it never authorizes
`await-merge`.

Review-only and close-check attempts inherit the related coding iteration when
they are linked to an existing run attempt. This keeps automatic review and
command-check bookkeeping from burning the implementation iteration budget.

## CLI Contract

The CLI exposes `harness hitch`:

```bash
harness hitch start --title "..." --scope-file scope.yaml --close-file close.yaml
harness hitch status <hitch-id>   # also reports per-hitch token usage (run_usage SUM over attempt runs, retry-inclusive, by kind)
harness hitch reopen <hitch-id> --reason "..." [--created-by actor] [--extend-iterations N] [--extend-review-cycles N] [--extend-reruns N]
harness hitch adopt-pr <hitch-id> <pr-url-or-number> --reason "..." [--created-by actor]
harness hitch update <hitch-id> [--close-file close.yaml] [--scope-file scope.yaml] [--policy-file policy.yaml] --reason "..." [--allow-scope-widen] [--allow-gate-loosen] [--created-by actor]
harness hitch finding add <hitch-id> --severity P1 --category correctness --summary "..."
harness hitch finding classify <finding-id> --scope in-scope --reason "..."
harness hitch finding fixed <finding-id> --note "..."
harness hitch finding defer <finding-id> --backlog --reason "..."
harness hitch review-cycle start <hitch-id> --mode delta
harness hitch close-check record <hitch-id> --condition typecheck --status passed
harness hitch check-convergence <hitch-id> --json
harness hitch close <hitch-id> --summary "..."
```

CLI/MCP close-check record tools may still record externally supplied command
evidence. Autonomous orchestrate only runs commands that resolve to the domain
policy allowlist; non-allowlisted command conditions fail fast and require
external evidence.

`hitch adopt-pr` is audit/status-only for operator takeover. It records the
adopted PR and the latest run PR it supersedes, but it does not rewrite
`runs.pr_url` / `runs.pr_number` and does not change hitch status. A hitch with
`pr_adopted` is rejected by `hitch await-merge`; adopted PRs are human-merge
only, followed by `hitch close --force` to close the record.

`hitch update` changes the frozen config only under explicit guards. It accepts
live statuses (`open`, `in_progress`, `close_ready`) and rejects terminal
statuses; `closed` / `budget_exhausted` / `escalated` must be reopened first,
and `cancelled` cannot be updated. `diverging` is not directly updatable either,
but it is not a dead end: it is re-derived live (rule 1, #164), so a transient
divergence self-clears to a live status on the next evaluation and then accepts
updates — `reopen` is not needed (and is not the recovery for a still-cumulative
divergence; see REOPENABLE_STATUSES in the repository). Scope edits are fail-closed:
`targetFiles`, `targetOperations`, `allowedFindingCategories`,
`excludedCategories`, and `targetSummary` must be provably non-widening unless
`--allow-scope-widen` is supplied; `notes` is the only non-semantic scope field.
Close-condition or policy edits that remove required close evidence or relax
`closeRequires` / `allowEmptyCloseConditions` require `--allow-gate-loosen`.
Each update writes an `updated` lifecycle event containing the changed fields and
previous config snapshot.

## MCP Contract

MCP exposes read tools for sessions, findings, and decisions, plus guarded
mutation tools for starting hitches, recording/classifying/fixing/deferring
findings, recording close checks, and evaluating convergence.

MCP hitch mutations use the same permission model as other mutation tools.
Dangerous terminal operations such as forced close/cancel and scope expansion
require confirmation. MCP finding details are capped and redacted.

`harness.hitch.orchestrate` is a bounded driver (args: `hitchId`, optional
`maxSteps` 1-50 default 20) that advances the loop a capped number of
orchestrator steps and halts at `close_ready` without opening a PR
(`stopAtCloseReady`). The target repo is resolved server-side from the hitch's
project/domain (never a client-supplied path); it never wires a publisher.
Opening the PR / closing the hitch stays the deliberate CLI
`harness hitch orchestrate` path. See [`mcp.md`](./mcp.md) for the full contract.

Hitch-linked run/review tools support optional `hitchId`:

```txt
harness.run.start
harness.review.auto
harness.rerun.start
harness.review.process
```

When supplied, the operation audit metadata includes both `hitchId` and
`hitch_id`, and the hitch repository records the attempt or review-cycle result.
`review.process` imports the bound review proposal into the hitch only on the
confirmed execution path.

## Fixture Matrix

`tests/unit/hitch/fixture-matrix.test.ts` simulates the agent loop without
calling Codex. The matrix covers:

```txt
converging fix -> close_ready
diverging review cycles -> diverging
out-of-scope follow-up -> defer -> close_ready
unknown scope -> needs_classification -> close_ready after classification
iteration budget exhaustion -> budget_exhausted
```

Each fixture records convergence decisions and updates hitch status so the test
asserts both the decision stream and the loop stop condition.

## Non-Goals

Phase 19 does not implement autonomous worker scheduling, semantic embedding
clustering, dashboard mutation UI, raw shell execution, or external issue
tracker sync.

Automatic merge is now available as an opt-in (default OFF): when
`harness hitch orchestrate --auto-merge` is set, `closeAndPr` evaluates a
deterministic merge gate (close-ready ∧ consensus approved with quorum, or a
human override ∧ CI green) and merges the PR, escalating fail-closed on a
hard-blocked gate. See [`workflow.md`](./workflow.md) (auto-merge).
```
