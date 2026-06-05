# Future features

Ideas recorded for later implementation. Each entry is a sketch, not an approved
design — run it through brainstorming → spec → plan when picked up.

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

1. **resumable な "awaiting-checks" goal 状態。** transient（CI / 外部レビュー未確定）
   のとき goal を `closed` ではなく非終端の新状態（例 `awaiting_checks`）に置く。
   `orchestrator-dispatch.ts` に再評価経路を足し、再 `orchestrate`（または定期
   `goal await-merge`）が CI + 外部レビュー verdict を **bounded budget で poll** →
   揃えば merge、未達は待機、failure は fix ループへ。これが「later merge」を
   harness 経路にする核（現状は手 merge しか無い）。

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
> fail-safe。**残 follow-up**: 削除でなく `it()` 純減（net-count 減）の検出、
> `src/core/automerge-tiers*.ts` 自体を Tier-2 にするか。

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
