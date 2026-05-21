# Phase 3-5 — SQLite Run Index 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase3/phase3-5-sqlite-run-index.md`（Phase 3-5 設計）
**Harness range:** Phase 3-5 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase3`

## 背景

ファイルベース（`runs/`）を source of truth に保ちつつ、一覧を高速化する SQLite index を導入する。index は派生キャッシュで、壊れたら `index rebuild` で再生成。

## 実装

| 層 | 変更 |
|----|------|
| `src/index/run-index.ts`（新規） | `rebuildIndex` / `loadFromIndex` / `indexStatus` / `showRunFromIndex`（better-sqlite3） |
| `src/core/review-lister.ts` | `applyListFilters` / `scanAllRuns` を抽出（file scan と index path が同一フィルタを通る） |
| `src/cli/run.ts` | `harness index rebuild/status/show`、`review list --use-index` |
| `.gitignore` / `paths.ts` | `.harness/index.sqlite` |

依存に `better-sqlite3`（ネイティブビルド — R4。インストール・動作確認済み）。**385 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1×1 + P2×2、全件 same-cycle fix:

| ID | severity | 概要 | 修正 |
|----|----------|------|------|
| 1 | P1 | `rebuildIndex` が live DB を削除して in-place 構築 → クラッシュで半端な index が残り `loadFromIndex` が正常扱い | sibling temp file に構築 → atomic rename。失敗時は temp を削除し旧 index を温存 |
| 2 | P2 | `showRunFromIndex` が `runs` table のみ参照 → invalid run を「not in index」と誤表示 | `invalid_runs` も参照、tagged union（valid/invalid/null） |
| 3 | P2 | `indexStatus` が corrupt DB で例外 → CLI exit 2 | SQLite error を捕捉し `{corrupt: true}` を返す |

## 実機デモ — E3-5

### E3-5-1: index rebuild

```
$ harness index rebuild
index rebuilt: runs=25 invalid=0 db=.../.harness/index.sqlite
$ harness index status
index: runs=25 invalid=0 rebuiltAt=2026-05-21T11:56:14Z size=28672B db=...
```

✅ `runs/` 全 25 件から index が構築された。

### E3-5-2: review list --use-index が file scan と一致

```
$ harness review list --all          > file scan 版
$ harness review list --all --use-index   > index 版
$ diff → 完全一致 ✓
```

✅ `--use-index` の出力が file scan と**完全一致**。両者が同一の `applyListFilters` を通る設計のため、index が最新なら結果は一致する。

### E3-5-3: index 破損 → rebuild で回復

```
$ echo garbage > .harness/index.sqlite
$ harness index status
index: corrupt (...): file is not a database; run 'harness index rebuild'
exit=1
$ harness index rebuild
index rebuilt: runs=25 invalid=0
$ harness index status
index: runs=25 invalid=0 ...   ← 回復
```

✅ 破損を `index status` が検出（exit 1 + rebuild 誘導）、`index rebuild` で完全回復。

## 閉じる条件チェック（Phase 3-5 設計 3-5.7）

```txt
[x] SQLite index を再構築できる        — E3-5-1（index rebuild）
[x] review list が index から読める     — E3-5-2（--use-index）
[x] file scan と結果が一致する          — E3-5-2（diff 完全一致）+ unit test
[x] index が壊れても rebuild できる     — E3-5-3
[x] source of truth は files と明記      — cli.md「source of truth は runs/ files」節
[x] docs に DB導入方針がある             — cli.md「DB 導入方針」節
```

## 新規 finding

なし。codex review の P1×1 + P2×2 は実装直後に fix 済み。

## 後片付け

- `.harness/index.sqlite` は gitignore 対象。デモ後も残置（次フェーズでも使える）
