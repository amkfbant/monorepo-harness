# Phase 5-9 — Dummy Project Matrix

**Date:** 2026-05-22
**Trigger:** `tmp/phase5/phase-5-9.md`（Phase 5-9 設計）
**Scope tag:** （Phase 5-9、close タグなし）

## 目的

`mini-commerce` 以外の構成で Phase 5 が使えることを示す。

## 成果物

`tests/integration/project-matrix.test.ts` — 4 種類の一時 git repo fixture を生成し、
`project inspect` / `init --dry-run` / `init --write` → `check` → `run --project --dry-run`
を横断検証。

| fixture | レイアウト | 期待 candidate / registry |
|---------|-----------|---------------------------|
| node apps+packages | `apps/*` + `packages/*` | node registry、`apps/admin`/`apps/web`/`packages/ui` |
| services+libs | `services/*` + `libs/*`（Node） | node registry、`libs/common`/`services/api` |
| python services | `services/*` + `packages/*`（pyproject） | generic registry、python-basic-v1 preset |
| docs-only | `README.md` + `docs/` | generic registry、`docs` domain |

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 1 / P2: 3。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | `init --dry-run` が node fixture でしか実行されていない（3+ layout 要件未達） | 全 4 layout で `init --dry-run --json` を実行 |
| P2 | 「書き込みゼロ」検証が `projects/<id>.yaml` 不在のみ | 一時 HARNESS_ROOT + `--json` `written: []` + `projects/`/`policies/` 不在を検証 |
| P2 | inspect assertion が緩い（`toContain`） | 全 layout で candidate id を exact 比較、`kind` / `suggestedCommandPresets` も検証 |
| P2 | 意図的に壊した case が無い、green で exit code 未検証 | broken case（存在しない `--repo`）で exit 1 + `status: error`、green で exit 0 を assert |

## テスト

`tests/integration/project-matrix.test.ts` 7 件 pass。
`npm run typecheck` green。`npm test` 649 pass / 1 skip。

## Close 条件

- [x] mini-commerce 以外の最低 3 種類の repo layout で dry-run できる（4 種類）。
- [x] inspect candidate が layout に応じて変わる（exact 比較で検証）。
- [x] check が green / intentional broken の両方を検出できる。
