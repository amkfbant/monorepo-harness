# Phase 3 — Close Package

**Date:** 2026-05-21
**Trigger:** `tmp/phase3/phase3-8-phase3-close-package.md`（Phase 3-8 設計）
**Harness range:** `phase2-close` タグ → Phase 3-8 close commit
**Scope tag:** `phase3-close`

## Phase 3 とは

Phase 2 の安全境界（ファイルベース、人間ゲート）を保ったまま、review / retry / knowledge reuse / index / PR化 を段階的に自動化・運用化する。完全自律化はゴールにしない。

## Phase 3 サブフェーズの到達点

実装順は `3-1 → 3-4 → 3-2 → 3-3 → 3-5 → 3-6 → 3-8`（**3-7 は Deferred**）。

| Phase | 内容 | 主要 deliverable | レポート |
|-------|------|------------------|----------|
| 3-1 | Review-driven Retry Loop | `harness workflow reviewed-run`、`workflow.json` / `workflow-summary.md` | `2026-05-21-phase3-1-reviewed-run-demo.md` |
| 3-4 | Promoted Knowledge Context Injection | `knowledge build-context`、`run --with-knowledge`、`deprecated` frontmatter | `2026-05-21-phase3-4-knowledge-context-demo.md` |
| 3-2 | Reviewer Agent Quality Evaluation | `review evaluate` / `review compare`、`evaluation-summary.md` | `2026-05-21-phase3-2-reviewer-evaluation-demo.md` |
| 3-3 | Agent Role Separation | prompt template の名前+version、`meta.promptTemplate`、role boundary docs | `2026-05-21-phase3-3-agent-role-separation-demo.md` |
| 3-5 | SQLite Run Index | `harness index rebuild/status/show`、`review list --use-index`（better-sqlite3） | `2026-05-21-phase3-5-sqlite-index-demo.md` |
| 3-6 | GitHub PR Integration | `harness pr create`（approved run → draft PR） | `2026-05-21-phase3-6-github-pr-demo.md` |
| 3-7 | Stronger Sandbox | — | **DEFERRED**（下記） |
| 3-8 | Close Package | 本レポート、root README 更新 | （本レポート） |

## Phase 3-7 の Deferred 判断

Phase 3-7（Docker による stronger sandbox）は **Phase 3 では実装しない**。計画段階のリスク **R1**（コンテナ内で `codex` CLI とその認証情報をどう持ち込むか — codex の認証はホストの keychain 等に紐づく）が現時点で解決困難なため、ユーザー判断（2026-05-21）で Deferred とした。設計メモは `tmp/phase3/phase3-7-stronger-sandbox.md` に残す。Phase 4 以降の候補。

## Phase 3 全体 close 条件

```txt
[x] reviewed-run workflow がある                       — Phase 3-1
[x] reviewer quality evaluation がある                 — Phase 3-2
[x] agent role separation が docs/実装に反映されている  — Phase 3-3
[x] promoted knowledge を context 注入できる            — Phase 3-4
[x] SQLite index を再構築できる                        — Phase 3-5
[x] approved run から draft PR を作れる                 — Phase 3-6
[x] typecheck / test が通る                            — tsc クリア、Tests 403 passed / 1 skipped、Test Files 50 passed / 1 skipped (51)
[x] docs/reports に Phase 3 レポートがある               — 3-1/3-2/3-3/3-4/3-5/3-6 + 本レポート
[x] README が更新されている                            — root README に Phase 3 機能表
[x] Phase 3-7 が Deferred として明記されている           — README / tmp/phase3/ / 本レポート
```

## CLI subcommand（Phase 3 追加分）

```
harness workflow reviewed-run   run→review auto→review process→rerun の bounded loop
harness knowledge build-context promote 済み knowledge を domain 別に集約
harness run --with-knowledge    knowledge context を prompt 注入
harness review evaluate         reviewer agent を N 回サンプリング
harness review compare          2 つの review-decision を比較
harness review list --use-index SQLite index から一覧
harness index rebuild/status/show  SQLite run index
harness pr create               approved run → GitHub draft PR
```

全 subcommand は `docs/specs/cli.md` に記載。

## codex review サマリ

各サブフェーズで codex review（gpt-5.5 / xhigh）を実施。P0 はゼロ。検出された指摘:

- Phase 3-1: P1×1 + P2×2
- Phase 3-4: P2×3
- Phase 3-2: P1×1 + P2×1
- Phase 3-3: P1×1 + P2×3
- Phase 3-5: P1×1 + P2×2
- Phase 3-6: P1×2 + P2×1

**すべて同サイクル内で fix 済み。** Phase 3-8 時点で未 close の P0/P1 finding は無い。各レポートに detail。

## Post-close ハードニング（ユーザーレビュー対応）

Phase 3 close 後、ユーザーから Phase 3 全体に対し **P1×1 + P2×7** のレビューを受け、対応した。さらにその修正を codex で 2 巡再レビューした:

- **ユーザーレビュー（P1×1 + P2×7）** → `e392c68` で fix:
  - P1: `pr create` が path のみ制限し content drift を検出していなかった → reviewed paths の content fingerprint を `meta.reviewed` に記録し照合
  - P2: pr-creator の events.jsonl 依存解消 / gh `--state open` / gh timeout / index に root_run_id・rerun_attempt / evaluator snapshot の symlink・dir 対応 / knowledge `<knowledge>` fence + 32 KiB 上限 / maxAttempts docs
- **codex 再レビュー 1（P1×1 + P2×3）** → `e392c68` の次コミットで fix:
  - P1: fingerprint が `readFile` で symlink を辿っていた → `lstat` ベースの type-tagged fingerprint
  - P2: gh timeout の握り潰し / index schema version / knowledge fence の tag 混入
- **codex 再レビュー 2（P0/P1 なし、P2×2）** → `518dfb3` で fix:
  - P2: `neutraliseFence` の nested bracket（`<</knowledge>>`）/ fingerprint file branch の TOCTOU（`O_NOFOLLOW`）

最終的に **codex 再レビューで P0/P1 ゼロ**、P2 も全件 fix 済み。テストは Tests 403 passed / 1 skipped に増加（content drift / fingerprint type 変化 / gh timeout / 旧 schema index / fence escape の regression テストを追加）。

## 実機デモ サマリ

- 3-1: `reviewed-run` を 2 回実機実行（E3-1-1 approved 収束）。rerun ループは fake-codex 統合テストで決定論担保（reviewer の goal 相対評価により実機 cr 誘発は非再現 — R5）
- 3-2: known-bad run を 3 サンプル評価 → 3/3 非 approved、UNSTABLE 検出
- 3-4: build-context → run --with-knowledge で prompt 注入 + meta/events 記録、deprecated 除外
- 3-3: 実機 run に `meta.promptTemplate` 記録、coder 出力が status を動かさないことを確認
- 3-5: `index rebuild` / `--use-index` が file scan と完全一致 / 破損 → rebuild 回復
- 3-6: `amkfbant/mini-commerce` に draft PR #1 を実機作成（デモ後クローズ）

## Phase 4 以降へ送る deferred items

```txt
- Phase 3-7: stronger sandbox（Docker。R1 = コンテナ内 codex 認証が未解決）
- 完全自律 merge / 人間レビューなしの本番反映
- multi-agent swarm
- Web UI
- reviewer agent の verdict 品質の定量基準（3-2 は観測まで）
- knowledge の自動昇格 / ベクトル検索
- 実機での changes_requested → rerun の決定論的再現（R5）
```

## 判定

**Phase 3 を close する。** Phase 3-7 を Deferred とした以外、3-1〜3-6 + 3-8 のすべてが設計どおりの close 条件を満たして完了。close 後のユーザーレビュー（P1×1 + P2×7）と codex 再レビュー 2 巡で出た指摘も全件 fix し、最終 codex レビューは **P0/P1 ゼロ**。typecheck / test green（403 passed / 1 skipped）、未 close の finding なし、docs / README 整備済み。

`phase3-close` タグを post-close ハードニング後の commit に更新する。
