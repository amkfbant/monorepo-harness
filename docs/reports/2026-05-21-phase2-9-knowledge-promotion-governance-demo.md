# Phase 2-9 — Knowledge Promotion Governance 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase2/phase2-9-knowledge-promotion-governance.md`（Phase 2-9 設計）の実装と E2-9 デモ
**Harness range:** `ac42d0f`（Phase 2-9 実装 + codex review fix）
**Scope tag:** `mvp-validation`

## 背景

Phase 2-4 の `knowledge promote` は md 書き出しのみ。Phase 2-9 で **誰が・なぜ・どの候補を**昇格／却下したかを記録し、運用可能にする。

データモデル:
- `runs/<runId>/knowledge-candidates.yaml` — run が生成した **immutable な観測ログ**
- `runs/<runId>/knowledge-decisions.yaml` — reviewer の **reject 決定 sidecar**
- `docs/knowledge/<kind>/*.md` — reviewer が **採用した知見**（YAML frontmatter 付き）

## 実装

| 層 | 変更 |
|----|------|
| `src/core/knowledge-promoter.ts` | `promoteKnowledge`（`--reviewer` 必須 / YAML frontmatter / 重複制御 / reject skip）、`rejectKnowledge`（sidecar + event）、`listKnowledge`（status 付き列挙）、`contentHash` |
| `src/cli/run.ts` | `knowledge list` / `knowledge reject` subcommand、`promote` に `--reviewer`（必須）/ `--allow-duplicate` |

unit 20 / integration 9。**334 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 / P1 なし。P2 ×5、全件 same-cycle fix:

| ID | severity | 概要 | 修正 |
|----|----------|------|------|
| 1 | P2 | `contentHash` の区切りが**ソース内の実 NUL バイト**（Write ツールが空白を NUL 化した既知バグ）→ `.ts` が git で binary 扱い | `JSON.stringify([...])` を hash 入力に。NUL 除去、かつ separator-collision も解消 |
| 2 | P2 | duplicate-by-hash が md 全体を `/^hash:/` で grep → 本文の `hash:` 行を誤検出 | 先頭 `--- ... ---` frontmatter のみを YAML parse |
| 3 | P2 | duplicate-by-(run,index) が filename prefix 依存 → `run-a` index 0 と run `run-a-00` が衝突 | frontmatter の `source_run` / `source_index` で判定 |
| 4 | P2 | `rejectKnowledge` が rejected のみ Map に読み sidecar 全書き直し → 未知 decision type が消える | raw decisions 配列を保持し upsert |
| 5 | P2 | sidecar が通常 `writeFile`（read-modify-write） | temp file + `rename` の atomic replace |

## 実機デモ — E2-9（mini-commerce）

candidate を持つ過去 run を流用（codex 実行なし、すべてメタデータ操作）。

### E2-9-1: list → promote --reviewer

run `mpf8f8sm32cb3f6d`（policy_violation candidate 1 件）:

```
$ harness knowledge list --run-id <run>
[0] candidate  kind=policy_violation domain=apps/catalog confidence=high
    Codex wrote outside the domain scope

$ harness knowledge promote --run-id <run>          # --reviewer なし
error: required option '--reviewer <name>' not specified

$ harness knowledge promote --run-id <run> --reviewer knkn
run=… promoted=1 skipped=0
  promoted policy_violation: docs/knowledge/policy_violation/<run>-00-codex-wrote-…-2e9910.md
```

生成 md の frontmatter:

```yaml
---
kind: policy_violation
domain: "apps/catalog"
title: "Codex wrote outside the domain scope"
source_run: run-20260521-apps-catalog-mpf8f8sm32cb3f6d
source_index: 0
confidence: "high"
source_status: "candidate"
promoted_by: "knkn"
promoted_at: "2026-05-21T09:07:11.233Z"
hash: 599e19f3129e9caf
---
```

✅ `--reviewer` 必須（commander が拒否）、frontmatter に `promoted_by` / `hash` / `source_run` / `source_index`。

### E2-9-2: 重複 promote → skip

同じ run を再 promote:

```
run=… promoted=0 skipped=1
  skipped [0] duplicate-index
$ harness knowledge list --run-id <run>
[0] promoted  kind=policy_violation …
```

✅ `duplicate-index` で skip（冪等）。list は status=`promoted` を表示。

### E2-9-3: reject → sidecar + promote skip

run `mpe41lnne60d2633`:

```
$ harness knowledge reject --run-id <run> --index 0 --reviewer knkn --reason "this violation is run-specific, not a reusable lesson"
run=… rejected candidate 0 by knkn
```

`knowledge-decisions.yaml`:
```yaml
decisions:
  - index: 0
    decision: "rejected"
    reviewer: "knkn"
    reason: "this violation is run-specific, not a reusable lesson"
    decidedAt: "2026-05-21T09:07:39.610Z"
```

```
$ harness knowledge list --run-id <run>
[0] rejected (by knkn)  kind=policy_improvement …

$ harness knowledge promote --run-id <run> --reviewer knkn
run=… promoted=0 skipped=1
  skipped [0] rejected — rejected by knkn
```

✅ reject 決定が sidecar に記録、list で `rejected (by knkn)`、promote は当該候補を skip。`knowledge_rejected` event も追記。

### E2-9-4: source run cleanup 後も knowledge md は残る

```
before cleanup: run dir exists=yes, md exists=yes
$ harness cleanup --run-id <run> --scope run --force
run=… scope=run runDirRemoved=true
after cleanup --scope run: run dir exists=NO, promoted md exists=yes
```

✅ `cleanup --scope run` で source run の `runs/<runId>/` が削除されても、promote 済みの knowledge md は残る（knowledge は run のライフサイクルより長く生きる設計）。

## 閉じる条件チェック（Phase 2-9 設計 2-9.9）

```txt
[x] knowledge list が candidates を表示できる              — E2-9-1/2/3
[x] promote に reviewer が必須                            — E2-9-1（commander 拒否）
[x] promoted md に frontmatter がある                     — E2-9-1
[x] duplicate promote は skip される                      — E2-9-2（duplicate-index）+ unit（duplicate-hash）
[x] reject decision を記録できる                          — E2-9-3（knowledge-decisions.yaml）
[x] rejected candidate は promote しようとすると skip      — E2-9-3
[x] source run 削除後も knowledge md が残る仕様が docs に  — cli.md「source run との独立性」+ E2-9-4 実証
[x] knowledge-candidates.yaml は不変                      — unit（never-modified テスト）+ 設計
[x] events に knowledge_promoted / knowledge_rejected      — E2-9-1/3（events.jsonl）
```

## 新規 finding

なし。codex review の P2×5 は実装直後に fix 済み。特に P2-1（NUL バイト）は Write ツール由来の混入で、JSON.stringify 化により恒久的に解消した。

## 後片付け

- demo で生成した `docs/knowledge/` は削除（Phase 2-4 デモと同様、デモ生成物のため）
- demo run のうち `mpf8f8…` は cleanup --scope run で削除済み。`mpe41ln…` は reject 済みで runs/ に残置（gitignore 対象）
