# Phase 5-6 — `project check` without Codex

**Date:** 2026-05-22
**Trigger:** `tmp/phase5/phase-5-6.md`（Phase 5-6 設計）
**Scope tag:** （Phase 5-6、close タグなし）

## 目的

Codex を実行せず、profile / policy / context / commands の不備を検出する。

## 成果物

| ファイル | 内容 |
|----------|------|
| `src/project/checker.ts` | `checkProject` — schema / repo / base branch / compile / glob lint / writability / commands / context pack / drift を ok/warn/error に分類 |
| `src/project/glob-linter.ts` | `lintGlobs` — root-anchored minimatch の落とし穴を検出 |
| `src/project/command-checker.ts` | `checkGeneratedCommands` — 生成 policy の command id 重複を独立再検証 |
| `src/project/context-pack-builder.ts` | `buildContextPack` — glob 解決・secret/binary/byte-cap（5-7 でも使用） |
| `src/project/format-check.ts` | text / JSON formatter |
| `src/cli/project.ts` | `project check`（config error で exit 1） |

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 4 / P2: 2。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | drift check が provenance サイドカーを見ていない | サイドカー JSON を parse し、生成元（template/preset/version）の drift も検出 |
| P1 | `repo.base_branch` を未検証 | `git rev-parse --verify` で base ref 解決を検査（Codex 不使用） |
| P1 | writability probe が unsound（narrow scope で誤警告、全 deny を見逃す） | write glob の代表パスを deny と照合。全 write が deny されたら error、root-coverage 警告は撤去 |
| P1 | context pack の byte cap が読み込みバイト数を制限していない | cap 判定を readFile の前へ移動。読み込み総量を maxBytes 程度に抑制 |
| P2 | repo walk が file 数のみで bound、truncation が silent | dir 数 cap 追加、truncation を finding として通知 |
| P2 | matched file の readFile が未 try/catch | unreadable を classified finding 化（throw しない） |

## テスト

`tests/unit/project/{checker,glob-linter,command-checker,context-pack-builder}.test.ts`、
`tests/integration/cli-project-check.test.ts`。
`npm run typecheck` green。`npm test` 627 pass / 1 skip。

## Close 条件

- [x] Codex を起動しない（child_process は git read-only のみ）。
- [x] 設定不備を error / warning に分類できる。
- [x] JSON 出力があり CI で使える。
- [x] 意図的に壊した fixture（全 deny / repo 不在）で error が出る。
- [ ] mini-commerce profile が `project check` を通る（Phase 5-8 で検証）。
