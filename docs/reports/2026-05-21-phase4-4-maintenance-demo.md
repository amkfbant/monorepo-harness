# Phase 4-4 — Maintenance / Cleanup Assistant 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase4/phase4-4-maintenance.md`（Phase 4-4 設計）
**Harness range:** Phase 4-4 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase4`

## 背景

個人運用で run を多数回すと stale lock / orphan worktree / 未 cleanup worktree / 巨大 run dir が溜まる。Phase 4-4 でこれらを検出・掃除する。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/maintenance.ts`（新規） | `checkMaintenance` / `runMaintenanceCleanup` / `parseDuration` |
| `src/cli/run.ts` | `harness maintenance check` / `maintenance cleanup` |

**449 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 なし。P1×1 + P2×2、全件 same-cycle fix:

| # | severity | 概要 | 修正 |
|---|----------|------|------|
| 1 | P1 | `stale-lock` が経過時間だけで auto-cleanable → 長時間 run の生きた lock を `cleanup --force` で削除し並行操作を許す危険 | lock の `pid`/`hostname` で**生存確認**。同 host で pid 死亡時のみ auto-cleanable、生存中は finding を出さない、別 host / JSON 破損は manual |
| 2 | P2 | `large-run-dir` が `scanAllRuns` の valid のみ走査 → meta 破損の巨大 dir を見逃す | `runsDir` を `RUN_DIR_RE` で直接列挙し全 run dir を size 計測 |
| 3 | P2 | docs が未存在の `docs/ops/personal-operating-manual.md` を参照、close 条件「週次手順」未充足 | cli.md に週次 maintenance 手順をインライン記載 |

## 実機デモ — E4-4

### E4-4-1: check が残骸を検出

```
$ harness maintenance check
[manual]    uncleaned-finished: run-...-mpf75yuncc79b763  — approved run still has a worktree ...
[manual]    uncleaned-finished: run-...-mpfcpvu2386dbf20  ...
[manual]    uncleaned-finished: run-...-mpfcxfug931cbadc  ...
```
✅ 既存 runs/ から approved 未 cleanup の 3 run を検出。

### E4-4-2 / E4-4-4 / E4-4-5: orphan worktree + cleanup gate

合成 orphan worktree（`workspaces/run-...-orphan99`、runs/ に対応なし）を作成して検証:

```
$ harness maintenance check
[cleanable] orphan-worktree: run-20260521-apps-demo-orphan99  — workspace exists but the run dir is gone

$ harness maintenance cleanup          # --force なし
harness error: maintenance cleanup would delete 1 item(s); re-run with --force to actually remove them
exit=1

$ harness maintenance cleanup --dry-run
maintenance cleanup would remove 1 item(s): orphan-worktree: ...

$ harness maintenance cleanup --force
maintenance cleanup removed 1 item(s): orphan-worktree: ...
→ orphan 削除確認
```
✅ E4-4-2 orphan 検出 / E4-4-4 `--dry-run` は削除せず表示 / E4-4-5 `--force` 無しの実削除を exit 1 で拒否。

### stale-lock の生存確認（P1 対応）

unit test で担保: 死亡 pid の古い lock → `cleanable: true`、生きた pid（`process.pid`）の古い lock → finding なし、別 host の lock → `cleanable: false`（manual）。E4-4-3（cleaned-with-worktree / uncleaned-finished）も unit test で担保。

## 閉じる条件チェック（Phase 4-4 設計 4-4.5）

```txt
[x] maintenance check が残骸を検出する     — E4-4-1、unit test（5 finding kind）
[x] cleanup candidates を表示する          — formatFindings の [cleanable]/[manual]
[x] --dry-run がある                       — E4-4-4
[x] destructive action は --force 必須      — E4-4-5
[x] docs に週次maintenance手順がある        — cli.md「週次 maintenance 手順」節
```

## 新規 finding

なし。codex review の P1×1 + P2×2 は実装直後に fix 済み。P1（stale-lock の生存確認）は、長時間 run の lock を誤って消すと並行操作で worktree/meta が壊れる現実的な危険があり、重要な往復だった。

## 後片付け

- 合成 orphan worktree は `--force` cleanup で削除済み
