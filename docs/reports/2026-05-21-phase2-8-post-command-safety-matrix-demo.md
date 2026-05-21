# Phase 2-8 — Post-command Safety Matrix 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase2/phase2-8-post-command-safety-matrix.md`（Phase 2-8 設計）の実装と E2-8 デモ
**Harness range:** `d23f13f`（Phase 2-8 実装 + codex review fix）
**Scope tag:** `mvp-validation`

## 背景

command 実行後の再 diff/validation（F8、Phase 2 cycle で実装）が、commands の作る**あらゆる副作用**に対して codex 直後と同じ安全境界を効かせることを網羅検証する。

Phase 2-8 の実装変更は events の `stage` 正規化のみ。残りは test/experiment による matrix の充足。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/workflow-runner.ts` | diff/validation events に `stage`（`post-codex` / `post-command`）を付与。旧 `phase: "post-commands"` を正規化、`diff_collected` にも `stage` |
| `tests/integration/workflow-fake-codex.test.ts` | post-command matrix を T1〜T7 に拡充。setupRepo に root `README.md`（scope 外 tracked ファイル） |
| `docs/specs/workflow.md` | events 例に `stage`、高レベルフローを 2-pass 構成に書き直し、RunStatus 優先順位に `failed-command` 追加 |

**324 tests PASS / 1 skipped**、typecheck クリア。

## post-command safety matrix（自動テスト）

`tests/integration/workflow-fake-codex.test.ts` の T1〜T7 が 9 シナリオを決定論的にカバー:

| # | command の副作用 | テスト | 期待 |
|---|-----------------|--------|------|
| 1 | scope 内 tracked 変更 | 正常系テスト群 | needs_review |
| 2 | scope 外 tracked 変更 | T7 | failed-policy-violation |
| 3 | scope 内 untracked | （暗黙）| needs_review |
| 4 | scope 外 untracked | F8 テスト（cmd-leak.ts）| failed-policy-violation |
| 5 | ignored untracked | T1 | ignoredUntrackedCount++, allowed |
| 6 | secret-shaped untracked | T2 | secretSuspectCount++, content redacted |
| 7 | symlink untracked | T3 | `@@ symlink @@`、target 内容は出ない |
| 8 | huge untracked | T4 | `@@ omitted (size=…, sha256=…) @@` |
| 9 | binary untracked | T5 | `@@ omitted (binary, …) @@` |

T6 は events.jsonl の `stage` 検証（post-codex → post-command の順）。

## codex review (gpt-5.5 / xhigh)

P0 / P1 なし。P2 ×2、全件 same-cycle fix:

| ID | severity | 概要 | 修正 |
|----|----------|------|------|
| 1 | P2 | `workflow.md` 高レベルフローが旧順序（diff_collected / status 決定が commands より前）、優先順位に `failed-command` 欠落 | 2-pass 構成（post-codex → commands → post-command → artifact → status）に書き直し、優先順位に `failed-command` 追加 |
| 2 | P2 | T4/T5 のファイル生成が `yes \| head -c` / `printf` octal escape 依存（環境依存）、`/a{1000}/` 検出が `yes` の改行で弱い | `node -e` structured command で決定論生成、T4 は 64-hex sha256 + patch 長 < 4000 を検証 |

## 実機デモ — E2-8（mini-commerce、catalog domain）

実機 codex 呼び出し計 3 回。各シナリオで catalog policy の `commands.allow` を 1 コマンドに設定し、benign な goal（`countInStock` 追加）で run。

### E2-8-1: command が scope 外を書く

policy command: `mkdir -p apps/orders/src && echo leak > apps/orders/src/cmd-leak.ts`

```
run=run-20260521-apps-catalog-mpf8f8sm32cb3f6d status=failed-policy-violation safetyStatus=denied commands=1/1
summary.md: ## Policy violations → apps/orders/src/cmd-leak.ts (deny_write)
events.jsonl: stage=post-codex, stage=post-command 両方
```

✅ command は exit 0（`commands=1/1`）だが、**post-command 再検査**が `apps/orders/**`（catalog の deny_write）への書き込みを検出 → `failed-policy-violation`。

### E2-8-2: command が secret-shaped file を作る

policy command: `echo API_TOKEN=sk-test-deadbeef > apps/catalog/.env.local`

```
run=run-20260521-apps-catalog-mpf8kbs47bb74b73 status=needs_review safetyStatus=allowed secretSuspectCount=1
untracked-secrets.txt: apps/catalog/.env.local  reasons=filename:.env,filename:*.env.*
untracked-files.patch: "sk-test-deadbeef" の出現回数 = 0
```

✅ path policy は許可（catalog scope 内）だが、secret heuristic が filename で検出。`secretSuspectCount=1`、`untracked-secrets.txt` 生成、**patch に secret 文字列は一切出ない**（content redacted）。

### E2-8-3: command が ignored output を作る

policy command: `mkdir -p apps/catalog/dist && echo built > apps/catalog/dist/out.js`

```
run=run-20260521-apps-catalog-mpf8pe27f159fc73 status=needs_review safetyStatus=allowed ignoredUntrackedCount=1
summary.md: ## Ignored by ignore_untracked (not validated) → apps/catalog/dist/out.js
```

✅ `global.ignore_untracked` の `**/dist/**` にマッチ → `ignoredUntrackedCount=1`、validation 対象外、run は `needs_review` のまま。

## 閉じる条件チェック（Phase 2-8 設計 2-8.6）

```txt
[x] command後の scope外変更が failed-policy-violation になる   — E2-8-1 + T4/T7
[x] command後の secret-shaped file が redacted される          — E2-8-2 + T2
[x] command後の ignored untracked が ignoredUntrackedCount に  — E2-8-3 + T1
[x] command後の symlink は follow されない                     — T3
[x] command後の huge file は content omitted                   — T4
[x] command後の binary file は content omitted                 — T5
[x] post-command artifacts が review-request.md に反映される    — summary.md / untracked-* に反映（E2-8-1〜3 で確認）
[x] events に post-command stage が残る                        — T6 + E2-8-1（実機 events.jsonl）
[x] mini-commerce 実機で最低3シナリオ通す                       — E2-8-1/2/3
```

## 新規 finding

なし。codex review の P2×2 は実装直後に fix 済み。

## 後片付け

- demo run 3 件（`mpf8f8…` failed-policy-violation / `mpf8kb…` / `mpf8pe…` needs_review）は runs/ に残置（gitignore 対象）
- `policies/repos/mini-commerce.yaml` の catalog `commands` は structured-form のデモ設定に復帰（E2-8 用の単一コマンドは一時設定だった）
