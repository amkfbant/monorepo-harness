# Phase 5-3 — Domain Registry / `project inspect`

**Date:** 2026-05-22
**Trigger:** `tmp/phase5/phase-5-3.md`（Phase 5-3 設計）
**Scope tag:** （Phase 5-3、close タグなし）

## 目的

target repo を静的に読んで（Codex 不使用）候補 domain を出せるようにする。

## 成果物

| ファイル | 内容 |
|----------|------|
| `templates/domain-registries/{node-monorepo-default-v1,generic-repo-default-v1}.yaml` | domain registry catalog |
| `src/project/domain-registry.ts` | `DomainRegistrySchema` + `loadDomainRegistry` |
| `src/project/repo-signals.ts` | `scanRepoSignals` — filesystem のみ走査（package manager / workspace / language / depth 1-2 ディレクトリ） |
| `src/project/inspector.ts` | `inspectProject` — registry × signals → 決定論的 candidate + warning。text / JSON formatter |
| `src/cli/project.ts` | `project inspect` サブコマンド（registry 自動選択） |

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 2 / P2: 3。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | `readPackageJson` が `existsSync` + 無制限 `readFile`（symlink follow / FIFO / 巨大ファイルでハング） | `lstat` で regular file 判定 + 1 MiB cap |
| P1 | generic registry が `docs-only-v1` を suggest しつつ Python code domain を提案（write scope が md/txt のみで誤り） | generic registry を `strict-monorepo-v1` に変更 |
| P2 | ディレクトリ走査の breadth 無制限 | `MAX_SCANNED_DIRS=400` で打ち切り + `truncated` フラグ + inspect warning |
| P2 | `project inspect --repo` がファイルパスで exit 0 空結果 | `statSync().isDirectory()` チェック → 非ディレクトリは exit 1 |
| P2 | registry の catalog id 参照が任意文字列 | `suggested_policy_template` / `command_presets` / `context_packs` を `TemplateId` 検証へ |

## テスト

`tests/unit/project/{domain-registry,inspector}.test.ts`、
`tests/integration/cli-project-inspect.test.ts`。
`npm run typecheck` green。`npm test` 567 pass / 1 skip。

## Close 条件

- [x] `project inspect` が candidate domain を出す。
- [x] 出力は決定論的順序（id ソート）。
- [x] Codex / allowedCommands は実行しない。
- [x] 複数構成（node monorepo fixture）で候補が出る。Phase 5-9 で更に複数 layout を検証予定。
