# Phase 3-3 — Agent Role Separation 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase3/phase3-3-agent-role-separation.md`（Phase 3-3 設計）
**Harness range:** Phase 3-3 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase3`

## 背景

Phase 2 で coder / reviewer は実装上は分離されていた。Phase 3-3 はこれを**設計上の標準**として明文化し、prompt template を名前付き・version 付きにする。

## 実装

| 層 | 変更 |
|----|------|
| `prompt-builder.ts` / `reviewer-agent.ts` / `rerun.ts` | `CODER_PROMPT_TEMPLATE` / `REVIEWER_PROMPT_TEMPLATE` / `RERUN_PROMPT_TEMPLATE`（名前 + version） |
| `run-log.ts` / `workflow-runner.ts` | `meta.promptTemplate` に coder テンプレートの `{name, version}` を記録 |
| `docs/specs/overview.md` | 「Agent role separation」節 |

**375 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1×1 + P2×3、全件 same-cycle fix:

| ID | severity | 概要 | 修正 |
|----|----------|------|------|
| 1 | P1 | docs が「coder は構造的に `runs/` へ到達不可」と断言していたが、runner は `resolved.codex.sandbox` をそのまま渡し schema は `danger-full-access` も許す → 境界が条件付き | docs を「標準の `workspace-write` sandbox 前提。`danger-full-access` 設定時は失効」に修正 |
| 2 | P2 | `RERUN_PROMPT_TEMPLATE` が定義のみで未使用 | rerun goal block のヘッダに `name v{version}` を明記（rerun の `codex-prompt.md` に残る） |
| 3 | P2 | docs「reviewer は artifacts も変更できない」が実装と齟齬（harness が検証後 review-decision.yaml を書く） | 「agent は直接変更できない / harness が検証済み output を書く」に修正 |
| 4 | P2 | version bump がコメント運用のみで検出機構なし | coder/reviewer prompt 内容を hash で pin する tripwire テストを追加 |

## role boundary（overview.md に明文化）

| ロール | 権限 | 構造上の境界 |
|--------|------|------|
| coder agent | 標準 `workspace-write`（cwd = worktree） | worktree に閉じ `runs/<id>/review-decision.yaml` に到達不可（`danger-full-access` 時は失効） |
| reviewer agent | `read-only` sandbox + artifact snapshot | 直接コード・artifact を変更不可。harness が検証後に review-decision.yaml を書く |
| harness | authoritative | status 遷移は harness のみ |

## 実機デモ — E3-3（mini-commerce、apps/catalog）

`harness run`（実機 codex）:

```
run=run-20260521-apps-catalog-mpff0vuof8c93386 status=needs_review commands=3/3
meta: {"status":"needs_review","promptTemplate":{"name":"coder-domain-task","version":1}}
```

✅ **E3-3-3**: 実機 run の `meta.promptTemplate` に `{name: "coder-domain-task", version: 1}` が記録された。
✅ **E3-3-2**: coder run 完了後 status は `needs_review`。coder の出力が何であれ status は動かない（`harness review process` のみが遷移させる）。整合テスト「a coder that claims approval in its output cannot change the run status」でも担保。

### E3-3-1（reviewer に編集指示を混ぜる）

reviewer agent が `read-only` sandbox + artifact snapshot で改竄不可であることは、**Phase 2-6 で実機検証済み**（E2-6-1 prose 混入）かつ unit test の tamper 検出群（`reviewer-agent.test.ts` の `commands/` / `review-decision.yaml` 改竄、tamper+timeout/non-zero）で決定論的に担保。Phase 3-3 では reviewer prompt template に version を付け、prompt 内容の tripwire テストを追加した。実機の追加 evaluate は省略（既存カバレッジで十分）。

## 閉じる条件チェック（Phase 3-3 設計 3-3.5）

```txt
[x] coder / reviewer prompt template が分離されている  — 3 モジュールに名前付き定数
[x] prompt template version が記録される               — meta.promptTemplate + tripwire テスト
[x] reviewer は read-only sandbox                       — review auto / evaluate（sandbox: read-only）
[x] reviewer は status を変更できない                   — review process のみが遷移、構造 + test
[x] coder は review-decision を変更できない             — workspace-write は worktree に閉じる + test（E3-3-2）
[x] docs に role boundary がある                        — overview.md「Agent role separation」節
```

## 新規 finding

なし。codex review の P1×1 + P2×3 は実装直後に fix 済み。P1（danger-full-access で coder 境界が失効する点）は docs に明記した。`danger-full-access` を coder sandbox で拒否するかは Phase 2 policy の挙動変更になるため本フェーズでは見送り、docs での注意喚起に留めた。

## 後片付け

- demo run（`mpff0vuof8c93386`）は runs/ に残置
