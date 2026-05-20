# Phase 2 — review-decision processor / allowedCommands / cleanup CLI

**Date:** 2026-05-21
**Trigger:** 前 report (`2026-05-20-mvp-validation-followup.md`) の "Next phase" Phase 2 (A → B → C)
**Harness range:** `4137b55` (Phase 1 close 直後) → `3a5f453` (codex review fix 適用後)
**Scope tag:** `feature-cycle` + `mvp-validation`

## Scope

Phase 1 で `needs_review` までは行けるが、その先のアクション（review 結果反映、commands 実行、後片付け）が無かった。本サイクルでこの 3 つを実装し、codex review で見つかった 4 件 (P0×1 / P1×3 / P2×1) を同サイクル内で fix、mini-commerce で実機 5 シナリオを通した。

---

## Part 1 — A: review-decision processor

前 report の plan `docs/superpowers/plans/2026-05-20-review-decision-processor.md` に従い、TDD 6 タスク・6 commit で実装。

### Task 1–6 (commits `26547a9` … `8c53690`)

| 層 | 変更 |
|---|---|
| schema | `src/core/review-decision-schema.ts` (Zod, strict、4 enum decision、null 許容 reviewer/reviewed_at)、`reporter/review-decision.ts` を type-import で統一 |
| loader | `src/core/review-decision-loader.ts` の `loadReviewDecision` / `writeReviewDecision` |
| RunMeta | `reviewer?: string \| null` + `reviewedAt?: string \| null`、`RunLog.setReviewerInfo` |
| processor core | `src/core/review-processor.ts:processReviewDecision`。runId/domain 整合性 + pending/needs_review gate + `reviewed_at` auto-fill + meta 反映 + `review_processed` event |
| CLI | `harness review process --run-id <id>` (subcommand) |
| docs | `docs/specs/{cli,workflow,overview}.md` に "harness review process" を追記、status 図 / event 例を更新 |

**unit + integration tests:** 22 件追加 (schema 6 / loader 3 / run-log 1 / processor 9 / CLI 3)。

**verdict:** ✅ 設計通り。reviewer null は warning のみで処理通過、reviewed_at は auto-fill して file に書き戻し。

---

## Part 2 — B: policy.allowedCommands 実行

### Tasks (commits `cbfa370`, `931eb12`, `a3c641a`)

`policy.allowedCommands` (元から schema にはあったが未使用) を実行するレイヤを新設。

| 層 | 変更 |
|---|---|
| runner core | `src/core/command-runner.ts:runAllowedCommands` — `sh -c "<cmd>"`、`detached:true` + `killProcessTree` で SIGKILL、5 分 timeout default、env は `PATH/HOME/USER/SHELL/LANG/LC_ALL/TERM/TMPDIR` のみ通過 |
| RunMeta | `commandResults?: Array<{command, exitCode, durationMs, timedOut}>`、`finalize` 経由で書き込み |
| workflow | path validation 通過後に commands を実行、1 件でも失敗なら `failed-command` |
| events | `commands_started` / `commands_completed` |
| artifacts | `runs/<id>/commands/<idx>-<slug>.{out,err}.log` |
| CLI 出力 | `commands=<ok>/<total>` を末尾に追加 |

**新規 unit + integration tests:** 9 件 (runner 7 / workflow 2)。

**verdict:** ✅ 動作確認。ただし codex review で P0 finding (workflow が commands 実行後に再 validation しない) が出て同サイクル内で fix → Part 4 参照。

---

## Part 3 — C: cleanup CLI

### Tasks (commits `fc7cb85`, `9187b7e`, `9933bca`)

`approved` / `rejected` 後の worktree + branch を削除して `cleaned` 状態へ。run dir は audit のため保持。

| 層 | 変更 |
|---|---|
| RunStatus | `cleaned` を enum に追加 |
| core | `src/core/cleanup.ts:cleanupRun`。ゲート判定: approved/rejected は素通り、changes_requested は --force でも refuse、needs_review/failed-* は --force 必須、cleaned は idempotent no-op |
| CLI | `harness cleanup --run-id <id> [--force]` subcommand |
| events | `cleaned` |
| docs | `docs/specs/{cli,workflow,overview}.md` に反映 |

**新規 tests:** 11 件 (unit 7 / integration 4)。

**verdict:** ✅ 基本動作 OK。codex review で P1 finding 3 件 (race lock 無し / branch 削除粒度 / runId 検証無し) と P2 finding 1 件 (exit code) → Part 4 参照。

---

## Part 4 — codex code review (gpt-5.5 / xhigh) + 修正

`tmp/code-review-phase2bc.md` を prompt として実機 codex に診断依頼。**5 件の finding** が出て全件同サイクルで fix。

### F8 (P0, fixed) — workflow が commands 実行後に再 validation しない

**問題:** `runAllowedCommands` は path validation 通過後に走るが、コマンドが scope 外を書いても artifact / 状態は走る前の snapshot のまま。`exit 0` のコマンドが `apps/orders/cmd-leak.ts` を作れば `needs_review` で素通り。

**修正 (`669af16`):** `diffAndValidate()` ヘルパに集約 → workflow が **2 回** 呼ぶ:
1. codex 直後 (commands を走らせる前提として、初期状態の policy verdict が必要)
2. commands 実行後 (artifacts と最終 status は post-command worktree を反映)

`safetyStatus === "denied"` の判定が post-command 結果に変わったので、コマンドが書いた scope 外も検出される。

**実証 (E5):** policy に `mkdir -p apps/orders/src && echo > apps/orders/src/cmd-leak.ts` を仕込んで catalog 正常タスクを実行 → commands=3/3 全 exit=0 だが status=**failed-policy-violation** safetyStatus=denied、summary に違反 path 明記。

### F9 (P1, fixed) — cleanup の branch 削除が worktree に depend していた

**問題:** `removeWorktree()` は内部で `git branch -D` を best-effort で叩く。cleanup はそれに依存していたので、(a) worktree が既に消えてる時に branch が残るケースで何もしない、(b) branch 削除失敗を握り潰して `branchRemoved=true` と報告する、の 2 つを内包。

**修正 (`6a9cec7`):** cleanup を `removeWorktree` 経由から `git worktree remove` + `git branch --list/-D` の直接呼び出しに置換。worktree と branch の有無を別個に check、削除失敗は明示的に throw。

### F10 (P1, fixed) — cleanup が domain lock を取らない

**問題:** cleanup は worktree / branch を触るが lock を取らないので、同 domain の新 run と race して git が壊れる可能性。

**修正 (`6a9cec7`):** `acquireDomainLock` を cleanup 内で取得、`runId = cleanup:<id>` で正規 run と判別可能、finally で release。`CleanupOpts.locksDir` 必須化。

### F11 (P1, fixed) — runId / meta.json の検証なし

**問題:** `--run-id ../escape` で runsDir / workspacesDir の外に出られる潜在。さらに meta.json の repoPath / runBranch / domain / status を validate せずに使う。

**修正 (`6a9cec7`):** `RUN_ID_RE = /^run-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/` で runId 検査、`validateMeta()` で各 field の型 + status enum を check。

### F12 (P2, fixed) — cleanup ゲート refusal が exit code 2

**問題:** spec では gate refusal は exit 1 (automation で分岐可能) のはずだが、global catch 経由で 2 に。

**修正 (`3a5f453`):** `CleanupGateError` class を新設、CLI で instanceof check → exit 1。それ以外の throw は global catch (exit 2) に。

---

## Part 5 — mini-commerce 実機実験 (5 シナリオ)

`/Users/kn/dev/mini-commerce/` で Phase 2 機能を E2E 実機検証。

| # | シナリオ | 確認 | 結果 |
|---|----------|------|------|
| E1 | 既存 needs_review run を approve | review process が status を遷移、reviewer/reviewedAt 同期、yaml に書き戻し | ✅ `needs_review → approved` |
| E2 | allowedCommands inline run | catalog domain に `commands.allow: [node -e ..., test -f ...]` を追加して新規 run、status / commands logs / commandResults を確認 | ✅ commands=2/2、log artifacts × 4、meta.commandResults に配列 |
| E3 | approved run を cleanup | worktree dir 削除、git branch 削除、meta.status=cleaned、run dir は保持 | ✅ `worktreeRemoved=true branchRemoved=true` |
| E4 | needs_review run を cleanup (force なし) | gate refusal で exit 1 | ✅ exit code = 1、message 明示 |
| E5 | commands が scope 外を書く | post-validation で検出して `failed-policy-violation` | ✅ commands=3/3 全 exit=0、status=failed-policy-violation、summary に `cmd-leak.ts (deny_write)` |

詳細は `tmp/validation/p2-experiments-notes.md` (.gitignore'd)。

**run id 一覧:**
- E1: `run-20260520-apps-catalog-mpe3vgb9e3b0a532` (review process)
- E2: `run-20260520-apps-catalog-mpe9vluk4ec0ec90` (commands ok)
- E3: 同 E1 (cleanup)
- E4: `run-20260520-apps-catalog-mpe9vluk4ec0ec90`
- E5: `run-20260520-apps-catalog-mpe9z84h9a1ed201`

実機 codex run は 2 件 (E2, E5)。E1/E3/E4 は新規 codex 不要。

---

## Findings summary

| ID | カテゴリ | サイクル | ステータス |
|----|---------|---------|-----------|
| F1–F7 | (前 report) | — | 既出 |
| F8 | P0 commands 後の再 validation 抜け | 本サイクル | closed (impl) |
| F9 | P1 cleanup branch 粒度 | 本サイクル | closed (impl) |
| F10 | P1 cleanup race lock | 本サイクル | closed (impl) |
| F11 | P1 cleanup runId/meta 検証 | 本サイクル | closed (impl) |
| F12 | P2 cleanup exit code | 本サイクル | closed (impl) |

---

## Test inventory

- 合計 **180 PASS / 1 skipped (35 files)**
- このサイクルで追加 unit + integration: **48 件**
  - review-decision schema (6)
  - review-decision loader (3)
  - run-log reviewer setter (1)
  - review-processor (9)
  - cli-review-process (3)
  - command-runner (7)
  - cli-cleanup (5)
  - cleanup unit (10)
  - workflow allowedCommands + post-command violation (3)
  - その他 finalize 形式テスト調整 (1)
- typecheck `tsc --noEmit` クリア

---

## このサイクルで明確になったこと

### 1. commands 実行後の再 validation は必須

最初の実装は path validation を 1 度だけ走らせていた。codex review が無ければ気付かなかった可能性が高い。**「副作用を持つステップは前後の状態を取り直す」** がハーネスの基本姿勢。

### 2. cleanup は run と同じ lock 名で取る

cleanup は worktree / branch / refs を触るので、`harness run` と完全に同じ排他制御が必要。`runId = cleanup:<id>` の prefix で正規 run と区別。

### 3. CLI exit code はテスト可能な粒度で

- `0`: 成功
- `1`: gate refusal / 明示的なユーザエラー (automation で「retry しない」分岐可能)
- `2`: 予期しない例外 (process / system エラー)

`harness cleanup` の F12 修正で揃った。`harness review process` も同じ規約だが pending / mismatch エラーは現状 global catch → exit 2 で動いている。実用上問題はないが、揃えるなら follow-up。

### 4. yaml に書き戻すフィールドの判断

`reviewed_at: null` の auto-fill だけは yaml にも書き戻し（audit）、それ以外は meta.json が source of truth。「reviewer のものは reviewer 自身のファイルに」原則。

### 5. mini-commerce での実機実験は cheap

E1/E3/E4 は新規 codex run 不要、E2/E5 のみで Phase 2 機能 5 種類すべて検証できた。ファイルベースの artifact だけで仕様確認できる設計の利点。

---

## Commits in this cycle

```
3a5f453 fix(cli): cleanup gate errors exit 1 (P2 from codex review)
6a9cec7 fix(cleanup): runId validation + meta sanity check + domain lock + independent branch handling (P1)
669af16 fix(workflow): re-collect diff and re-validate AFTER commands (P0 from codex review)
9933bca docs(specs): document 'harness cleanup' + 'cleaned' status + events
9187b7e feat(cli): 'harness cleanup --run-id <id> [--force]' subcommand
fc7cb85 feat(core): cleanup core + 'cleaned' RunStatus
a3c641a docs(specs): document policy.allowedCommands behavior and artifacts
931eb12 feat(workflow): run policy.allowedCommands after path validation; status=failed-command on failure
cbfa370 feat(core): allowlist command runner (sh -c, tree-kill timeout, log artifacts)
8c53690 docs(specs): document 'harness review process' subcommand
371f5dd feat(cli): add 'harness review process --run-id <id>' subcommand
233eef9 feat(core): processReviewDecision applies review-decision.yaml to meta.json
903dd70 feat(logging): add reviewer/reviewedAt to RunMeta + setReviewerInfo
60abbec feat(core): load/write review-decision.yaml with schema validation
26547a9 feat(core): zod schema for review-decision.yaml + share with reporter
```

15 commit、`f514e9f`（Phase 1 close） → `3a5f453`（本サイクル末尾）。

---

## Next phase / Open items

**Phase 3 (multi-agent / retry / promotion) は未着手。** 候補:

- **`harness review process --apply-changes-requested`**: `changes_requested` を受けて `required_changes` を新 run の prompt に組み込んで起動する retry loop
- **reviewer agent**: 別 codex セッションで artifact をレビューさせ、`review-decision.yaml` を機械的に埋める
- **knowledge promotion CLI**: `knowledge-candidates.yaml` の signal を確定 knowledge ファイル (`docs/knowledge/`) に昇格
- **`harness review list`**: `needs_review` 状態の run を列挙 (運用補助)
- **`harness review process` の exit code 統一**: 現状 pending / mismatch が exit 2、cleanup と揃えるなら exit 1 に
- **command timeout / env allowlist の policy 化**: 現状 hardcoded、policy から動的に注入できると運用幅が広がる
