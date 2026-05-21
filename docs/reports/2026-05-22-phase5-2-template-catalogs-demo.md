# Phase 5-2 — Template Catalogs

**Date:** 2026-05-22
**Trigger:** `tmp/phase5/phase-5-2.md`（Phase 5-2 設計）
**Scope tag:** （Phase 5-2、close タグなし）

## 目的

project profile が参照する再利用可能 catalog（policy template / command preset /
context pack preset）を定義し、schema validated に読み込めるようにする。

## 成果物

| ファイル | 内容 |
|----------|------|
| `templates/policy/{strict-monorepo-v1,docs-only-v1}.yaml` | policy template（domain kind ごとの read/write/deny default、`{root}` 等の placeholder） |
| `templates/commands/{node-basic-v1,node-package-basic-v1,python-basic-v1}.yaml` | command preset |
| `templates/context-packs/monorepo-docs-v1.yaml` | context pack preset |
| `src/project/template-schema.ts` | `PolicyTemplateSchema` |
| `src/project/command-preset.ts` | `CommandPresetSchema` + `compilePresetCommand`（plain / 抽象 package_script → policy `StructuredCommand`） |
| `src/project/context-pack-spec.ts` | `ContextPackPresetSchema` + `NormalizedContextPack` 正規化 |
| `src/project/template-loader.ts` | `loadPolicyTemplate` / `loadCommandPreset` / `loadContextPackPreset` |

## 設計上のポイント

- policy template の `domain_defaults` read/write/deny は `{root}` /
  `{other_domain_roots}` / `{root_deny}` placeholder を保持する文字列（Phase 5-4
  の compiler が展開）。一方 `ignore_untracked` / `root_deny` は concrete glob なので
  `SafeGlob` で前倒し検証。
- command preset は structured argv 形式に compile される。`sh -c` 経路なし。
  抽象 `package_script` は repo の package manager で解決、未知なら skip + reason。
- placeholder 置換は未解決・誤記（`{domain-root}` 等）を残さず error 化。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 1 / P2: 2。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | `substitute` が `{[a-z_]+}` だけを placeholder 扱い → `{domain-root}` 等の誤記が argv にそのまま残る | 置換後に残った任意の `{...}` を検出して error 化 |
| P2 | template の `ignore_untracked` / `root_deny` が raw string 検証 | concrete glob なので `SafeGlob` 検証へ変更 |
| P2 | id-matches-filename guard が未テスト | 一時 catalog fixture（`mismatch.yaml` が別 id を宣言）のテストを追加 |

## テスト

`tests/unit/project/{template-loader,command-preset,context-pack-spec}.test.ts`。
`npm run typecheck` green。Phase 5-2 分のユニットテストは全 pass。

## Close 条件

- [x] policy template が 2 種類（strict-monorepo-v1 / docs-only-v1）。
- [x] command preset が Node 系 2 種 + Python 系 1 種。
- [x] context pack preset が 1 種（monorepo-docs-v1）。
- [x] template / preset は schema validated で読み込まれる。
