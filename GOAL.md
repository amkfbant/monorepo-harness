# GOAL.md — 残 follow-up ロードマップ（A〜D）

monorepo-harness を **goal モード**で実装させるための作業項目定義。実行ルール
（レビュー・close 条件・テスト粒度・ブランチ運用・安全境界）は
[`GOAL_RULES.md`](./GOAL_RULES.md) を参照。本ファイルは「何を作るか」を、
`GOAL_RULES.md` は「どう作るか」を定める。

> **大 Phase 1〜4 は全て完了・main merge 済み**（`goal-phaseN-close` タグ。
> Phase 1=CI 足回り / Phase 2=consensus 拡張 / Phase 3=auto-merge / Phase 4=
> dashboard mutation UI。設計は `docs/superpowers/specs/2026-06-05-phaseN-*.md`）。
> 本ファイルは**残っている follow-up A〜D のみ**を扱う。

- 各 follow-up = サブ Phase 規模（1〜数コミット、TDD で関連テスト + `npm run
  typecheck` 緑）。codex サブレビュー（最大 3 回、`codex exec -m gpt-5.5 -c
  model_reasoning_effort="xhigh"`）。未解決 P0 ゼロが close の必須条件。
- A〜D は**相互依存なし**。独立に着手・merge してよい。A/B/C はコード、D は doc のみ。
- 着手前に必要なら spec / plan を用意する（spec 駆動）。

---

## Follow-up A: `review auto` proposal insert の TOCTOU 解消

**目的**: `reviewer-agent.ts` の status pre-check（`runs.status = 'needs_review'`
∧ `source_mode = 'db-first'`）を `ReviewProposalRepository.insertProposal` と
**同一トランザクション**に入れ、並行する `review process` が pre-check と insert の
間に run を promote しても proposal が挿入されないようにする。

- **現状の土台**: pre-check は既存（Phase 9 の P1-4 status guard）。残存 TOCTOU は
  共有 `insertProposal` path に影響（default latest-proposal flow と consensus mode
  の両方）。`docs/future-features.md` の同項目を本 follow-up が引き継ぐ。
- **性質**: 最悪でも「promote 済み run に、すぐ無視される active proposal が残る」
  程度で、corruption も安全境界破りもない。だが共有 review hot-path の insert に
  トランザクショナルな status 再読を足すため、default flow 用テスト込みで慎重に。

### サブ Phase
- **A-1 ガード付き insert（TDD）**
  - `insertProposal`（or guarded wrapper）の `tx.immediate()` 内で run の
    `status` / `source_mode` を再読し、`db-first && needs_review` でなければ
    `ReviewerAgentGateError` を throw。
  - 並行 promote → insert が決定論的に弾かれること、正常 path（needs_review の
    run）は従来どおり通ることを TDD で検証。

### close 条件（A）
- [ ] 関連テスト + `npm run typecheck` 緑、回帰なし（既存 review/consensus テスト含む）
- [ ] 未解決 P0 ゼロ
- [ ] 並行 promote 弾き / 正常通過 の両方に TDD テスト
- [ ] `docs/specs/workflow.md`（review hot-path の insert 仕様）を更新

---

## Follow-up B: `CopilotReviewer.poll` を AbortSignal でキャンセル可能に

**目的**: `runCopilotReview` の watchdog（`Promise.race`）で**負けた側の poll が
中断されず放置**される問題を解消する。`poll` に `AbortSignal` を渡し、watchdog
発火時に in-flight poll を abort してリソースを解放する。

- **現状の土台**: `src/core/copilot-reviewer.ts`（interface `poll(prNumber,
  timeoutMs?)`）/ `copilot-reviewer-gh.ts`（gh 実装）/ `copilot-review-run.ts`
  （`rejectAfter` watchdog）。現状 `poll` に signal 引数は無い（確認済み）。
  Copilot round-5 review で deferred とされ未記録だった項目。
- **不可侵の不変条件**: `runCopilotReview` は **NEVER throw**、Copilot outcome は
  close/merge を**一切 gate しない**、外部出力は観測（audit + log）のみ。これらは
  維持する（[`docs/future-features.md`](./docs/future-features.md) の Copilot 項参照）。

### サブ Phase
- **B-1 poll に AbortSignal を追加（TDD）**
  - `CopilotReviewer.poll` に optional `signal?: AbortSignal` を追加。gh runner は
    子プロセス / フェッチへ伝播。
  - `copilot-review-run.ts` で `AbortController` を生成し、watchdog 発火時に
    `abort()`、`finally` で cancel。負け側 poll が abort されることを fake reviewer
    で検証。`runCopilotReview` の non-throw 不変条件は回帰させない。

### close 条件（B）
- [ ] 関連テスト + `npm run typecheck` 緑、回帰なし
- [ ] 未解決 P0 ゼロ
- [ ] watchdog 発火で poll が abort される TDD テスト（fake reviewer）
- [ ] `runCopilotReview` non-throw / 非 gating の不変条件にテストで回帰なし
- [ ] `docs/specs/cli.md`（`pr request-review`）/ `workflow.md`（Copilot 観測ステップ）
      に signal 挙動を反映

---

## Follow-up C: `harness knowledge deprecate` コマンド

**目的**: 今は frontmatter `deprecated:` の手編集でしか deprecate できない。
`knowledge deprecate <id>` コマンドを足し、決定論的に deprecated へ遷移させる
（`knowledge build-context` の除外と整合）。

- **現状の土台**: `knowledge list / reject / promote` は実装済み。`deprecated`
  frontmatter と除外ロジック（`src/core/knowledge-context.ts` /
  `knowledge-promoter.ts`）も実装済み。**コマンドのみ欠落**
  （`docs/specs/overview.md` の「deprecate コマンドは未実装」）。

### サブ Phase
- **C-1 deprecate subcommand（TDD）**
  - `knowledge promote` / `reject` に倣い CLI subcommand を追加。対象 knowledge を
    `deprecated: true` に遷移（DB-canonical の asset 更新 + file export 整合）。
    状態遷移は harness のみ。
  - deprecate 後に `build-context` から除外されることを TDD で検証。

### close 条件（C）
- [ ] 関連テスト + `npm run typecheck` 緑、回帰なし
- [ ] 未解決 P0 ゼロ
- [ ] deprecate → build-context 除外 の TDD テスト
- [ ] `docs/specs/cli.md`（knowledge 節）更新 + `overview.md` の「deprecate コマンド
      未実装」記述を実装済みに更新

---

## Follow-up D: `overview.md` の stale 修正（pr create / rerun の実 codex smoke）

**目的**: `docs/specs/overview.md`「できないこと」の「`pr create` / `rerun` の実
codex smoke 未検証」は、**2026-06-04 の smoke で検証済み**
（[`docs/reports/2026-06-04-real-codex-smoke.md`](./docs/reports/2026-06-04-real-codex-smoke.md)、
real GitHub に draft PR #2 を作成）。記述を実態に合わせる。

- **性質**: doc のみ。ロジック変更なし。

### サブ Phase
- **D-1 記述の更新**
  - 当該 bullet を削除、または「実 codex smoke 検証済み（2026-06-04）」へ書き換え、
    reports へリンク。

### close 条件（D）
- [ ] `docs/specs/overview.md` を実態（検証済み）に更新
- [ ] reports（`2026-06-04-real-codex-smoke.md`）へのリンク整合

---

## 実行フロー

```
各 follow-up（A / B / C は独立、D は doc のみ）:
  branch を切る（必要なら spec / plan 用意）
    └ TDD 実装 → commit → codex サブレビュー（最大 3 回）
         ├ P0 残 → 修正 / 再レビュー、上限なら停止 + エスカレーション
         └ P0 ゼロ → 残 P1↓ は follow-up、close 条件を満たして merge
```

詳細な判断基準・レビューテンプレート・安全境界は [`GOAL_RULES.md`](./GOAL_RULES.md)。
より大きい保留事項（multi-reviewer consensus orchestration / codex session
continuation 等）は [`docs/future-features.md`](./docs/future-features.md)。
