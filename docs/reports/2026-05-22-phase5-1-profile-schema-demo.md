# Phase 5-1 — Project Profile Schema / Loader

**Date:** 2026-05-22
**Trigger:** `tmp/phase5/phase-5-1.md`（Phase 5-1 設計）
**Scope tag:** （Phase 5-1、close タグなし）

## 目的

`projects/<project-id>.yaml`（project profile）を定義・読み込み・検証できるようにする。
Project Abstraction 層の最初のコード。

## 成果物

| ファイル | 内容 |
|----------|------|
| `src/project/errors.ts` | `ProjectError` / `ProjectProfileError` / `ProjectNotFoundError`（CLI exit 1 へマップ） |
| `src/project/schema.ts` | Zod `ProjectProfileSchema`。project_id / repo.id / domain.id / domain.root / glob の安全制約 |
| `src/project/profile-loader.ts` | `loadProjectProfile(path)` — read + YAML parse + validate、全失敗を `ProjectProfileError` 化 |
| `src/project/profile-resolver.ts` | `resolveProjectProfile` / `loadProjectById`、repo path 解決（profile dir 相対、`--repo` override） |
| `src/cli/project.ts` | `registerProjectCommands(program)` + `project show` サブコマンド |
| `src/config/paths.ts` | `projectsDir` / `templatesDir` / `projectProfilePath(id)` を追加 |
| `src/cli/run.ts` | `registerProjectCommands` を呼ぶ |

## 安全制約

- `project_id` / `repo.id`: `assertValidRepoId` 相当（separator / `..` 不可）。
- `domain.id`: slash は許可（後方互換）。`..` / `.` segment / 空 / NUL / backslash /
  absolute / 先頭末尾・二重 slash は拒否。
- `domain.root`: repo-relative path（`.` は repo root として許可）。
- glob（read/write/deny_write/context pack）: brace 展開した**全ブランチ**を検証。
  `{..,docs}/**` のような escape を拒否。
- `repo.path`: filesystem path のため `..` は許可。NUL は拒否。

## codex レビュー（gpt-5.5 xhigh）

P0: 0 / P1: 3 / P2: 1。全件対応済み。

| ID | 指摘 | 対応 |
|----|------|------|
| P1 | `SafeGlob` が brace 展開前に検証 → `{..,docs}/**` が escape | `minimatch.braceExpand` で全ブランチを検証 |
| P1 | `repo.path` が NUL を許容 | schema と `--repo` override で NUL 拒否 |
| P1 | 不正な `--project` id が generic Error → exit 2 | `loadProjectById` で `ProjectError` にラップ → exit 1 |
| P2 | `apps/./web` の `.` segment が canonical alias を作る | `.` segment を domain id / root / glob で拒否 |

## テスト

`tests/unit/project/{schema,profile-loader,profile-resolver}.test.ts`、
`tests/integration/cli-project-show.test.ts`。レビュー指摘のケース（brace escape /
NUL / 不正 id の exit code / `.` segment）も追加。

`npm run typecheck` green。`npm test` 545 pass / 1 skip（既存 + Phase 5-1 分）。

## Close 条件

- [x] `projects/<id>.yaml` を読み込める。
- [x] schema error が人間に読める形で出る。
- [x] 既存 policy load / resolver / run dry-run が壊れていない（全 integration test green）。
