# Phase 2 — Close Package

**Date:** 2026-05-21
**Trigger:** `tmp/phase2/phase2-10-phase2-close-package.md`（Phase 2-10 設計）
**Harness range:** `f236aa3`（bootstrap）→ Phase 2-10 close commit
**Scope tag:** `mvp-validation` / `phase-close`

## Phase 2 とは

Phase 2 のゴールは、harness を **「試験運用可能なファイルベースのハーネス」** にすること。完成形:

> ファイルベースで、`Codex 実行 → 検証 → レビュー → 再実行 → 知見候補 → cleanup` までを、人間が安全に操作できる状態。

完全な自律エージェント化（自動 retry loop / multi-agent / DB）は **Phase 3** に送る。

## Phase 2-1〜2-10 の到達点

| Phase | 内容 | 主要 deliverable | レポート |
|-------|------|------------------|----------|
| 2-1 | review-decision processor | `harness review process`、review-decision schema | `2026-05-21-phase2-review-commands-cleanup.md` |
| 2-2 | allowedCommands 実行 | `policy.commands.allow`、post-command 再 validation（F8） | 同上 |
| 2-3 | cleanup CLI | `harness cleanup` | 同上 |
| 2-4 | review auto / rerun / knowledge / cleanup --scope の実機デモ | structured commands、reviewer agent 実機初検証 | `2026-05-21-phase2-4-feature-demo.md` |
| 2-5 | Review / Run List | `harness review list`（--status/--domain/--limit/--json） | `2026-05-21-phase2-5-review-list-demo.md` |
| 2-6 | Reviewer Agent Robustness | error artifact / --allow-overwrite / --dry-run / 再帰 snapshot | `2026-05-21-phase2-6-reviewer-agent-robustness-demo.md` |
| 2-7 | Rerun Convergence | rootRunId / rerunAttempt / --max-attempts / rerun chain | `2026-05-21-phase2-7-rerun-convergence-demo.md` |
| 2-8 | Post-command Safety Matrix | events stage、副作用 9 シナリオ網羅 | `2026-05-21-phase2-8-post-command-safety-matrix-demo.md` |
| 2-9 | Knowledge Promotion Governance | knowledge list / reject / promote --reviewer、frontmatter、重複制御 | `2026-05-21-phase2-9-knowledge-promotion-governance-demo.md` |
| 2-10 | Close Package | root README、本レポート | （本レポート） |

## CLI subcommand 一覧（全て `docs/specs/cli.md` に記載）

```
harness run                              codex に 1 ドメインを編集させる
harness lock list / lock release         domain lock の確認 / 解除
harness review list                      レビュー待ち run の一覧（--status/--domain/--limit/--json/--all）
harness review auto                      reviewer agent が review-decision.yaml を生成（--allow-overwrite/--dry-run）
harness review process                   review-decision を meta.status に適用
harness rerun --from-review              changes_requested から新 run（--max-attempts）
harness rerun chain                      再実行系譜のツリー表示
harness cleanup                          worktree/branch/run dir を scope 単位で削除（--scope/--force）
harness knowledge list / reject / promote  knowledge candidate のレビューと昇格
```

## Phase 2 全体 close 条件

```txt
[x] Phase 2-1 review process が実装・検証済み
[x] Phase 2-2 allowedCommands が実装・検証済み
[x] Phase 2-3 cleanup CLI が実装・検証済み
[x] Phase 2-4 review auto / rerun / knowledge / cleanup scope の実機デモ済み
[x] Phase 2-5 review list が動く
[x] Phase 2-6 reviewer agent 異常系が担保されている
[x] Phase 2-7 rerun 収束条件がある
[x] Phase 2-8 post-command safety matrix が通る
[x] Phase 2-9 knowledge promotion governance がある
[x] docs/reports に全レポートが保存されている（MVP×2 + Phase 2×7 + 本レポート = phase2-review-commands-cleanup と 2-4〜2-9 の 7 本）
[x] docs/specs に全 CLI 仕様がある（cli.md に上記 subcommand 全て）
[x] README から mini-commerce 検証手順に辿れる（root README.md の Phase 2 quick start）
[x] typecheck が通る（`tsc --noEmit` クリア）
[x] test が通る（334 passed / 1 skipped, 43 files）
```

## E2-10 実験結果

### E2-10-1: clean environment walkthrough

root README.md の Phase 2 quick start に沿って `run → review list → review auto → review process → cleanup` を mini-commerce 実機で 1 本通した（詳細は本レポート「実機 walkthrough」節）。README 記載のコマンドはそのまま動作した。

### E2-10-2: validation docs completeness

`docs/reports/` に以下が揃っている:
- MVP validation（initial / followup）
- Phase 2 review/commands/cleanup
- Phase 2-4 feature demo
- Phase 2-5〜2-9 の各デモレポート
- Phase 2 close checklist（本レポート）

### E2-10-3: test suite

`npm run typecheck` / `npm test` ともに green（334 passed / 1 skipped）。

## 実機 walkthrough（E2-10-1）

mini-commerce 上で README quick start のコマンド列を実行:

1. `harness run --domain apps/catalog --goal …` → `needs_review`
2. `harness review list` → 当該 run が表示
3. `harness review auto --run-id <id> --reviewer-name codex-reviewer-p210` → reviewer agent が `decision` を生成
4. `harness review process --run-id <id>` → status 遷移
5. `harness cleanup --run-id <id>` → worktree + branch 削除、`cleaned`

各ステップで README 記載どおりの出力が得られ、追加の前提知識なしに一連の流れを実行できることを確認した。

## Finding registry サマリ

Phase 2 を通じて F8〜F12（+ 各 Phase の codex review P1/P2）を発見・全件 closed。Phase 2-10 時点で **未 close の P0/P1 finding は無い**。registry の全体は `docs/reports/README.md`。

各 Phase の codex review（gpt-5.5 / xhigh）で出た指摘:
- Phase 2 cycle: F8（P0）+ F9-F11（P1）+ F12（P2）
- Phase 2-5: P1×1 + P2×3
- Phase 2-6: P1×2 + P2×1
- Phase 2-7: P1×1 + P2×1
- Phase 2-8: P2×2
- Phase 2-9: P2×5（うち 1 件は contentHash の NUL バイト混入）

すべて同サイクル内で fix 済み。

## Phase 3 へ送る deferred items

```txt
- review process → rerun → review の完全自動 retry loop
- multi-agent reviewer / coder の分離並走
- DB / SQLite index
- Web UI
- GitHub PR 作成
- knowledge md の LLM への自動注入
- policy DSL の gitignore 互換化
- Docker / より強い sandbox
- reviewer agent の実機異常系サンプル拡充（現状 prose 混入 1 件 + unit 担保）
- reviewer agent の verdict 品質評価（複数モデル / 複数回）
- knowledge-candidates の 4 signal 生成条件の網羅実機検証
```

## 判定

**Phase 2 を close する。** ファイルベースで Codex 実行 → 検証 → レビュー → 再実行 → 知見昇格 → cleanup までが、人間の操作で安全に回せる状態に達した。typecheck / test green、全 finding closed、docs / README 整備済み。

close commit に続けて `phase2-close` タグを打つ。
