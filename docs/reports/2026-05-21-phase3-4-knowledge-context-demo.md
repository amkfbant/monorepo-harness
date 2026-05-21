# Phase 3-4 — Promoted Knowledge Context Injection 実機デモ

**Date:** 2026-05-21
**Trigger:** `tmp/phase3/phase3-4-promoted-knowledge-context-injection.md`（Phase 3-4 設計）
**Harness range:** Phase 3-4 実装 commit + 本レポート commit
**Scope tag:** `mvp-validation` / `phase3`

## 背景

Phase 2-9 で promoted knowledge（`docs/knowledge/<kind>/*.md`）を作れるようになった。Phase 3-4 はそれを次回 codex run の prompt に context として注入する。

## 実装

| 層 | 変更 |
|----|------|
| `src/core/knowledge-context.ts`（新規） | `buildKnowledgeContext` — domain 別に promoted knowledge を集約 |
| `src/codex/prompt-builder.ts` | `knowledgeContext` opt → prompt 末尾に「Relevant knowledge from past runs」section |
| `src/core/workflow-runner.ts` | `knowledgeContext` opt → prompt 注入 + `meta.knowledgeContext` + `knowledge_context_loaded` event |
| `src/core/knowledge-promoter.ts` | promote 済み md frontmatter に `deprecated: false` |
| `src/cli/run.ts` | `knowledge build-context` subcommand、`run --with-knowledge` / `--knowledge-context` |

**359 tests PASS / 1 skipped**、typecheck クリア。

## codex review (gpt-5.5 / xhigh)

P0 / P1 なし。P2 ×3、全件 same-cycle fix:

| ID | severity | 概要 | 修正 |
|----|----------|------|------|
| 1 | P2 | `deprecated` 除外が `=== true` のみ → 手編集の `"true"` 文字列を見逃す | bool / 文字列を正規化する `isDeprecated` |
| 2 | P2 | `domainSlug` が非単射 — `apps/user-api` と `apps/user/api` が同一ファイルに衝突 | 8-hex content hash suffix を付与（build-context / run --with-knowledge 共通関数） |
| 3 | P2 | frontmatter 終端 `indexOf("\n---")` が単独行を要求しない | 行単位 `^---\s*$` delimiter の共有 helper `splitFrontmatter`（CRLF 許容） |

## 実機デモ — E3-4（mini-commerce、apps/catalog）

### E3-4-1: build-context

catalog run の secret_suspect 候補を 1 件 promote → `knowledge build-context --domain apps/catalog`:

```
domain=apps/catalog entries=1 out=docs/knowledge-context/apps-catalog-532b50d5.md
```

✅ promoted knowledge が domain 別に集約された。ファイル名に hash suffix（`-532b50d5`）。

### E3-4-3: deprecated 除外

promote 済み md の frontmatter を `deprecated: true` に手編集 → 再 build-context:

```
domain=apps/catalog entries=0 out=docs/knowledge-context/apps-catalog-532b50d5.md
entry_count: 0
(no promoted knowledge for this domain yet)
```

✅ deprecated は context から除外。`deprecated: false` に戻すと entries=1 に復帰。

### E3-4-2: run --with-knowledge

`harness run --domain apps/catalog --goal "filterByTag を追加" --with-knowledge`（実機 codex）:

```
run=run-20260521-apps-catalog-mpfdqm7eabba9d47 status=needs_review safetyStatus=allowed commands=3/3
```

- `codex-prompt.md`: 「Relevant knowledge from past runs」section が 1 個含まれる ✅
- `meta.knowledgeContext`: `{ "enabled": true, "contextFile": ".../apps-catalog-532b50d5.md" }` ✅
- `events.jsonl`: `{"type":"knowledge_context_loaded","contextFile":"..."}` ✅

`candidate / rejected は注入されない` — `buildKnowledgeContext` は `docs/knowledge/` のみを走査し、candidate（`runs/<id>/knowledge-candidates.yaml`）と rejected（`knowledge-decisions.yaml`）は `runs/` 配下で走査対象外。構造上注入され得ない（unit test で担保）。

## 閉じる条件チェック（Phase 3-4 設計 3-4.7）

```txt
[x] promoted knowledge を domain別に集約できる        — E3-4-1
[x] candidate/rejected は注入されない                 — 構造上（docs/knowledge のみ走査）+ unit test
[x] deprecated knowledge は注入されない               — E3-4-3
[x] run prompt に knowledge section が入る             — E3-4-2（codex-prompt.md）
[x] meta/events に使用knowledgeが残る                  — E3-4-2（meta.knowledgeContext / knowledge_context_loaded）
[x] knowledgeあり/なし比較実験がある                   — E3-4-2（あり）+ workflow-fake-codex unit（なし時 meta 未記録）
[x] docs に knowledge injection の限界がある           — cli.md「knowledge injection の限界」節
```

## 新規 finding

なし。codex review の P2×3 は実装直後に fix 済み。

## 後片付け

- demo で生成した `docs/knowledge/` `docs/knowledge-context/` は削除（Phase 2-9 デモと同様、デモ生成物のため）
- demo run（`mpfdqm7eabba9d47`）は runs/ に残置
