# Phase 3-1 — Review-driven Retry Loop 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase3/phase3-1-review-driven-retry-loop.md`（Phase 3-1 設計）
**Harness range:** Phase 3-1 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase3`

## 背景

Phase 2-7 で `harness rerun --from-review` が単体で使えるようになった。Phase 3-1 はこれを bounded workflow として束ねる:

`harness workflow reviewed-run` = `run → review auto → review process → (changes_requested なら rerun)*`

新しい状態遷移は導入せず、既存の `runDomainCoding` / `runReviewerAgent` / `processReviewDecision` / `prepareRerunFromReview` を順に呼ぶオーケストレータ。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/reviewed-run-workflow.ts`（新規） | `runReviewedRunWorkflow` orchestrator。`workflow.json` / `workflow-summary.md` を root run dir に出力 |
| `src/core/workflow-runner.ts` | `RunFinalizedError`（finalize 済み runId を載せた typed error） |
| `src/core/reviewer-agent.ts` | post-codex の全 gate error が `review-auto-error.json` を残すよう再構成 |
| `src/cli/run.ts` | `harness workflow reviewed-run` subcommand |

**345 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1×1 + P2×2、全件 same-cycle fix:

| ID | severity | 概要 | 修正 |
|----|----------|------|------|
| 1 | P1 | `runDomainCoding` が `failed-internal-error` finalize 後に bare error を rethrow → workflow が exit 2、artifact 書かれず | `RunFinalizedError`（runId 付き）を throw、orchestrator が failed attempt として記録 + artifact 出力 |
| 2 | P2 | `review-auto-error.json` は YAML parse 失敗時のみ生成、timeout / non-zero / tamper では残らない | reviewer-agent の post-codex 領域全体を try/catch で囲み、全 `ReviewerAgentGateError` で artifact 生成 |
| 3 | P2 | orchestrator 自体が `maxAttempts` を未検証（CLI のみ検証） | `runReviewedRunWorkflow` 入口で正の整数チェック |

## fake-codex 統合テスト（決定論カバレッジ）

`tests/integration/reviewed-run-workflow.test.ts`（9 ケース）で E3-1-1〜5 を**決定論的に**担保:

| テスト | 内容 | 結果 |
|--------|------|------|
| E3-1-1 | 初回 approved | finalStatus=approved, attempts=1 ✅ |
| E3-1-2 | changes_requested → rerun → approved | attempts=2、子に parentRunId/rootRunId/rerunAttempt=1 ✅ |
| E3-1-3 | maxAttempts 超過 | finalStatus=not_converged ✅ |
| E3-1-4 | policy violation で停止 | finalStatus=failed-policy-violation、rerun せず ✅ |
| E3-1-5 | reviewer invalid output | finalStatus=review-auto-failed、review-auto-error.json 残存 ✅ |
| + | --stop-on-changes-requested / --no-auto-review / crashing coder / 不正 maxAttempts | ✅ |

reviewer の verdict は非決定的なため、reviewer runner を sequenced fake にして cr→approved を制御。

## 実機デモ（mini-commerce、apps/orders）

`harness workflow reviewed-run` を実機 codex で 2 回実行:

| run | goal | 結果 |
|-----|------|------|
| `mpfcpvu2386dbf20` | couponCode 検証の追加 | attempt 0 → **approved**（finalStatus=approved, attempts=1） |
| `mpfcxfug931cbadc` | validateDiscount を**意図的に未実装**で提出 | attempt 0 → **approved**（attempts=1） |

両方とも attempt 0 で `approved` に収束（**E3-1-1 を実機で 2 回確認**）。`workflow.json` / `workflow-summary.md` が root run dir に正しく出力された。

### 観察: reviewer agent は goal に対してレビューする

2 回目は「validateDiscount を未実装（`// TODO: implement` + `return false`）で提出」という意図的に不完全な goal にしたが、reviewer agent は `approved` を返した。`review-decision.yaml` の non_blocking_comments:

> The placeholder export matches the requested unimplemented shape and stays scoped to apps/orders.
> No tests were added or run, matching the explicit task constraints.

→ reviewer agent は**絶対基準ではなく goal に対する適合**を評価する。goal が「未実装で出せ」と指示していれば、未実装の提出は goal 準拠として approve される。これは reviewer agent の妥当な挙動。

### 実機で changes_requested → rerun を誘発できなかった件

設計の close 条件「mini-commerce 実機で changes_requested → rerun → approved が通る」は、実機 codex では**再現できなかった**。理由:

- reviewer agent は goal に対してレビューする（上記）。競合のない coder 出力は goal を満たすため approve される
- coder（codex）は competent で、goal を 1 回で満たす
- → `changes_requested` を実機で確実に誘発するには prompt の人為的改変が必要で、それでは verdict が人工的になる

これは計画段階で **R5（reviewer agent の非決定性）** として明示し、ユーザー承認済みのリスク。**rerun ループの動作そのものは fake-codex 統合テスト E3-1-2 で決定論的に検証済み**（子 run に parentRunId/rootRunId/rerunAttempt が正しく伝播することを含む）。実機では「reviewer が approve した場合に workflow が正しく rerun しない」E3-1-1 を 2 回確認した。

## 閉じる条件チェック（Phase 3-1 設計 3-1.7）

```txt
[x] reviewed-run workflow CLI がある
[x] maxAttempts が効く                              — E3-1-3 + 入口検証
[x] changes_requested 時だけ rerun する             — E3-1-2/4 統合テスト
[x] failed-* / rejected では rerun しない           — E3-1-4 統合テスト
[x] approved で success 終了する                    — E3-1-1 実機 ×2 + 統合テスト
[x] workflow-summary.md / workflow.json が残る       — 実機で確認
[x] parentRunId / rootRunId / rerunAttempt が維持    — E3-1-2 統合テスト（子 meta 検証）
[~] mini-commerce 実機で cr → rerun → approved       — 実機は非再現（R5）。rerun ループは E3-1-2 統合テストで決定論検証
[x] not_converged 相当の停止ができる                 — E3-1-3 統合テスト
[x] docs/specs/workflow.md に仕様がある              — reviewed-run 節を追加
```

`[~]` 1 項目: 実機での `cr → rerun` 再現は R5 により非決定的。動作は統合テストで担保。

## 新規 finding

- **観察（finding ではなくドキュメント化）**: reviewer agent は goal 相対でレビューする。これは Phase 3-2（reviewer quality evaluation）で評価軸として扱うべき性質。

## 後片付け

- demo run 3 件（`mpfcpvu…` / `mpfcxfug…` ほか）は runs/ に残置（gitignore 対象）
- mini-commerce worktree は cleanup 未実行（workflow は cleanup しない設計）
