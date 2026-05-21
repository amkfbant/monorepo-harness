# Phase 4 — Close Package

**Date:** 2026-05-21
**Trigger:** `tmp/phase4/phase4-10-close-package.md`（Phase 4-10 設計）
**Harness range:** `phase3-close` タグ → Phase 4-10 close commit
**Scope tag:** `phase4-close`

## Phase 4 とは

チーム運用ではなく、**個人が頻繁な変更・多数の run・レビュー待ち・backlog・知見・cleanup を安全に扱えるようにする**（Personal Operations）。ファイルベースの source of truth を維持し、SQLite index を運用 CLI の高速化に使う。

## Phase 4 サブフェーズの到達点

実装順は設計の推奨順 `4-1 → 4-2 → … → 4-10`。

| Phase | 内容 | 主要 deliverable | レポート |
|-------|------|------------------|----------|
| 4-1 | Run Show / Timeline | `run show / timeline / artifacts` | `2026-05-21-phase4-1-run-show-demo.md` |
| 4-2 | Inbox | `harness inbox`（5 section + action hint） | `2026-05-21-phase4-2-inbox-demo.md` |
| 4-3 | Personal Backlog | `backlog add/list/show/run/done/defer`、run と双方向リンク | `2026-05-21-phase4-3-backlog-demo.md` |
| 4-4 | Maintenance | `maintenance check / cleanup`（残骸検出・掃除） | `2026-05-21-phase4-4-maintenance-demo.md` |
| 4-5 | Knowledge Digest | `knowledge digest`（candidate/promoted/rejected 集計） | `2026-05-21-phase4-5-knowledge-digest-demo.md` |
| 4-6 | Personal Metrics | `metrics summary / domain / failures` | `2026-05-21-phase4-6-metrics-demo.md` |
| 4-7 | Session Planning | `session plan / start / summary`（提案のみ） | `2026-05-21-phase4-7-session-planning-demo.md` |
| 4-8 | Static HTML Export | `dashboard export` → `docs/dashboard/index.html` | `2026-05-21-phase4-8-dashboard-export-demo.md` |
| 4-9 | Personal Operating Manual | `docs/ops/personal-operating-manual.md` | （docs のみ） |
| 4-10 | Close Package | 本レポート、root README 更新 | （本レポート） |

## Phase 4 全体 close 条件（設計 4-10.2）

```txt
[x] run show / timeline がある            — Phase 4-1
[x] inbox がある                          — Phase 4-2
[x] backlog がある                        — Phase 4-3
[x] maintenance check がある               — Phase 4-4
[x] knowledge digest がある                — Phase 4-5
[x] metrics summary がある                 — Phase 4-6
[x] session planning がある                — Phase 4-7
[x] static HTML export がある              — Phase 4-8
[x] personal operating manual がある        — Phase 4-9（docs/ops/）
[x] typecheck / test が通る                — tsc クリア、Tests 484 passed / 1 skipped、Test Files 59 passed / 1 skipped (60)
[x] README が更新されている                — root README に「Phase 4 で追加した機能」+ Personal Operations quick start
```

## CLI subcommand（Phase 4 追加分）

```
harness run show / timeline / artifacts   1 run の状態を read-only 表示
harness inbox                             今日見るべきものの集約
harness backlog add/list/show/run/done/defer   個人 backlog
harness maintenance check / cleanup       残骸の検出・掃除
harness knowledge digest                  知見の期間・domain 別集計
harness metrics summary / domain / failures   運用指標
harness session plan / start / summary    ルール順の作業提案
harness dashboard export                  静的 HTML ダッシュボード
```

全 subcommand は `docs/specs/cli.md` に記載。

## codex review サマリ

各サブフェーズで codex review（gpt-5.5 / xhigh）を実施。**P0 はゼロ。**

| Phase | 指摘 |
|-------|------|
| 4-1 | P2×3 |
| 4-2 | P2×3 |
| 4-3 | P1×2 + P2×3 |
| 4-4 | P1×1 + P2×2 |
| 4-5 | P2×3 |
| 4-6 | P1×1 + P2×3 |
| 4-7 | P1×1 + P2×1 |
| 4-8 | P2×1 |

**すべて同サイクル内で fix 済み。** Phase 4-10 時点で未 close の P0/P1 finding は無い。各レポートに detail。主な P1:

- 4-3: `recordBacklogRun` の meta patch 競合 → link を backlog 側のみに保持し `run show` が逆引き / `moveItemFile` を atomic 化
- 4-4: stale-lock を経過時間だけで auto-clean → 所有プロセスの生存確認を追加
- 4-6: policy violation を `safetyStatus==="denied"` で集計（status と直交）
- 4-7: `loadAllRuns` が stale index を無条件優先 → freshness チェックを追加（inbox/metrics/session 全てに効く）

## 実機デモ サマリ

- ほとんどのサブフェーズは既存 `runs/` に対する read-only 集計のため codex 不要でデモ
- 4-3 のみ `backlog run` で mini-commerce に対し実機 codex を 1 回起動（E4-3-2、reviewed-run でなく `--workflow run`）
- 4-8 は `docs/dashboard/index.html` を実生成しリポジトリにコミット（成果例、ユーザー承認済み）

## ファイルベース運用の維持

Phase 4 でも source of truth は `runs/` / `backlog/` / `docs/knowledge/` 等のファイル。SQLite index は派生キャッシュで、inbox/metrics/session は index が stale なら自動で file scan にフォールバックする（4-7 P1 対応）。

## Phase 5 以降へ送る項目

```txt
- Web dashboard（Phase 4-8 は静的 export のみ。インタラクティブ UI は Phase 5）
- Phase 3-7: stronger sandbox（Docker。R1 = コンテナ内 codex 認証が未解決）
- multi-user permission / reviewer assignment
- 完全自律 merge / 人間レビューなしの本番反映
- reviewer agent の verdict 品質の定量基準
```

## 判定

**Phase 4 を close する。** 4-1〜4-9 のすべてが設計どおりの close 条件を満たして完了。typecheck / test green（484 passed / 1 skipped）、全 codex finding closed（P0 ゼロ）、docs / README / operating manual 整備済み。

close commit に続けて `phase4-close` タグを打つ。
