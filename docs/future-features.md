# Future features

Ideas recorded for later implementation. Each entry is a sketch, not an approved
design — run it through brainstorming → spec → plan when picked up.

## commit-object identity metadata exfil (author / committer)

- **P3 (defense-in-depth, deferred)** — the git-validation hardening PR
  authenticates the commit MESSAGE (`%B`) and suppresses hook / message-cleanup /
  `gpgsig`-header injection at mint (`-c core.hooksPath=/dev/null --no-gpg-sign
  --cleanup=verbatim`). The remaining unauthenticated bytes in a pushed commit
  object are the author/committer identity fields (name / email / date), which a
  target-repo `user.name` / `user.email` config could carry. Capacity is bounded
  and the values are surfaced/auditable in the PR + commit metadata, and pinning a
  fixed harness identity would discard real authorship — so it is deferred rather
  than fixed. If picked up: pin author+committer at mint (`-c user.name=… -c
  user.email=…` or `GIT_AUTHOR_*`/`GIT_COMMITTER_*`) and/or assert them post-commit.
  Surfaced by codex gpt-5.5 xhigh during the Part B review.

## tracked out-of-scope file modifications surface bytes in final-diff.patch

- **P3 (pre-existing, by design)** — a committed (or plain) MODIFICATION of a
  base-tracked out-of-scope file stays a tracked modification after the run-flow
  `git reset --mixed <base>` normalization (the working-tree content still differs
  from base), so its bytes appear in `final-diff.patch` / the DB artifact blob.
  This already occurs on `main` (no normalize there; `git diff <base>` of a
  committed tracked-modify shows the same bytes) and is NOT worsened by the
  #141/#197 change. The run still finalizes `failed-policy-violation` (the modify
  is detected via the pre-normalize evaluation), so it cannot reach
  needs_review/approved/PR — the bytes only enter a reviewer-facing artifact of a
  FAILED run, which is the intended behavior that tracked denied-file diffs are
  surfaced for the reviewer to understand the violation. Only committed/staged
  out-of-scope ADDs are byte-suppressed (they fold to untracked → metadata-only).
  A dedicated tracked-denied redaction pass is deferred (it would withhold the
  bytes of out-of-scope tracked modifications too). Surfaced by Opus during the
  #141/#197 review.

## close-check ignored-untracked directory fingerprints

- **P2: recursive directory fingerprinting** — ignored untracked directories can
  appear as directory-granularity entries from `git ls-files --others` (for
  example nested git checkouts). The current close-check snapshot fingerprints
  that path as `["dir"]`, so it does not recursively detect changes inside the
  directory. Normal file, symlink, and listed-path fingerprints remain covered,
  and unreadable fingerprints still fail closed. Recursive directory
  fingerprinting is deferred because it needs explicit cost and traversal
  bounds.
- **P3: empty ignored directories** — `git ls-files --others` does not list empty
  directories, so creating an empty ignored directory is not detected. This does
  not provide a path to mix unreviewed file content into a PR, so it is deferred.

## near-duplicate finding dedup — residual tuning (#155)

- **P2: bare `line N` / `L123` line-reference normalization** — `replaceLineReferenceNumbers`
  normalizes filename-adjacent `:line` plus bare `line 123` / `line:123` / `l123`
  forms so reviewer paraphrases that differ only by a line number dedup. Host/IP
  `:port` is excluded (meaningful ports preserved), but bare `line N` without a
  filename can still over-dedup pathless findings whose number is meaningful
  (e.g. "queue line 1" vs "queue line 2"). Blast radius is bounded: pathless
  near-dup additionally requires the stronger anchor (token ≥ 0.8 + distinctive
  token), and promotion-on-merge keeps the canonical close-blocking, so no
  blocker is hidden. Restricting bare `line N` normalization to filename-adjacent
  context is deferred tuning.
- **P3: benign failure-word advisories** — the command/test-evidence advisory
  suppression vetoes notes containing failure/negation words so real failures are
  not suppressed; environment/test-not-run notes that merely mention "error" /
  "failed" in meta context therefore import as `review-non-blocking-comment`
  findings. These are always classified `out_of_scope` (never `unknown`), so they
  never escalate or block close — at worst they add deferral noise. Tightening the
  veto to word/suite context is deferred.

## DB stats snapshot/delta

The Phase 15 `db_stats_snapshots` repository/table was removed in audit cleanup
#126 because it had no production callers: `harness db stats` only reads live
`dbStats()` output, and snapshot/delta commands were never wired. Reintroduce this
only with an end-to-end CLI/API surface, retention policy, and migration plan.

## lock_busy event metrics — implemented

Implemented by schema v28 as `domain_lock_contention`. `DomainLockBusyError`
still happens before a run log exists, so the signal is recorded in a dedicated
append-only telemetry table instead of `run_events`. The scoped KPI is exposed as
`metricsSummary.lockContentionCount`.

## Operational knowledge — deferred surfaces (issue #57)

**Issue #57 is COMPLETE** (closed). The operational knowledge category
(`knowledge_entries.category='operational'`, schema v19) shipped as: storage core +
CLI (`knowledge ops add/list/show/deprecate/digest/export/import`) + MCP read
(`ops_knowledge.search/get`) + MCP write (`ops_knowledge.record/deprecate`, guarded
mutation) + inbox surfacing (E) + reviewer/goal injection (F, never the coder prompt) +
**file-export parity** (`docs/ops-knowledge/<kind>/<key>.md` round-trip, separate from the
codebase `docs/knowledge/` namespace) + **digest**. `promote` parity is intentionally
N/A — operational knowledge is authored directly (no untrusted generator to gate).

## Release planning — beyond `harness release plan`

`harness release plan` (deterministic release-readiness + compatibility analysis,
`docs/specs/release.md`) shipped as a CLI command. Natural follow-ups:

- ~~**MCP read exposure** (`harness.release.plan`)~~ — **landed** (read tool wrapping
  the analyzer core; `docs/specs/mcp.md`).
- ~~**`harness release check`**~~ — **landed**: a fail-closed readiness gate
  (plan-clean + version-consistency + spec-sync + clean-tree). `docs/specs/release.md`.
  build/test stay CI's job. An agent runs this before merging the release PR.
- **`harness release notes`** — render a `docs/UPGRADING.md` section from the plan
  (feature summary + the schema no-downgrade caveat + surface changes).
- **richer surface diffing** — the current MCP/CLI surface parse is regex-based
  (best-effort) and does not diff config keys; a structured surface snapshot would
  be more robust for future ranges.

Recorded 2026-06 when the `release plan` CLI landed.

## Course orchestrate follow-ups (SP-2 out of scope)

SP-2 shipped `course orchestrate` as a drive-only, single-pass bounded driver over
manually linked hitches. These adjacent capabilities are intentionally out of
scope and should go through their own design/plan before implementation:

- **Auto-spawn from `needs_link`** — `needs_link` is the deterministic junction
  where a future increment can spawn/link a hitch for an actionable leaf phase.
  Current behavior reports the phase and continues.
- **Course-level PR automation (`--open-prs`)** — a future opt-in may open PRs
  for hitches that become close-ready during the pass. SP-2 stops at close-ready
  and leaves PR/close to explicit follow-up commands.
- **Phase auto-close** — `readyToClose` is derived from live convergence and
  `PhaseRollup`; SP-2 does not write `phase.status = closed`.
- **Parallel hitch drive** — SP-2 drives hitches serially within a course-pass
  budget and one course lease.
- **Durable `course_orchestration_runs` table** — SP-2 records operation audit
  only; it does not add a new run table or migration.
- **Phase dependency edges** — ordering is the current phase tree pre-order.
  Cross-phase dependency modeling is a later roadmap-layer extension.

## Atomic authorization for MCP mutations (TOCTOU)

MCP mutation tools authorize (project scope / existing-entry checks) in a
pre-dispatch step, then write later in a separate OperationRunner transaction —
the general pattern for every mutation tool, not just `ops_knowledge.*`. A
concurrent writer could change the target between check and write. For the
current single-operator MCP deployment this is low risk, but if restricted MCP
clients are ever treated as mutually-untrusted tenants, the authorization should
move into the same `immediate()` transaction as the mutation (e.g. an authorize
callback the core write invokes inside its tx). Flagged by the G codex review
(P2), 2026-06.

## Coder prompt knowledge provenance audit

Reviewer prompt provenance is implemented in schema v24:
`review_proposals.prompt_sha256` is populated by `review auto`, and
`prompt_provenance_json` records the reviewer template and injected operational
knowledge entry ids/versions as audit-only metadata. A remaining follow-up is the
analogous coder-side codebase-knowledge provenance for prompts assembled by
`runDomainCoding`.

## Multi-reviewer consensus orchestration (drive the stall trigger)

**What:** Let `harness hitch orchestrate` drive **multiple reviewers** per review
cycle so consensus-mode hitches can actually reach quorum (and accumulate the
pending timeline that the Phase 2 stall detector escalates on).

**Why it is NOT in scope (Phase 2 boundary):** Phase 2 implemented the consensus
extension — quorum / staleness, the deterministic `detectConsensusStall`
detector, and the hitch integration (`evaluateConsensusStallForHitch`), all
unit-tested. But the orchestrator's review runner drives a **single** reviewer
per cycle (`review.auto` with one reviewer), then `review process`. In consensus
mode a single reviewer can never satisfy a `quorum > 1`, so `review process`
returns a fail-closed pending and the orchestrator loop escalates on the first
pending — the multi-cycle stall path is never exercised in the wired flow. The
escalation *capability* exists and is correct; only the multi-reviewer *driving*
is missing.

**How (sketch):**
- Teach the orchestrator review runner to dispatch N reviewers (per the run's
  review rule / reviewer groups) before calling `review process`.
- On a pending consensus, record the review cycle and run
  `evaluateConsensusStallForHitch` (rather than escalating immediately), so the
  stall detector decides escalate-vs-keep-waiting across cycles.
- Reconcile with the single-writer review model and the hitch budget.

**Prerequisites:** reachable consensus mode (profile-loaded review rules —
`resolveEffectiveRule` currently always returns the default latest-proposal rule;
Phase 14 profile loading is the gate).

**Status:** idea only — recorded 2026-06 during `GOAL.md` Phase 2 (consensus
extension) review.

## Copilot PR review integration

**Idea:** Let `harness pr create` optionally request a GitHub Copilot code
review on the PR it opens, so an approved run can be handed to Copilot for an
automated second-pass review on GitHub.

**Why:** The harness already produces approved runs and opens (draft) PRs via
`gh`. Adding a Copilot reviewer request closes the loop to "PR is up and a
review is already in flight" with no extra manual step.

**How (sketch):**
- GitHub CLI supports this since 2026-03: `gh pr create --reviewer @copilot` and
  `gh pr edit <pr> --add-reviewer @copilot` (bot reviewer `@copilot`).
- Wire it into `src/core/pr-creator.ts` / `src/core/gh-pr-publisher.ts`: add an
  opt-in flag (e.g. `harness pr create --copilot-review`) that passes
  `--reviewer @copilot` to the publisher (or issues the `gh pr edit
  --add-reviewer` follow-up after the PR is created).
- Consider the orchestrator: a `closeAndPr` that also requests Copilot review
  would make the autonomous loop produce a PR with a review already requested.

**Prerequisites / caveats:**
- The repo/org must have Copilot code review enabled, on a plan that includes it.
- Keep it opt-in (a flag), not default — it triggers an external, billable
  review and posts bot comments on the PR.
- Third-party `gh` extensions exist (`k1LoW/gh-copilot-review`,
  `ChrisCarini/gh-copilot-review`) with duplicate-prevention / wait-for-completion;
  evaluate vs. a thin native `--reviewer @copilot` call.

**Status:** **実装済み**（best-effort opt-in, 非 gating）。最終的な配線は当初の
sketch（`pr create --copilot-review`）とは別の形で着地した:

- 単発: `harness pr request-review <pr-number> --repo <path>`（retry-then-skip・
  非 gating。詳細は [`specs/cli.md`](./specs/cli.md#harness-pr-request-review)）。
- 自律ループ: `harness hitch orchestrate --request-copilot-review`（既定 OFF）。
  `closeAndPr` で PR 作成後・auto-merge 前に best-effort で実行
  （[`specs/workflow.md`](./specs/workflow.md) の「Copilot review（観測ステップ）」）。

いずれも **close / merge を一切 gate しない**（外部出力を状態遷移の根拠にしない安全
境界）。outcome は operation audit（`copilot-review`）に記録するのみ。

経緯メモ: 2026-06 の実験（`monorepo-harness` / `mini-commerce` への throwaway PR）
では Copilot が "encountered an error and was unable to review this pull request"
を返し、自動レビューを有効化しても実レビューが返らなかった。アカウント / GitHub 側の
事象と判断し、配線自体は非 gating の best-effort（失敗しても loop を止めない）として
実装した。Copilot が end-to-end で実レビューを返すかは運用環境に依存する。

## Codex session continuation (conversation resume)

**Idea:** Let the harness optionally keep a codex *session* (conversation /
rollout) across multiple invocations of the same logical task, instead of always
running single-shot. A rerun-after-review, or a multi-turn refinement, could
resume the prior codex conversation rather than rebuilding a fresh prompt.

**Why considered:** Today every codex call is single-shot and stateless — the
runner hardcodes `--ephemeral` (`src/codex/codex-cli-runner.ts`), so no session
state is persisted in `CODEX_HOME`, and no session/conversation id is parsed or
stored. Context is carried *only* via prompt injection: rerun re-injects
`required_changes` (`src/core/rerun.ts`), knowledge context is appended as a
`<knowledge>` block (`src/codex/prompt-builder.ts`), and lineage is tracked
harness-side (`parentRunId` / `rootRunId` / `rerunAttempt`). A session could, in
principle, preserve intermediate reasoning that re-injection drops, and be
cheaper on long multi-turn refinements.

**Why it is NOT in scope (the tension):** Statelessness is a deliberate part of
the safety model (`GOAL_RULES.md` §G, `docs/specs/workflow.md`), not a gap:
- **Reproducibility** — a run is fully determined by `prompt + policy +
  worktree`; there is no hidden conversational state to drift.
- **Auditability** — policy verification is purely after-the-fact `git diff`;
  nothing accumulates on the codex side that the harness cannot see.
- **Don't trust LLM-side state** — resuming a session means trusting context the
  harness no longer owns; the harness must remain the single source of truth for
  state transitions.

**How (sketch, if ever pursued):**
- Drop `--ephemeral` for an opt-in session-backed runner; capture codex's
  session/rollout id from its output and persist it (new DB column on the run).
- Add a `resume` path in `CodexExecRunner` implementations that re-attaches to a
  stored session id instead of building a fresh prompt.
- Reconcile with the safety model: bound which surfaces may use sessions (likely
  *not* the reviewer agent, which must stay read-only and stateless), and keep
  policy verification on `git diff` regardless of session state.

**Prerequisites / caveats:**
- Requires the installed codex CLI to expose stable session-resume semantics;
  verify the exact flags/behaviour for the pinned codex version before relying on
  them.
- Likely needs a spike first to confirm sessions actually beat prompt injection
  for our workloads, and that resume can coexist with reproducibility/audit.

**Status:** idea only — not designed or scheduled; recorded 2026-06 during
`GOAL.md` planning.

## rerun parent-work continuation for non-hitch paths (#163 follow-up)

**Idea:** Extend the #163 parent-work continuation (a rerun materializes the
parent run's uncommitted policy surface into the child worktree so codex amends
in place instead of re-implementing from a clean base) to the non-hitch rerun
entrypoints.

**Why considered:** #163 is **scoped to the hitch fix-loop only** — the
continuation is set up in the hitch orchestrator's `coder()`
(`src/hitch/orchestrator-runners.ts`), which resolves `continueFrom` and threads
it into `runDomainCoding`. The other rerun paths — `harness rerun` /
`harness rerun --from-review` (`src/core/rerun.ts`), `harness workflow
reviewed-run`, and the MCP rerun tools — do **not** pass `continueFrom`, so they
still run **fresh-from-base** (carry context only via prompt-injected
`required_changes`). The materialization mechanism in `runDomainCoding`
(`continueFrom` / `resolvedBaseSha`) is general and could be wired into them.

**Why it is NOT in scope:** #163 deliberately landed the minimal hitch-loop fix
(where back-to-back reruns dominate). The other paths need their own
base-equality gate + parent-worktree resolution and tests; folding them in would
widen the change beyond the reviewed surface.

**Status:** idea only — recorded 2026-06 alongside the #163 fix.

## 非同期な外部チェック（codex GitHub App review / Copilot review / CI）の bounded await + 取り込み

**問題 / 観測:** `harness hitch orchestrate --auto-merge` の `closeAndPr` は、PR を
作成した**直後に merge gate を 1 回だけ評価**し（CI は `createGhCiStatus` の単発
スナップショット＝完了を待たない）、その後 hitch を `closed` にする。`closed` は
`orchestrator-dispatch.ts` で `stop` にマップされ、`runAutoMerge` も単発評価のため、
**PR 作成後に遅れて到着する signal は gate に一切反映されない**。実 repo では CI が
数分かかるので通常 `ci_not_green`（transient）→ PR を残して hitch close、になる。

2026-06-05 の B（PR #15）実験で具体化: PR には codex GitHub App が**絵文字 reaction
で ack**したが、Copilot review と CI が先に終わって harness が gate 評価・hitch を
閉じたため、**codex App の本レビューを待たず / 取り込まずに**進んだ可能性が高い
（`hitch_attempts: implement=1`、rerun ゼロ、required_changes ゼロで一発マージ）。

**なぜ重要（規模依存）:** 小規模変更では「即評価 → 残ったら operator が手 merge」で
無害。だが**サブフェーズが多い大規模 PR** では、(a) 外部レビュー（特に codex GitHub
App / Copilot）が実バグを拾う価値が高く、(b) それを取りこぼすと修正ループへ戻す
経路が無い、の二重の問題になる。harness 内部の codex review はローカル `codex exec`
で **diff のみ**を見るので、GitHub 上の PR コンテキストで動く外部レビューとは観点が
異なり、補完価値がある。

**対策案（sketch、実装はしない / 複数の方向）:**

1. **resumable な "awaiting-checks" hitch 状態 — CI 部分は実装済み（slice 1）。**
   transient が **`ci_not_green` のみ**のとき hitch を `closed` でなく **`close_ready`**
   に残し（新 status / migration を避け close_ready を「PR up・CI 待ち」に二重利用）、
   後続の `hitch orchestrate` が closeAndPr に再入して CI 緑なら merge する
   （`createPullRequest` は既存 PR を冪等返却し reviewed head SHA を run branch tip から
   解決、`runAutoMerge` が再 pin）。`tier_not_auto_eligible` は再チェック無意味なので
   `closed`（人手）。これで「later merge」が harness 経路になった（CI 待ちのみ）。
   **外部レビュー verdict の advisory ingestion も実装済み（slice 2）**: opt-in
   `--ingest-external-reviews` で gate 評価前に PR の verdict（codex App / Copilot）を
   fetch、`CHANGES_REQUESTED` を **unknown-scope finding**（1 度だけ）として記録 →
   closeReady 落ち→escalate→operator 分類（§6・fail-closed）。approve は ingest しない
   （§0 非対称）。`createGhReviewVerdicts` + `ingestExternalReviewVerdicts`。
   **外部レビューの bounded await も実装済み（slice 3）**: opt-in
   `--external-review-timeout <seconds>`（既定 `0`＝単発）で CI bounded await と対称に、
   gate 評価前に verdict を 15 秒間隔で poll（`CHANGES_REQUESTED` 出現か budget 切れまで）。
   budget 内に blocking 無ければ gate 評価へ進む（fail-safe。遅延 verdict は close_ready
   再 check で後拾い）。`reviewAwait`（`now`/`sleep` 注入可）。これで「一発 orchestrate が
   verdict 到着前に評価してしまう」窓を bounded に塞いだ。
   **残 slice**（いずれも core 機構に触れる**大 Phase 級・codex review 必須**の独立タスク。
   セッション末尾で急がない＝fail-closed）:

   - **専用 `awaiting_checks` status（close_ready 二重利用の解消）— 高リスク migration が前提。**
     **判断（2026-06-08・defer 確定）**: C#9 として評価したが**実装しない（defer）**。当初
     「scheduler 駆動 `hitch await-merge` の前提」とされたが、**C#7 の `hitch await-merge` を新
     status 無し（`close_ready` の resumable パス）で実装した**ため前提が消滅。「PR オープン・
     CI 待ち」は既に `close_ready` ＋ PR-open で表現でき、status を足すと**情報が重複**し、
     convergence（finding/close-check から decision を算出）と orchestration（PR/merge）の
     関心が混ざる。一方コストは**最高**（下記の FK 親 recreate migration ＋ runner への新
     インフラ）。可視化が要るなら base column ではなく**派生ビュー**（`close_ready` ∧ PR-open →
     `effective_status='awaiting_checks'`）で十分。よって実装せず本メモを設計記録として残す。
     以下は将来どうしても入れる場合の最小設計。
     `hitch_sessions.status` は `CHECK (status IN (...))`（`schema.ts:1253`）。新値の追加は
     SQLite では **テーブル recreate** が必須だが、現状これは**現 migration runner と非互換**:
     runner は全 DDL を**トランザクション内**で実行し（`migrations.ts:197`）、接続は
     **`foreign_keys = ON`**（`connection.ts:44`）、かつ `hitch_sessions` には**子 5 本**
     （`hitch_attempts` / `hitch_findings` / `hitch_review_cycles` / `hitch_close_checks` /
     `hitch_convergence_decisions`）が **`ON DELETE CASCADE` FK** で依存する。この状態で
     CHECK 変更に要る `DROP TABLE hitch_sessions` を実行すると、暗黙 DELETE が子の **CASCADE
     を誘発し全削除**される（`PRAGMA defer_foreign_keys` は検査を遅らせるだけで cascade
     アクションは止められない）。FK-safe な recreate には `PRAGMA foreign_keys=OFF`（**tx 外
     でしか切替不可**）が要る。artifacts v4 recreate（`schema.ts:475`）は子 FK 無しの前例で、
     ここには使えない。**実装方針**: migration runner に「FK 親を recreate する migration」を
     表現する hook を足す（apply 前後で `foreign_keys` を OFF/ON、tx 外で実行、末尾に
     `PRAGMA foreign_key_check` で整合を assert して fail-closed）。`writable_schema` で
     sqlite_master の CHECK 文字列を直接書き換える手は cascade を避けられるが SQLite が
     非推奨で corruption リスク・review で落ちるため**不採用**。consumer（v17）と同時に出す。
     配線側は: `HITCH_STATUSES`/`SCHEMA_VERSION` 追加、`orchestrator-runners.ts:581-590` の
     recheckable 時 status を `close_ready`→`awaiting_checks`、`convergence-status.ts` の
     close_ready reversion（`:110`）を `awaiting_checks` にも適用、close_ready 決定時に現在
     `awaiting_checks` なら据え置く分岐。dispatch は decision 駆動なので不要。**migration の
     data-survival テスト（既存 hitch が子ごと生存）を必須**にする。
   - **ingest 後の fix ループへの finding 注入 — 実装済み（slice 4）。** 以前は hitch mode の
     coder rerun が `runDomainCoding({ goal: context.goal })` のみで、open in-scope finding を
     coder prompt に注入していなかった（① 以前からの潜在ギャップ）。`augmentGoalWithOpenFindings`
     を追加し、`rerun` 系 attempt で open in-scope（lifecycle `open`/`reopened`/`escalated`）を
     集約してゴール文言末尾に「Open in-scope findings to address」ブロックとして注入する
     （run 単体 `core/rerun.ts` の required_changes 注入の hitch-mode 版）。初回 `implement` は
     非注入、`unknown`-scope は分類前なので非注入（fail-closed）、件数上限 25（超過は明示注記）。
     pure helper を単体テスト＋coder runner の prompt 捕捉で統合テスト。これで operator が
     finding を in_scope 分類した後の rerun が「何を直すか」を持つ。`runDomainCoding`/
     prompt-builder は無改変（ゴール文言だけ拡張）で最小リスク。~~**残**: 外部 finding 分類→
     rerun の**自動連鎖**~~ → **実装済み（C#8, PR #50）**: `hitch finding classify --then-rerun
     --repo <path>` が in-scope 分類後、convergence が `needs_fix` のときだけ orchestrator を
     bounded で回し coder rerun を連鎖する（gate 経由・operator 分類が trigger・LLM は
     execution-only）。`needs_fix` でなければ自動実行せず `rerun=skipped(<reason>)`。
   - 定期 `hitch await-merge`（scheduler 駆動の自動再 orchestrate。`awaiting_checks` status が
     前提＝上記の後）、semantic dedup（§3）。
   - **`hitch await-merge` の外部レビュー ingestion の wall-clock を完全束縛する**（codex
     review C#7 round4 の P2・defer）。現状 `await-merge` は各試行の CI await / external-review
     await / verdict fetch（`gh pr view`）timeout を残予算で clamp し、予算切れなら ingestion
     を省くが、`--ingest-external-reviews` 時の **initial fetch ＋ await-loop の複数 fetch が
     加算的**になり、`--max-wait` を僅かに超え得る（超過は O(予算)・opt-in・秒未満予算という
     非現実的設定でのみ顕在）。厳密束縛には `ingestExternalReviewVerdicts` /
     `fetchBlockingVerdicts` / reviewAwait に **deadline（残予算）を引き回し**、各 I/O 前に
     deadline チェックする必要がある（共有 review-await 機構への変更＝await-merge 単体スコープ外）。

   core（§2/§6 の advisory レーン＋ async bounded await、slice 1–3）は通った。

2. **bounded poll-and-ingest lander（land を実装ループから分離）。** `ciStatus` を
   bounded poll 化し、`gh pr view --json reviews` で codex App / Copilot の verdict を
   取得。`harness pr land` / `hitch await-merge` を resumable に。

3. **外部レビュー指摘の finding 化（advisory）。** PR の review コメント（codex App /
   Copilot）を hitch finding として ingest → P0〜P3 分類 → 修正ループへ。**ただし安全
   境界（外部出力を状態遷移の根拠にしない / 現状 Copilot review は意図的に非 gating、
   [[Copilot PR review integration]] 参照）と衝突する。** 衝突回避案: 外部由来 finding は
   **operator 分類必須の advisory** とし自動 gate しない（`stopOnUnknownScope` と同様、
   分類するまで close をブロックする fail-closed 側に倒す）。これで「外部レビューを
   無視しない」と「外部出力を信用しない」を両立。

4. **GitHub native auto-merge をブリッジに（opt-in）。** 即 `gh pr merge` の代わりに
   `gh pr merge --auto` ＋ branch protection（required checks に CI、required reviewers
   に codex App / Copilot）で async 待機を GitHub 側へ委譲。harness gate の決定論性は
   弱まる（merge 判定が GitHub 側）ので opt-in。harness は outcome を後追いで
   operation audit に取り込む。

5. **規模に応じた behavior 切り替え。** サブフェーズ数 / 変更行数 / domain などの閾値で、
   小規模は現状の即評価、大規模は (1)〜(3) の bounded await + ingest、を選ぶ。

**トレードオフ / caveat:**
- **安全境界が最大の論点。** 外部レビューを gate / fix に使うのは現行方針（非 gating）の
  転換。advisory + operator 分類 + fail-closed で寄せるのが安全。
- 既存制約に手を入れる必要（1〜3）: `orchestrator-dispatch.ts`（closed→stop）、
  `gh-pr-publisher.ts`（`createGhCiStatus` 単発）、`orchestrator-runners.ts`
  （`runAutoMerge` 単発評価 / closeAndPr が即 close）。
- **bounded であること必須**（無制限待機 / 常駐 daemon は別件で非ゴール、
  `specs/overview.md`「できないこと」）。timeout は fail-closed で PR を人手へ残す。
- codex App / Copilot の到着タイミングはアカウント / GitHub 側に依存し不確定。

**関連:** [[Copilot PR review integration]]（非 gating の既存配線）、auto-merge
（`specs/workflow.md` の「Phase 3 — auto-merge」）、Multi-reviewer consensus
orchestration（内部レビューの multi-reviewer driving）。

**Status:** idea only — 未実装 / 未設計。フロー自体が手探り段階のため設計だけ記録。
2026-06-05 の B（PR #15）auto-merge 実験での観測に基づく。

## 設計原則: 外部出力と状態遷移の非対称（bugfix2 / advisory finding / auto-merge tier）

上記「非同期な外部チェックの取り込み」を**どう安全に組むか**の判断基準。実装前の
合意事項として明文化する（2026-06-05 の運用整理ディスカッションより）。

### 0. 貫く一原則（非対称）

> **外部 / LLM / 自動化は、流れのどこでも fail-closed 方向（厳しくする・作業を
> 増やす・人手に寄せる・両方残す）には自由に押してよい。だが fail-open 方向
> （自動承認・完了・drop・gate 緩和・auto-merge 許可）には決して押せない。
> そこは決定論ロジックと operator が握る。**

理由: tighten 方向の誤り（誤検知・無駄作業）は最悪 operator が却下して終わる。
open 方向の誤り（偽の "LGTM" を信用）は悪コードの merge に直結する（取り返しが
つかない）。だから両方向を同じ信頼度で扱わない。

### 1. close 条件は「ルール」、レビューは「データ」（gate の切り分け）

- **ルール（固定・operator 所有）**: `closeConditions`（`--close-file`）＋
  `policy.closeRequires`（open in-scope P0/P1 ゼロ・unknown ゼロ）。**主ゴールと
  一緒に最初に決まり、レビューで書き換わらない。**
- **データ（レビューが生む）**: finding。レビューは finding を足すだけで、close
  条件（ルール）は追加・緩和できない。
- 「サブ条件が増える」感覚の正体: 固定ルールが**新しい finding を数えて未達に
  なる**現象。条件追加ではない。
- finding が「候補」から「ブロッカー」に化ける唯一の関所は **scope/severity 分類**。
  ここが決定論 or operator（LLM の severity 自己申告は不採用、unknown は
  `stopOnUnknownScope` で escalate、"直した" は tests/diff で再検証）。**これが
  「外部を根拠にしない」の実体。**
- 本当に新しい明示 close 条件を足すのは **operator の意図的操作**のみ
  （`hitch close-check` / close 条件編集）。LLM 自動追加は不可。

### 2. 三レーン（trust / risk で分ける運用層）

| レーン | 駆動 | 状態遷移の根拠 | merge |
|--------|------|----------------|-------|
| **Fast** | 内部 codex review + CI | 決定論（consensus / CI / finding） | 小規模のみ auto（CI bounded await 前提） |
| **Advisory** | copilot / GitHub codex app review | **operator 分類**（advisory→promote） | bugfix2 で再検証後に再 gate |
| **Human** | 大規模 / 迷い | 人 | 人手 merge |

bugfix2（PR 後の修正ループ）は Advisory レーンに置く。外部 finding は既定
**deferred/advisory**、operator が in-scope P0/P1 に promote したものだけ修正に
入れる。修正の効果は内部と同じく **tests/diff で決定論的に再検証**（"直った" を
信用しない）。

### 3. 三論点の指針（いずれも §0 の非対称に従う）

- **semantic dedup**: 畳む/落とすは fail-open（本物の P0 を消すリスク）。
  **疑わしきは両方残す**。順序は ①anchor+category の決定論完全一致のみ畳む
  ②「重複候補」は operator へのヒント（advisory） ③embedding/意味クラスタリングは
  後回し（hitch-convergence の **non-goal** に "semantic embedding clustering" が明記）。
- **operator 分類負荷**: 権威ある分類は operator から外せない（安全境界）。が
  (a) **決定論 auto-scope**（diff/domain 外を指す finding は自動 out_of_scope）、
  (b) **default-defer**（外部 finding の既定を非ブロッキングにし「沈黙=stuck」を
  「沈黙=defer=前進」へ反転）、(c) **severity ルーティング**（LLM severity は gate
  でなく "誰の目を先に向けるか" の優先度にだけ使う）、(d) **サブエージェント
  前処理**（クラスタ化/scope 提案を advisory で出し operator は一括確認）で軽くする。
- **auto-merge tier 境界**: tier 許可は**決定論・operator 所有の信号のみ**で計算
  （path の **sensitivity map**＝blast-radius を符号化した glob / 変更サイズ /
  サブフェーズ・rerun 数 / 内部 finding プロファイル / CI coverage）。どの信号も
  **人手方向にしか押せない**。外部レビュー結果は tier を**厳しくする方向にだけ**
  使え、緩める方向には使わない。**既定は人手**（fail-closed）、積極的に全 gate を
  クリアした薄いスライスだけ auto。`src/policy/**` `src/codex/**` `src/hitch/**`
  migrations `.github/**` 等の安全境界路は常に auto 不可。

### 4. 前提（最初のベーシックな一歩）— **実装済み（P1, PR #19）**

auto-merge を実在させる前提だった **CI の bounded await**（PR 作成後に CI 完了を
timeout 付きで poll、timeout は fail-closed で人手に残す）は **実装済み**。
`createGhCiStatus`（`src/core/gh-pr-publisher.ts`）が単発スナップショットから
bounded poll になり、`hitch orchestrate --ci-await-timeout`（既定 1200s）で CI 完了を
待ってから gate 評価する。head-moved / terminal failure / timeout はすべて
fail-closed。仕様は [`specs/workflow.md`](./specs/workflow.md) の「Phase 3 — auto-merge」。

> 残るのは**非ブロッキング化**: 現状は `closeAndPr` が in-process で CI 完了まで待つ
> （最大 timeout 分ブロック）。上記エントリの **resumable `awaiting_checks` 状態 /
> 外部レビュー ingestion** は未実装で、bounded await はその「最小の一歩」に当たる。

### 5. sensitivity map の初期 tier（monorepo-harness 向け）— **実装済み（P2, PR #20）**

path glob → tier（= blast radius と meta-risk の符号化）。tier 許可は決定論的に
これで計算する。**meta-risk**（gate する仕組みそのものを変える変更）は常に
auto 不可 — 変更が自分のチェックを無効化しうるため。

> **実装済み**: `src/core/automerge-tiers.ts`（`DEFAULT_AUTO_MERGE_SENSITIVITY_MAP`
> ＋ `computeAutoMergeTier`）。`evaluateMergeGate` に `tierEligible` を足し、tier>0 は
> `tier_not_auto_eligible`（**非hard**＝PR を残すだけ・escalate しない）。`runAutoMerge`
> は run の changed paths から tier を計算し **tier===0 のときだけ auto-merge**。
> fail-closed: 空 paths→tier-1 / multi-match→max tier / 未マップ→tier-1。tier gate は
> auto-merge を**制限方向にしか効かない**（§0 非対称）。下表は初期 map（コード内の
> 既定値が真）。**operator override は実装済み（PR #23）**: `policies/automerge-tiers.yaml`
> （任意）の rule を既定 map に追記、max-tier セマンティクスで **operator は厳格化方向
> にしか効かない**（緩められない）、malformed は throw（`src/core/automerge-tiers-config.ts`）。
> **tests additive-only ガードは実装済み**: Tier-0 の tests-only 変更が test 削除/
> skip 追加でカバレッジを削る場合は Tier-1 へ降格（`detectsTestWeakening` を run 時に
> `meta.reviewed.weakensTests` で捕捉、`effectiveAutoMergeTier` が降格）。両誤り方向で
> fail-safe。**`it()` 純減（net-count 減）の検出も実装済み**: `tests/**` ファイル単位で
> test/suite 定義の追加数 < 削除数なら降格（バランスした rename/refactor は非降格、
> ファイル単位評価で「足すだけの別ファイル」が「削るファイル」を隠せない）。
> **残 follow-up**: `src/core/automerge-tiers*.ts` 自体を Tier-2 にするか。

| tier | 方針 | path（例） | 理由 |
|------|------|-----------|------|
| **Tier-2 絶対 auto 不可** | 安全機構そのもの | `src/policy/**` / `src/codex/**` / `src/core/merge-gate.ts`・`src/hitch/orchestrator*.ts`・`src/hitch/convergence.ts` / `src/core/reviewer-agent.ts`・`src/db/repositories/review-*.ts` / `src/db/migrations*` / `.github/**` / `policies/**` | meta-risk: 壊れると安全境界・gate・CI 設定・policy 定義が緩む |
| **Tier-1 既定 人手** | 一般コード | 上記以外の `src/**`（cli/mcp/dashboard/knowledge/config/workspace…） | 通常の blast radius |
| **Tier-0 auto 適格** | 低 blast・survivable | `docs/**`、**追加のみの** `tests/**` | 非実行 or テスト純増。取りこぼしても follow-up で吸収可 |

bootstrap: Tier-0 を最小（`docs/**` ＋ テスト純増のみ）から開始、未マップは既定
人手（fail-closed）、事故ゼロ実績で慎重に拡大。map は operator 所有・versioned・
監査可能。**Tier-0 tests の罠**: テスト削除/`.skip`/`xfail` は silent に安全を下げる
ため、決定論検出（テスト純減/skip 追加）で人手へ降格（「追加のみ」が条件）。

### 6. default-defer の外部 P0 取りこぼしを人手 tier で拾う

外部 finding を既定 deferred にする穴（本物の P0 も既定で止まらない）は、
**defer ≠ drop**（defer は PR/hitch 上に可視で残り記録される）を前提に tier で拾う:

- **非 Tier-0**: どのみち merge 前に人がレビュー。**deferred な外部 finding を
  目立つ形で surface**し、人が本物の P0 を promote → merge ブロック → bugfix2。
  トリアージ担当が「ループ途中」から「merge 時の人」へ移るだけ。`merged with N
  deferred external findings` をログ（監査可能）。
- **Tier-0 auto**: 外部レビューは async（merge 後着）で間に合わない。緩和は
  (a) Tier-0 は「外部が P0 を出しにくい path」を選ぶ（docs・追加テスト）、
  (b) **merge 後着の外部 finding → 自動 follow-up 化**（backlog/revert 候補）。
  → **Tier-0 の本質は「小さい」でなく「外部 P0 を取りこぼしても follow-up で
  吸収できる＝実質可逆（survivable）」**。
- **severity floor（全 tier の保険・fail-closed）**: 外部 finding が **source 申告
  critical かつ in-diff で sensitive path を指す**なら default-defer せず人手強制。
  source severity は「承認」でなく「注意の強制喚起（fail-closed 方向）」にだけ使う。

→ 取りこぼしは「低 severity か低 blast、常に記録・follow-up、silent drop しない」に
bound される。

### 7. 発散検出の外部 finding 拡張

外部（複数 LLM）は大量・言い換え再提示・out-of-scope が多く、`maxNewFindingsPerCycle`
等にそのまま数えると偽 diverging or 永遠に減らない。拡張:

- **promote された in-scope P0/P1 だけカウント**（advisory/deferred は **inventory
  =在庫**でカウント外）。発散は **in-flight=仕掛り（修正中の blocking 集合）の
  軌跡**で測る。
- **外部レビューに独立 round 予算**（例 1、最大 2）。尽きたら残りは backlog。
  安定 head ごとに 1 パス、fix ごとに毎回再レビューしない（無制限ソース化を防ぐ）。
- **カウント前に保守的 dedup**（§3 anchor）。過剰 dedup は発散を早める＝fail-closed
  側なので安全。
- **外部 flood は fail-closed 方向にだけ**: 増え続けたら diverging→人手 escalate
  （「contentious な変更」の安全な応答）。「無視して merge」方向には効かせない。
- **operator の disposition を round 跨ぎで尊重**: deferred にした finding は外部が
  言い換え再提示しても（dedup して）再 escalate しない（`maxReopenedPerFinding` の
  精神を外部に拡張）。

**Status:** 設計原則 ＋ 三論点詳細（tier 表 / 取りこぼし吸収 / 発散拡張）を記録
（実装なし）。実装着手時は §5 の tier 表と「§0 非対称・§4 CI bounded await 前提」を
出発点にする。2026-06-05 の運用整理ディスカッション（A〜D auto-merge 実験後）に基づく。

## orchestrator が failed-command（検証失敗）から自動復帰しない

**観測（P2 実装中, 2026-06-05）:** coder run の検証コマンド（typecheck / vitest）が
失敗すると run は `failed-command` になる。だが `hitch orchestrate` はこの run を
**review しようとして**「only needs_review can be auto-reviewed」で **escalate** する。
bugfix ループ（rerun）は `review process` の `changes_requested` 経路のみが入口で
（`harness rerun --from-review` は changes_requested 必須）、**コマンド失敗からの
rerun 経路が無い**。

**なぜ重要:** P2 では codex が既存 auto-merge テストを回帰させ failed-command に
なった（harness が正しく弾いた）。だが orchestrator が自動で coder を rerun せず
escalate し、operator が手で hitch を作り直す必要があった。回帰の多い大きめタスクで
この手間が効いてくる。

**対策案（sketch・未実装）:**
- `failed-command` を dispatch で「coder rerun」アクションへマップする（review でなく）。
  失敗コマンドの stderr/stdout を rerun prompt に `required_changes` 同様に注入。
- `harness rerun` に `--from-failed-command <run-id>` 経路を足す（changes_requested
  限定を緩める）。`max-reruns` 予算内で bound。
- fail-closed: rerun 予算超過は従来どおり escalate。

**Status:** idea only — 未実装。P2 実装中の実観測に基づく。

## verify-guarded — committed 履歴の帰属（#69 の続き）

`harness verify-guarded`（#69）は **未コミット working-tree 変更**の guarded scope 違反を fail-closed
で検知する（[`docs/specs/policy.md`](./specs/policy.md)）。**committed 済み**の変更について「どの過去
コミットがレビュー済み harness run 由来か」を健全に判定する部分は未実装（defer）。

- 健全な帰属には **reviewed-head-sha の記録**（pr-creator が捕捉する reviewedHeadSha を queryable に
  永続化）と、base..HEAD の各コミットの **到達可能性**判定が要る。commit author/message での推測は
  spoofable で fail-closed にならないため採用しない。
- これは additive な schema 変更（reviewed-head-sha の保存）を伴うため、スコープと schema 影響を確定
  してから別 Phase で実装する。
- hook 自動設置 / CI 必須化（呼び出し側の強制）も本コマンドの範囲外（呼び出し側の運用選択）。

## 直接制御型 harness からの取り込み（pre-execution 介入の追加層）

**背景:** 本ハーネスの安全モデルは **bounded review gate**（codex を直接操らず、
事後 `git diff` を policy 検証して reject、最終 decision は reviewer）。一方
「harness＝手綱で直接操る」側の設計（ツールコール仲介 / パッチブローカー / 実行環境
強制 / セッション操舵）には、**安全境界を緩めずに**取り込める防御の追加層・無駄打ち
削減のアイデアがある。**いずれも `git diff` ベースの事後検証を最終判定として残した
まま**の上乗せとして設計する（検証を緩める / バイパスする変更は安全境界違反で不可、
`GOAL_RULES.md` §G）。費用対効果の高い順に記す。

### 1. coder prompt への compile 済み policy スコープ注入（rerun コスト削減）

compile 済み policy の write / deny_write リスト（と deny の理由）を coder prompt に
明示注入し、agent が自発的に違反を避けるようにする。

- **これは安全機構ではない。** LLM の遵守を信用しない原則どおり検証は従来のまま。
  効果は **reject 率の低下＝rerun コスト削減**のみ。fail-open には一切寄与しない。
- prompt template は名前付き・version 付き（`coder-domain-task`）なので、その改版
  として乗る（`src/codex/prompt-builder.ts`）。knowledge context の `<knowledge>`
  ブロックと同じ注入機構。
- **要確認:** 既に scope を注入しているなら、deny_write の「理由」付与の余地が
  あるかの差分確認から。実装最小で即効くため最優先候補。

### 2. 実行中の早期中断ウォッチドッグ（budget 浪費の最適化）

codex 実行中に harness 側で `git status --porcelain` / `git diff --name-only` を定期
ポーリングし、**deny_write path への接触や diff サイズ超過を検知したら run を即 kill**。

- **判定の正本はあくまで事後検証のまま。** これは「どうせ reject される run に budget
  を使い切らせない」**最適化**であって安全機構ではない、と位置づける（早期 kill の
  見落としがあっても事後検証が必ず捕まえる＝fail-safe）。
- codex 側への介入面は不要（worktree を外から観るだけ）なので、`codex exec
  --ephemeral` の単発・ステートレス設計と衝突しない。
- 状態機械には `failed-codex-timeout` 系と同列の `failed-*` status を 1 つ足すだけで
  収まる（例 `failed-watchdog-deny`）。`limits` に poll 間隔 / diff サイズ上限を追加。

### 3. path 制御の confirm 階層（`confirm_write`）

現状 path は allow / deny の二値。第三階層 `confirm_write` を設け、「触っても run は
fail しないが、**reviewer が該当 diff を明示承認しない限り approve に遷移できない**」
とする（MCP の `confirmation_required` の per-action 承認を policy path 制御へ輸入）。

- migration ファイルや CI 設定など「禁止ではないが必ず人が見るべき path」に合う。
- 判定は決定論的（path マッチ＋reviewer の明示操作）なので原則と整合。fail-closed
  方向（承認が要る＝厳しくなる）にしか効かないので §0 非対称にも従う。
- `ResolvedPolicy` に `confirmWrite: string[]` を追加し、review gate の approve 遷移
  条件に「confirm_write に該当する diff があれば明示承認フラグ必須」を足す。
  sensitivity map（§5 の auto-merge tier）と概念が近く、設計時に整合を取る。

### 4. パッチブローカーモード（opt-in run mode・予防型への格上げ）

高感度 domain 限定で、coder を `read-only` sandbox で走らせ **unified diff を提案
として出力させ、harness が policy 検証してから自分で apply** する（直接制御型の
「パッチブローカー」をそのまま opt-in 取り込み）。

- 違反 diff は worktree に**触れる前に** reject できる（**検出→予防への格上げ**）。
  apply 後にも従来の事後 diff 検証をそのまま走らせれば**二重検証**になり、既存の
  安全モデルを一切緩めない。
- 「LLM の出力を信用しない」「状態遷移は harness のみ」と完全整合（agent は終始
  ファイルに触れない＝review decision に到達できない構造境界がさらに固くなる）。
- `policy.codex.mode: propose-patch` のような policy 宣言で domain ごとに選択。
- **コストは apply 実装**（コンフリクト / バイナリ / 新規ファイル / 行末・エンコーディング
  の扱い）で小さくない。だから全面移行ではなく **opt-in、かつ感度の高い domain が実際
  に出てきてから**が現実的。価値は最大だが着手は最後。

### 取り込まないもの（設計判断と衝突）

- **セッション操舵型**（実行中に system message を注入して軌道修正）は
  `codex exec --ephemeral` の単発・ステートレス設計（再現性・監査性のための明示的
  判断）と真っ向衝突。取り込むなら設計判断ごと反転する別件＝[[Codex session
  continuation (conversation resume)]] の範疇。本エントリには含めない。
- **OS マウントレベルの deny_write 物理 read-only 化** は `workspace-write` sandbox
  内で agent が chmod を戻せるため見かけほど効かず、本気でやるならコンテナ化という
  別の大工事。費用対効果が低く保留。

**優先順位:** 1（prompt 注入）→ 2（ウォッチドッグ）→ 3（confirm 階層）→
4（パッチブローカー）。1 は実装最小で rerun コスト削減が即効き、4 は価値最大だが
apply 実装が重い。いずれもスコープ外の新規 feature ＝着手時は brainstorming → spec →
plan を通す。

**関連:** [[Codex session continuation (conversation resume)]]（セッション操舵の本体）、
auto-merge sensitivity map（§5、confirm 階層と概念が近い）、安全境界（`GOAL_RULES.md`
§G・`specs/overview.md`「安全モデル」）。

**Status:** idea only — 未実装 / 未設計。2026-06-11 の「直接制御型 harness からの
取り込み」ディスカッションに基づく。安全境界（事後 `git diff` 検証が最終判定）を
不変条件とする上乗せ層として記録。

## hitch reopen の監査永続化（#76 review P2）

`harness hitch reopen`（#76）は `--reason` を stdout にエコーするだけで、close/cancel が
`updateStatus` 経由で reason をカラムに残すのと違い **永続化していない**（DB から「なぜ・いつ
reopen したか」を追えない）。lifecycle 変化自体は status で見えるが、dangerous 操作の監査としては
弱い。`hitch_decisions`（`listDecisions` が読む層）に reopen 行を 1 件記録するか、reason を
退避してから NULL クリアするのを follow-up とする。MCP 露出時の confirmation 要否も併せて判断。

## orchestrator が project profile の compiled policy を coder に thread しない（#83 review P2）

`createOrchestratorRunners` の coder runner（`src/hitch/orchestrator-runners.ts`）は
`runDomainCoding` に `compiledPolicy` / `project` を渡さず、`workflow-runner` 側の
フォールバック（`policies/<repoId>.yaml` を読む）に委ねている。project profile から
コンパイルした scope（テンプレ default / placeholder 込み）と raw repo policy が乖離
しうる点が、commit `3a1d824`「verify-guarded uses the compiled policy scope」と同種の
懸念。`OrchestratorRunnerDeps` に compiled policy を通す口が無く、**出荷済みの CLI
`hitch orchestrate` / `classify --then-rerun` も同一挙動**であり、`harness.hitch.orchestrate`
（#83）が新規導入した回帰ではない。事後 `git diff` ベースの policy 検証自体は機能する
（最終判定は変わらず git diff）が、project-scoped hitch では guardrail のスコープが
raw repo policy になる。follow-up: `OrchestratorRunnerDeps` に `compiledPolicy` を追加し
coder / closeAndPr に thread する（CLI と MCP 共通の独立改善）。S7 のブロッカーにはしない。

## review budget だけ残して rerun が budget 境界で停止すると未レビュー run が残る（#104 review P2）

#104 の reviewPending 分岐は `hitchBudgetLimitReason`（iteration/rerun budget）の**後**に
置かれている（`src/hitch/convergence.ts`、`docs/specs/hitch-convergence.md` step 6）。これは
「genuinely over-budget な hitch は止まる」という意図的な fail-closed 選択だが、rerun が
budget 境界ちょうどで終わると、その fix が未レビューのまま `budget_exhausted` で停止する
境界ケースが残る（#104 が消そうとした症状の残滓）。運用上は **#76 `hitch reopen`（review
budget 延長）** が救済になる。follow-up: rerun budget は尽きたが **review budget が残っている**
ケースに限り、停止前に pending coder run のレビューを 1 回だけ許す（review は新規 coding を
増やさないので発散しない）改善を検討。fail-closed 方向のため S の close ブロッカーにはしない。

## policy compile / verify-pr の CLI action 層テスト（#78/#82 review P2）

`harness policy compile`（#78）と `harness workspace verify-pr`（#82）の **CLI action 層**
（`policy compile` の `loadProjectById`→既定 repoPolicyPath 解決・`--out` 分岐・warnings surface／
`verify-pr` の `git fetch`→detached worktree 配線）は現状ユニットテスト無し。load-bearing な決定論
コア（`writeCompiledPolicyFiles` / `createDetachedWorktree`・両 #68 preflight 配線）は covered で、
action 層は既存 `policy snapshot`/`export` 同様に手動動作確認に委ねている（network fetch / project
profile + templatesDir のフル setup が必要で hermetic test が重い）。follow-up: `loadProjectById` を
fake した薄い action-level test で配線退行を防ぐ。本 Phase のブロッカーにはしない。

## onboard ウィザードの DX 改善（#92 大レビュー P2/P3・非ブロッカー）

`harness onboard`（#92）の大 Phase レビューで非ブロッカーとして残った改善（いずれも fail-closed 方向 or nit）:
- **P2-2**: run/probe の例外がステップ文脈なしに漏れる（既存 policy ファイル clash の `ProjectError`・不正 mcp.yaml の zod throw 等）。exit 1 で fail-closed だが、failing step + remediation を付けて握ると親切。
- **P2-3**: blocked 時に原因/remediation を表示していない（repo 不在で「✗ Preflight: blocked」のみ）。
- **P2-5**: `dbStep` の probe が profile の `source_sha256` 照合でなく projects row 存在のみ。profile を編集後 resume すると stale 登録のまま skip しうる。
- **P3**: serve smoke が `clients[0]` + `hitch.start` 固定（opt-in client が先頭でない/`run.start` のみだと smoke の意味が薄い）／preflight が gh の「未インストール」と「未認証」を混同／`readlinePrompts.select` は不正入力で黙って先頭 fallback（かつ未使用）／merge rewrite で YAML コメント・`version`/`mcp` 以外の top-level キーが消える（schema が strip するので実害小）。
follow-up: onboard の対話 UX を磨く際にまとめて対応。本 feature のブロッカーではない。

## `harness goal` erroring stub の削除（SP-0 rename follow-up）

goal→hitch リネーム（SP-0）で `harness goal` は「→ `harness hitch` を使え」と案内して exit 1
する **erroring stub**（`src/cli/run.ts`）に置き換えた。これは muscle-memory / 自動化の
discoverability のための**1 リリース限りの暫定措置**。次のリリースサイクルでこの stub を
削除する（その時点で `harness goal` は commander の unknown-command エラーになる）。MCP 側は
最初から stub を置かない（`harness.goal.*` は unknown-tool で落ちる・非対称は意図的）。

## dangerous MCP tools の allowedOperations 横展開（audit #117 follow-up）

audit #117 では dangerous / `requireConfirmation` 操作を `guarded-mutation` client mode に限定し、
`read-only` / `dry-run` client が confirmation を起票・confirm replay できないよう fail-closed にした。
一方で、dangerous tools へ `allowedOperations` allowlist も課す横展開は今回スコープ外にした。
既存 `.harness/mcp.yaml` は dangerous confirmation を `allowedOperations` なしで使っている可能性があり、
一度に要求すると breaking migration が大きい。follow-up: dangerous operation にも
`allowedOperations` を要求するか、別 allowlist（例: `allowedDangerousOperations`）を導入するかを設計し、
移行手順と compatibility warning を伴う独立変更として扱う。

## private MCP mutation wrapper の統合（audit #124 follow-up）

audit #124 では `operation-wrapper.ts` の公開 `runMcpOperation` /
`runMcpMutationOperation` 重複を統合し、`mutation-tools.ts` の private
`runMcpOperation` には audit input redaction のみ適用した。private wrapper は
`hitchGate` / `queued` / `pendingExternalExecutor` など公開 wrapper と追加機能差があるため、
全体統合は独立設計で扱う。

## redaction high-entropy detection（audit #134 follow-up）

MCP redaction は現状、secret keyword / 代入形 regex / `scanForSecrets` の既知パターンで
表示・監査面を redact する。任意の高 entropy 文字列検出は false positive が多く、ID・hash・
fixture・短い opaque token まで潰して運用性を落とす可能性があるため #134 Batch B では実装しない。
follow-up で扱う場合は、対象フィールド・最小長・allowlist・テスト fixture への影響を設計し、
confirmation replay に必要な at-rest 原本保存とは独立した「表示時 redaction」だけに適用する。

## #125 large-file staged split deferral

#125（800 行超 15 ファイルの段階分割）は保守性 hygiene としての価値に比べて churn が大きいため、
ユーザー判断で defer する。再開する場合は `run.ts` の Phase A から始め、1〜2 コマンド群/PR の
極小 PR に分け、挙動変更ゼロを `--help` snapshot と既存 CLI テストで担保しながら進める。

## token usage の HTML dashboard 描画（#85 follow-up）

token-usage 拡張（#85）で `run_usage` を per-invocation 化し、`DbTokenUsageSummary` は
total / `usage_source` 別件数 / `byKind`（coder/reviewer/evaluator）を持つ。これは
**dashboard snapshot・read API・CLI `harness metrics`・MCP には露出済み**だが、**HTML
dashboard（`src/dashboard/render.ts`）は usage section 自体を描画していない**（per-invocation
化以前からの既存ギャップで、#85 の完了の定義 — hitch status / course status / harness metrics —
には含まれない）。follow-up として `render.ts` に usage section（total + `bySource` +
`byKind`）を追加する。データは snapshot に既にあるため描画と render テストのみ。
コスト推定（USD、model→単価テーブル）も #85 の別 follow-up として未実装。

## staged-only path の review surface 反映（#141 follow-up P2）

#141 の codex レビューで非 fail-open と確認済み。staged-only path は change budget には
算入されるが、最終 review surface（`reviewed.paths` / review artifacts）には tracked
working-tree path しか載らない。このため budget surface と pre-review surface が一致せず、
staged-only 変更が budget 内なら `needs_review` に行ける一方、reviewer の通常 surface からは
見えない。PR 作成側の staged-diff-subset gate で実害は止まるため release blocker にはしない。
follow-up: review surface に staged/index 側の path も含め、budget と reviewer 入力の path
集合を揃える。

## allowed untracked binary line count の厳密化（#141 follow-up P3）

#141 の codex レビューで非 fail-open と確認済み。allowed untracked binary の line count は
8KiB sample heuristic と whole-file read に依存しており、末尾だけ binary な巨大ファイルを text
として数え得る。通常の binary は 0 行扱いで、現状は budget の近似精度の問題に留まる。
follow-up: untracked file の binary 判定をより厳密にし、巨大 file でも sample 偏りで text
扱いになりにくい実装へ寄せる。

## escalation 事後レビュー・ループ（合議制 案G — design/applications.md）

escalate / 誤分類のイベント（runtime ログは `hitch_findings` / `hitch_convergence_decisions`
等の hitch テーブル。`docs/reports/` は手動 index であって runtime ログではない）を定期的に
合議でレビューし、分類 heuristic・評価軸・プロンプトを更新する運用ループ。小粒・低リスクだが、
案 A/B の運用知見が溜まってから issue 化する。設計は
[`design/applications.md`](./design/applications.md#案g)、前提は
[`design/deliberation.md`](./design/deliberation.md)。

## Multi-lens review — lens persona ライブラリ / 推奨 lens セットのプリセット化（#229 案B follow-up）

#229（[案B] multi-lens review consensus、設計は [`design/proposals/design-229-multi-lens-consensus.md`](./design/proposals/design-229-multi-lens-consensus.md) 付録I）の Phase 1b では lens を reviewer `metadata_json.lens` の enum（correctness/security/regression/efficacy/spec_compliance + 任意 axis）+ 自由文 `lens_prompt` で宣言する最小機構までを in-scope とする。以下は **#229 外 follow-up**:

- lens persona ライブラリ / 推奨 lens セット（correctness/security/regression/efficacy/spec_compliance）のプリセット化と CLI 配布。
- lens を ReviewerRow 第一級カラムへ昇格 + migration（#229 は metadata_json 上の zod 検証に留め新 table/migration 不要）。
- lens 多様性の定量評価・外部正解較正（lens が実際に盲点を割っているかの測定）。
- lens を集約に反映する案（票多様性ボーナス / lens 重複減点）は `evaluateConsensus` 凍結契約の書き換えにあたり**恒久的に採用しない**（安全境界違反）。記録のみ。
- lens 品質を LLM judge で検査する案も LLM 出力を gate にするため**恒久的に採用しない**。
- dashboard / MCP への lens カバレッジ・N-proposal・lens provenance 露出（dashboard.md / mcp.md は単一 reviewer 形状前提）。
- run 生成時の事前 lens 充足検証（`harness project check` 拡張。#229 は orchestrator preflight に委譲）。

## Multi-lens review — 異モデル調達による真の多様性 / reviewer runner DI 改修（#229 案B follow-up）

#229 Phase 1b は **同一 runner + lens prompt 変化**まで（同一基盤モデルの lens 別 prompt）。同一基盤モデルの複数インスタンスは Condorcet 的独立投票者にならず疑似多様性に留まる（[`design/deliberation.md`](./design/deliberation.md) §4 / #163）。真の独立性には異モデル調達が要るが、現状 `ReviewerType` に model field が無く `reviewerRunner` は単一 DI のため別 Phase:

- `ReviewerType` / reviewer registry への model field 追加、reviewer ごとの runner 選択（DI 改修）。
- 異モデル procurement のコスト計上単位（run_usage per-invocation は既存、N×model の wire は follow-up）。
- 異モデル failure-domain 独立性の評価（C4 部分失敗の本格対応 = 研究 §8.3 失敗時回復性）。
- 異モデル procurement 連動の独立性メトリクス（C2/PM-1 の declaredLensCardinality を超える実体測定）。

## Refute verify（#229 Phase 2）— DSL 実装 / target binding / 儀式化対策 gate

#229 の反証 verify は付録H H2 のとおり別 issue 切り出し推奨（Phase 2-0 の target binding data model が前提）。設計は #229 内で inline 確定（付録I.1.2/I.1.3）するが、実コードは Phase 2 follow-up:

- refute output DSL の実装本体（refute 専用 schema、`{target_change_hash, refute_verdict, refute_reason, counter_evidence_ref, refute_condition, retract_condition}`、`refute_verdict ∈ {uphold, refute, inconclusive}`＝design-db §3.1 CHECK と統一）。target id は content-hash（`sha256(normalizeChangeText(change_text))`、FK なし、idx は advisory）に pin。
- `normalizeChangeText` 純関数実装（NFC + CRLF→LF + 行内空白畳み + 全体 trim、case 折り/句読点除去なし）+ 単体テスト。
- binding 決定論検証（未知 target / hash 不一致 = fail-closed reject、harness 再計算のみが権威）。
- counter_evidence_ref が指す diff/test の実在検証を既存 automatic verification kind（command/finding_policy/artifact_exists）へ配線。
- refute layer の participant 除外ロジック（必須フィールド欠落 / artifact 不在 / kind=none を集約前に無効化、無効票は `review_refute_votes` に validation_status/reject_reason 付きで記録し `review_proposals` には入れない＝通常 consensus 汚染を防ぐ）。
- refute reviewer agent variant（別 prompt, distinct registered reviewer_id）。lens 注入機構（reviewer-agent.ts の reviewerPrompt 拡張）を再利用。
- reject された refute 票の入力監査記録の形式。
- **M15（全 proposal を証拠の有無で減点/参加除外）は恒久的に #229 外**: `evaluateConsensus` のラベル集合濃度 quorum + 固定 tie-break（凍結集約契約）の書き換えにあたり安全境界違反。証拠規律は refute DSL に限定して畳む（採用しない理由としてここに記録）。

## Multi-reviewer consensus — 部分失敗回復 / parallel dispatch / escalate 要約の露出（#229 案B follow-up）

#229 Phase 1a/1b の運用品質まわりの follow-up（in-scope は逐次 dispatch + fail-closed + 決定論要約の payload 添付まで）:

- 失敗 reviewer の bounded retry（C4。budget/timeout 設計が前提）。#229 は失敗→non-participant→fail-closed pending まで。
- parallel N-reviewer dispatch（budget/timeout 設計が前提）。#229 は逐次。parallel 化時の部分失敗集約も別 Phase。
- N-dispatch helper を orchestrator と reviewed-run で共有（#229 は reviewed-run を consensus 非対応で明示拒否）。
- consensus escalate 要約（C3: decisiveVotes / requirementStatus / unresolvedBlocking / dissentingProposals / stallCycles）の dashboard・MCP 露出と cycle 跨ぎ差分ビュー。#229 は escalate payload（decision record metrics + recommendedNextAction.message）への決定論 projection 添付まで。
- `review_consensus_summary` / `review_process_metrics` materialized table 化（可視化要件が固まってから。#229 は summary_json への同梱で migration 不要）。
- 合議プロセス品質メトリクス（C2/PM-1）の厳格 gate 化（未宣言 requirement への escalate 拡大。#229 は宣言 requirement のみ warning）。
