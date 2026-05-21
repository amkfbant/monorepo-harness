# Phase 5-5 — `project init` / Safe Write / Migration

**Date:** 2026-05-22
**Trigger:** `tmp/phase5/phase-5-5.md`（Phase 5-5 設計）
**Scope tag:** （Phase 5-5、close タグなし）

## 目的

新規・既存 repo を profile 化し、dry-run で policy proposal を見られるようにする。
安全にファイル生成もできるようにする。

## 成果物

| ファイル | 内容 |
|----------|------|
| `src/project/init.ts` | `runProjectInit` — mode A（repo を inspect → profile）/ mode B（既存 policy を migrate）→ compile → proposal → safe write |
| `src/project/policy-migrator.ts` | `migratePolicyToProfile` — 既存 RepoPolicy → ProjectProfile |
| `src/project/domain-registry.ts` | `selectDefaultRegistryId` を export（CLI と共用） |
| `src/cli/project.ts` | `project init` サブコマンド（`--repo` / `--from-policy` / `--dry-run` / `--write` / `--force`） |

## 設計上のポイント

- `--dry-run`（既定）は書き込みゼロ。`--write` は 3 ファイル（profile / repo policy /
  provenance sidecar）を生成。`--force` で上書き。
- safe write: 全ターゲットを preflight → 各ファイルを `linkSync`（no-clobber 原子
  ゲート）/ `renameSync`（force）で書き込み。途中失敗時は当 call で新規作成した
  ファイルをロールバック。
- migrator: 既存 policy の domain scope を explicit に引き継ぐ（空 scope も `[]` で
  保持）。repo-level read を各 domain へ畳み込む。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 2 / P2: 3。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | `safeWrite` の TOCTOU（`existsSync`→`renameSync` で clobber 競合） | `linkSync` による原子 no-clobber ゲートへ。force のみ `renameSync` |
| P1 | migrator が空 scope を省略 → compiler が template default を適用し no-write domain を writable 化 | read/write/deny_write を空でも常に explicit 設定 |
| P2 | 複数ファイル書き込みの partial 状態 | 全ターゲット preflight + 失敗時に新規作成ファイルをロールバック |
| P2 | temp ファイル名が衝突しうる | `randomUUID` + `wx` 排他作成 |
| P2 | `--repo` + `--from-policy` の併用が曖昧 | `--repo` の help を「from-policy 時は埋め込む repo path」と明記 |

## テスト

`tests/unit/project/policy-migrator.test.ts`、
`tests/integration/cli-project-init.test.ts`、
`tests/integration/cli-project-init-write.test.ts`。
`npm run typecheck` green。`npm test` 607 pass / 1 skip。

## Close 条件

- [x] `project init --dry-run` が policy proposal を出す。
- [x] `--dry-run` が書き込みゼロであることをテストで確認。
- [x] `--write` は safe write で profile / policy を生成。
- [x] 既存 policy から profile 化できる（`--from-policy`）。
