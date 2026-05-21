# Phase 5 — Close Package: Project Abstraction

**Date:** 2026-05-22
**Trigger:** `tmp/phase5-abstraction-implementation-plan.md`（設計）→ `tmp/phase5/` 分割
**Harness range:** `phase4-close` タグ → Phase 5-10 close commit
**Scope tag:** `phase5-close`

## Phase 5 とは

`mini-commerce` 検証用デモアプリに寄っていた policy / domain / command / context の
形を、任意の新規・既存プロジェクトへ適用できる **Project Abstraction 層**として
分離した。`project profile → domain registry → templates / presets / context packs
→ policy proposal / check → run` の流れを提供する。

## サブフェーズの到達点

実装順は設計の推奨順 `5-0 → 5-10`。各サブフェーズで実装 → codex（gpt-5.5 xhigh）
レビュー → 修正 → demo report → commit。

| Phase | 内容 | レポート |
|-------|------|----------|
| 5-0 | spec skeleton / guardrails | `2026-05-22-phase5-0-spec-skeleton-demo.md` |
| 5-1 | project profile schema / loader | `2026-05-22-phase5-1-profile-schema-demo.md` |
| 5-2 | template catalogs（policy / command / context pack） | `2026-05-22-phase5-2-template-catalogs-demo.md` |
| 5-3 | domain registry / `project inspect` | `2026-05-22-phase5-3-domain-registry-inspect-demo.md` |
| 5-4 | policy compiler / proposal engine | `2026-05-22-phase5-4-policy-compiler-demo.md` |
| 5-5 | `project init`（dry-run / write / migration） | `2026-05-22-phase5-5-project-init-demo.md` |
| 5-6 | `project check`（Codex 不使用） | `2026-05-22-phase5-6-project-check-demo.md` |
| 5-7 | runtime integration（`run --project` / namespaced lock / context pack） | `2026-05-22-phase5-7-runtime-integration-demo.md` |
| 5-8 | mini-commerce 移行 | `2026-05-22-phase5-8-mini-commerce-migration-demo.md` |
| 5-9 | dummy project matrix | `2026-05-22-phase5-9-dummy-matrix-demo.md` |
| 5-10 | docs / close package | （本レポート） |
| 5-7-f | backlog `projectId` | （本レポート、5-7 follow-up） |

## codex レビュー集計

全サブフェーズで gpt-5.5 xhigh レビューを実施。P0 はゼロ。P1 / P2 は全件対応済み。

| Phase | P0 | P1 | P2 |
|-------|---:|---:|---:|
| 5-0 | 0 | 3 | 3 |
| 5-1 | 0 | 3 | 1 |
| 5-2 | 0 | 1 | 2 |
| 5-3 | 0 | 2 | 3 |
| 5-4 | 0 | 3 | 2 |
| 5-5 | 0 | 2 | 3 |
| 5-6 | 0 | 4 | 2 |
| 5-7 | 0 | 1 | 3 |
| 5-8 | 0 | 2 | 1 |
| 5-9 | 0 | 1 | 3 |

## close 条件チェックリスト（設計 §9）

```txt
[x] project profile を定義できる                                  — 5-1
[x] domain registry を定義できる                                  — 5-3
[x] mini-commerce を project profile 形式へ移行できる              — 5-8
[x] project inspect が候補 domain を出せる                        — 5-3
[x] project init --dry-run が policy proposal を出せる             — 5-5
[x] policy template がある                                        — 5-2
[x] command preset がある                                         — 5-2
[x] context pack を明示できる                                     — 5-2 / 5-7
[x] project check が Codex 実行なしで設定不備を検出できる          — 5-6
[x] 別構成のダミープロジェクトに dry-run できる                   — 5-9
[x] 既存 repo policy / run CLI が後方互換で動く                   — 全 phase（既存テスト green）
[x] run / workflow reviewed-run が --project を使える             — 5-7
[x] backlog が projectId を保持できる                             — 5-7-f
[x] lock が project/repo + domain で namespace される             — 5-7
[~] knowledge context / promoted knowledge が project/repo namespace — 部分（下記 follow-up）
[~] metrics / inbox / digest が project/repo filter を持つ        — follow-up（下記）
[x] profile / template / preset / context pack に schema version  — 5-1 / 5-2 / 5-3
[x] generated policy に provenance が残る                         — 5-4（サイドカー JSON）
[x] dry-run / proposal 出力が決定論的                             — 5-4
[x] project init --write が safe write で実装されている           — 5-5
[x] context pack secret / binary / size cap が検査される          — 5-6
[x] docs/specs/README/reports が更新されている                    — 5-10
[x] unit / integration / CLI tests が追加されている               — 全 phase
[x] npm run typecheck が通る                                      — green
[x] npm test が通る                                               — 651 pass / 1 skip
```

## Follow-up（Phase 5 範囲外、Phase 6 候補）

設計 §9 の 2 項目は本 Phase の範囲外とした。理由と現状:

1. **metrics / inbox / digest の `--project` / `--repo-id` filter** — 未実装。
   実装には run summary（`ReviewListEntry`）と SQLite index schema へ `repoId` を
   追加する migration が必要で、operational polish の価値に対して変更が大きい。
   `RunMeta.project` は実装済みのため、各 run は project 帰属を持つ。
2. **`knowledge build-context` の project namespace ディレクトリ** — 未実装。
   knowledge candidate は `runs/<runId>/` 配下で run 単位に分離済み。`RunMeta.project`
   が projectId を持つため project 帰属の追跡は可能。`docs/knowledge-context/`
   のディレクトリ namespace 化のみ follow-up。

これらは Project Abstraction の中核（profile / registry / templates / compiler /
init / check / run）には影響せず、Phase 4 運用 CLI への additive な filter。

## 後方互換

- 既存 `policies/repos/*.yaml` + `harness run --repo-id` は不変。
- `RunMeta.project` は optional。旧 run / 旧 knowledge は legacy 扱い。
- mini-commerce: 生成 policy は移行前後で `resolvePolicy` 出力が同一。
  `run --repo-id mini-commerce`（共有 global.yaml 併用）も従来どおり保護される。
- 全 484 → 651 テスト green（Phase 5 で +162、1 skip は既存）。

## 検証

- `npm run typecheck`: green
- `npm test`: 651 passed / 1 skipped
- `mini-commerce` / dummy 4 layout で `inspect` / `init --dry-run` / `check` /
  `run --project --dry-run` が通ることを integration test で確認。
