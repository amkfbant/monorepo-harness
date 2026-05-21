# Phase 5-7 — Runtime Integration

**Date:** 2026-05-22
**Trigger:** `tmp/phase5/phase-5-7.md`（Phase 5-7 設計）
**Scope tag:** （Phase 5-7、close タグなし）

## 目的

project profile を実行フローで実際に使えるようにする。`run --project` /
`workflow reviewed-run --project`、namespaced lock、context pack 注入、
`RunMeta.project` provenance。

## 成果物

| ファイル | 内容 |
|----------|------|
| `src/project/run-project.ts` | `prepareProjectRun` — profile load → compile → domain resolve → context pack assemble |
| `src/project/run-context-packs.ts` | `assembleProjectContextPacks` — prompt text + manifest、総 byte cap |
| `src/workspace/domain-lock.ts` | `domainLockName(domain, repoId?)` — repoId namespaced lock（衝突耐性 hash） |
| `src/core/workflow-runner.ts` | `RunDomainCodingOpts` に `compiledPolicy` / `project` / `projectContextPacks` |
| `src/core/reviewed-run-workflow.ts` | `projectRun` を全 coder run / rerun へ伝播 |
| `src/codex/prompt-builder.ts` | `projectContextPacks` プロンプトセクション（fence 中和） |
| `src/logging/run-log.ts` | `RunMeta.project`（optional） |
| `src/core/{review-processor,cleanup,pr-creator}.ts` | `meta.repoId` から namespaced lock を取得 |
| `src/cli/run.ts` | `run --project` / `reviewed-run --project`、`lock release --repo-id` |

## 5-7-a〜d 実装範囲

- **5-7-a** prepared run: `compiledPolicy` で policy file load をスキップ。
- **5-7-b** RunMeta.project: optional、旧 run は legacy 扱い。
- **5-7-c** namespaced lock: dual-mode。全ライフサイクルコマンドが `meta.repoId`
  から同一 key を導出。
- **5-7-d** context pack 注入: `buildContextPack` → prompt section + manifest artifact。
  secret-shaped file は content を prompt/manifest に入れない。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 1 / P2: 3。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | `run --project` が profile の `repo.base_branch` を無視（commander の default "main" が優先） | `--base-branch` の default を撤去。explicit > profile.base_branch > "main" |
| P2 | lock name の hash が domain のみ — repoId slug 衝突で誤 contention | hash を `repoId\0domain` 全体に拡張 |
| P2 | `reviewed-run` legacy 検証が `--repo-id` のみ（`--repo` 欠落で `"undefined"`） | `--repo` + `--repo-id` 両方を検証 |
| P2 | context pack の総 byte cap が source bytes のみカウント（prompt block 未計上） | 描画後の chunk byte 数で cap 判定 |

## 範囲外（follow-up）

設計 5-7-e/f の一部は本 phase の範囲外（Phase 5 close report に follow-up として記録）:
metrics / inbox / digest の `--project` filter、backlog `projectId`、
`knowledge build-context` の project namespace ディレクトリ。`RunMeta.project` は
実装済みなので knowledge candidate は run 単位で自然に分離される。

## テスト

`tests/integration/{workflow-project-profile,cli-run-project-dry-run}.test.ts`、
`tests/unit/workspace/domain-lock.test.ts`（namespaced / 衝突耐性）。
namespaced lock 化に伴い `cleanup` / `review-processor` のロック競合テストを更新。
`npm run typecheck` green。`npm test` 638 pass / 1 skip。

## Close 条件

- [x] `run --project --dry-run` が通る。
- [x] fake codex で `run --project` が実行できる。
- [x] context pack が prompt に入る。
- [x] run meta / artifacts に project provenance が残る。
- [x] 2 つの project が同じ domain id を持っても lock が混線しない。
- [x] 既存 `run --repo-id` 系テストが通る。
