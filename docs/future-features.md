# Future features

Ideas recorded for later implementation. Each entry is a sketch, not an approved
design — run it through brainstorming → spec → plan when picked up.

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

## Reviewer prompt provenance audit (prompt_sha256 + injected knowledge)

The reviewer prompt is now DB-dependent (operational-knowledge injection, issue #57
roadmap F; codebase-knowledge injection already feeds the coder prompt). Neither path
records WHAT was injected: `review_proposals.prompt_sha256` exists in the schema but is
not populated, and the injected operational `entryId`/`version` list is not recorded.
After an entry is edited/deprecated a past verdict can no longer be reproduced exactly.

**Sketch:** compute the assembled reviewer prompt once, record `prompt_sha256` on the
proposal (extend `ReviewProposalInput` + the insert), and capture the injected
operational entry ids/versions (e.g. as proposal metadata or an audit artifact). This is
a cross-cutting provenance improvement (should also cover the coder's codebase-knowledge
injection), and it touches the safety-sensitive `insertProposal` hot-path, so it is
designed/reviewed separately rather than folded into F. Flagged by the F codex review
(P2), 2026-06.

## Transactional run-status guard on `review auto` proposal insert

**Promoted to an active follow-up** — now tracked as **Follow-up A** in
[`GOAL.md`](../GOAL.md) (TOCTOU on the shared `insertProposal` path: re-read
`status` / `source_mode` inside `tx.immediate()` and throw
`ReviewerAgentGateError` when not `db-first && needs_review`). See GOAL.md for
the scoped sub-phase and close conditions. Flagged by the Phase 2 round-5 review;
recorded 2026-06.

## Multi-reviewer consensus orchestration (drive the stall trigger)

**What:** Let `harness goal orchestrate` drive **multiple reviewers** per review
cycle so consensus-mode goals can actually reach quorum (and accumulate the
pending timeline that the Phase 2 stall detector escalates on).

**Why it is NOT in scope (Phase 2 boundary):** Phase 2 implemented the consensus
extension — quorum / staleness, the deterministic `detectConsensusStall`
detector, and the goal integration (`evaluateConsensusStallForGoal`), all
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
  `evaluateConsensusStallForGoal` (rather than escalating immediately), so the
  stall detector decides escalate-vs-keep-waiting across cycles.
- Reconcile with the single-writer review model and the goal budget.

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
- 自律ループ: `harness goal orchestrate --request-copilot-review`（既定 OFF）。
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

## 非同期な外部チェック（codex GitHub App review / Copilot review / CI）の bounded await + 取り込み

**問題 / 観測:** `harness goal orchestrate --auto-merge` の `closeAndPr` は、PR を
作成した**直後に merge gate を 1 回だけ評価**し（CI は `createGhCiStatus` の単発
スナップショット＝完了を待たない）、その後 goal を `closed` にする。`closed` は
`orchestrator-dispatch.ts` で `stop` にマップされ、`runAutoMerge` も単発評価のため、
**PR 作成後に遅れて到着する signal は gate に一切反映されない**。実 repo では CI が
数分かかるので通常 `ci_not_green`（transient）→ PR を残して goal close、になる。

2026-06-05 の B（PR #15）実験で具体化: PR には codex GitHub App が**絵文字 reaction
で ack**したが、Copilot review と CI が先に終わって harness が gate 評価・goal を
閉じたため、**codex App の本レビューを待たず / 取り込まずに**進んだ可能性が高い
（`goal_attempts: implement=1`、rerun ゼロ、required_changes ゼロで一発マージ）。

**なぜ重要（規模依存）:** 小規模変更では「即評価 → 残ったら operator が手 merge」で
無害。だが**サブフェーズが多い大規模 PR** では、(a) 外部レビュー（特に codex GitHub
App / Copilot）が実バグを拾う価値が高く、(b) それを取りこぼすと修正ループへ戻す
経路が無い、の二重の問題になる。harness 内部の codex review はローカル `codex exec`
で **diff のみ**を見るので、GitHub 上の PR コンテキストで動く外部レビューとは観点が
異なり、補完価値がある。

**対策案（sketch、実装はしない / 複数の方向）:**

1. **resumable な "awaiting-checks" goal 状態 — CI 部分は実装済み（slice 1）。**
   transient が **`ci_not_green` のみ**のとき goal を `closed` でなく **`close_ready`**
   に残し（新 status / migration を避け close_ready を「PR up・CI 待ち」に二重利用）、
   後続の `goal orchestrate` が closeAndPr に再入して CI 緑なら merge する
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
     「scheduler 駆動 `goal await-merge` の前提」とされたが、**C#7 の `goal await-merge` を新
     status 無し（`close_ready` の resumable パス）で実装した**ため前提が消滅。「PR オープン・
     CI 待ち」は既に `close_ready` ＋ PR-open で表現でき、status を足すと**情報が重複**し、
     convergence（finding/close-check から decision を算出）と orchestration（PR/merge）の
     関心が混ざる。一方コストは**最高**（下記の FK 親 recreate migration ＋ runner への新
     インフラ）。可視化が要るなら base column ではなく**派生ビュー**（`close_ready` ∧ PR-open →
     `effective_status='awaiting_checks'`）で十分。よって実装せず本メモを設計記録として残す。
     以下は将来どうしても入れる場合の最小設計。
     `goal_sessions.status` は `CHECK (status IN (...))`（`schema.ts:1253`）。新値の追加は
     SQLite では **テーブル recreate** が必須だが、現状これは**現 migration runner と非互換**:
     runner は全 DDL を**トランザクション内**で実行し（`migrations.ts:197`）、接続は
     **`foreign_keys = ON`**（`connection.ts:44`）、かつ `goal_sessions` には**子 5 本**
     （`goal_attempts` / `goal_findings` / `goal_review_cycles` / `goal_close_checks` /
     `goal_convergence_decisions`）が **`ON DELETE CASCADE` FK** で依存する。この状態で
     CHECK 変更に要る `DROP TABLE goal_sessions` を実行すると、暗黙 DELETE が子の **CASCADE
     を誘発し全削除**される（`PRAGMA defer_foreign_keys` は検査を遅らせるだけで cascade
     アクションは止められない）。FK-safe な recreate には `PRAGMA foreign_keys=OFF`（**tx 外
     でしか切替不可**）が要る。artifacts v4 recreate（`schema.ts:475`）は子 FK 無しの前例で、
     ここには使えない。**実装方針**: migration runner に「FK 親を recreate する migration」を
     表現する hook を足す（apply 前後で `foreign_keys` を OFF/ON、tx 外で実行、末尾に
     `PRAGMA foreign_key_check` で整合を assert して fail-closed）。`writable_schema` で
     sqlite_master の CHECK 文字列を直接書き換える手は cascade を避けられるが SQLite が
     非推奨で corruption リスク・review で落ちるため**不採用**。consumer（v17）と同時に出す。
     配線側は: `GOAL_STATUSES`/`SCHEMA_VERSION` 追加、`orchestrator-runners.ts:581-590` の
     recheckable 時 status を `close_ready`→`awaiting_checks`、`convergence-status.ts` の
     close_ready reversion（`:110`）を `awaiting_checks` にも適用、close_ready 決定時に現在
     `awaiting_checks` なら据え置く分岐。dispatch は decision 駆動なので不要。**migration の
     data-survival テスト（既存 goal が子ごと生存）を必須**にする。
   - **ingest 後の fix ループへの finding 注入 — 実装済み（slice 4）。** 以前は goal mode の
     coder rerun が `runDomainCoding({ goal: context.goal })` のみで、open in-scope finding を
     coder prompt に注入していなかった（① 以前からの潜在ギャップ）。`augmentGoalWithOpenFindings`
     を追加し、`rerun` 系 attempt で open in-scope（lifecycle `open`/`reopened`/`escalated`）を
     集約してゴール文言末尾に「Open in-scope findings to address」ブロックとして注入する
     （run 単体 `core/rerun.ts` の required_changes 注入の goal-mode 版）。初回 `implement` は
     非注入、`unknown`-scope は分類前なので非注入（fail-closed）、件数上限 25（超過は明示注記）。
     pure helper を単体テスト＋coder runner の prompt 捕捉で統合テスト。これで operator が
     finding を in_scope 分類した後の rerun が「何を直すか」を持つ。`runDomainCoding`/
     prompt-builder は無改変（ゴール文言だけ拡張）で最小リスク。~~**残**: 外部 finding 分類→
     rerun の**自動連鎖**~~ → **実装済み（C#8, PR #50）**: `goal finding classify --then-rerun
     --repo <path>` が in-scope 分類後、convergence が `needs_fix` のときだけ orchestrator を
     bounded で回し coder rerun を連鎖する（gate 経由・operator 分類が trigger・LLM は
     execution-only）。`needs_fix` でなければ自動実行せず `rerun=skipped(<reason>)`。
   - 定期 `goal await-merge`（scheduler 駆動の自動再 orchestrate。`awaiting_checks` status が
     前提＝上記の後）、semantic dedup（§3）。
   - **`goal await-merge` の外部レビュー ingestion の wall-clock を完全束縛する**（codex
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
   取得。`harness pr land` / `goal await-merge` を resumable に。

3. **外部レビュー指摘の finding 化（advisory）。** PR の review コメント（codex App /
   Copilot）を goal finding として ingest → P0〜P3 分類 → 修正ループへ。**ただし安全
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
  （`goal close-check` / close 条件編集）。LLM 自動追加は不可。

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
  後回し（goal-convergence の **non-goal** に "semantic embedding clustering" が明記）。
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
  クリアした薄いスライスだけ auto。`src/policy/**` `src/codex/**` `src/goal/**`
  migrations `.github/**` 等の安全境界路は常に auto 不可。

### 4. 前提（最初のベーシックな一歩）— **実装済み（P1, PR #19）**

auto-merge を実在させる前提だった **CI の bounded await**（PR 作成後に CI 完了を
timeout 付きで poll、timeout は fail-closed で人手に残す）は **実装済み**。
`createGhCiStatus`（`src/core/gh-pr-publisher.ts`）が単発スナップショットから
bounded poll になり、`goal orchestrate --ci-await-timeout`（既定 1200s）で CI 完了を
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
| **Tier-2 絶対 auto 不可** | 安全機構そのもの | `src/policy/**` / `src/codex/**` / `src/core/merge-gate.ts`・`src/goal/orchestrator*.ts`・`src/goal/convergence.ts` / `src/core/reviewer-agent.ts`・`src/db/repositories/review-*.ts` / `src/db/migrations*` / `.github/**` / `policies/**` | meta-risk: 壊れると安全境界・gate・CI 設定・policy 定義が緩む |
| **Tier-1 既定 人手** | 一般コード | 上記以外の `src/**`（cli/mcp/dashboard/knowledge/config/workspace…） | 通常の blast radius |
| **Tier-0 auto 適格** | 低 blast・survivable | `docs/**`、**追加のみの** `tests/**` | 非実行 or テスト純増。取りこぼしても follow-up で吸収可 |

bootstrap: Tier-0 を最小（`docs/**` ＋ テスト純増のみ）から開始、未マップは既定
人手（fail-closed）、事故ゼロ実績で慎重に拡大。map は operator 所有・versioned・
監査可能。**Tier-0 tests の罠**: テスト削除/`.skip`/`xfail` は silent に安全を下げる
ため、決定論検出（テスト純減/skip 追加）で人手へ降格（「追加のみ」が条件）。

### 6. default-defer の外部 P0 取りこぼしを人手 tier で拾う

外部 finding を既定 deferred にする穴（本物の P0 も既定で止まらない）は、
**defer ≠ drop**（defer は PR/goal 上に可視で残り記録される）を前提に tier で拾う:

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
失敗すると run は `failed-command` になる。だが `goal orchestrate` はこの run を
**review しようとして**「only needs_review can be auto-reviewed」で **escalate** する。
bugfix ループ（rerun）は `review process` の `changes_requested` 経路のみが入口で
（`harness rerun --from-review` は changes_requested 必須）、**コマンド失敗からの
rerun 経路が無い**。

**なぜ重要:** P2 では codex が既存 auto-merge テストを回帰させ failed-command に
なった（harness が正しく弾いた）。だが orchestrator が自動で coder を rerun せず
escalate し、operator が手で goal を作り直す必要があった。回帰の多い大きめタスクで
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
