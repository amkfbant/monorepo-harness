# Hitch Convergence Controller

Phase 19 adds a DB-backed control plane for long-running coding-agent hitches.
It answers whether a hitch has converged, needs another bounded fix pass, should
defer new findings, or must stop for human classification/escalation.

Implementation status: Phase 19 is implemented as schema v16 plus repository,
CLI, MCP, run/review integration, and a simulated hitch-loop fixture matrix.
The source of truth is `.harness/harness.sqlite`; compatibility files remain
outside this feature's authority.

Later roadmap integrations add a phase-level spec review layer above hitch
convergence. That layer can ratify a phase's scope and close conditions before a
hitch is linked or started from it, but it does not replace the hitch
convergence state machine. A hitch still closes only through deterministic hitch
findings, close-check evidence, budgets, and lifecycle gates described here.

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

## Spec Review Layer & Ratified Phase Compatibility

The course/phase roadmap layer owns phase specs (`scope_json` and
`close_conditions_json`) plus phase-level review facts in
`review_state_json`. This review state is not a mirror of hitch convergence: it
does not store hitch P0/P1 counts, does not satisfy hitch close checks, and does
not encode GOAL_RULES.md process rules. It records operator-visible phase facts
such as notes and spec approval.

`phase ratify <phase-id> --approved-by <actor>` records human approval under
`review_state_json.specApproval` with `{ approvedBy, approvedAt, reason,
specHash }`. `specHash` is the sha256 of canonical JSON for the structured
`[scope, closeConditions]` tuple. Phases without `specApproval` keep the legacy
free link/start behavior.

For a ratified phase, `phase link-hitch` and `phase start-hitch` run a
compatibility gate before the hitch can be attached. The gate compares the
hitch spec with the phase's current spec using the same pure predicates as live
hitch config updates:

- Scope compatibility uses `isScopeWidening`; a wider hitch scope requires
  `--allow-scope-widen`.
- Close-condition compatibility uses `closeConditionsLoosenGate`. Every
  required phase close condition must still be present in the hitch by `id`,
  remain `required: true`, and keep the same gate fingerprint (`kind`,
  `command`, `rule`, `metadata`). Removing it, making it optional, or changing
  its gate fingerprint requires `--allow-gate-loosen`. Additional stricter hitch
  conditions are allowed.

`phase start-hitch` defaults the new hitch's scope and close conditions from the
phase, and explicit `--scope-file` / `--close-file` overrides are checked in the
same transaction as hitch creation plus phase linking. A ratified-spec rejection
rolls the hitch insert back. `phase link-hitch` applies the same gate to an
existing hitch. If the phase spec changed after ratification, both paths compare
the current hash with the approved `specHash` and emit a drift warning while
still applying the current-spec compatibility gate.

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

**(#278) Auto-resolve of superseded review blockers on approve.** The
`open -> fixed` edge is also driven deterministically by the harness — not only by
the operator's manual `hitch finding fixed`. When a later review cycle's
**canonical decision is `approved`** (the same harness-computed
`canonical.decision === "approved"` signal, event-sourced from
`review_decisions` / `review_consensus`, that already drives
`suppressBlockingFindings`), the import path retires the prior cycles' now-stale
blockers via `HitchRepository.resolveSupersededReviewFindings`. The transition is
bounded by a STRICT allowlist (fail-closed): only findings with `source = 'review'`
**and** category in the review-blocking set (`review-required-change` /
`review-negative-decision`, the only categories the harness emits as P1 blockers
from review proposals) **and** `scope_status = 'in_scope'` **and**
`lifecycle_status IN ('open','reopened')` **and** `severity <> 'P0'` **and**
`duplicate_of IS NULL` **and** stamped with a `source_cycle_id` that resolves to a
review cycle of the SAME hitch whose `cycle_number` is **strictly less** than the
approving (superseding) cycle's `cycle_number` are flipped to `fixed`. The
earlier-cycle predicate is a strict cycle_number comparison (an inner join on
`hitch_review_cycles`), not a `<> superseding` id check: a NULL, dangling, future,
or same-cycle `source_cycle_id` cannot be proven earlier and is left OPEN
(fail-closed). Everything outside the allowlist — operator-origin (`human`/`mcp`)
findings, out_of_scope/unknown, non-blocking advisory categories, the approving
cycle's own (or later) rows, manual NULL-cycle review findings, P0 — stays OPEN.
The auto-resolve runs BEFORE `completeReviewCycle`, so that cycle's
`findingsFixed` / `findingsInScopeOpen` counts and the subsequent convergence
evaluation both observe the resolved state (convergence reaches `close_ready`
instead of routing `needs_fix` on a now-superseded `openInScopeP1`). A deterministic
`resolution_note` records the CURRENT superseding run + cycle: it is written when
the note is empty OR when the existing note is a prior harness auto-resolve note
(refreshed so a reopen->re-approve names the current cycle, not a stale earlier
one), while a genuine operator-authored note is preserved. When a `processResult`
is supplied, auto-resolve additionally requires `processResult.runId` to equal the
proposal's `runId` (the applied result must belong to the proposal's run) —
otherwise it is skipped (fail-closed). **Current-review-target guard:** the
earlier-cycle / same-hitch predicate alone does NOT prove the approving run is the
run those blockers should be superseded by — the MCP `review.process` path accepts
any `needs_review` run linked by project/repo/domain, so a manually-processed
approve for a STALE/older run could be imported as a later cycle. Therefore, when
the hitch has a current coding-run target (its latest `implement`/`rerun` attempt's
run, ranked deterministically by attempt iteration — not the nullable
`runs.started_at`), the approving `decisionRunId` MUST equal it; an approve for any
other (older / foreign) run retires nothing (fail-closed). The externally-ingested
`external-review-changes-requested` P1 blocker (a third `source='review'` category,
in neither the blocking nor the advisory set) is deliberately NOT auto-resolved: an
internal review approve must never retire an external human reviewer's verdict.
This is the harness observing an event-sourced APPROVE —
never an LLM "I fixed it" self-report. The auto-resolve fires only on `approved`:
a later `changes_requested` / `rejected` re-blocks correctly, and a genuinely
re-raised blocker is re-promoted through the normal `fixed -> reopened` edge.

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
   A trigger that **never self-clears** — the cumulative session-budget trigger
   (`harnessOriginNewFindings > maxTotalNewFindings`), whose count never decreases
   — therefore stays diverging permanently and is NOT reachable by `reopen` (which
   extends only the iteration/review/rerun budgets, not the divergence budget). It
   has one sanctioned recovery: **`hitch recover-diverging`** (#280), a separate,
   explicit, audited operator action gated DETERMINISTICALLY (see "Sanctioned
   cumulative recovery" below). The divergence circuit breaker itself and its
   ordering (rule 4, before the `close_ready` rule 5) are UNCHANGED — recovery only
   raises the budget input after the deterministic close pre-gate is already green.
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
   divergence. **(#283)** Non-actionable advisory review categories
   (`review-non-blocking-comment`, `review-out-of-scope-suggestion`) are
   harness-origin (`review`) rows that are RECORDED as findings (operator-visible,
   classified `out_of_scope`) but are EXCLUDED from the divergence churn count.
   These categories are assigned deterministically by the harness (never by an
   LLM self-report) and are, by construction, never required changes and never
   close blockers, so an approval/positive advisory comment materialized as such a
   row cannot inflate the harness-origin divergence count (`harnessOriginNewFindings`
   and the per-cycle divergence churn) or trip "new findings did not decrease". The
   row is still recorded in the cycle summary (operator-visible); only the computed
   divergence metrics exclude it. The
   exclusion is CATEGORY-based, not scope-based: a genuinely ACTIONABLE finding
   that happens to be `out_of_scope` (e.g. `correctness`) STILL counts toward
   churn, and the blocking categories `review-required-change` /
   `review-negative-decision` are deliberately NOT excluded — they still drive
   divergence and still block close (fail-closed). **(#278)** The approve-driven
   auto-resolve of superseded review blockers (see Finding Lifecycle) changes ONLY
   `lifecycle_status` (open->fixed); it does NOT rewrite or delete the underlying
   `source` / `source_cycle_id` rows, so `harnessOriginDivergenceMetrics`
   (cumulative `harnessOriginNewFindings` and the per-cycle churn) is unchanged and
   the cumulative divergence circuit-breaker stays intact. The `openInScopeP1`
   close gate itself is also unchanged — it still blocks for EVERY finding origin
   (operator `human`/`mcp` included); the auto-resolve merely retires the
   superseded review-origin review-blocking rows BEFORE the gate evaluates, so the
   gate sees the truthful post-approve count. **(#280) Effective total-findings
   ceiling.** The cumulative-total trigger checks two ceilings in order: first the
   per-hitch session budget (`harnessOriginNewFindings > session.maxTotalNewFindings`
   → reason `total new findings exceeded hitch budget`), then the policy default
   (reason `total new findings exceeded policy budget`). The policy check uses the
   EFFECTIVE ceiling `max(policy.maxTotalNewFindings, session.maxTotalNewFindings)`:
   the shared policy default is a FLOOR, not an independent ceiling. A LOWERED
   session budget still tightens (the session check fires first and returns), so
   normal divergence detection is byte-identically preserved; a RAISED session
   budget (e.g. the audited `recover-diverging` extension, or an operator
   `--max-total-new-findings` above policy) is an explicit per-hitch authorization
   that lifts the effective ceiling, so the shared default does not re-fire under
   it. This is what lets a default-budget hitch (`session == policy`) recover.
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
    command is re-run. A required `facet_red_test` (#279) is auto-verify and
    deterministic: a `failed` fail-open shape (production surface changed with no
    covering test) routes to `needs_fix` like any failed required check. A
    `pending` facet routes by its **recovery disposition** (#308): a
    *code-recoverable* pending — a facet with **no covering test present**, so no
    recorded evidence row could ever clear it (`matchedTestPaths` is empty) —
    routes to `needs_fix` with `fix_findings` so the coder adds a RED covering
    test; an *evidence-recoverable* pending (covering test present, only the RED
    evidence row missing/stale) waits for operator/runner evidence via the
    external-evidence path below. A `failed` fail-open shape that has only a
    STALE prior evidence row keeps its actionable "production surface changed, no
    covering test" message (it can be cleared only by adding a test, never by
    recording evidence); only the test-present-no-fresh-evidence case emits the
    "record fresh RED evidence" stale message.
14. If the only remaining required close checks need external/operator evidence
    (`manual`, `artifact_exists`, `operation_status`, or another non-command
    condition), the decision is `continue` with `ask_human`; the orchestrator
    waits for recorded evidence and does not auto-escalate by invoking the
    command runner with no runnable command. The `ask_human` message lists each
    pending external condition as `condition <id> kind=<kind> pending <N>
    cycle(s)` using completed review cycles since the latest evidence for that
    condition (or all completed cycles when no evidence exists). If the hitch is
    linked to a ratified phase whose approved `specHash` no longer matches the
    current phase spec, the same message appends the phase id plus approved and
    current hashes as a runtime spec-drift diagnostic.

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

## Sanctioned cumulative recovery (`hitch recover-diverging`, #280)

A cumulative session-budget divergence (`harnessOriginNewFindings >
maxTotalNewFindings`) never self-clears — the cumulative count never decreases —
so the hitch stays `diverging` forever and is unreachable by `reopen` (which does
not touch the divergence budget). `close --force` would "recover" it only by
SKIPPING the close gate entirely, which the design forbids as the sanctioned path.

`hitch recover-diverging <id>` is the sanctioned, deterministic, audited recovery.
It is **NOT a gate-skip** — it is strictly STRONGER than `close --force`: it
returns the hitch to live `open` (and extends the divergence budget so
re-derivation does not immediately re-fire) ONLY when a harness-side gate is
green, computed entirely from `ConvergenceService.evaluate()` metrics plus a fresh
close-condition evaluation (never from any LLM/self-report). The gate, all of
which must hold, else the command REFUSES fail-closed (exit 1, no state change):

- the live decision is still `diverging` (the trigger did not already self-clear);
- the divergence trigger is the **cumulative session-budget** one (reason `total
  new findings exceeded hitch budget`). Every OTHER trigger — per-cycle
  (`maxNewFindingsPerCycle`), reopen-count (`maxReopenedPerFinding`), and the
  non-decreasing-trend trigger — is **NOT recoverable** by a budget bump and is
  refused with a clear message (investigate or cancel+recreate). (The separate
  policy-total reason is, by the effective-ceiling rule below, only ever reached
  when the session budget was already explicitly raised above policy — which is
  not divergence — so it is not an independent non-recoverable trigger.)
- `openInScopeP0 == 0` AND `openInScopeP1 == 0` AND `openUnknownScope == 0` (the
  same in-scope blocker conditions the `close_ready` gate requires); and
- all required close-checks are green: `closeConditionsFailed == 0` AND
  `closeConditionsPending == 0`.

When the gate is green it extends `max_total_new_findings` by the minimal amount
that lifts the cumulative count above the strict `>` comparison (deficit + 1, or
an operator-supplied `--extend-divergence-budget`), then RE-DERIVES the divergence
reason under the post-bump budget to PROVE no trigger remains — if any would still
fire (a per-cycle / reopen-count / non-decreasing trigger that no budget bump can
clear), it refuses fail-closed. The effective total ceiling for the post-bump
re-derivation is `max(session.maxTotalNewFindings, policy.maxTotalNewFindings)`
(see "Effective total-findings ceiling" under rule 4), so a DEFAULT-budget hitch
(where `createSession` makes `session.maxTotalNewFindings == policy` total) can
actually recover: raising the session budget above the count clears BOTH the
session and the policy-total checks, instead of the equal policy default re-firing.

The state transition is fail-closed and atomic. The deterministic gate is RE-RUN
from fresh DB state INSIDE the write transaction (not only as a pre-check), so a
concurrent `finding add` / close-check transition / cancel-close-escalate between
the pre-check and the commit aborts recovery (no mutation, no audit event). The
status precondition is enforced atomically by a `WHERE hitch_id = ? AND status =
'diverging'` guard; zero changed rows is a state-conflict error (never a silent
flip of a just-terminal hitch back to `open`). The flip and budget bump are a
single harness-only state transition recorded as a `diverging_recovered`
lifecycle audit event (with `previousStatus`, `divergenceBudgetExtension`,
`previousMaxTotalNewFindings`, `newMaxTotalNewFindings`). The divergence circuit
breaker (rule 4) and its ordering before `close_ready` (rule 5) are unchanged;
ordinary convergence then re-derives `close_ready` (or a live-work decision) so
nothing lands that the normal path would have blocked. Recovery is an explicit
operator action — never auto-triggered on a finding-fix.

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
open (design §3 invariant 4), and so a non-authoritative (lease-lost) drive
mutates **no state**: **Phase 1** (DB open, synchronous, **READ-ONLY**) partitions
the open+`unknown` findings — it *computes* the heuristic decision for
heuristic-resolvable harness-origin findings but does **not** write, snapshots the
still-`unknown` jury candidates, and snapshots the operator-origin findings — then
closes the DB; **Phase 2** (DB closed) runs the LLM deliberation per candidate in
memory; **Phase 3** (DB re-open) is the **only** phase that mutates state — it
applies the snapshotted heuristic writes, persists the audit rows, re-verifies
state, freshness-checks file citations, and classifies or escalates. Because every
write is deferred to Phase 3 (behind the pre-Phase-3 lease guard), a lease lost any
time before Phase 3 leaves the entire classify step state-free.

The jury **run context** (worktree + compiled policy + run id) is resolved
**lazily** — only when Phase 1 produced actual jury candidates (the heuristic and
operator-origin paths need no worktree/policy). A hitch session without
repoId/domain whose `unknown` findings are *only* heuristic-classifiable or
operator-origin therefore classifies / escalates a manual-classification packet
**without** a run-context resolution error.

### The 5-stage deliberation pipeline

Each finding is deliberated independently (`deliberate.ts`):

1. **Stage 1 — PROPOSE** (LLM, DB closed, 3 lenses). Three lenses
   (`correctness`, `scope_fit`, `spec_adherence`) each propose a scope
   *independently* (no shared view): `{ proposedScope, proposalStatus,
   evidence[]{citation,kind,claim}, refutationCondition, uncertainty, reasoning,
   confidence?, proposedSeverity? }`. This is round 1. Every lens prompt embeds a
   READ-ONLY **frozen hitch scope snapshot** (`scope-snapshot.ts`:
   goal/domain/targetSummary/targetFiles/targetOperations/allowed+excluded
   categories/notes/closeConditions, built from the session the classify runner
   loads READ-ONLY in Phase 1) so each lens classifies the finding **against the
   actual change scope**, not just the finding text. The snapshot is prompt
   context only — it never feeds a state transition and the LLM cannot mutate it;
   the same snapshot is threaded into Stage 3 and Stage 4. (`JuryProposerDeps.
   scopeSnapshot` is required, so a deliberation cannot run without it.)

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
   When it runs, each lens sees the others' proposals + evidence (and the same
   frozen scope snapshot), raises a concrete objection, and re-votes (round 2),
   recording `voteChanged` / `critique`. **`voteChanged` is DERIVED
   deterministically** as `revisedScope !== round-1 scope` — the model's
   self-reported `voteChanged` is parsed (for contract compatibility) but
   IGNORED, so a lens that flips its scope yet claims `voteChanged:false` cannot
   hide the conformity / false-consensus signal Stage 4 reads. **A critique
   vote-flip is FAIL-CLOSED (requires human review).** The critique round does
   NOT collect fresh citations, so the round-1 evidence was gathered for the OLD
   position; when a lens flips its scope (`voteChanged`), its round-2 proposal
   carries **empty** gate-supporting evidence (`evidence: []`) — the round-1
   evidence is NOT carried forward. This makes the deterministic gate's
   `allHaveVerifiedEvidence` FALSE for the flipped lens, so a split that converges
   to unanimous **via a vote flip ESCALATES** (it can never auto_confirm on stale
   evidence, and Stage 4 is skipped because the final round is not all-verified).
   A vote that did NOT flip keeps its still-relevant round-1 evidence. (Collecting
   FRESH critique evidence for a flipped vote is a follow-up.) **Convergence
   after critique does NOT auto-confirm**: the post-critique round is
   re-aggregated, and a post-critique unanimous set still must pass Stage 4 +
   Stage 5.

4. **Stage 4 — REFUTE** (LLM, adversarial, conditional). The refuter runs **only
   when the selected final round is unanimous AND every final-round proposal
   carries verified evidence**. It receives the unanimous verdict, each lens's
   `refutationCondition`, the verified evidence, (only when critique ran) who
   changed their vote, and the same frozen scope snapshot, and attacks the
   consensus — explicitly probing for false consensus by conformity. It returns
   `{ refuteVerdict: uphold | refute | inconclusive, reasoning, counterEvidence? }`.

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

Every Stage-1/3/4 codex invocation goes through one wrapper
(`src/hitch/jury/run-codex.ts`, `runJuryCodex`) that enforces two safety
properties (the runner exposes a `signal` but **no** timeout field, so the
caller must enforce both):

- **Per-call timeout.** Each call derives a fresh `AbortController` and a
  `setTimeout(timeoutMs)` (`JURY_CODEX_TIMEOUT_MS`, 600 s) and passes the
  combined signal (`AbortSignal.any([lease, timeout])`) into the codex run; an
  aborted/timed-out call maps **fail-closed** (`proposalStatus: timeout` /
  refuter `inconclusive`), never `complete`. A hanging jury codex therefore
  cannot block the classify step indefinitely despite the per-invocation batch
  cap.
- **Lease-loss abort (#132).** The orchestrator's drive signal is threaded
  through the classify runner into every jury codex call. When the course loses
  its lease mid-deliberation the signal aborts and the in-flight codex is
  SIGKILLed. The classify runner ALSO checks the signal **before Phase 1** and
  **before Phase 3**: because Phase 1 is fully READ-ONLY and ALL writes (the
  heuristic writes too) live in Phase 3, a non-authoritative (lease-lost) drive
  persists/classifies/escalates **nothing** and returns the benign no-op
  (`{ resolved: true }`); the orchestrator's next-iteration `driveAborted` check
  — or, on the **final** step (e.g. `maxSteps:1`, with no next iteration), the
  orchestrator's **post-loop** `driveAborted` guard — then maps the stop to
  `lease_lost` (the runner never throws from inside — that would route through the
  orchestrator try/catch and wrongly escalate the hitch).
- **Shared-log truncation safety (lease-gated, TOCTOU-safe).** The per-(hitch,
  finding,lens,stage) stdout/stderr/events log paths are deterministic and SHARED.
  `runJuryCodex` TRUNCATES them before a real run (so a codex that exits 0 without
  writing stdout cannot leave a STALE prior proposal for `readFile` to reparse).
  An already-aborted (lease-lost) call short-circuits BEFORE any truncation/write,
  so a stale worker can never erase the authoritative worker's logs. The lease is
  ALSO **re-checked immediately before EACH `writeFile("")`** (after the `mkdir`):
  the pre-check and the truncation are separated by an `await`, a window in which a
  stale drive may lose its lease — re-checking closes that TOCTOU window
  (codex#254-R6 FIX 1). Truncation runs ONLY on the still-authoritative path.

### Monotonic, fail-closed invariants (the safety backbone)

The deliberation can only *add* safety; it can never relax a decision (design
§3, mirrored in the harness safety boundary):

0. **Two deterministic deciders, MECE over the finding population — no LLM
   utterance ever drives a classification.** Every open + `unknown` finding is
   resolved by **exactly one** of two *deterministic* (non-LLM) deciders, and the
   two cover the population without overlap:
   - **The deterministic heuristic** (`classifyFindingForHitch`, non-LLM): clear-cut
     **harness-origin** findings the frozen-scope classifier can resolve (e.g. a
     target-file / category / glob hit) **bypass the jury** — no
     proposer/critique/refuter call, no jury audit rows. The heuristic decision is
     *computed* in the READ-ONLY Phase 1 but the scope is **written** in Phase 3
     (`repo.classifyFinding`, behind the lease guard), together with the jury
     classifications, so a lease-lost drive writes nothing. (Operator-origin
     `unknown` findings are also partitioned here in Phase 1: they are never
     machine-classified at all — bundled to escalate, R5.)
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
   turn a split into an auto-confirm. A split that converges to unanimous does so
   only via a vote FLIP, and a flipped lens carries no gate-supporting evidence
   (the critique round collects no fresh citations), so the gate's
   `allHaveVerifiedEvidence` fails and the deliberation ESCALATES (fail-closed,
   human review) — the refuter is never reached. Only a CLEAN unanimous round 1
   (no flip) passes the refuter and gate. The refuter can only `uphold` (does not
   block the gate) or `refute` / `inconclusive` (veto).

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
   citations. The same still-`unknown`+open re-check is applied to the
   operator-origin findings snapshotted in Phase 1 before they are bundled into
   the escalate packet: one classified by a human/process during the (long)
   Phase-2 deliberation is dropped from the packet (no spurious escalate on a
   stale snapshot). Hitch status syncs deterministically via
   `recordConvergenceDecisionWithStatus`. The LLM never writes finding scope /
   severity / lifecycle / hitch status. A drive that lost its lease mid-run is
   **non-authoritative**: Phase 1 is READ-ONLY and the runner checks the lease
   signal before Phase 3 (the only mutating phase, which applies the heuristic
   writes too), so it writes nothing (see the per-call codex wrapper note above).

4. **Evidence is verified deterministically.** Hallucinated citations are
   rejected in Stage 2; the gate never trusts the model's evidence claim.

5. **Severity is never auto-modified.** `auditSeverity` returns the harness
   severity unchanged; divergence only sets an `escalate` flag and a packet
   record for human review (see severity precedence below).

The DB is open only during Phase 1 (READ-ONLY synchronous snapshot) and Phase 3
(heuristic writes + append-only audit persistence + classify), and closed for the
whole LLM deliberation, mirroring the reviewer path.

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
  hides one side's required action. When a batch BOTH escalates (a jury split /
  operator-origin finding) AND has an auto-confirmed finding whose severity
  diverged, the escalate packet **merges** the accumulated `severity_audit`
  divergences (their `findings[]` + `review severity` `nextActions[]`) into the
  same packet — the diverged finding's required severity-review action is never
  dropped just because another finding forced the escalate. The merge also
  **carries the severity-audit SUMMARY** into the escalate packet's
  `severityAudit` (status / `juryConsensus` / `harnessSeverity`), so a packet
  that advertises `severity_audit` in `decisionKinds` also exposes the actual
  audit (codex#254-P2 FIX2). Precedence: an escalate base never sets its own
  `severityAudit`, so the severity packet's lead summary is adopted; were a base
  to already carry one, the base's is kept (per-finding linkage stays in
  `findings[]`).
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
- A bundled `review_split` packet may flatten **multiple findings'** votes into
  one shared `evaluationAxes` block, so each `evaluationAxes[].lensVotes[]` entry
  AND each `rejectedProposals[]` entry carries its own **`findingId`** (it is
  attributable to its finding). `rejectedProposals[]` tallies scopes **per
  finding** (a bundle does not merge two findings into one finding-blind count).
- `minorityView` is a **single** summary object, so it can attribute only one
  finding's dissent. For a single-finding split it carries that finding's minority
  scopes; for a **bundled multi-finding** split it is **omitted (`null`)** rather
  than tallied across findings (codex#254-P3 FIX4) — a global tally would blend
  two unrelated splits into a finding-blind pseudo-summary, or cancel opposite
  2-1 splits into `null`. Per-finding attribution lives in `rejectedProposals[]`.

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
(`updateStatus: false`, a non-blocking `continue` decision) so an operator can
review the divergence while the classification stands. The advisory row is tagged
`metrics.advisorySeverityRecord === true` (`advisory: true` on
`recordConvergenceDecisionWithStatus`) so the course/phase rollup
**display** (`latestDecisionForPhase`) skips it — a still-blocking live
convergence is never masked by the advisory `continue` (codex#254-P2 FIX1). The
row stays persisted/retrievable; only the display ignores it.

### `verifyEvidence` guarantees and its limit

`verifyEvidence` (`src/hitch/jury/evidence.ts`) is deterministic, read-only IO
(no SQLite, no network — same input + same context → deep-equal output). It
ignores any model-supplied `verified` flag and recomputes existence:

- `file` (`<path>[:line[-line]]`): the path resolves under the run worktree as a
  file, and any cited line is within range. `resolvedRef` is the absolute path.
  An absolute citation, or a `..`-escaping one whose resolved path leaves the
  worktree, is rejected (fail-closed) before any read. The lexical guard is
  followed by a **real-path (symlink-resolved) guard**: an in-tree path whose
  symlink TARGET points OUTSIDE the worktree (or that cannot be realpath-resolved)
  is rejected before `statSync`/`readFileSync` can follow it.
- `spec` (`<md-path>#<anchor>`): the md is covered by `specDocsGlobs` (default
  `docs/specs/**/*.md`) and exactly one heading slug equals the anchor (missing
  → false; duplicate-ambiguous → false, fail-closed). The slug is **GitHub-style
  and Unicode-preserving** — lowercase, whitespace → `-`, and only the
  punctuation GitHub strips is removed while Unicode letters/digits are KEPT — so
  Japanese / non-ASCII headings (which `docs/specs/*.md` use) match their anchors;
  the same slugifier is applied to both the heading and the citation anchor.
  Mirroring the `file` guard,
  an absolute citation, or a `..`-escaping path that the glob nonetheless matched
  on the raw string but whose resolved path leaves the glob's static-prefix spec
  root, is rejected before any read (so a citation cannot read a markdown file
  OUTSIDE the spec tree). The containment guards run **per matched glob and a
  SINGLE glob must satisfy all of them**: (1) the file lexically inside the glob's
  spec root; (2) the **real** file inside the **real** spec root (symlinked spec
  FILE escape); and (3) the **real spec ROOT itself inside the real worktree**
  (symlinked spec ROOT escape — e.g. `docs/specs` is a symlink to an external dir;
  codex#254-P2 FIX3). Any unresolvable realpath, or a root/file that escapes, is
  rejected before the read (fail-closed); platforms without symlink support are
  unaffected.
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

Because a capped batch leaves the hitch's live convergence at
`needs_classification` (unknown-scope findings remain), the **course**
orchestrator must NOT advance past it. After a non-escalating drive the course
re-derives the hitch's live convergence and, if it is a blocking decision
(`escalate` / `diverging` / `budget_exhausted` / `needs_classification`),
isolates the subtree exactly like the pre-drive gate — **retryable**, not a human
escalation and not a terminal advance: the phase stays open, downstream phases do
not progress, and a later invocation re-fires the same decision and drains the
next batch. The pre-drive gate and this post-drive check share one
`BLOCKED_DECISIONS` set so they never drift.

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
When the run's frozen review-rule snapshot contains `review.refute`,
target-bound rows in `review_refute_votes` are evaluated as a second
requirement before the aggregate decision is promoted. Only
`validation_status='passed'` rows from the configured refute group and frozen
refute reviewer set are eligible; only `uphold` / `refute` participate, and
`inconclusive` remains audit-only. A target is neutralized only when
`refute` votes form a strict majority of the frozen refute reviewer set
(`refutes > expectedReviewers / 2`). Missing, rejected, duplicate, group-mismatched,
or frozen-set-external votes fail closed and leave the original blocking
required_change intact. This refute path does not mutate finding severity; it
only affects which target-bound `changes_requested` blockers survive the
deterministic consensus gate.
When the hitch review runner sees a decisive blocking `changes_requested`
aggregate and the frozen review-rule snapshot defines `review.refute`, it
preflights the frozen refute reviewer set, dispatches `runRefuteAgent` once per
unrefuted target/reviewer pair, and then promotes the aggregate through the
same deterministic review-processing gate. Refute preflight failures
(unregistered reviewer, wrong group, or under-quorum registered set), rejected
refute rows, and sub-majority refute results fail closed: the run stays
unapproved or the blocking required change remains. Refute prompts identify a
target by `target_change_hash` plus `change_text`; filtered positional indices
are not part of prompt identity, so a crash/re-drive after another target was
already refuted deduplicates the same reviewer/target vote through the stable
`prompt_sha256`.
For frozen consensus runs (`reviewer_ids` present in the run's review-rule
snapshot), the hitch review runner dispatches the frozen reviewer set
sequentially and then processes the aggregate once. The runner's reported
`decision` is the processed aggregate status, not the final individual reviewer
verdict. Clean reviewer failures (timeout / non-zero / invalid output) are
treated as non-participants for that cycle; artifact tamper or unclassified
reviewer failures still fail closed. If every frozen reviewer fails cleanly and
no active proposal exists, the runner records a pending `review_consensus` row
and a completed hitch review cycle, invokes consensus-stall evaluation, and
returns `pending` instead of propagating the no-active-proposals gate error.
This pending-cycle exception is limited to frozen dispatch cycles with clean
reviewer failures; non-frozen consensus runs still surface `review process`
pending gates as `ReviewGateError`.
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
fail-closed classification gate. **(#283)** The two non-actionable advisory
categories `review-non-blocking-comment` and `review-out-of-scope-suggestion`
are additionally EXCLUDED from harness-origin divergence counts (the same
exclusion lane already applied to `duplicate` rows below): they are still
recorded and operator-visible in the cycle summary, but an approval/positive
advisory cannot inflate the harness-origin divergence count
(`harnessOriginNewFindings` / the per-cycle divergence churn) or trip a false
`diverging` on reopen. The exclusion keys on the
harness-assigned `category` column (deterministic, not LLM self-report) and is
category-based, not scope-based — an actionable `out_of_scope` finding still
counts. The blocking categories `review-required-change` and
`review-negative-decision` are deliberately NOT excluded, so genuine churn still
drives divergence and still blocks close (fail-closed).

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

`facet_red_test` (#279) is an **opt-in, deterministic** close-condition kind
(category `auto-verify`) that closes the reviewer-depth gap: the static
consensus reviewer does not execute tests, so it can approve work whose
production surface changed with no covering test (a fail-open shape). A
`facet_red_test` condition declares, in `rule.facets[]`, the contracted facets
the deliverable requires a RED test for:

```yaml
- id: facet-red
  kind: facet_red_test
  required: true
  rule:
    facets:
      - id: auth-login
        testGlobs: ["tests/auth/**"]        # where the covering test must live
        changedFileGlobs: ["src/auth/**"]   # optional: the production surface
```

Each facet is evaluated **deterministically** from the latest coding run's
`run_changed_files` (the same surface the post-hoc policy diff verified) plus
operator/runner-recorded close-check `evidence.facets[]` rows of shape
`{facetId, redTestPath, redDemonstrated: true, runId, evidenceRef?}`. **No
LLM/reviewer verdict is consulted for the state transition.** Glob matching uses
the harness-standard root-anchored `minimatch` options (`docs/policy-semantics.md`);
author `testGlobs` / `changedFileGlobs` with a leading `**/` for "anywhere in
the repo". The decision table (fail-closed at every junction — never `passed` on
missing/stale/malformed/unresolvable input):

| Situation | Facet status |
|-----------|--------------|
| changed test matches `testGlobs` AND fresh RED evidence for the facet from the close run on a changed test path | `passed` |
| `changedFileGlobs` matched a changed path but NO changed test matches `testGlobs` (fail-open shape) | `failed` |
| changed test matches but no corroborating RED evidence, and a fresh evidence row exists | `failed` |
| changed test matches but no evidence row recorded yet | `pending` (record evidence) |
| no recorded evidence row / stale evidence (older than `freshAfter`) and no fail-open shape | `pending` |
| evidence `runId` ≠ the close run (stale prior-approved run) / `redDemonstrated` ≠ `true` / `redTestPath` not a changed test | not counted → `failed`/`pending` per above |
| malformed `rule.facets` (missing id, empty `testGlobs`, duplicate id, …) | `failed` |
| no resolvable coding run (`latestCodingRunId` null) / `changedPaths` unavailable | `pending` |

The condition fails if any facet failed, is pending if any facet is pending,
and passes only when every facet passes. Evidence is **bound to the closing
`runId`**, so a re-opened hitch cannot inherit a prior approved run's coverage.
Existing hitches that never declare a `facet_red_test` condition are completely
unaffected — the gate is purely additive and can only make close **stricter**
for hitches that opt in.

**Recovery routing (#308).** The gate decision (pass/fail/pending) is unchanged;
only the recovery message and the routing of a *pending* facet condition differ
by what can satisfy it:

The recovery **message is keyed off what can satisfy the condition**, so it is
always consistent with where the condition routes — even when a STALE prior
check row exists. The stale/"record fresh RED evidence" message is emitted ONLY
for an evidence-recoverable pending (covering test present, only the RED evidence
row missing/stale); a fail-open-shape failure and a code-recoverable pending both
keep the actionable "no covering test" message, because recording evidence can
never satisfy either.

- A `failed` fail-open shape (production surface changed, no covering test)
  routes to `needs_fix` and keeps the actionable "production surface changed, no
  covering test" message — even when the only recorded evidence row is STALE,
  because a fail-open shape can be cleared **only by adding a covering test**,
  never by recording evidence.
- A `pending` facet is *code-recoverable* when at least one still-pending facet
  has **no covering test present** (reasonCode `no_change`): `matchedTestPaths`
  is empty, so no evidence row can ever clear it. It routes to `needs_fix` /
  `fix_findings` so the coder adds a RED covering test, and keeps the actionable
  "no covering test" message even with a stale prior check row. The coder rerun
  goal also carries that message: `closeCheckFailureContexts` includes a
  code-recoverable pending `facet_red_test` (in addition to failed required
  conditions). The message it injects for **any** `facet_red_test` condition
  (failed fail-open shape OR code-recoverable pending) is the **evaluator's
  current** message — `evaluateFacetRedTest` re-derives it from the current
  `run_changed_files` + evidence on every evaluation, so it is always correctly
  routed — never a possibly-stale facet `check.message`. (For NON-facet
  conditions the recorded `check.message` stays the preferred feedback, since a
  real recorded failure detail is the right coder feedback there.)
  Evidence-recoverable pendings and every other pending kind are NOT injected
  into the coder goal.
- A `pending` facet is *evidence-recoverable* when every pending facet has a
  covering test present and merely lacks a fresh RED evidence row: recording
  evidence clears it, so it routes to `continue` / `ask_human` via the
  external-evidence path (the pre-#308 behaviour, unchanged). The disposition is
  surfaced on the evaluated condition (`facetPendingDisposition`) and consumed by
  the convergence routing — convergence never re-derives it from facet internals.

The spec review and config-update paths share a pure spec-gate helper layer
under `src/hitch/`:

- `spec-gates.ts` exports the shared widening/loosening predicates used by hitch
  config updates and ratified phase attach gates: `isScopeWidening` and
  `closeConditionsLoosenGate`. These are pure helpers; the repository remains
  the writer that enforces them.
- `gap-to-kind.ts` maps a gap metric to one close-condition kind without I/O. It
  recognizes allowlisted command pass metrics, finding threshold metrics,
  review approval, artifact existence, operator verification, external operation
  status, and DB migration validity. Unmapped or ambiguous metrics return a
  reject result; they never silently default to `manual`.
- `spec-validation.ts` exports `validateCloseConditions`, a form/kind guard that
  reports hard errors and advisory warnings. It validates duplicate ids,
  `finding_policy.rule` keys, required `operation_status.metadata.operationId`, and
  required `db_doctor` gates while the runner is not implemented. `command`
  conditions are validated form-only (kind + syntax); allowed-command resolution
  is deferred entirely to the close-check runner. `facet_red_test` conditions are
  validated form-only too: `rule.facets[]` must declare each facet with a string
  `id` and a non-empty `testGlobs[]`, with no duplicate ids — but the validator
  **never touches the filesystem** to check whether the declared tests exist
  (that is the runtime gate's job, evaluated from `run_changed_files` + recorded
  RED evidence). Missing external-evidence descriptions and missing
  `artifact_exists.metadata.path` are advisory warnings. The validator does not
  decide close readiness; convergence and close-check evaluation remain the only
  close-state authority.

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
The scope-widening and close-gate-loosening predicates are the shared pure
helpers in `src/hitch/spec-gates.ts`, so hitch and phase-spec gates use one
behavior definition instead of mirrors.
Each update writes an `updated` lifecycle event containing the changed fields and
previous config snapshot.
`HitchRepository.createSession()` is also a write barrier: it parses scope and
close conditions and runs the close-condition validator before inserting, so
direct repository callers cannot bypass CLI/MCP parsing. MCP `hitch.expand_scope`
uses `updateSessionConfig()` after merging scope, with explicit
`allowScopeWiden`, and therefore records the same `updated` lifecycle event.

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
