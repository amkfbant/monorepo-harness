# Copilot PR review integration — 設計

これまで `docs/future-features.md` に保留されていた **Copilot PR review 連携** を、
実機で機能することを確認できたため回収する。ただし Copilot review は不安定（過去に
未投稿で長時間 cancelled）だったため、**非基幹・best-effort・retry-then-skip** に
徹し、harness の状態遷移を一切 gate しない。

- base ref: `goal-phase3-close` 以降の main（GOAL.md 完了後の follow-up feature）
- 安全境界（既存と同一）: 外部（Copilot / GitHub）の出力を **状態遷移の根拠にしない**。
  Copilot review の結果は観測情報（audit + ログ）に留め、close / merge を gate しない。
  best-effort 処理は決して harness のワークフローを失敗させない（fail-open ではなく
  「非 gating」: review は任意の付加価値であり、無くても安全）。

---

## コンポーネント

### 1. `CopilotReviewer`（`src/core/copilot-reviewer.ts`）

DI 抽象（`PrPublisher` / `PrMerger` と同じ慣習）。

```ts
export type CopilotReviewPollResult = "reviewed" | "pending";

export interface CopilotReviewer {
  /** Copilot reviewer を PR に要求する。一時エラーは throw してよい（呼び出し側が retry）。 */
  request(prNumber: number): Promise<void>;
  /** Copilot のレビューが投稿済みかを返す。 */
  poll(prNumber: number): Promise<CopilotReviewPollResult>;
}
```

### 2. `runCopilotReview`（`src/core/copilot-review-run.ts`、純粋オーケストレーション）

```ts
export interface CopilotReviewConfig {
  requestAttempts: number;   // request の一時エラー retry 上限（既定 3）
  pollTimeoutMs: number;     // poll の総タイムアウト（既定 300_000 = 5 分）
  pollIntervalMs: number;    // poll 間隔（既定 15_000）
}
export type CopilotReviewStatus = "reviewed" | "skipped" | "failed";
export interface CopilotReviewOutcome {
  status: CopilotReviewStatus;
  attempts: number;          // 実 request 試行回数
  polls: number;             // 実 poll 回数
  detail: string;            // 人間可読の要約（"reviewed" / "timed out after Ns" / エラー要約）
}

export function runCopilotReview(input: {
  reviewer: CopilotReviewer;
  prNumber: number;
  config?: Partial<CopilotReviewConfig>;
  sleep?: (ms: number) => Promise<void>;  // テスト注入
  now?: () => number;                     // テスト注入（経過判定）
}): Promise<CopilotReviewOutcome>;
```

挙動（**決して throw しない**）:
- `request` を呼ぶ。一時エラーなら `requestAttempts` まで retry（間隔は pollInterval を流用）。
  全 retry 失敗 → `{ status: "failed", detail }`。
- request 成功後、`pollTimeoutMs` を超えるまで `pollIntervalMs` 間隔で `poll`:
  - `reviewed` → `{ status: "reviewed" }`。
  - timeout 到達（最後の poll も pending）→ `{ status: "skipped", detail: "timed out ..." }`。
- `poll` の一時エラーは握って次の interval へ（poll は best-effort）。timeout まで継続。
- `now()` で経過を判定し、最大 `ceil(pollTimeoutMs/pollIntervalMs)` 回程度 poll。
- `pollTimeoutMs` は **総タイムアウトとして実効化**: 各 `poll` 呼び出しを残り時間
  （`deadline - now()`）で打ち切る（`setTimeout` ベースの内部 race、`sleep` 注入とは独立）。
  hang した `poll` でも `pollTimeoutMs` 内に `skipped` へ収束する。
- never-throw は厳密: 非 Error の reject も安全に文字列化し、本体全体を最終防衛の
  try/catch で包む。注入された `sleep` / `now` が throw しても `{ status: "failed" }`
  を返し、関数外へ reject しない。

> `skipped` は「Copilot が時間内にレビューしなかった」= 正常な best-effort 結果。
> `failed` は「要求自体が確立できなかった」（gh エラー継続）。どちらも非 gating。

### 3. `createGhCopilotReviewer`（`src/core/copilot-reviewer-gh.ts`、gh アダプタ）

- `request(prNumber)`: `gh api --method POST repos/{owner}/{repo}/pulls/{n}/requested_reviewers
  -f "reviewers[]=Copilot"`（実機で確認済み）。owner/repo は `repoDir` から gh が解決
  （`gh` は cwd のリポジトリを使う）。timeout は既存 `runGh` 相当（spawn + SIGKILL）。
  非 0 / timeout は throw（runCopilotReview が retry/最終 failed 化）。
- `poll(prNumber)`: `gh pr view {n} --json reviews` を実行し、`reviews[].author.login` に
  `copilot-pull-request-reviewer` があれば `reviewed`、無ければ `pending`。
  （`gh pr view` の reviews は bot author を含む。GraphQL は使わず JSON で十分。）

### 4. operation audit（既存 `operations` 台帳）

`runCopilotReview` の **呼び出し側（CLI / orchestrate）** で記録:
- `startOperation(db, { operationType: "copilot-review", targetType: "pr",
  targetId: String(prNumber), actor, dryRun:false, input:{prNumber,config} })`
- outcome に応じて `succeedOperation`(reviewed) / `markOperationPending`(skipped) /
  `failOperation`(failed, errorCode="copilot_review_failed")。
- audit は best-effort（記録失敗で本処理を壊さない）。

### 5. CLI: `harness pr request-review`

```
harness pr request-review <prNumber> --repo <path>
  [--timeout <seconds>] [--poll-interval <seconds>] [--request-attempts <n>] [--json]
```

- `createGhCopilotReviewer(repo)` + `runCopilotReview` を実行し、audit 記録。
- 出力: `pr=<n> copilot-review=<status> (detail)`。`--json` で構造化。
- exit code（standalone CLI のみの慣習。orchestrate は exit に依らず非 gating）:
  `reviewed` / `skipped`（timeout = 正常な best-effort 結果）→ **0**。
  `failed`（要求すら確立できなかった）→ **非 0**（operator が検知できるよう）。
  引数不正も非 0。orchestrate 経路はこの exit を見ず、いずれの outcome でも close を継続。

### 6. orchestrate opt-in: `goal orchestrate --request-copilot-review`

- 既定 **OFF**。flag ON 時のみ `deps.copilotReview = { reviewer, config? }` を組み立て。
- `closeAndPr` の **PR 作成後**（auto-merge があればその前）に、`deps.copilotReview` が
  あれば `runCopilotReview` を best-effort 実行し audit + ログ。
  - 結果（reviewed/skipped/failed）は `OrchestrationResult` には影響させない。
    **close / auto-merge を一切 gate しない**。例外は握る（万一の throw でも goal を
    壊さない）。
- auto-merge と併用時: Copilot review（最大 timeout）→ auto-merge。review 結果は
  merge gate に入れない（独立・非 gating）。

---

## データフロー

```
PR 作成（createPullRequest）
  └ (opt-in) runCopilotReview:
       request → (retry) → poll loop (timeout) → outcome
       └ operation audit (succeeded/pending/failed)
  └ (既存) auto-merge / close   ← Copilot review の結果に依存しない
```

## エラーハンドリング（中核・非基幹の担保）

- `runCopilotReview` は **throw しない**（必ず outcome を返す）。
- orchestrate 側でも `runCopilotReview` 呼び出しを try/catch で囲み、万一の例外でも
  goal の close/merge を継続（review は付加価値で、無くても安全）。
- 外部出力（Copilot のレビュー有無）を **状態遷移の根拠にしない**（既存安全境界）。

## テスト（TDD・回帰禁止）

- `runCopilotReview`（fake reviewer + 注入 sleep/now）:
  - request 成功 + poll が即 reviewed → reviewed。
  - poll が pending のまま timeout → skipped（poll 回数が bound 内）。
  - request が毎回 throw → requestAttempts 後 failed。
  - poll が一時 throw → 握って継続し最終 reviewed/skipped。
- gh アダプタ（fake gh スクリプト）: request が `requested_reviewers` を叩く、poll が
  `copilot-pull-request-reviewer` を検出/未検出で reviewed/pending。
- CLI: reviewed/skipped が exit 0、status を出力、audit 行が記録される。
- orchestrate opt-in: fake reviewer が reviewed/skipped でも closeAndPr が close まで進む。
  既定 OFF（flag 無し）では reviewer を要求しない（fake が呼ばれない）。
- フルスイート + typecheck 緑。

## close 条件

- [ ] フルスイート + typecheck 緑、回帰なし
- [ ] 未解決 P0 ゼロ（codex 大レビュー）
- [ ] best-effort（throw しない）/ 非 gating（close/merge を gate しない）/ 既定 OFF の
      テスト
- [ ] `docs/future-features.md` の Copilot 項目を「実装済み（best-effort opt-in）」へ更新、
      `docs/specs/cli.md`（pr request-review / orchestrate flag）/ `workflow.md` を更新
