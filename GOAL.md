# GOAL.md — 実装ロードマップ

monorepo-harness を **goal モード**で実装させるための作業項目定義。実行ルール
（レビュー・close 条件・テスト粒度・ブランチ運用・安全境界）は
[`GOAL_RULES.md`](./GOAL_RULES.md) を参照。本ファイルは「何を作るか」を、
`GOAL_RULES.md` は「どう作るか」を定める。

> **大 Phase 1〜4 は全て完了・main merge 済み**（`goal-phaseN-close` タグ。
> Phase 1=CI 足回り / Phase 2=consensus 拡張 / Phase 3=auto-merge / Phase 4=
> dashboard mutation UI。設計は `docs/superpowers/specs/2026-06-05-phaseN-*.md`）。

---

## 完了した follow-up（A〜D）

follow-up A〜D は**すべて実装・main merge 済み**（close 条件＝テスト + spec 更新も充足）。
履歴・設計根拠は git log / 各 PR を参照。

| follow-up | 内容 | 実体（現状コード） | テスト | spec |
|-----------|------|------|------|------|
| **A** | `review auto` proposal insert の TOCTOU 解消 | `ReviewProposalRepository.insertProposal` が `tx.immediate()` 内で `runs.status`/`source_mode` を再読し非 `db-first && needs_review` なら `ReviewerAgentGateError`（`src/db/repositories/review-proposals.ts`） | `tests/unit/db/review-proposals.test.ts`（guard throw / 正常通過） | `docs/specs/workflow.md` |
| **B** | `CopilotReviewer.poll` を AbortSignal でキャンセル可能に | `poll(prNumber, timeoutMs?, signal?)` を gh runner まで配線、watchdog 発火で in-flight poll を abort（`src/core/copilot-reviewer*.ts` / `copilot-review-run.ts`）。`runCopilotReview` の non-throw / 非 gating 不変条件は維持 | `tests/unit/core/copilot-review-run.test.ts` | `docs/specs/cli.md` / `workflow.md` |
| **C** | `harness knowledge deprecate` コマンド | `knowledge deprecate <id>` が DB-current revision に `deprecated: true` を記録し compat file を export（`src/cli/run.ts`） | `tests/integration/cli-knowledge-promote.test.ts`（deprecate → build-context 除外） | `docs/specs/cli.md` / `overview.md` |
| **D** | `overview.md` の stale 修正（pr create / rerun の実 codex smoke） | doc のみ。`pr create` / `rerun` の実 codex smoke を検証済みに反映 | — | `docs/specs/overview.md`（`2026-06-04-real-codex-smoke.md` リンク） |

---

## 現在の focus — operational knowledge の deferred surfaces（issue #57）

[issue #57](https://github.com/amkfbant/monorepo-harness/issues/57) の **Core + MCP read**
は完了（schema v19 `knowledge_entries.category` / `harness knowledge ops` CLI /
`harness.ops_knowledge.*` MCP read。`docs/specs/{db,cli,mcp}.md`）。残る deferred surfaces
を本ロードマップの現行項目とする（詳細スケッチは [`docs/future-features.md`](./docs/future-features.md)）。

- **E: inbox / session surfacing** — `harness.inbox` / dashboard に operational 知識の
  件数・最近エントリを出す（read 中心）。
- **F: goal / reviewer context 注入** — 関連 operational 知識を reviewer / goal briefing
  prompt に注入（**coder には注入しない** — §G の安全境界は恒久）。関連度 scope モデルが要る。
- **G: MCP write（`ops_knowledge.record` / `deprecate`）** — operating agent が MCP 経由で
  ops 知識を記録。guarded-mutation（allowlist + `runOperation` の idempotency / audit /
  budget）として実装。
- **H: file-export parity** — operational entry の `docs/ops-knowledge/` compat export
  （importer namespace の衝突回避が前提）。

各項目 = サブ Phase 規模（TDD で関連テスト + `npm run typecheck` 緑、codex サブレビュー
最大 3 回、未解決 P0 ゼロが close 必須）。相互依存は薄く独立に着手・merge してよい。

---

## 実行フロー

```
各 follow-up:
  branch を切る（必要なら spec / plan 用意）
    └ TDD 実装 → commit → codex サブレビュー（最大 3 回）
         ├ P0 残 → 修正 / 再レビュー、上限なら停止 + エスカレーション
         └ P0 ゼロ → 残 P1↓ は follow-up、close 条件を満たして merge
```

詳細な判断基準・レビューテンプレート・安全境界は [`GOAL_RULES.md`](./GOAL_RULES.md)。
より大きい保留事項（multi-reviewer consensus orchestration / codex session
continuation 等）は [`docs/future-features.md`](./docs/future-features.md)。
